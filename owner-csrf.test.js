"use strict";
// Regression tests for the owner CSRF bootstrap and cookie policy.
//
// THE BUG THESE GUARD AGAINST
//   The dashboard is served from one origin and the API from another, so every
//   owner request is cross-origin. The CSRF cookie was set SameSite=Lax whenever
//   NODE_ENV was not "production", and a Lax cookie is NOT sent on a cross-origin
//   POST. The browser therefore dropped it before /api/owner/login, requireCsrf
//   read an empty cookie, and the owner got "A valid CSRF token is required" even
//   though the token in the X-CSRF-Token header was correct.
//
//   It was invisible to curl and to every same-origin test, because neither sends
//   cookies cross-origin. Only a real browser exposes it.
//
//   The fix: the cookie is SameSite=None; Secure whenever the deployment is
//   cross-origin, which is production AND every local setup, because the static
//   frontend is always a different origin from the API.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createOrderRouter, sameSiteFor, serializeCookie, isCrossOriginDeployment } = require("./order-routes");
const { createSandboxDatabase } = require("./local-sandbox-database");
const { createPoolAdapter } = require("./pglite-pool");
const { hashOwnerPassword } = require("./owner-credentials-tool");

const ORIGIN = "http://localhost:4173";
const PASSWORD = "Synthetic-Csrf-Regression-4417";
const SECRET = "synthetic-csrf-regression-secret-0123456789abcdef";

// Mounts the real router over the real sandbox, so the cookie and the CSRF
// middleware are the ones the running server uses.
async function mount() {
	const sandbox = await createSandboxDatabase();
	const app = express();
	app.use(express.json());
	app.use("/api", createOrderRouter(createPoolAdapter(sandbox.db), {
		allowedOrigins: [ORIGIN],
		isOriginAllowed: origin => origin === ORIGIN,
	}));
	// The same error handler server.js mounts, so failures come back as JSON with
	// the code the dashboard reads, not as an Express HTML page.
	app.use(require("./api-error-handler").createApiErrorHandler());
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	return {
		base: `http://127.0.0.1:${server.address().port}`,
		async close() {
			await new Promise(resolve => server.close(resolve));
			await sandbox.close();
		},
	};
}

// Performs the bootstrap-then-login pair exactly as the frontend does.
async function attemptLogin(base, password, { sendToken = true, sendCookie = true } = {}) {
	const csrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: ORIGIN } });
	const setCookie = csrf.headers.get("set-cookie") || "";
	const body = await csrf.json();
	const cookieName = /^([^=]+)=/.exec(setCookie);
	const cookieValue = /^[^=]+=([^;]*)/.exec(setCookie);
	const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
	if (sendCookie && cookieName && cookieValue) headers.Cookie = `${cookieName[1]}=${cookieValue[1]}`;
	if (sendToken) headers["X-CSRF-Token"] = body.csrf_token;
	const response = await fetch(`${base}/api/owner/login`, {
		method: "POST", headers, body: JSON.stringify({ password }),
	});
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

test("the cookie policy allows a cross-origin POST", () => {
	assert.equal(sameSiteFor(true), "None", "a secure deployment must allow cross-origin cookies");
	assert.equal(sameSiteFor(false), "Lax", "without Secure the browser would reject None anyway");
	const header = serializeCookie("maridel_owner_csrf", "synthetic", { maxAge: 600, secure: true });
	assert.match(header, /SameSite=None/, "the CSRF cookie must travel cross-origin");
	assert.match(header, /Secure/, "SameSite=None requires Secure");
});

test("every local deployment is treated as cross-origin", () => {
	// The dashboard is a static page and the API a separate service, so the page
	// origin never equals the API origin.
	const previous = process.env.FRONTEND_ORIGINS;
	try {
		delete process.env.FRONTEND_ORIGINS;
		assert.equal(isCrossOriginDeployment(), true, "undeclared means the published origin");
		process.env.FRONTEND_ORIGINS = "";
		assert.equal(isCrossOriginDeployment(), true, "empty means the defaults");
		process.env.FRONTEND_ORIGINS = "https://gjdos07.github.io";
		assert.equal(isCrossOriginDeployment(), true, "a remote page origin is cross-origin");
		process.env.FRONTEND_ORIGINS = "https://a.example, https://b.example";
		assert.equal(isCrossOriginDeployment(), true, "all remote means cross-origin");
		// A loopback-only list would mean same-origin, which the project never uses.
		process.env.FRONTEND_ORIGINS = "http://localhost:4173";
		assert.equal(isCrossOriginDeployment(), false, "a declared loopback origin is same-origin");
		// The project's own default mixes the published site with local servers, so
		// one remote entry is enough to require SameSite=None.
		process.env.FRONTEND_ORIGINS = "https://gjdos07.github.io, http://localhost:5500";
		assert.equal(isCrossOriginDeployment(), true, "a mixed list is cross-origin");
	} finally {
		if (previous === undefined) delete process.env.FRONTEND_ORIGINS;
		else process.env.FRONTEND_ORIGINS = previous;
	}
});

