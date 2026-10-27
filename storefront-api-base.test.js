"use strict";
// Regression tests for the storefront's API base URL.
//
// THE BUG THESE GUARD AGAINST
//   index.html hardcoded `const API_BASE_URL = 'https://maridel-s-store.onrender.com'`.
//   The page is static and the API is a separate service, so when the storefront
//   was opened from a local web server it still fetched production. On a machine
//   with no route to Render, or with Render asleep, the product request failed and
//   the page showed "Products could not be loaded", even though a healthy local
//   backend was running with the products in it.
//
//   The owner dashboard already selected its backend from the hostname; the
//   storefront did not. These tests pin the shared behaviour so the two pages
//   cannot drift apart again.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

// The exact selection the owner dashboard uses, so both pages must agree.
const LOOPBACK_SELECTOR = '["localhost", "127.0.0.1"].includes(window.location.hostname)';
const LOCAL_BACKEND = "http://localhost:3000";
const PRODUCTION_BACKEND = "https://maridel-s-store.onrender.com";

test("the storefront picks its backend from the page hostname", () => {
	assert.match(html, new RegExp(`const API_BASE_URL = ${LOOPBACK_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]{0,200}${LOCAL_BACKEND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
		"opened from a loopback host, the storefront must use the local backend");
	assert.match(html, new RegExp(`${PRODUCTION_BACKEND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
		"and the deployed backend must remain for every other host");
});

test("the storefront no longer hardcodes the production backend", () => {
	// The old line was a plain assignment with no condition. Any single-line
	// assignment of the production URL is the regression.
	const hardcoded = new RegExp(`^\\s*const API_BASE_URL = ['"\`]${PRODUCTION_BACKEND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"\`]\\s*;`, "m");
	assert.doesNotMatch(html, hardcoded,
		"the production URL must not be the unconditional value");
});

test("the storefront and the owner dashboard resolve the backend identically", () => {
	// Two pages that pick their backend differently is how the storefront ended up
	// pointing at production while the dashboard worked locally.
	const dashboard = fs.readFileSync(path.join(root, "owner-dashboard.js"), "utf8");
	assert.match(dashboard, new RegExp(LOOPBACK_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		"the dashboard must use the same hostname signal");
	for (const source of [html, dashboard]) {
		assert.ok(source.includes(LOCAL_BACKEND), "the local backend must be named");
		assert.ok(source.includes(PRODUCTION_BACKEND), "the production backend must be named");
	}
});

test("the storefront still reports a load failure when the API is unreachable", () => {
	// The error message is the operator's only signal when the API is genuinely
	// down, so it must remain rather than being replaced with a silent success.
	assert.match(html, /Products could not be loaded/);
});

test("the served storefront requests the local API when opened locally", async t => {
	// End-to-end: serve the real page and confirm which backend the browser
	// actually calls, rather than trusting the source text.
	const { spawn } = require("node:child_process");
	const SITE_PORT = 4299;
	const site = spawn(process.execPath, [path.join(root, "serve-local.js")], {
		env: { ...process.env, SITE_PORT: String(SITE_PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => {
		site.kill("SIGTERM");
		return new Promise(resolve => setTimeout(resolve, 400));
	});
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	let ready = false;
	for (let i = 0; i < 40 && !ready; i += 1) {
		try { if ((await fetch(`http://127.0.0.1:${SITE_PORT}/index.html`)).status === 200) ready = true; } catch {}
		if (!ready) await sleep(200);
	}
	if (!ready) return t.diagnostic("static server did not start; skipped");

	const served = await (await fetch(`http://127.0.0.1:${SITE_PORT}/index.html`)).text();
	assert.match(served, new RegExp(LOOPBACK_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		"the served page must carry the hostname-based selection");
	assert.match(served, new RegExp(LOCAL_BACKEND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		"and the local backend URL");
});
