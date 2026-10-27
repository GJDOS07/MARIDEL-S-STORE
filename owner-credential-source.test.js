"use strict";
// Regression tests for the owner credential source.
//
// THE BUG THESE GUARD AGAINST
//   The login route reads the owner_credentials table on every login, but used to
//   fall back to the OWNER_PASSWORD_HASH value captured once at startup. The two
//   sources therefore had different freshness. After a hash was rotated in .env,
//   every fresh process (check-owner-config, the login verifier) saw the new hash
//   while the long-running backend kept verifying the old one, and login returned
//   401 INVALID_OWNER_CREDENTIALS with nothing to distinguish it from a typo.
//
// These tests use the SAME sandbox initialisation the running server uses, so the
// credential table, the migration state and the route are all the real ones. All
// values are synthetic; no hash or password is printed.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createOrderRouter } = require("./order-routes");
const { createApiErrorHandler } = require("./api-error-handler");
const { createPoolAdapter } = require("./pglite-pool");
const { createSandboxDatabase } = require("./local-sandbox-database");
const { hashOwnerPassword } = require("./owner-credentials-tool");

const SECRET = "r".repeat(43);
const ORIGIN = "http://localhost:4174";

// Mounts the real router over the real sandbox, with credentials supplied via the
// environment exactly as the running server does.
async function startApp() {
	const sandbox = await createSandboxDatabase();
	const app = express();
	app.use(express.json({ limit: "1mb" }));
	const router = createOrderRouter(createPoolAdapter(sandbox.db), {
		allowedOrigins: [ORIGIN],
		isOriginAllowed: origin => origin === ORIGIN,
		secureCookies: false,
		ownerResetDeliver: null,
		// No ownerPasswordHash option: the environment is the source, matching
		// what server.js does.
	});
	app.use("/api", router);
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));

	const base = `http://127.0.0.1:${server.address().port}`;
	const login = async password => {
		const csrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: ORIGIN } });
		const body = await csrf.json();
		const jar = csrf.headers.getSetCookie().map(c => c.split(";")[0]);
		const response = await fetch(`${base}/api/owner/login`, {
			method: "POST",
			headers: {
				Origin: ORIGIN, "Content-Type": "application/json",
				Cookie: jar.join("; "), "X-CSRF-Token": body.csrf_token,
			},
			body: JSON.stringify({ password }),
		});
		return { status: response.status, code: (await response.json().catch(() => ({}))).code };
	};

	return {
		login,
		describe: () => router.describeOwnerCredentialSource(),
		sandbox,
		async close() {
			await new Promise(resolve => server.close(resolve));
			await sandbox.close();
		},
	};
}

