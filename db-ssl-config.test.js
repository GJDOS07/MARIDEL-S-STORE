"use strict";
// Regression tests for the database SSL/TLS configuration.
//
// Finding F-001: server.js previously created its production Pool with
// `ssl: { rejectUnauthorized: false }`, which disabled TLS certificate
// verification and allowed MITM attacks. The fix sets `ssl: true` so
// certificates are validated via Node's default CA store.
//
// These tests guard both server.js and migrate-owner-tables.js against
// any regression that weakens certificate verification.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;

function readSource(name) {
	return fs.readFileSync(path.join(root, name), "utf8");
}

const FORBIDDEN_PATTERN = /rejectUnauthorized:\s*false/;

test("server.js does not disable TLS certificate verification", () => {
	const source = readSource("server.js");
	// The insecure pattern must never appear.
	assert.equal(FORBIDDEN_PATTERN.test(source), false,
		"server.js must not contain ssl.rejectUnauthorized: false");
	// The production Pool must explicitly enable SSL verification.
	assert.match(source, /ssl:\s*true/,
		"server.js must configure ssl: true for the production Pool");
});

test("migrate-owner-tables.js does not disable TLS certificate verification", () => {
	const source = readSource("migrate-owner-tables.js");
	assert.equal(FORBIDDEN_PATTERN.test(source), false,
		"migrate-owner-tables.js must not contain ssl.rejectUnauthorized: false");
	assert.match(source, /ssl:\s*true/,
		"migrate-owner-tables.js must configure ssl: true");
});

test("neither file falls back to a different unverified SSL option", () => {
	// Catch accidental substitutions like `ssl: { ca: ... }` without verification,
	// or `ssl: process.env.NODE_ENV !== "production"`.
	for (const file of ["server.js", "migrate-owner-tables.js"]) {
		const source = readSource(file);
		const sslMatch = /ssl:\s*([^\n,]+)/.exec(source);
		if (sslMatch) {
			const value = sslMatch[1].trim();
			assert.equal(/rejectUnauthorized/.test(value), false,
				`${file}: ssl value must not mention rejectUnauthorized`);
			// `ssl: true` is the only form accepted.
			assert.equal(value, "true",
				`${file}: ssl must be exactly true, got "${value}"`);
		}
	}
});
