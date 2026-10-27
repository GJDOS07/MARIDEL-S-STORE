"use strict";
// Builds the isolated local database that lets the real server run without
// touching production.
//
// Activated only by LOCAL_SANDBOX_DB. Without it, server.js behaves exactly as
// before and opens a pg Pool against DATABASE_URL.
//
//   LOCAL_SANDBOX_DB=1 npm start
//
// What you get: a real PostgreSQL engine (PGlite), the real project migrations
// applied in order, the seeded catalog, and a pool adapter the existing routes
// use unchanged. Products, orders and sessions created while it runs live only in
// that database and are gone when the process exits, so nothing here can affect
// the production data the previous session verified.

const { createPoolAdapter } = require("./pglite-pool");
const { LEGACY_SCHEMA, seedCatalog, MIGRATION_FILES, readSql } = require("./sandbox-schema");

// PGlite is a devDependency and is needed only when the sandbox is requested.
//
// It is required HERE rather than at module load: server.js imports this module
// unconditionally at startup, so a top-level require made the whole server
// unloadable on a host that installed production dependencies only (the file is
// present, the package is not). A missing install is reported through the same
// SandboxUnavailableError path as any other sandbox failure.
function loadPGlite() {
	try {
		return require("@electric-sql/pglite").PGlite;
	} catch {
		throw new SandboxUnavailableError(new Error(
			"@electric-sql/pglite is not installed, so the local sandbox database is unavailable. "
			+ "Install the development dependencies (npm ci) to run with LOCAL_SANDBOX_DB.",
		));
	}
}

// When unset the sandbox is in memory. Setting it persists the database to a
// local directory, which is useful for poking at the dashboard across restarts.
function sandboxDataDir() {
	const value = process.env.LOCAL_SANDBOX_DATA_DIR;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isSandboxRequested() {
	const value = process.env.LOCAL_SANDBOX_DB;
	return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

async function createSandboxDatabase() {
	const PGlite = loadPGlite();
	const dataDir = sandboxDataDir();
	const db = dataDir ? await PGlite.create(dataDir) : await PGlite.create();

	// The real migrations, in the order the project documents. Applying them here
	// means the sandbox schema is produced by the same SQL that runs in Neon,
	// which is the point: a schema mismatch would surface locally instead of in
	// production.
	await db.exec(LEGACY_SCHEMA);
	for (const file of MIGRATION_FILES) {
		await db.exec(readSql(file));
	}
	await seedCatalog(db);

	return {
		db,
		pool: createPoolAdapter(db),
		// The sandbox is deliberately isolated: nothing it contains is production
		// data, and closing it discards anything created during the session.
		async close() {
			await db.close();
		},
		describe() {
			return {
				engine: "PGlite (isolated PostgreSQL)",
				persistent: Boolean(dataDir),
				migrationsApplied: MIGRATION_FILES.length,
			};
		},
	};
}

// Raised when the sandbox is requested but cannot be created, so the startup log
// can name the cause instead of failing with a raw stack trace.
class SandboxUnavailableError extends Error {
	constructor(cause) {
		super(`The local sandbox database could not be created: ${cause && cause.message ? cause.message : cause}`);
		this.name = "SandboxUnavailableError";
		this.cause = cause;
	}
}

async function createSandboxDatabaseOrThrow() {
	try {
		return await createSandboxDatabase();
	} catch (error) {
		// Already explained (for example PGlite is not installed); wrapping it
		// again would bury the message the operator needs.
		if (error instanceof SandboxUnavailableError) throw error;
		throw new SandboxUnavailableError(error);
	}
}

module.exports = {
	createSandboxDatabase,
	createSandboxDatabaseOrThrow,
	isSandboxRequested,
	sandboxDataDir,
	SandboxUnavailableError,
};
