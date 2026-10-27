"use strict";
// Tests for the .env writer used by `npm run set-owner-password -- --write-env`.
//
// The failure this guards against is losing DATABASE_URL. Every other line in a
// working .env has to survive byte-for-byte, because a silently truncated
// connection string means the backend will not start and the storefront goes
// down, which is far worse than a login that does not work yet.
//
// No real credentials appear here: the fixtures are synthetic strings.

const test = require("node:test");
const assert = require("node:assert/strict");

const { updateEnvFile } = require("./owner-credentials-tool");

const HASH = "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128);
const SECRET = "c".repeat(43);

test("every other line survives byte-for-byte", () => {
	const original = [
		"# local environment",
		"DATABASE_URL=postgres://user:synthetic@localhost:5432/maridel",
		"FRONTEND_ORIGINS=https://gjdos07.github.io",
		"",
	].join("\n");
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.ok(result.content.includes("DATABASE_URL=postgres://user:synthetic@localhost:5432/maridel"));
	assert.ok(result.content.includes("FRONTEND_ORIGINS=https://gjdos07.github.io"));
	assert.ok(result.content.includes("# local environment"));
	assert.ok(!result.content.includes("\n\n\n"), "no extra blank lines are introduced");
});

test("a missing file is created with just the new keys", () => {
	const result = updateEnvFile("", { OWNER_PASSWORD_HASH: HASH, OWNER_SESSION_SECRET: SECRET });
	assert.equal(result.replaced, 0);
	assert.equal(result.appended, 2);
	assert.equal(result.content, `OWNER_PASSWORD_HASH=${HASH}\nOWNER_SESSION_SECRET=${SECRET}\n`);
});

test("an existing key is replaced, not duplicated", () => {
	const original = [
		"DATABASE_URL=postgres://localhost:5432/db",
		"OWNER_PASSWORD_HASH=scrypt$old$old",
		"OWNER_SESSION_SECRET=old-secret",
		"NODE_ENV=development",
	].join("\n") + "\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.equal(result.replaced, 1);
	assert.equal(result.appended, 0);
	assert.equal((result.content.match(/^OWNER_PASSWORD_HASH=/gm) || []).length, 1, "no duplicate key");
	assert.ok(result.content.includes(`OWNER_PASSWORD_HASH=${HASH}`));
	assert.ok(!result.content.includes("scrypt$old$old"), "the old value is gone");
	// Untouched keys keep their place.
	assert.ok(result.content.includes("OWNER_SESSION_SECRET=old-secret"));
	assert.ok(result.content.includes("NODE_ENV=development"));
	assert.ok(result.content.includes("DATABASE_URL=postgres://localhost:5432/db"));
});

test("an existing session secret is preserved when it is not being replaced", () => {
	// Reusing an existing secret avoids signing the owner out for no reason.
	const original = "OWNER_SESSION_SECRET=existing-secret-value\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.ok(result.content.includes("OWNER_SESSION_SECRET=existing-secret-value"));
	assert.ok(result.content.includes(`OWNER_PASSWORD_HASH=${HASH}`));
});

test("CRLF line endings are preserved", () => {
	// The project is developed on Windows, so .env may legitimately use CRLF and
	// rewriting it to LF would churn the file.
	const original = "DATABASE_URL=postgres://localhost:5432/db\r\n\r\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.ok(result.content.includes("\r\n"), "CRLF must be preserved");
	assert.ok(!/(?<!\r)\n/.test(result.content.replace(`${HASH}\r\n`, "")), "no bare LF introduced");
});

test("LF line endings are preserved", () => {
	const original = "DATABASE_URL=postgres://localhost:5432/db\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.ok(!result.content.includes("\r\n"), "LF must stay LF");
});

test("a trailing newline is preserved, and a missing one is not added", () => {
	assert.ok(updateEnvFile("A=1\n", { OWNER_PASSWORD_HASH: HASH }).content.endsWith("\n"));
	assert.ok(!updateEnvFile("A=1", { OWNER_PASSWORD_HASH: HASH }).content.endsWith("\n"));
});

test("a value containing a newline is refused before anything is written", () => {
	// A newline inside the value would truncate the entry, which is the exact
	// bug this function exists to prevent.
	assert.throws(() => updateEnvFile("A=1\n", { OWNER_PASSWORD_HASH: `${HASH}\n` }), /must not contain a newline/);
	assert.throws(() => updateEnvFile("A=1\n", { OWNER_PASSWORD_HASH: HASH.replace("$", "\n") }), /must not contain a newline/);
});

test("an empty value or a bad key name is refused", () => {
	assert.throws(() => updateEnvFile("A=1\n", { OWNER_PASSWORD_HASH: "" }), /non-empty string/);
	assert.throws(() => updateEnvFile("A=1\n", { "bad-key": HASH }), /invalid key name/);
	assert.throws(() => updateEnvFile("A=1\n", { "1BAD": HASH }), /invalid key name/);
});

test("keys with surrounding whitespace around the equals sign are still replaced", () => {
	// dotenv accepts `KEY = value`, so the writer must recognise it too.
	const original = "DATABASE_URL=x\nOWNER_PASSWORD_HASH = old\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.equal((result.content.match(/^\s*OWNER_PASSWORD_HASH\s*=/gm) || []).length, 1);
	assert.ok(!result.content.includes("old"), "the stale value is removed");
	assert.ok(result.content.includes("DATABASE_URL=x"));
});

test("duplicate keys are all removed so dotenv cannot resolve them ambiguously", () => {
	// dotenv keeps the FIRST occurrence, so leaving a stale first copy behind
	// would make the update silently ineffective.
	const original = "OWNER_PASSWORD_HASH=first\nOWNER_PASSWORD_HASH=second\nDATABASE_URL=x\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.equal((result.content.match(/^OWNER_PASSWORD_HASH=/gm) || []).length, 1, "all copies removed");
	assert.ok(result.content.includes(`OWNER_PASSWORD_HASH=${HASH}`));
	assert.ok(!result.content.includes("first"), "the value dotenv would have used is gone");
});

test("a similar key name is not mistaken for the target", () => {
	// OWNER_PASSWORD_HASH_OLD must not be replaced when OWNER_PASSWORD_HASH is
	// the target: the regex matches the whole key name.
	const original = "OWNER_PASSWORD_HASH_OLD=keep-me\nOWNER_PASSWORD_HASH=replace-me\n";
	const result = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	assert.ok(result.content.includes("OWNER_PASSWORD_HASH_OLD=keep-me"), "the similarly named key survives");
	assert.ok(result.content.includes(`OWNER_PASSWORD_HASH=${HASH}`));
	assert.ok(!result.content.includes("replace-me"));
});

test("re-running the same update is a no-op", () => {
	const original = "DATABASE_URL=x\n";
	const first = updateEnvFile(original, { OWNER_PASSWORD_HASH: HASH });
	const second = updateEnvFile(first.content, { OWNER_PASSWORD_HASH: HASH });
	assert.equal(second.content, first.content, "running twice must not duplicate or reorder");
});

test("the update is atomic in content: no partial state on refusal", () => {
	// A rejected update must leave the original untouched, never a half-written
	// file where DATABASE_URL has already been dropped.
	const original = "DATABASE_URL=x\n";
	assert.throws(() => updateEnvFile(original, {
		OWNER_PASSWORD_HASH: HASH,
		OWNER_SESSION_SECRET: "has\nnewline",
	}), /must not contain a newline/);
	// The original string is immutable, so the caller can only write on success.
	assert.equal(original, "DATABASE_URL=x\n");
});
