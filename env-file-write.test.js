"use strict";
// Tests for the .env write path actually used by
// `npm run set-owner-password -- --write-env`.
//
// These exercise the real file-writing code, but against a temporary file: the
// developer's actual .env is never read or written by this suite. The property
// under test is that DATABASE_URL survives, because losing it would stop the
// backend from starting at all.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { writeEnvFile, readExistingEnvValue } = require("./set-owner-credentials");

let tempDir;
test.beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maridel-env-test-"));
});
test.afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const HASH = "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128);
const envPath = () => path.join(tempDir, ".env");

test("an existing .env keeps DATABASE_URL and gains the owner keys", () => {
	fs.writeFileSync(envPath(), "DATABASE_URL=postgres://localhost:5432/maridel\n");
	const summary = writeEnvFile(envPath(), { OWNER_PASSWORD_HASH: HASH, OWNER_SESSION_SECRET: "c".repeat(43) });

	assert.equal(summary.changed, true);
	assert.equal(summary.appended, 2);
	assert.equal(summary.replaced, 0);
	assert.deepEqual(summary.keys, ["OWNER_PASSWORD_HASH", "OWNER_SESSION_SECRET"]);
	assert.ok(summary.changed, "a change was reported");

	const content = fs.readFileSync(envPath(), "utf8");
	assert.ok(content.includes("DATABASE_URL=postgres://localhost:5432/maridel"), "DATABASE_URL must survive");
	assert.ok(content.includes(`OWNER_PASSWORD_HASH=${HASH}`));
});

test("a stale owner key is replaced in place", () => {
	fs.writeFileSync(envPath(), "DATABASE_URL=x\nOWNER_PASSWORD_HASH=stale\nOWNER_SESSION_SECRET=keep\n");
	const summary = writeEnvFile(envPath(), { OWNER_PASSWORD_HASH: HASH });
	assert.equal(summary.replaced, 1);

	const content = fs.readFileSync(envPath(), "utf8");
	assert.ok(!content.includes("stale"), "the stale hash is gone");
	assert.ok(content.includes("OWNER_SESSION_SECRET=keep"), "an untouched key is preserved");
	assert.ok(content.includes("DATABASE_URL=x"));
});

test("writing the same values twice reports no change", () => {
	fs.writeFileSync(envPath(), "DATABASE_URL=x\n");
	const updates = { OWNER_PASSWORD_HASH: HASH };
	assert.equal(writeEnvFile(envPath(), updates).changed, true);
	assert.equal(writeEnvFile(envPath(), updates).changed, false, "a second identical write is a no-op");

	const content = fs.readFileSync(envPath(), "utf8");
	assert.equal((content.match(/^OWNER_PASSWORD_HASH=/gm) || []).length, 1, "and it does not duplicate");
});

test("a file with no trailing newline is handled", () => {
	fs.writeFileSync(envPath(), "DATABASE_URL=x");
	const summary = writeEnvFile(envPath(), { OWNER_PASSWORD_HASH: HASH });
	assert.equal(summary.changed, true);
	const content = fs.readFileSync(envPath(), "utf8");
	assert.ok(content.includes("DATABASE_URL=x"));
	assert.ok(content.includes(`OWNER_PASSWORD_HASH=${HASH}`));
});

test("a rejected value leaves the file on disk untouched", () => {
	fs.writeFileSync(envPath(), "DATABASE_URL=x\n");
	const before = fs.readFileSync(envPath(), "utf8");
	assert.throws(
		() => writeEnvFile(envPath(), { OWNER_PASSWORD_HASH: `${HASH}\n` }),
		/must not contain a newline/,
	);
	assert.equal(fs.readFileSync(envPath(), "utf8"), before, "the file must not be half-written");
});

test("a newline inside the value is the only silent-corruption risk and is blocked", () => {
	// A newline would end the entry early, so dotenv would read a truncated hash
	// and login would fail with no visible cause. This is the exact bug that made
	// hand-editing .env unreliable.
	fs.writeFileSync(envPath(), "DATABASE_URL=x\n");
	const original = fs.readFileSync(envPath(), "utf8");
	assert.throws(() => writeEnvFile(envPath(), { OWNER_PASSWORD_HASH: `${HASH}\nextra=1` }), /newline/);
	assert.equal(fs.readFileSync(envPath(), "utf8"), original, "the file must be left exactly as it was");
});

test("readExistingEnvValue finds a real value and ignores placeholders", () => {
	assert.equal(readExistingEnvValue("OWNER_SESSION_SECRET=keep\n", "OWNER_SESSION_SECRET"), "keep");
	assert.equal(readExistingEnvValue("OWNER_SESSION_SECRET=REPLACE_WITH_A_SECRET\n", "OWNER_SESSION_SECRET"), "");
	assert.equal(readExistingEnvValue("OWNER_SESSION_SECRET=\n", "OWNER_SESSION_SECRET"), "");
	assert.equal(readExistingEnvValue("DATABASE_URL=x\n", "OWNER_SESSION_SECRET"), "");
	assert.equal(readExistingEnvValue("", "OWNER_SESSION_SECRET"), "");
	// A different key with the same prefix must not be mistaken.
	assert.equal(readExistingEnvValue("OWNER_SESSION_SECRET_OLD=nope\n", "OWNER_SESSION_SECRET"), "");
});

test("a .env.example in the same directory is not touched", () => {
	// The example file must stay a template, even if someone points the tool at
	// a folder that also holds one.
	fs.writeFileSync(envPath(), "OWNER_PASSWORD_HASH=REPLACE_WITH_A_HASH\n");
	writeEnvFile(envPath(), { OWNER_PASSWORD_HASH: HASH });
	const content = fs.readFileSync(envPath(), "utf8");
	assert.ok(!content.includes("REPLACE_WITH_A_HASH"), "the placeholder is replaced, not kept");
});
