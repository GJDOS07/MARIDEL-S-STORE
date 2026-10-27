"use strict";
// Tests that the served dashboard page carries every password toggle and that
// none of the credential fields lost its masking.
//
// owner-dashboard.js runs in the browser and this project has no DOM harness, so
// these exercise the real HTTP surface of serve-local.js rather than simulating
// the DOM: the page is fetched and its markup checked, which is what a future
// edit would actually break.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4291;

// Extracts the full opening tag carrying a given id, so attribute order does not
// affect the assertion.
function tagWithId(markup, id) {
	const at = markup.indexOf('id="' + id + '"');
	if (at === -1) return "";
	const start = markup.lastIndexOf("<", at);
	const end = markup.indexOf(">", at);
	return start === -1 || end === -1 ? "" : markup.slice(start, end + 1);
}

async function startStaticServer() {
	const site = spawn(process.execPath, [path.join(__dirname, "serve-local.js")], {
		env: { ...process.env, SITE_PORT: String(PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	site.stdout.on("data", c => { output += c.toString("utf8"); });
	site.stderr.on("data", c => { output += c.toString("utf8"); });
	const base = `http://127.0.0.1:${PORT}`;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		try { if ((await fetch(base)).status === 200) return { base, site, output }; } catch {}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`static server did not start: ${output.slice(0, 200)}`);
}

const PASSWORD_FIELDS = [
	["ownerPassword", "togglePassword"],
	["currentPassword", "toggleCurrentPassword"],
	["newPassword", "toggleNewPassword"],
	["confirmPassword", "toggleConfirmPassword"],
	["resetNewPassword", "toggleResetNewPassword"],
	["resetConfirmPassword", "toggleResetConfirmPassword"],
];

test("the served dashboard ships every password field masked with its own toggle", async t => {
	const server = await startStaticServer();
	t.after(() => {
		server.site.kill("SIGTERM");
		return new Promise(resolve => setTimeout(resolve, 400));
	});

	const html = await (await fetch(`${server.base}/owner-dashboard.html`)).text();
	const js = await (await fetch(`${server.base}/owner-dashboard.js`)).text();

	for (const [inputId, buttonId] of PASSWORD_FIELDS) {
		assert.match(tagWithId(html, inputId), /type="password"/, `${inputId} must be masked`);
		assert.match(tagWithId(html, buttonId), /type="button"/, `${buttonId} must not submit the form`);
		assert.match(tagWithId(html, buttonId), /aria-pressed="false"/, `${buttonId} must start hidden`);
		assert.match(tagWithId(html, buttonId), /aria-label="Show password"/, `${buttonId} needs a label`);
	}
	assert.ok(js.includes("function wirePasswordToggle"), "the shared helper must ship");
});

test("the served dashboard embeds no plaintext credential", async t => {
	const server = await startStaticServer();
	t.after(() => {
		server.site.kill("SIGTERM");
		return new Promise(resolve => setTimeout(resolve, 400));
	});
	const js = await (await fetch(`${server.base}/owner-dashboard.js`)).text();

	// A quoted string assigned to a variable is the only shape a hardcoded
	// credential could take. The patterns narrow on the assignment, so a CSS
	// class named "hidden-tag" is not misread as a secret.
	const quoted = [...js.matchAll(/=\s*"[^"]{12,}"\s*;/g)].map(m => m[0]);
	const credentialShaped = quoted.filter(c =>
		/scrypt\$|api[_-]?key\s*=|session[_-]?secret\s*=|password\s*=\s*"/i.test(c));
	assert.deepEqual(credentialShaped, [], "no hardcoded credential may be embedded in the script");
});

test("the served dashboard keeps the confirmation hint and the auth contract", async t => {
	const server = await startStaticServer();
	t.after(() => {
		server.site.kill("SIGTERM");
		return new Promise(resolve => setTimeout(resolve, 400));
	});
	const html = await (await fetch(`${server.base}/owner-dashboard.html`)).text();
	const js = await (await fetch(`${server.base}/owner-dashboard.js`)).text();

	// The auth wiring is untouched by the UI work: login still posts a password.
	assert.match(js, /apiRequest\("\/api\/owner\/login"/);
	assert.match(js, /JSON\.stringify\(\{ password: document\.getElementById\("ownerPassword"\)\.value \}\)/);
	assert.match(js, /apiRequest\("\/api\/owner\/password"/);
	// The hint exists and reports only agreement.
	assert.match(html, /id="passwordMatch"/);
	assert.match(js, /next === confirm/);
	// No persisted credential anywhere in the page.
	assert.ok(!/localStorage|sessionStorage/.test(js), "credentials must not be kept in browser storage");
});