// Sets the owner environment variables for the whole test and restores them
// afterwards. The restore must happen in t.after, not when the app finishes
// starting: the logins run later, and restoring early leaves the router reading a
// deleted variable, which is what a naive helper does.
function useOwnerEnv(t, { passwordHash, sessionSecret = SECRET } = {}) {
	const originals = {};
	const entries = [
		["OWNER_PASSWORD_HASH", passwordHash],
		["OWNER_SESSION_SECRET", sessionSecret],
	];
	for (const [key, value] of entries) {
		originals[key] = process.env[key];
		if (value === null || value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	t.after(() => {
		for (const key of Object.keys(originals)) {
			if (originals[key] === undefined) delete process.env[key];
			else process.env[key] = originals[key];
		}
	});
}


test("the sandbox creates owner_credentials and starts it empty", async t => {
	const sandbox = await createSandboxDatabase();
	t.after(() => sandbox.close());
	const table = await sandbox.pool.query(
		"SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='owner_credentials'",
	);
	assert.equal(table.rows[0].n, 1, "the table must exist after the migration");
	const rows = await sandbox.pool.query("SELECT count(*)::int AS n FROM owner_credentials");
	assert.equal(rows.rows[0].n, 0, "it must start empty, so login falls back to the environment");
});

test("an empty owner_credentials falls back to the environment hash", async t => {
	useOwnerEnv(t, { passwordHash: hashOwnerPassword("Synthetic-Cred-1234") });
	const app = await startApp();
	t.after(() => app.close());

	assert.equal((await app.login("Synthetic-Cred-1234")).status, 200, "the environment password must work");
	assert.equal((await app.login("wrong-password")).status, 401, "a wrong password must be refused");

	const described = await app.describe();
	assert.equal(described.source, "OWNER_PASSWORD_HASH environment variable");
	assert.equal(described.usable, true);
	assert.equal(described.changedSinceStartup, false);
});

test("a rotated environment hash takes effect WITHOUT restarting the router", async t => {
	// This is the exact regression: the router is created once, the environment
	// changes, and the next login must use the new value.
	const first = hashOwnerPassword("First-Owner-Pass-1");
	const second = hashOwnerPassword("Second-Owner-Pass-2");

	const original = process.env.OWNER_PASSWORD_HASH;
	const secret = process.env.OWNER_SESSION_SECRET;
	process.env.OWNER_SESSION_SECRET = SECRET;
	process.env.OWNER_PASSWORD_HASH = first;

	const app = await startApp();
	t.after(async () => {
		await app.close();
		if (original === undefined) delete process.env.OWNER_PASSWORD_HASH;
		else process.env.OWNER_PASSWORD_HASH = original;
		if (secret === undefined) delete process.env.OWNER_SESSION_SECRET;
		else process.env.OWNER_SESSION_SECRET = secret;
	});

	assert.equal((await app.login("First-Owner-Pass-1")).status, 200, "the original password works");
	assert.equal((await app.login("Second-Owner-Pass-2")).status, 401, "the new password is not live yet");

	// Rotate, exactly as `npm run set-owner-password -- --write-env` would.
	process.env.OWNER_PASSWORD_HASH = second;

	assert.equal((await app.login("First-Owner-Pass-1")).status, 401, "the old password must stop working");
	assert.equal((await app.login("Second-Owner-Pass-2")).status, 200,
		"the new password must work with no router restart");

	// And the operator is told the configuration moved under the process.
	const described = await app.describe();
	assert.equal(described.changedSinceStartup, true, "the rotation must be reported");
	assert.equal(described.source, "OWNER_PASSWORD_HASH environment variable");
});

test("an owner_credentials row overrides the environment hash", async t => {
	// The documented precedence, made explicit and testable: the database row wins,
	// so a row left behind by a password reset keeps working even if the
	// environment variable is later changed.
	const envHash = hashOwnerPassword("Env-Password-1234");
	const dbHash = hashOwnerPassword("Database-Password-4567");

	useOwnerEnv(t, { passwordHash: envHash });
	const app = await startApp();
	t.after(() => app.close());

	assert.equal((await app.login("Env-Password-1234")).status, 200, "the environment password works first");

	await app.sandbox.pool.query(
		"INSERT INTO owner_credentials (singleton, password_hash) VALUES (true, $1)",
		[dbHash],
	);

	assert.equal((await app.login("Database-Password-4567")).status, 200, "the database password now works");
	assert.equal((await app.login("Env-Password-1234")).status, 401,
		"the environment password is overridden by the row");
	const described = await app.describe();
	assert.equal(described.source, "owner_credentials table");
});

test("an unparseable environment hash fails closed instead of accepting any password", async t => {
	useOwnerEnv(t, { passwordHash: "not-a-valid-scrypt-hash" });
	const app = await startApp();
	t.after(() => app.close());

	// The property that matters is that nothing authenticates. The route reports
	// 503 rather than 401 because an unparseable hash is a configuration fault,
	// not a wrong password; both are fail-closed, and 503 is the diagnosable one.
	for (const password of ["", "x", "First-Owner-Pass-1", "not-a-valid-scrypt-hash"]) {
		const response = await app.login(password);
		assert.notEqual(response.status, 200, `a malformed hash must never authenticate: ${JSON.stringify(password)}`);
		assert.equal(response.status, 503, "an unusable hash must fail closed with a configuration error");
	}
	const described = await app.describe();
	assert.equal(described.usable, false, "the unusable configuration must be reported");
});

test("a missing environment hash is reported, not silently ignored", async t => {
	useOwnerEnv(t, { passwordHash: null });
	const app = await startApp();
	t.after(() => app.close());

	const response = await app.login("whatever");
	assert.equal(response.status, 503, "no credential means the route fails closed");
	assert.equal(response.code, "OWNER_AUTH_NOT_CONFIGURED");
});

test("the source descriptor never exposes a hash, password or token", async t => {
	useOwnerEnv(t, { passwordHash: hashOwnerPassword("Synthetic-Cred-1234") });
	const app = await startApp();
	t.after(() => app.close());

	const described = await app.describe();
	const serialized = JSON.stringify(described);
	// The descriptor names a SOURCE, so "OWNER_PASSWORD_HASH" is expected and is
	// not a secret. What must never appear is any actual value or hash shape.
	assert.ok(!serialized.includes("scrypt$"), "no hash shape may be reported");
	assert.ok(!serialized.includes(process.env.OWNER_PASSWORD_HASH), "no hash value may be reported");
	assert.ok(!serialized.includes("Database-Password"), "no password may be reported");
	assert.ok(!serialized.includes(SECRET), "no session secret may be reported");
	assert.deepEqual(
		Object.keys(described).sort(),
		["changedSinceStartup", "source", "usable"],
		"the descriptor must stay a fixed, safe shape",
	);
});
