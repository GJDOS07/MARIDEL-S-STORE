"use strict";
// Tests for the origin allow-list that gates the API.
//
// The failure this file exists to prevent is a regression in the opposite
// direction of the usual one: too permissive in production. The local-dev
// loopback allowance is deliberately unreachable from the public internet, so
// it must never accidentally switch on when NODE_ENV is "production".

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	createOriginChecker,
	defaultOriginsFor,
	isLoopbackOrigin,
	PRODUCTION_FRONTEND_ORIGIN,
} = require("./allowed-origins");

test("production accepts only the configured frontend origin", () => {
	const check = createOriginChecker({
		allowedOrigins: [PRODUCTION_FRONTEND_ORIGIN],
		isProduction: true,
	});
	assert.equal(check(PRODUCTION_FRONTEND_ORIGIN), true, "the storefront must work");
	assert.equal(check("https://evil.example"), false, "an unrelated public origin must be refused");
	assert.equal(check("https://gjdos07.github.io.evil.example"), false, "a look-alike host must be refused");
	assert.equal(check("http://gjdos07.github.io"), false, "plain http on the allowed host must be refused");
});

test("production never accepts loopback, on any port", () => {
	const check = createOriginChecker({
		allowedOrigins: [PRODUCTION_FRONTEND_ORIGIN],
		isProduction: true,
	});
	for (const origin of ["http://localhost:3000", "http://localhost:4173", "http://127.0.0.1:5500"]) {
		assert.equal(check(origin), false, `loopback must be refused in production: ${origin}`);
	}
});

test("the local-dev allowance is limited to loopback", () => {
	const check = createOriginChecker({
		allowedOrigins: defaultOriginsFor({ isProduction: false }),
		isProduction: false,
	});
	for (const port of [80, 3000, 4173, 5500, 8000, 5173, 65535]) {
		assert.equal(check(`http://localhost:${port}`), true, `localhost:${port} must be allowed for local dev`);
		assert.equal(check(`http://127.0.0.1:${port}`), true, `127.0.0.1:${port} must be allowed for local dev`);
	}
	// A hostname that merely contains "localhost" is not loopback.
	assert.equal(check("http://localhost.evil.example"), false);
	assert.equal(check("http://notlocalhost:4173"), false);
	assert.equal(check("http://127.0.0.1.evil.example"), false);
	assert.equal(check("http://evil.example"), false);
});

test("an explicitly configured origin list wins over the loopback allowance", () => {
	const check = createOriginChecker({
		allowedOrigins: ["https://staging.example"],
		isProduction: false,
	});
	assert.equal(check("https://staging.example"), true);
	assert.equal(check("http://localhost:4173"), true, "loopback still works in dev");
	assert.equal(check("https://gjdos07.github.io"), false, "the GitHub Pages origin is not automatic when the list is set");
});

test("a missing origin is refused, matching the previous behaviour", () => {
	for (const isProduction of [true, false]) {
		const check = createOriginChecker({
			allowedOrigins: [PRODUCTION_FRONTEND_ORIGIN],
			isProduction,
		});
		assert.equal(check(undefined), false);
		assert.equal(check(""), false);
	}
});

test("the default origin lists differ between environments", () => {
	const production = defaultOriginsFor({ isProduction: true });
	assert.deepEqual(production, [PRODUCTION_FRONTEND_ORIGIN], "production allows one origin");
	assert.ok(!production.some(origin => isLoopbackOrigin(origin)), "and it is not loopback");

	const development = defaultOriginsFor({ isProduction: false });
	assert.ok(development.includes(PRODUCTION_FRONTEND_ORIGIN), "development keeps the storefront");
	assert.ok(development.some(origin => origin.startsWith("http://localhost:")), "and includes a local host");
});

test("server.js keeps the CORS methods the owner dashboard needs", () => {
	// The CORS methods list sits in server.js, which cannot be required without
	// a DATABASE_URL, so read the file. PATCH and DELETE are used by product edit
	// and delete; without them the browser preflight fails and those features
	// cannot work at all.
	const fs = require("node:fs");
	const path = require("node:path");
	const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
	const match = /methods:\s*\[([^\]]+)\]/.exec(source);
	assert.ok(match, "server.js must configure the CORS methods");
	const methods = match[1].split(",").map(entry => entry.trim().replace(/"/g, ""));
	for (const required of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]) {
		assert.ok(methods.includes(required), `CORS must allow ${required}`);
	}
	// The owner API relies on a CSRF header, so it must stay preflight-allowed.
	assert.match(source, /allowedHeaders[\s\S]{0,120}X-CSRF-Token/, "X-CSRF-Token must be an allowed header");
	assert.match(source, /credentials:\s*true/, "cookies must be allowed across origins");
});
