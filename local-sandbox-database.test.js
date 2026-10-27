"use strict";
// Tests for the local sandbox database.
//
// The property that matters is that the sandbox is built from the real
// migrations and never touches DATABASE_URL. A sandbox that silently connected
// to production would be far worse than no sandbox, so both halves are asserted.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSandboxDatabase, isSandboxRequested, SandboxUnavailableError } = require("./local-sandbox-database");

test("the sandbox is only used when explicitly requested", () => {
	const original = process.env.LOCAL_SANDBOX_DB;
	try {
		delete process.env.LOCAL_SANDBOX_DB;
		assert.equal(isSandboxRequested(), false, "unset must not select the sandbox");
		process.env.LOCAL_SANDBOX_DB = "0";
		assert.equal(isSandboxRequested(), false);
		process.env.LOCAL_SANDBOX_DB = "1";
		assert.equal(isSandboxRequested(), true);
		process.env.LOCAL_SANDBOX_DB = "true";
		assert.equal(isSandboxRequested(), true);
		process.env.LOCAL_SANDBOX_DB = "please-no-thanks";
		assert.equal(isSandboxRequested(), false, "an unrelated value must not switch the database");
	} finally {
		if (original === undefined) delete process.env.LOCAL_SANDBOX_DB;
		else process.env.LOCAL_SANDBOX_DB = original;
	}
});

test("the sandbox never reads DATABASE_URL", async t => {
	// If this ever starts using the connection string, local runs would read and
	// write production rows. Assert the variable is not needed at all.
	const original = process.env.DATABASE_URL;
	delete process.env.DATABASE_URL;
	try {
		const sandbox = await createSandboxDatabase();
		t.after(() => sandbox.close());
		assert.ok(sandbox.pool, "the sandbox must work with no DATABASE_URL present");
	} finally {
		if (original !== undefined) process.env.DATABASE_URL = original;
	}
});

test("the sandbox applies the real migrations and carries the seeded catalog", async t => {
	const sandbox = await createSandboxDatabase();
	t.after(() => sandbox.close());

	// Every object both project migrations create must exist.
	const products = await sandbox.pool.query("SELECT count(*)::int AS n FROM products");
	assert.equal(products.rows[0].n, 18, "the seeded catalog must be present");

	const published = await sandbox.pool.query("SELECT count(*)::int AS n FROM products WHERE is_published");
	assert.equal(published.rows[0].n, 18, "is_published must exist and default to published");

	for (const table of ["owner_sessions", "owner_login_attempts", "owner_credentials", "owner_reset_tokens", "owner_contact"]) {
		const exists = await sandbox.pool.query(
			"SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
			[table],
		);
		assert.equal(exists.rows[0].n, 1, `${table} must exist after the migrations`);
	}

	const orders = await sandbox.pool.query("SELECT count(*)::int AS n FROM orders");
	assert.equal(orders.rows[0].n, 1, "the historical order must be seeded");
});

test("the pool adapter reports rowCount the way pg does", async t => {
	// A DELETE that matched rows must not look like a 404. PGlite returns rows: []
	// and reports affectedRows separately, so this is the adapter's whole reason
	// for existing.
	const sandbox = await createSandboxDatabase();
	t.after(() => sandbox.close());

	await sandbox.pool.query("INSERT INTO products (name, price) VALUES ('Delete Me', 1.00)");
	const deleted = await sandbox.pool.query("DELETE FROM products WHERE name = 'Delete Me'");
	assert.equal(deleted.rowCount, 1, "a matched DELETE must report rowCount 1");

	const missed = await sandbox.pool.query("DELETE FROM products WHERE name = 'Nothing Here'");
	assert.equal(missed.rowCount, 0, "an unmatched DELETE must report rowCount 0");
});

test("the pool adapter supports a transaction through connect()", async t => {
	// The checkout route opens a client and runs BEGIN/COMMIT explicitly, so the
	// adapter must support that shape.
	const sandbox = await createSandboxDatabase();
	t.after(() => sandbox.close());
	const client = await sandbox.pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("INSERT INTO products (name, price) VALUES ('In Transaction', 2.00)");
		await client.query("ROLLBACK");
	} finally {
		client.release();
	}
	const found = await sandbox.pool.query("SELECT count(*)::int AS n FROM products WHERE name = 'In Transaction'");
	assert.equal(found.rows[0].n, 0, "a rolled back insert must not persist");
});

test("a sandbox that cannot be created is reported, not swallowed", async () => {
	const { createSandboxDatabaseOrThrow } = require("./local-sandbox-database");
	// Point the persistent directory at a path that cannot be created, so the
	// failure path is exercised without touching anything real.
	const original = process.env.LOCAL_SANDBOX_DATA_DIR;
	process.env.LOCAL_SANDBOX_DATA_DIR = "\\0\\not\\a\\real\\path";
	try {
		await assert.rejects(() => createSandboxDatabaseOrThrow(), error => error instanceof SandboxUnavailableError
			&& /could not be created/i.test(error.message));
	} finally {
		if (original === undefined) delete process.env.LOCAL_SANDBOX_DATA_DIR;
		else process.env.LOCAL_SANDBOX_DATA_DIR = original;
	}
});

// --- how server.js selects the database -------------------------------------