test("the bootstrap endpoint sets a cross-origin cookie and returns the token", async t => {
	const app = await mount();
	t.after(() => app.close());
	const csrf = await fetch(`${app.base}/api/owner/csrf`, { headers: { Origin: ORIGIN } });
	assert.equal(csrf.status, 200);
	const setCookie = csrf.headers.get("set-cookie") || "";
	assert.match(setCookie, /maridel_owner_csrf=/, "the CSRF cookie must be set");
	assert.match(setCookie, /SameSite=None/, "and must travel cross-origin");
	assert.match(setCookie, /Secure/, "and be Secure, which None requires");
	const body = await csrf.json();
	assert.equal(typeof body.csrf_token, "string", "the token must be returned in the body");
	assert.ok(body.csrf_token.length > 0);
	// The cookie value and the body value must match, which is the invariant
	// requireCsrf depends on.
	const cookieValue = /^[^=]+=([^;]*)/.exec(setCookie);
	assert.equal(decodeURIComponent(cookieValue[1]), body.csrf_token, "cookie and body must agree");
});

test("a correct password authenticates with the bootstrapped cookie and token", async t => {
	const previous = process.env.OWNER_PASSWORD_HASH;
	process.env.OWNER_PASSWORD_HASH = hashOwnerPassword(PASSWORD);
	process.env.OWNER_SESSION_SECRET = SECRET;
	try {
		const app = await mount();
		t.after(() => app.close());
		const good = await attemptLogin(app.base, PASSWORD);
		assert.equal(good.status, 200, `login must succeed: ${JSON.stringify(good.body).slice(0, 120)}`);
		assert.equal(good.body.authenticated, true);
		assert.equal(typeof good.body.csrf_token, "string", "login must return a session CSRF token");
	} finally {
		if (previous === undefined) delete process.env.OWNER_PASSWORD_HASH;
		else process.env.OWNER_PASSWORD_HASH = previous;
		delete process.env.OWNER_SESSION_SECRET;
	}
});

test("an incorrect password is rejected as invalid credentials, not a CSRF error", async t => {
	// This is the assertion that proves the token is arriving: if the CSRF cookie
	// were dropped the owner would see CSRF_INVALID instead, which is exactly how
	// the bug looked.
	const previous = process.env.OWNER_PASSWORD_HASH;
	process.env.OWNER_PASSWORD_HASH = hashOwnerPassword(PASSWORD);
	process.env.OWNER_SESSION_SECRET = SECRET;
	try {
		const app = await mount();
		t.after(() => app.close());
		const bad = await attemptLogin(app.base, "not-the-password");
		assert.equal(bad.status, 401);
		assert.equal(bad.body.code, "INVALID_OWNER_CREDENTIALS",
			"a wrong password must be reported as a credential error, never a CSRF error");
	} finally {
		if (previous === undefined) delete process.env.OWNER_PASSWORD_HASH;
		else process.env.OWNER_PASSWORD_HASH = previous;
		delete process.env.OWNER_SESSION_SECRET;
	}
});

test("a missing CSRF token is rejected", async t => {
	const app = await mount();
	t.after(() => app.close());
	const noToken = await attemptLogin(app.base, PASSWORD, { sendToken: false });
	assert.equal(noToken.status, 403);
	assert.equal(noToken.body.code, "CSRF_INVALID");
});

test("a missing CSRF cookie is rejected", async t => {
	const app = await mount();
	t.after(() => app.close());
	const noCookie = await attemptLogin(app.base, PASSWORD, { sendCookie: false });
	assert.equal(noCookie.status, 403, "a header without the matching cookie must be refused");
	assert.equal(noCookie.body.code, "CSRF_INVALID");
});

