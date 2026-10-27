"use strict";
// Tests for the owner authentication configuration check.
//
// The failure this guards against is a silent one: the service starts happily
// whether or not owner login can work, so the only symptom is a dashboard that
// answers OWNER_AUTH_NOT_CONFIGURED. These tests pin the classification of every
// real-world state, including the two that look identical from outside but need
// different remedies: an unset variable and a correctly generated hash that was
// pasted with a stray newline.
//
// All fixtures are synthetic. No real password, hash, or secret is used.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
	classifyPasswordHash,
	classifySessionSecret,
	describeOwnerAuthConfig,
	isOwnerAuthConfigured,
	startupNoticeLines,
	MIN_SESSION_SECRET_LENGTH,
} = require("./owner-config-check");
const { hashOwnerPassword } = require("./owner-credentials-tool");

// A synthetic hash produced by the shipped generator, so the tests exercise the
// real generator and the real classifier together.
const VALID_HASH = hashOwnerPassword("Synthetic-Config-Check-9981");
const VALID_SECRET = crypto.randomBytes(32).toString("base64url");

test("a hash produced by the shipped generator is classified valid", () => {
	// This is the compatibility guarantee: the value the tool prints must be a
	// value the classifier, and therefore login, accepts.
	assert.equal(classifyPasswordHash(VALID_HASH), "valid");
	assert.equal(isOwnerAuthConfigured({ passwordHash: VALID_HASH, sessionSecret: VALID_SECRET }), true);
});

test("a missing or empty hash is reported as missing, not malformed", () => {
	// The remedy differs, so the distinction has to be preserved: unset means
	// generate one, malformed means the value is wrong.
	assert.equal(classifyPasswordHash(undefined), "missing");
	assert.equal(classifyPasswordHash(null), "missing");
	assert.equal(classifyPasswordHash(""), "missing");
	assert.equal(classifyPasswordHash(42), "missing");
});

test("a hash pasted with stray whitespace is reported separately", () => {
	// A correctly generated hash with a trailing newline is the most likely real
	// cause of a still-broken login after a value was pasted into a dashboard.
	assert.equal(classifyPasswordHash(`${VALID_HASH}\n`), "has-whitespace");
	assert.equal(classifyPasswordHash(` ${VALID_HASH}`), "has-whitespace");
	assert.equal(classifyPasswordHash(`${VALID_HASH} `), "has-whitespace");
	assert.equal(classifyPasswordHash(`\t${VALID_HASH}\t`), "has-whitespace");
});

test("hashes that are wrong in shape are reported as malformed", () => {
	const malformed = [
		"MyStorePassword123",
		"$2b$10$" + "x".repeat(53),
		"f".repeat(64),
		VALID_HASH.slice(0, -1),                       // one character short
		VALID_HASH + "a",                              // one character long
		VALID_HASH.replace("$", "|"),
		"scrypt$" + "a".repeat(30) + "$" + "a".repeat(128),   // salt under 32 hex
		"scrypt$" + "a".repeat(31) + "$" + "a".repeat(128),   // odd-length salt
	];
	for (const value of malformed) {
		assert.equal(classifyPasswordHash(value), "malformed", `must be malformed: ${value.slice(0, 24)}...`);
	}
});

test("a session secret is validated by length, not by content", () => {
	assert.equal(classifySessionSecret(undefined), "missing");
	assert.equal(classifySessionSecret(""), "missing");
	assert.equal(classifySessionSecret("x".repeat(MIN_SESSION_SECRET_LENGTH - 1)), "too-short");
	assert.equal(classifySessionSecret("x".repeat(MIN_SESSION_SECRET_LENGTH)), "valid");
	assert.equal(classifySessionSecret(VALID_SECRET), "valid");
});

test("isOwnerAuthConfigured requires both to be usable", () => {
	assert.equal(isOwnerAuthConfigured({ passwordHash: VALID_HASH, sessionSecret: VALID_SECRET }), true);
	assert.equal(isOwnerAuthConfigured({ passwordHash: VALID_HASH, sessionSecret: "short" }), false);
	assert.equal(isOwnerAuthConfigured({ passwordHash: "nope", sessionSecret: VALID_SECRET }), false);
	assert.equal(isOwnerAuthConfigured({}), false, "an empty config is not configured");
	assert.equal(isOwnerAuthConfigured(), false, "no arguments is not configured");
});

test("the problem list names the remedy for each failing value", () => {
	const described = describeOwnerAuthConfig({
		passwordHash: `${VALID_HASH}\n`,
		sessionSecret: "x".repeat(10),
	});
	assert.equal(described.passwordHash, "has-whitespace");
	assert.equal(described.sessionSecret, "too-short");
	assert.equal(described.problems.length, 2, "each broken value adds one problem");
	assert.match(described.problems[0], /whitespace/i, "the hash problem explains the whitespace");
	assert.match(described.problems[1], /SESSION_SECRET/, "the secret problem names the variable");
	assert.match(described.problems[1], /shorter than 32 characters/i, "and says why");
	assert.equal(
		describeOwnerAuthConfig({ passwordHash: VALID_HASH, sessionSecret: VALID_SECRET }).problems.length,
		0,
		"a working configuration has no problems",
	);
});

test("the startup notice never echoes a credential", () => {
	// Anything printed at startup lands in a log that can be read by anyone with
	// log access, so no value, length, or fragment may appear in the output.
	// The probe values are chosen so they are not substrings of the words the
	// notice itself uses, which would make the assertion meaningless.
	const probeSecret = "zq".repeat(20);
	for (const passwordHash of [undefined, VALID_HASH, `${VALID_HASH}\n`]) {
		for (const sessionSecret of [undefined, "wv".repeat(20), VALID_SECRET]) {
			const notice = startupNoticeLines({ passwordHash, sessionSecret }).join("\n");
			if (typeof passwordHash === "string") {
				assert.ok(!notice.includes(passwordHash), "the hash must never appear in the notice");
			}
			if (typeof sessionSecret === "string") {
				assert.ok(!notice.includes(sessionSecret), "the secret must never appear in the notice");
			}
			// Not even a fragment that could be used to recognise a value.
			assert.ok(!notice.includes("scrypt$"), "the hash must not be partially revealed");
		}
	}
	void probeSecret;
});

test("the notice states the outcome plainly", () => {
	const ready = startupNoticeLines({ passwordHash: VALID_HASH, sessionSecret: VALID_SECRET }).join("\n");
	assert.match(ready, /password hash valid/i);
	assert.match(ready, /session secret valid/i);

	const broken = startupNoticeLines({ passwordHash: undefined, sessionSecret: undefined }).join("\n");
	assert.match(broken, /password hash missing/i);
	assert.match(broken, /session secret missing/i);
	assert.match(broken, /Owner login disabled/, "a broken configuration must say so");
});

test("the classifier uses the same parser the login route uses", () => {
	// The check is only trustworthy if it cannot drift from parsePasswordHash, so
	// verify the exact boundary both share rather than trusting a copy of the
	// rule.
	const { parsePasswordHash } = require("./order-routes");
	const boundary = [
		"scrypt$" + "a".repeat(32) + "$" + "a".repeat(128),   // minimum salt, exact key
		"scrypt$" + "a".repeat(33) + "$" + "a".repeat(128),   // odd salt length
		"scrypt$" + "a".repeat(64) + "$" + "a".repeat(128),   // long salt, still valid
	];
	for (const value of boundary) {
		assert.equal(
			classifyPasswordHash(value) === "valid",
			parsePasswordHash(value) !== null,
			`classifier must agree with parsePasswordHash for ${value.slice(0, 20)}...`,
		);
	}
});
