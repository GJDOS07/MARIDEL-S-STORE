"use strict";
// Real end-to-end verification of the local owner admin.
//
// Starts the actual server.js in a subprocess, against the isolated sandbox
// database, using the owner credentials from the real local .env. It then drives
// the real HTTP surface a browser would: CSRF, login, protected routes, the
// dashboard's own endpoints, and logout.
//
// The password is read from the environment into memory and is never printed.
// The production database is never contacted: the sandbox is in-process only.

require("dotenv").config();
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = Number(process.argv[2]) || 4310;
const ORIGIN = "http://localhost:4173";
// The documented local setup: static frontend on 4173, API on 3000. Both are
// started here so the real cross-origin browser conditions are reproduced.
const SITE_PORT = Number(process.env.E2E_SITE_PORT) || 4173;
const API_PORT = Number(process.env.E2E_API_PORT) || PORT || 3000;
const MANIFEST = process.argv[3] || "e2e-manifest.json";
const DEPLOYMENT_ROOT = __dirname;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`  PASS  ${label}`);
	} else {
		failed += 1;
		failures.push(label);
		console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
	}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Starts a server subprocess and resolves once it reports that it is listening.
async function start({ script, port, env }) {
	const child = spawn(process.execPath, [path.join(DEPLOYMENT_ROOT, script)], {
		env: {
			...process.env,
			...env,
			// Each child gets only its own port variable. Passing the ambient PORT
			// to both is what made the static server fight the backend for it.
			SITE_PORT: env.SITE_PORT !== undefined ? env.SITE_PORT : undefined,
			NODE_ENV: "development",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", c => { output += c.toString("utf8"); });
	child.stderr.on("data", c => { output += c.toString("utf8"); });
	const base = `http://127.0.0.1:${port}`;
	let ready = false;
	const deadline = Date.now() + 25000;
	while (Date.now() < deadline && !ready) {
		try {
			const response = await fetch(base);
			if (response.status === 200) ready = true;
		} catch { /* not listening yet */ }
		if (!ready) await sleep(200);
	}
	return {
		base, output, child, ready,
		async stop() {
			child.kill("SIGTERM");
			await new Promise(resolve => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", resolve);
				setTimeout(resolve, 3000);
			});
		},
	};
}

(async () => {
	// The password is read from stdin, never from an argument or a file: argv
	// lands in shell history and the process list, and a file would be committed.
	// Nothing about it is printed.
	const passwordFromStdin = await new Promise(resolve => {
		let value = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", chunk => {
			value += chunk;
			if (value.includes("\n")) {
				process.stdin.pause();
				resolve(value.split("\n")[0].trimEnd());
			}
		});
		process.stdin.on("end", () => resolve(value.trim()));
		setTimeout(() => resolve(value.trim()), 2000);
	});
	const ownerPassword = passwordFromStdin || process.env.OWNER_PASSWORD_TEST_VALUE;
	if (!ownerPassword) {
		console.error("No password supplied on stdin. Pipe it in, e.g.  echo -n YOUR_PASSWORD | node e2e-owner-admin.js");
		process.exitCode = 2;
		return;
	}

	// The documented local setup, exactly: static frontend on one port, API on
	// another, dashboard calling the API cross-origin. Starting both is the only
	// way the real browser conditions are reproduced.
	const site = await start({ script: "serve-local.js", port: SITE_PORT, env: { SITE_PORT: String(SITE_PORT) } });
	const api = await start({ script: "server.js", port: API_PORT, env: { LOCAL_SANDBOX_DB: "1", PORT: String(API_PORT) } });
	const manifest = {
		site: site.base,
		api: api.base,
		origin: ORIGIN,
		startup: api.output,
		steps: {},
	};

	try {
		if (!api.ready) throw new Error(`API server did not start: ${api.output.slice(0, 400)}`);
		if (!site.ready) throw new Error(`static server did not start: ${site.output.slice(0, 300)}`);

		console.log("\n=== LOCAL OWNER ADMIN END-TO-END VERIFICATION ===\n");
		const base = api.base;

		// 1. Health and startup diagnostics.
		check("API server started and health endpoint answered 200", api.ready);
		check("startup log names the isolated database", /isolated PostgreSQL/.test(api.output));
		check("startup log reports owner auth valid", /password hash valid/.test(api.output)
			&& /session secret valid/.test(api.output));
		check("startup log prints no connection string", !/postgres(ql)?:\/\//.test(api.output));

		// 2. The login page and its assets, served by the static server.
		const page = await fetch(`${site.base}/owner-dashboard.html`);
		const pageBody = await page.text();
		check("login page serves from the frontend origin", page.status === 200, `got ${page.status}`);
		check("login page contains the login form", /loginForm/.test(pageBody));
		check("login page contains the Forgot password link", /forgotPasswordLink/.test(pageBody));
		check("login page points the API at the local backend",
			/localhost:3000/.test((await (await fetch(`${site.base}/owner-dashboard.js`)).text())));

		for (const asset of ["style.css", "pickup-time-display.js"]) {
			const response = await fetch(`${site.base}/${asset}`);
			check(`dashboard asset ${asset} loads`, response.status === 200, `got ${response.status}`);
		}
		check("the .env file is not downloadable", (await fetch(`${site.base}/.env`)).status !== 200);

		// 3. Unauthenticated protected routes are refused.
		const anon = await fetch(`${base}/api/owner/orders`, { headers: { Origin: ORIGIN } });
		check("unauthenticated /api/owner/orders is 401", anon.status === 401, `got ${anon.status}`);
		check("unauthenticated response is OWNER_LOGIN_REQUIRED",
			(await anon.json()).code === "OWNER_LOGIN_REQUIRED");

		const bogusCookie = await fetch(`${base}/api/owner/session`, {
			headers: { Origin: ORIGIN, Cookie: "maridel_owner_session=not-a-real-session" },
		});
		check("a bogus session cookie is 401", bogusCookie.status === 401, `got ${bogusCookie.status}`);

		// 4. Login with the real stored credential.
		const login = async password => {
			const csrfResponse = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: ORIGIN } });
			const csrfBody = await csrfResponse.json();
			const jar = csrfResponse.headers.getSetCookie().map(c => c.split(";")[0]);
			const response = await fetch(`${base}/api/owner/login`, {
				method: "POST",
				headers: {
					Origin: ORIGIN,
					"Content-Type": "application/json",
					Cookie: jar.join("; "),
					"X-CSRF-Token": csrfBody.csrf_token,
				},
				body: JSON.stringify({ password }),
			});
			return {
				status: response.status,
				body: await response.json().catch(() => ({})),
				cookies: response.headers.getSetCookie(),
			};
		};

		const wrong = await login("definitely-not-the-configured-password");
		check("an incorrect password is 401", wrong.status === 401, `got ${wrong.status}`);
		check("an incorrect password is INVALID_OWNER_CREDENTIALS",
			wrong.body.code === "INVALID_OWNER_CREDENTIALS");

		const good = await login(ownerPassword);
		check("the existing owner password authenticates", good.status === 200, `got ${good.status} ${JSON.stringify(good.body).slice(0, 120)}`);
		check("login returns a CSRF token", typeof good.body.csrf_token === "string" && good.body.csrf_token.length > 0);
		const sessionCookie = good.cookies.map(c => c.split(";")[0]).find(c => c.startsWith("maridel_owner_session="));
		const csrfCookie = good.cookies.map(c => c.split(";")[0]).find(c => c.startsWith("maridel_owner_csrf="));
		check("login sets the session cookie", Boolean(sessionCookie));
		check("login sets the CSRF cookie", Boolean(csrfCookie));
		manifest.steps.sessionCookie = good.cookies.find(c => c.startsWith("maridel_owner_session="));
		manifest.steps.sameSite = /SameSite=(\w+)/i.exec(manifest.steps.sessionCookie || "")?.[1];
		manifest.steps.httpOnly = /HttpOnly/i.test(manifest.steps.sessionCookie || "");
		manifest.steps.path = /Path=([^;]+)/i.exec(manifest.steps.sessionCookie || "")?.[1];

		const cookieHeader = [sessionCookie, csrfCookie].filter(Boolean).join("; ");

		// 5. The session works on protected routes.
		const orders = await fetch(`${base}/api/owner/orders?limit=100`, {
			headers: { Origin: ORIGIN, Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token },
		});
		check("authenticated /api/owner/orders is 200", orders.status === 200, `got ${orders.status}`);
		const orderRows = await orders.json();
		check("order list returns the seeded row", Array.isArray(orderRows) && orderRows.length === 1,
			`got ${Array.isArray(orderRows) ? orderRows.length : "non-array"}`);

		const sessionCheck = await fetch(`${base}/api/owner/session`, { headers: { Origin: ORIGIN, Cookie: cookieHeader } });
		check("the session survives a follow-up request", sessionCheck.status === 200, `got ${sessionCheck.status}`);

		// 6. Dashboard data endpoints.
		const products = await fetch(`${base}/api/owner/products`, {
			headers: { Origin: ORIGIN, Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token },
		});
		check("authenticated /api/owner/products is 200", products.status === 200, `got ${products.status}`);
		const productBody = await products.json();
		check("product listing reports the visibility capability",
			productBody.visibility_supported === true);
		check("product listing returns the seeded catalog", productBody.products.length === 18,
			`got ${productBody.products.length}`);

		const availability = await fetch(`${base}/api/pickup/availability`, { headers: { Origin: ORIGIN } });
		check("public pickup availability still answers", availability.status === 200);
		const customerCheck = await fetch(`${base}/api/products`, { headers: { Origin: ORIGIN } });
		check("customer product listing still answers", customerCheck.status === 200);

		// 7. Product administration works against the sandbox.
		const createResponse = await fetch(`${base}/api/owner/products`, {
			method: "POST",
			headers: {
				Origin: ORIGIN, "Content-Type": "application/json",
				Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token,
			},
			body: JSON.stringify({ name: "Sandbox Test Item", category: "Drinks", price: "3.50", stock: "5" }),
		});
		check("product creation succeeds", createResponse.status === 201, `got ${createResponse.status}`);
		const created = await createResponse.json();
		const createdId = created.product && created.product.id;
		check("the created product is published by default", created.product && created.product.is_published === true);

		const hideResponse = await fetch(`${base}/api/owner/products/${createdId}`, {
			method: "PATCH",
			headers: {
				Origin: ORIGIN, "Content-Type": "application/json",
				Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token,
			},
			body: JSON.stringify({ is_published: false }),
		});
		check("hide/unpublish succeeds", hideResponse.status === 200, `got ${hideResponse.status}`);
		const publicList = await fetch(`${base}/api/products`, { headers: { Origin: ORIGIN } });
		const publicRows = await publicList.json();
		check("a hidden product is excluded from the storefront",
			!publicRows.some(p => p.id === createdId));
		check("the storefront still lists the seeded products", publicRows.length === 18,
			`got ${publicRows.length}`);

		const deleteResponse = await fetch(`${base}/api/owner/products/${createdId}`, {
			method: "DELETE",
			headers: {
				Origin: ORIGIN, "Content-Type": "application/json",
				Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token,
			},
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		check("deleting an unreferenced product succeeds", deleteResponse.status === 200, `got ${deleteResponse.status}`);

		const referenced = await fetch(`${base}/api/owner/products/73`, {
			method: "DELETE",
			headers: {
				Origin: ORIGIN, "Content-Type": "application/json",
				Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token,
			},
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		check("an order-referenced product refuses to delete", referenced.status === 409, `got ${referenced.status}`);
		check("order history is preserved", (await fetch(`${base}/api/owner/orders`, {
			headers: { Origin: ORIGIN, Cookie: cookieHeader },
		}).then(r => r.json())).length === 1);

		// 8. Logout invalidates the session.
		const logout = await fetch(`${base}/api/owner/logout`, {
			method: "POST",
			headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookieHeader, "X-CSRF-Token": good.body.csrf_token },
			body: "{}",
		});
		check("logout succeeds", logout.status === 200, `got ${logout.status}`);
		const afterLogout = await fetch(`${base}/api/owner/orders`, {
			headers: { Origin: ORIGIN, Cookie: cookieHeader },
		});
		check("the session is invalid after logout", afterLogout.status === 401, `got ${afterLogout.status}`);
		// 9. Password recovery boundary checks.
		// The sandbox server has no Resend configuration, so the request route takes
		// the fail-closed path: it must stay generic and issue no token. The
		// delivering path is covered by the mocked provider in owner-email.test.js.
		const recoveryCsrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: ORIGIN } });
		const recoveryToken = (await recoveryCsrf.json()).csrf_token;
		const recoveryJar = recoveryCsrf.headers.getSetCookie().map(c => c.split(";")[0]);
		const recoveryHeaders = {
			Origin: ORIGIN, "Content-Type": "application/json",
			Cookie: recoveryJar.join("; "), "X-CSRF-Token": recoveryToken,
		};

		const resetRequest = await fetch(`${base}/api/owner/password/reset-request`, {
			method: "POST", headers: recoveryHeaders, body: "{}",
		});
		check("a reset request without a provider stays generic", resetRequest.status === 200
			&& (await resetRequest.json()).requested === true);

		for (const [label, badToken] of [["malformed", "not-a-token"], ["unknown", "a".repeat(43)]]) {
			const refused = await fetch(`${base}/api/owner/password/reset`, {
				method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
				body: JSON.stringify({ token: badToken, new_password: "Whatever-1234", confirm_password: "Whatever-1234" }),
			});
			check(`reset token ${label} is refused`, refused.status === 400, `got ${refused.status}`);
		}

		// A weak new password is refused before the token is even consumed.
		const weakResponse = await fetch(`${base}/api/owner/password/reset`, {
			method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({ token: "b".repeat(43), new_password: "short", confirm_password: "short" }),
		});
		check("a weak new password is refused", weakResponse.status === 400, `got ${weakResponse.status}`);
	} catch (error) {
		failed += 1;
		failures.push(`harness error: ${error.message}`);
		console.log(`\n  FAIL  harness error :: ${error.message}`);
	} finally {
		await api.stop();
		await site.stop();
	}

	manifest.summary = { passed, failed, failures };
	require("node:fs").writeFileSync(path.join(DEPLOYMENT_ROOT, MANIFEST), JSON.stringify(manifest, null, 2));

	console.log(`\n=== ${passed} passed, ${failed} failed ===`);
	if (failures.length > 0) {
		console.log("Failures:");
		for (const failure of failures) console.log(`  - ${failure}`);
	}
	process.exitCode = failed === 0 ? 0 : 1;
})();