test("a mismatched token is rejected", async t => {
	const app = await mount();
	t.after(() => app.close());
	const csrf = await fetch(`${app.base}/api/owner/csrf`, { headers: { Origin: ORIGIN } });
	const setCookie = csrf.headers.get("set-cookie") || "";
	const cookieValue = /^[^=]+=([^;]*)/.exec(setCookie);
	const response = await fetch(`${app.base}/api/owner/login`, {
		method: "POST",
		headers: {
			Origin: ORIGIN, "Content-Type": "application/json",
			Cookie: `maridel_owner_csrf=${decodeURIComponent(cookieValue[1])}`,
			"X-CSRF-Token": "a-token-that-does-not-match",
		},
		body: JSON.stringify({ password: PASSWORD }),
	});
	assert.equal(response.status, 403, "cookie and header must be compared");
	assert.equal((await response.json()).code, "CSRF_INVALID");
});

test("an unauthenticated protected route is still refused", async t => {
	const app = await mount();
	t.after(() => app.close());
	const response = await fetch(`${app.base}/api/owner/orders`, { headers: { Origin: ORIGIN } });
	assert.equal(response.status, 401, "no session must not reach owner data");
	assert.equal((await response.json()).code, "OWNER_LOGIN_REQUIRED");
});

test("the dashboard bootstraps the token before submitting", () => {
	// The frontend must fetch /api/owner/csrf on load and store the token: a page
	// that never bootstraps has nothing to send.
	const fs = require("node:fs");
	const path = require("node:path");
	const script = fs.readFileSync(path.join(__dirname, "owner-dashboard.js"), "utf8");
	assert.match(script, /apiRequest\("\/api\/owner\/csrf"\)/, "the token must be bootstrapped");
	assert.match(script, /credentials: "include"/, "cookies must be sent with every request");
	assert.match(script, /"X-CSRF-Token": csrfToken/, "the token must be sent as X-CSRF-Token");
	assert.match(script, /if \(body\.csrf_token\) csrfToken = body\.csrf_token;/, "the token must be stored from the response");
});

// --- the stale-token bug -----------------------------------------------------
//
// THE BUG THESE GUARD AGAINST
//   The CSRF token is derived from the current session. Any request that ends the
//   session clears both cookies on the server, and the browser will not reveal
//   Set-Cookie to script, so a cached token silently goes stale. The next protected
//   request then sent a stale header against an empty cookie and requireCsrf
//   refused it with "A valid CSRF token is required." — which read like a broken
//   login form rather than an expired token.
//
//   Reproduced in Chrome: log in, change the password (which revokes every
//   session), then submit the login form again -> 403 CSRF_INVALID. Fixed by
//   discarding the token whenever a session ends and re-fetching it before a
//   protected request.

test("a protected request never goes out without a token", () => {
	// Line 56 used to read "... && csrfToken ? {...} : {}", so an empty token meant
	// the header was skipped entirely and the request was guaranteed to be refused.
	const fs = require("node:fs");
	const path = require("node:path");
	const script = fs.readFileSync(path.join(__dirname, "owner-dashboard.js"), "utf8");
	assert.match(script, /if \(needsToken && !csrfToken\) await bootstrapCsrfToken\(\);/,
		"a protected request must obtain a token before it is sent");
	assert.match(script, /const needsToken = Boolean\(options\.method && options\.method !== "GET"\);/,
		"the header must be attached for every non-GET method, not just POST");
	assert.ok(!/&& csrfToken \? \{ "X-CSRF-Token"/.test(script),
		"the header must not be conditional on the token being present");
});

test("the token is discarded when a session ends", () => {
	// Logout, password change and password reset all end the session and must each
	// re-arm the token, or the next login is refused.
	const fs = require("node:fs");
	const path = require("node:path");
	const script = fs.readFileSync(path.join(__dirname, "owner-dashboard.js"), "utf8");
	const endingPoints = [
		[/apiRequest\("\/api\/owner\/logout"[\s\S]{0,400}?invalidateCsrfToken\(\)/, "logout"],
		[/apiRequest\("\/api\/owner\/password"[\s\S]{0,600}?invalidateCsrfToken\(\)/, "password change"],
		[/apiRequest\("\/api\/owner\/password\/reset"[\s\S]{0,600}?invalidateCsrfToken\(\)/, "password reset"],
	];
	for (const [pattern, label] of endingPoints) {
		assert.match(script, pattern, `${label} must invalidate the cached token`);
	}
});

test("a refused token is re-fetched and the request retried once", () => {
	const fs = require("node:fs");
	const path = require("node:path");
	const script = fs.readFileSync(path.join(__dirname, "owner-dashboard.js"), "utf8");
	assert.match(script, /CSRF_INVALID/, "the client must recognise a CSRF refusal");
	// Exactly one retry: a loop would hide a genuine rejection.
	const retries = (script.match(/await send\(\{ path, options, needsToken \}\)/g) || []).length;
	assert.equal(retries, 2, "the request is sent at most twice: once, plus one retry");
});
