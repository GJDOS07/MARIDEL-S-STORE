#!/usr/bin/env node
"use strict";

// PARTIAL MIGRATION SCRIPT - DO NOT USE AS A SUBSTITUTE FOR
// production-order-system.sql.
//
// This script creates only public.owner_sessions and
// public.owner_login_attempts. It does NOT add the four columns the application
// requires on public.orders (tracking_token_hash, idempotency_fingerprint,
// cancellation_reason, order_number), so running only this script leaves
// customer checkout, customer order tracking and the owner dashboard failing
// with HTTP 500.
//
// production-order-system.sql is the authoritative migration. It adds all six
// objects, plus the required indexes and constraints, and it preflights and
// verifies itself. Use that file instead.
//
// This script is kept because it is the historical record of how the two owner
// tables were defined, and it is safe to re-run.

const { Pool } = require("pg");
require("dotenv").config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
	console.error("DATABASE_URL is not set. Set it as an environment variable.");
	process.exit(1);
}

const pool = new Pool({
	connectionString: DATABASE_URL,
	ssl: true,
});

const MIGRATION_SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS public.owner_sessions (
	session_hash CHAR(64) PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS owner_sessions_expires_at_idx
	ON public.owner_sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.owner_login_attempts (
	client_key_hash CHAR(64) PRIMARY KEY CHECK (client_key_hash ~ '^[a-f0-9]{64}$'),
	window_started_at TIMESTAMPTZ NOT NULL,
	attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 1000000)
);

COMMIT;
`;

async function runMigration() {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(MIGRATION_SQL);
		await client.query("COMMIT");
		console.log("Migration completed successfully: owner_sessions and owner_login_attempts tables created.");
	} catch (error) {
		await client.query("ROLLBACK");
		console.error("Migration failed:", error.message);
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

runMigration().catch(() => process.exit(1));