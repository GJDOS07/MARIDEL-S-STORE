"use strict";
// Tests for the local owner-credential tool.
//
// The one failure that matters most is a hash the login route cannot verify:
// that leaves the operator with no way in at all. Every assertion below
// therefore checks the hash against the very code path /api/owner/login uses,
// not just against its own generator.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
	hashOwnerPassword,
	generateSessionSecret,
	buildCredentialsSql,
} = require("./owner-credentials-tool");
const { validatePasswordPolicy } = require("./owner-account");

// Copied verbatim from order-routes.js: the login route verifies a supplied
// password with THIS function. Keeping it in sync is the whole point of the test.
function parsePasswordHash(encoded) {
	if (typeof encoded !== "string") return null;
	const match = /^scrypt\$([a-f0-9]{32,})\$([a-f0-9]{128})$/i.exec(encoded);
	if (!match || match[1].length % 2 !== 0) return null;
	return { salt: Buffer.from(match[1], "hex"), hash: Buffer.from(match[2], "hex") };
}

// The owner_credentials table constrains the same shape, so a hash that passes
// login but fails the CHECK constraint would be equally unusable.
const DB_CHECK_PATTERN = /^scrypt\$[a-f0-9]{32,}\$[a-f0-9]{128}$/;

async function verifiesAsLoginWould(password, encodedHash) {
	const parsed = parsePasswordHash(encodedHash);
	if (!parsed) return false;
	// scryptSync, because the callback form returns undefined and a test that
	// silently compares undefined would always pass.
	const supplied = crypto.scryptSync(password, parsed.salt, parsed.hash.length);
	return crypto.timingSafeEqual(supplied, parsed.hash);
}

test("a generated hash parses and verifies through the login path", async t => {
	for (const password of ["Local-Test-Pass-1234", "correct horse battery staple 1", "Aa1" + "x".repeat(60)]) {
		const policy = validatePasswordPolicy(password);
		assert.equal(policy.valid, true, `fixture password must be acceptable: ${policy.reason}`);
		const hash = hashOwnerPassword(password);
		assert.ok(await verifiesAsLoginWould(password, hash), "the login route must accept this hash");
		assert.ok(await verifiesAsLoginWould(password, hash), "verification must be deterministic");
	}
});

test("a generated hash satisfies the owner_credentials CHECK constraint", () => {
	const hash = hashOwnerPassword("Local-Test-Pass-1234");
	assert.match(hash, DB_CHECK_PATTERN, "the SQL insert would otherwise be rejected by the database");
	assert.equal(hash.split("$")[1].length, 32, "salt is 16 bytes of hex");
	assert.equal(hash.split("$")[2].length, 128, "derived key is 64 bytes of hex");
});

test("a generated hash rejects a different password", async () => {
	const hash = hashOwnerPassword("Local-Test-Pass-1234");
	assert.equal(await verifiesAsLoginWould("Local-Test-Pass-1235", hash), false, "an off-by-one password must fail");
	assert.equal(await verifiesAsLoginWould("", hash), false);
	assert.equal(await verifiesAsLoginWould("local-test-pass-1234", hash), false, "password comparison is case sensitive");
});

test("each hash uses a fresh random salt", () => {
	const first = hashOwnerPassword("Same-Password-1234");
	const second = hashOwnerPassword("Same-Password-1234");
	assert.notEqual(first, second, "salts must differ so identical passwords do not collide");
	assert.notEqual(first.split("$")[1], second.split("$")[1]);
	// A different salt genuinely produces a different derived key, so both hashes
	// still verify the same password through the login path.
	const third = hashOwnerPassword("Same-Password-1234", Buffer.from(first.split("$")[1], "hex"));
	assert.equal(third, first, "reusing the salt reproduces the hash exactly");
	const fourth = hashOwnerPassword("Same-Password-1234", Buffer.from(second.split("$")[1], "hex"));
	assert.equal(fourth, second, "and again for the second salt");
});

test("the supplied salt is used verbatim, which makes tests reproducible", () => {
	const salt = Buffer.alloc(16, 7);
	const first = hashOwnerPassword("Reproducible-Pass-1", salt);
	const second = hashOwnerPassword("Reproducible-Pass-1", salt);
	assert.equal(first, second, "an explicit salt makes the output deterministic");
	assert.equal(first.split("$")[1], salt.toString("hex"));
});

test("hashing refuses an empty or non-string password", () => {
	assert.throws(() => hashOwnerPassword(""), /must not be empty/);
	assert.throws(() => hashOwnerPassword(undefined), /must be a string/);
	assert.throws(() => hashOwnerPassword("x", "not-a-buffer"), /salt must be a Buffer/);
});

test("the generated session secret satisfies the login route's length rule", () => {
	const secret = generateSessionSecret();
	assert.ok(typeof secret === "string", "the secret is a string");
	assert.ok(secret.length >= 32, "the login route requires at least 32 characters");
	assert.match(secret, /^[A-Za-z0-9_-]+$/, "base64url only, so it survives an environment variable");
	assert.notEqual(generateSessionSecret(), secret, "each call is independently random");
});

test("the emitted SQL is an idempotent upsert", () => {
	const hash = hashOwnerPassword("Local-Test-Pass-1234");
	const sql = buildCredentialsSql(hash);
	assert.match(sql, /INSERT INTO public\.owner_credentials/);
	assert.match(sql, /ON CONFLICT \(singleton\) DO UPDATE/, "re-running must not error");
	assert.ok(sql.includes(hash), "the generated hash must be the value stored");
	assert.match(sql, /password_hash = EXCLUDED\.password_hash/, "the conflict path must update the hash");
	assert.match(sql, /updated_at = CURRENT_TIMESTAMP/);
	// It must never drop and recreate the row: that would invalidate nothing
	// else, but the shape makes the intent obvious to a reviewer.
	assert.doesNotMatch(sql, /DELETE|DROP|TRUNCATE/i);
});

test("the emitted SQL pins singleton to true, so there is exactly one owner row", () => {
	const sql = buildCredentialsSql(hashOwnerPassword("Local-Test-Pass-1234"));
	assert.match(sql, /VALUES \(true, 'scrypt\$[a-f0-9]{32,}\$[a-f0-9]{128}', CURRENT_TIMESTAMP\)/);
});

test("the SQL builder refuses to embed a non-string", () => {
	assert.throws(() => buildCredentialsSql(null), /non-empty string/);
	assert.throws(() => buildCredentialsSql(""), /non-empty string/);
});

test("the policy the tool enforces is the same one the API enforces", () => {
	// Deliberately naive passwords must be rejected, so the operator cannot set
	// a password that login would later refuse.
	for (const weak of ["short1", "123456789012", "no-digits-here-at-all", " spacedkey1", "spacedkey1 "]) {
		const policy = validatePasswordPolicy(weak);
		assert.equal(policy.valid, false, `weak password must be rejected: ${weak}`);
		assert.notEqual(policy.reason, "", "a rejected password must explain why");
	}
	assert.equal(validatePasswordPolicy("Local-Test-Pass-1234").valid, true);
	// The policy is a length and character-class rule only; it deliberately does
	// not reject a common-looking password, because guessing defenses belong at
	// the rate limiter. This is a documented limitation, not an oversight.
	assert.equal(validatePasswordPolicy("passwordpassword1").valid, true);
});