const path = require("node:path");
const { spawn } = require("node:child_process");

// Starts the real server.js in a subprocess with a controlled environment, waits
// for it to report that it is listening, and hands back a helper for probing it.
// The real DATABASE_URL in .env cannot leak in: dotenv is pointed at a file that
// does not exist, and every owner variable is supplied explicitly.
async function startRealServer(envOverrides, { port } = {}) {
	// fetch (undici, like a browser) refuses a short list of well-known ports
	// before connecting. Two of them, 4045 and 4190, fall inside the random
	// range below and made an already-running server unreachable to the tests
	// ("bad port"). Skip them so every chosen port is actually fetchable.
	const blockedPorts = new Set([4045, 4190]);
	let chosen = port;
	while (!chosen || blockedPorts.has(chosen)) {
		chosen = 3900 + Math.floor(Math.random() * 500);
	}
	const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
		env: {
			...envOverrides,
			DOTENV_CONFIG_PATH: path.join(__dirname, "does-not-exist.env"),
			PORT: String(chosen),
			NODE_ENV: "development",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
	child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });

	const base = `http://127.0.0.1:${chosen}`;
	const ready = await new Promise(resolve => {
		// PGlite boots in a few seconds on an idle machine, but a parallel
		// test run keeps every core busy booting other sandboxes at the same
		// time. A slow first boot is a normal outcome, not a failure, so
		// give the sandbox generous room.
		const deadline = setTimeout(() => resolve(false), 45000);
		child.stdout.on("data", () => {
			if (output.includes("backend is running")) { clearTimeout(deadline); resolve(true); }
		});
	});
	return {
		base,
		output,
		ready,
		async stop() {
			child.kill("SIGTERM");
			await new Promise(resolve => {
				if (child.exitCode !== null || child.signalCode) return resolve();
				child.once("exit", resolve);
				setTimeout(resolve, 3000);
			});
		},
	};
}

test("without the sandbox flag, a missing DATABASE_URL still fails loudly", async () => {
	const server = await startRealServer({
		LOCAL_SANDBOX_DB: "",
		DATABASE_URL: "",
		OWNER_PASSWORD_HASH: "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128),
		OWNER_SESSION_SECRET: "c".repeat(43),
	});
	await server.stop();
	// The production guard must survive the sandbox addition: an unset
	// DATABASE_URL is a startup error, not a silent fallback to the sandbox.
	assert.equal(server.ready, false, "startup must fail");
	assert.match(server.output, /DATABASE_URL is not set/);
	assert.ok(!/isolated PostgreSQL/.test(server.output), "an unset DATABASE_URL must not select the sandbox");
});

test("with the sandbox flag the server starts and answers requests with no DATABASE_URL", async () => {
	// This is the whole point of the sandbox: the real server runs and serves
	// real HTTP without ever looking at a connection string.
	const server = await startRealServer({
		LOCAL_SANDBOX_DB: "1",
		DATABASE_URL: "",
		OWNER_PASSWORD_HASH: "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128),
		OWNER_SESSION_SECRET: "c".repeat(43),
	});
	try {
		assert.equal(server.ready, true, `startup must succeed. output: ${server.output.slice(0, 400)}`);
		assert.match(server.output, /isolated PostgreSQL/, "the startup log must say which database is in use");
		assert.match(server.output, /password hash valid/, "owner configuration must be reported");
		assert.ok(!server.output.includes("postgres://"), "no connection string may be printed");

		const health = await fetch(server.base);
		assert.equal(health.status, 200);
		assert.match(await health.text(), /backend is running/);

		// A route that reads the database proves the pool adapter is live.
		const products = await fetch(`${server.base}/api/products`);
		assert.equal(products.status, 200, "the product route must answer");
		const rows = await products.json();
		assert.ok(Array.isArray(rows) && rows.length === 18, "the seeded catalog must be readable");
		assert.ok("is_published" in rows[0], "the migrated column must be present");
	} finally {
		await server.stop();
	}
});

test("the public product API reports an integer stock and nothing internal", async () => {
	// The storefront clamps cart quantities to the stock the API hands back, so
	// the field must always be a whole non-negative number. low_stock_threshold
	// is owners-only and must never leak through this route.
	const server = await startRealServer({
		LOCAL_SANDBOX_DB: "1",
		DATABASE_URL: "",
		OWNER_PASSWORD_HASH: "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128),
		OWNER_SESSION_SECRET: "c".repeat(43),
	});
	try {
		assert.equal(server.ready, true, `startup must succeed. output: ${server.output.slice(0, 400)}`);

		const listed = await (await fetch(`${server.base}/api/products`)).json();
		assert.ok(Array.isArray(listed) && listed.length > 0, "catalog must be readable");
		for (const row of listed) {
			assert.ok(Number.isInteger(row.stock) && row.stock >= 0, `stock must be a non-negative integer for product ${row.id}`);
			assert.ok(!("low_stock_threshold" in row), "the owner-only threshold must not be exposed");
		}

		const single = await (await fetch(`${server.base}/api/products/73`)).json();
		assert.ok(Number.isInteger(single.stock) && single.stock >= 0, "the single product read must carry the same integer stock");
	} finally {
		await server.stop();
	}
});
