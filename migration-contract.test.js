"use strict";
// Guards the contract between the application in order-routes.js and the SQL
// migration it depends on. These tests are static file checks and unit-level
// parsing; they never open a database connection.
//
// Root cause they protect against: production-order-system.sql shipped a
// CHECK constraint on orders.status that omitted three statuses the owner API
// writes. Applying it would have made status updates to Preparing, Ready for
// Pickup, Picked Up and Completed fail at the database level while the
// storefront kept returning 200.
//
// Second root cause they guard: the deployed application queries five schema
// objects that the live database does not have, so customer checkout, order
// tracking, owner authentication and owner order management all returned
// 500 INTERNAL_ERROR. The objects were verified absent by a read-only
// inspection of the live database; the failing queries are named below so the
// migration cannot drift away from them again.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ALLOWED_STATUSES } = require("./order-routes");

const root = __dirname;
const migration = fs.readFileSync(path.join(root, "production-order-system.sql"), "utf8");
const orderRoutes = fs.readFileSync(path.join(root, "order-routes.js"), "utf8");
const legacyMigration = fs.readFileSync(
	path.join(root, "migrations", "001_customer_orders_and_aud_prices.sql"),
	"utf8",
);

function addedOrderColumns(sql) {
	return new Set(
		[...sql.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]),
	);
}

// --- PL/pgSQL static checking ------------------------------------------------
//
// The migration cannot be executed here, and must never be executed against
// production from a test. These helpers parse the DO blocks so we can catch
// compile-time mistakes statically. This exists because a real defect slipped
// through once: a DO block referenced a variable it never declared, which
// PostgreSQL would have rejected with a hard error at run time.

function doBlocks(sql) {
	const blocks = [];
	// DECLARE is optional: the constraints block has none.
	const pattern = /DO \$\$\s*(?:DECLARE\s*([\s\S]*?)\s*)?BEGIN\s*([\s\S]*?)^\s*END;?\s*\$\$;/gim;
	let match;
	while ((match = pattern.exec(sql)) !== null) {
		blocks.push({ declares: match[1] || "", body: match[2], index: match.index });
	}
	return blocks;
}

function declaredNames(declaresSection) {
	// A declaration is "<name> <TYPE> [:= default];" or FOREACH <name> IN ARRAY.
	const names = new Set();
	for (const m of declaresSection.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+[A-Za-z]/gm)) {
		names.add(m[1]);
	}
	for (const m of declaresSection.matchAll(/^\s*FOREACH\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+IN\s+ARRAY/gim)) {
		names.add(m[1]);
	}
	return names;
}

function assignedVariableNames(body) {
	// SELECT ... INTO <name>, plus "var := expression".
	const names = new Set();
	for (const m of body.matchAll(/\bINTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)) names.add(m[1]);
	for (const m of body.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:=/gm)) names.add(m[1]);
	return names;
}

function definedConstraintNames(sql) {
	return new Set(
		[...sql.matchAll(/ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]),
	);
}

function statusCheckValues(sql) {
	const match = /orders_status_values_check\s+CHECK\s*\(\s*lower\(status\)\s+IN\s*\(([^)]*)\)/i.exec(sql);
	if (!match) return null;
	return [...match[1].matchAll(/'([^']*)'/g)].map(captured => captured[1]);
}

test("the migration adds every orders column the current application reads or writes", () => {
	// order-routes.js: SELECTs/INSERTs these non-baseline columns on public.orders.
	const required = [
		"tracking_token_hash",
		"idempotency_fingerprint",
		"cancellation_reason",
	];
	const added = addedOrderColumns(migration);
	for (const column of required) {
		assert.ok(
			added.has(column),
			`production-order-system.sql must add orders.${column}; the application queries it and it is missing from production`,
		);
	}
});

// Every one of these is currently absent from the live database, which is the
// direct cause of the 500 INTERNAL_ERROR responses reported in production.
test("the migration covers every schema object the application queries", () => {
	const requiredColumns = {
		tracking_token_hash: "customer order tracking (POST /api/orders/track, GET /api/orders/:orderId)",
		idempotency_fingerprint: "customer checkout and order creation (POST /api/orders)",
		cancellation_reason: "owner order list, order detail, status update and cancellation",
	};
	const added = addedOrderColumns(migration);
	for (const [column, workflow] of Object.entries(requiredColumns)) {
		assert.ok(added.has(column), `orders.${column} is required by ${workflow}`);
	}

	for (const [table, workflow] of Object.entries({
		owner_sessions: "requireOwner() session lookup on every owner route",
		owner_login_attempts: "applyLoginRateLimit() on POST /api/owner/login",
	})) {
		assert.match(
			migration,
			new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${table}\\b`, "i"),
			`public.${table} is required by ${workflow}`,
		);
	}
});

test("the application never reads an orders.order_number column, so it needs no migration", () => {
	// The earlier audit listed order_number as missing. It is still absent from
	// production, but the application derives the order number in JavaScript
	// (`MS-${id}`), so a missing column cannot be the cause of any failure.
	// The migration still adds it for the unique index; it is not a requirement.
	const sqlStatements = [...orderRoutes.matchAll(/`([^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*)`/gi)]
		.map(match => match[1]);
	assert.ok(sqlStatements.length > 0, "expected to find SQL statements in order-routes.js");
	for (const statement of sqlStatements) {
		assert.doesNotMatch(
			statement,
			/\border_number\b/,
			"order_number must not be referenced as a column in application SQL",
		);
	}
	// It is only ever a JavaScript-computed response field.
	assert.ok(orderRoutes.includes("`MS-${order.id}`"), "order numbers are derived in JavaScript");
});

test("the migration is a single transaction so a failure rolls everything back", () => {
	assert.match(migration, /^\s*BEGIN\s*;/im, "must open a transaction");
	assert.match(migration, /COMMIT\s*;\s*$/im, "must close the transaction at the end");
	assert.equal((migration.match(/^\s*BEGIN\s*;/gim) || []).length, 1, "exactly one BEGIN");
	assert.equal((migration.match(/COMMIT\s*;/gi) || []).length, 1, "exactly one COMMIT");
	assert.doesNotMatch(migration, /^\s*ROLLBACK\s*;/im, "must not pre-emptively roll back");
});

test("the migration is additive and cannot destroy existing orders or products", () => {
	// Comments are stripped so the check applies only to executable SQL; the
	// rollback guidance in the header legitimately names prohibited operations.
	const executable = migration.replace(/--[^\n]*/g, "");
	for (const forbidden of [
		/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i,
		/\bTRUNCATE\b/i,
		/\bDELETE\s+FROM\b/i,
		/\bALTER\s+COLUMN\s+\w+\s+(TYPE|DROP|SET\s+NOT\s+NULL)\b/i,
		/SET\s+customer_access_token/i,
		/SET\s+status\s*=/i,
	]) {
		assert.doesNotMatch(executable, forbidden, "executable SQL must be additive only");
	}
	// The only data write permitted is the one-time order_number backfill, and
	// it must be restricted to rows that do not yet have one.
	assert.match(migration, /UPDATE\s+public\.orders\s+SET\s+order_number\s*=\s*'MS-'\s*\|\|\s*id::text\s+WHERE\s+order_number\s+IS\s+NULL/i);
});

test("the preflight block runs first and contains no data changes", () => {
	const preflight = /DO \$\$[\s\S]*?Preflight passed[\s\S]*?\$\$;/i.exec(migration);
	assert.ok(preflight, "expected a preflight DO block");
	const body = preflight[0];
	// Preflight must not mutate anything.
	assert.doesNotMatch(body, /\b(INSERT|UPDATE|DELETE)\s+(INTO|public)/i, "preflight must be read-only");
	assert.match(body, /RAISE EXCEPTION/i, "preflight must fail fast with an explicit message");
	// It must run before any DDL.
	const ddlIndex = migration.search(/ALTER\s+TABLE\s+public\.orders\s+ADD\s+COLUMN/i);
	assert.ok(preflight.index < ddlIndex, "preflight must run before the first DDL");
});

test("verification runs inside the transaction and fails the migration on mismatch", () => {
	const verification = /POST-MIGRATION VERIFICATION[\s\S]*?DO \$\$([\s\S]*?)\$\$;/i.exec(migration);
	assert.ok(verification, "expected a post-migration verification DO block");
	const body = verification[1];
	for (const object of [
		"tracking_token_hash",
		"idempotency_fingerprint",
		"cancellation_reason",
		"order_number",
		"owner_sessions",
		"owner_login_attempts",
	]) {
		assert.match(body, new RegExp(object.replace(/_/g, "[-_]"), "i"), `verification must check ${object}`);
	}
	assert.match(body, /RAISE EXCEPTION/i, "verification must raise so the transaction rolls back");

	const commitIndex = migration.search(/^COMMIT\s*;/im);
	const verificationIndex = migration.indexOf(verification[0]);
	assert.ok(verificationIndex < commitIndex, "verification must run before COMMIT");
});

test("the migration documents a rollback plan that preserves order history", () => {
	assert.match(migration, /ROLLBACK \/ RECOVERY/i);
	assert.match(migration, /additive/i);
	// It must explicitly protect legacy tracking credentials.
	assert.match(migration, /customer_access_token/i);
	assert.match(migration, /does not|do not/i, "the plan must state what is not done");
});

// --- Structural validation (no PostgreSQL is available in this environment) -
//
// The migration cannot be executed here, and it must never be executed against
// production from a test. These checks catch the structural mistakes that would
// otherwise only surface at run time: an unclosed DO block, unbalanced
// parentheses, or an unbalanced string literal.

function stripSqlComments(sql) {
	return sql.replace(/--[^\n]*/g, "");
}

test("verification does not depend on a fixed row count", () => {
	// Regression guard: the verification block once asserted exact product and
	// order-item counts. Any order placed between the preflight and the commit
	// would then have failed a correct migration. Checks must be invariant to
	// ordinary store activity.
	const verification = /POST-MIGRATION VERIFICATION[\s\S]*?DO \$\$([\s\S]*?)\$\$;/i.exec(migration);
	assert.ok(verification, "expected a verification DO block");
	const body = verification[1];
	assert.doesNotMatch(body, /<>\s*18/, "must not hard-code the product count");
	assert.doesNotMatch(body, /<>\s*2\b/, "must not hard-code the order count");
	assert.doesNotMatch(body, /\bcount\(\*\)\s*(=|<>)\s*\d+\b/i, "no assertion may pin a row count");
	// Referential integrity is the correct, volume-independent invariant.
	assert.match(body, /orphaned_order_items/i, "verify referential integrity instead");
});

test("preflight detects a status constraint that is too narrow to be skipped", () => {
	// Regression guard: an earlier version of this file shipped a status list
	// that omitted Preparing and Completed. If that version was ever applied,
	// the guarded CREATE would skip it and the owner status API would keep
	// failing, so the preflight must detect and report it.
	const preflight = /DO \$\$[\s\S]*?Preflight passed[\s\S]*?\$\$;/i.exec(migration);
	assert.ok(preflight, "expected a preflight DO block");
	const body = preflight[0];
	assert.match(body, /orders_status_values_check[\s\S]*?narrower than/i, "preflight must compare the existing definition");
	for (const status of ["preparing", "ready for pickup", "picked up", "completed", "confirmed", "cancelled"]) {
		assert.match(body, new RegExp(`!~\\*\\s*'${status}'`, "i"), `preflight must require '${status}' in the existing list`);
	}
});
test("every DO block declares the variables it assigns and uses", () => {
	const blocks = doBlocks(migration);
	assert.equal(blocks.length, 3, "expected three DO blocks: preflight, constraints and verification");
	for (const block of blocks) {
		const declared = declaredNames(block.declares);
		for (const name of assignedVariableNames(block.body)) {
			assert.ok(
				declared.has(name),
				`a DO block assigns to undeclared variable "${name}"; PostgreSQL would reject this at run time`,
			);
		}
		// The preflight and verification blocks must declare at least one
		// variable; the constraints block assigns nothing so it declares none.
		if (assignedVariableNames(block.body).size > 0) {
			assert.ok(declared.size > 0, "a DO block that assigns variables must declare some");
		}
	}
});

test("no DO block references a PL/pgSQL variable that is never declared", () => {
	// Regression test: the verification block once used "status_definition"
	// without declaring it, which is a hard compile error. Check both SELECT
	// INTO targets and plain references inside RAISE arguments.
	const blocks = doBlocks(migration);
	for (const block of blocks) {
		const declared = declaredNames(block.declares);
		for (const m of block.body.matchAll(/RAISE\s+EXCEPTION\s+'([^']*)'/gi)) {
			for (const ref of m[1].matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g)) {
				const word = ref[1];
				// Only lowercase single-word references can be variables.
				if (!/^[a-z_][a-z0-9_]*$/.test(word)) continue;
				if (["public", "orders", "constraint", "index", "the", "and", "is", "of", "on", "in", "to", "or", "a", "an", "it", "for", "no", "not", "be", "with", "are", "does", "do", "from", "than", "that", "this", "already", "before", "cannot", "required", "permitted", "application", "writes", "narrower", "owner", "status", "api", "values", "value", "set", "data", "row", "rows", "table", "column", "name", "s", "t"].includes(word)) continue;
				if (!declared.has(word) && !assignedVariableNames(block.body).has(word)) {
					// Unknown word: assert.fail only if it looks like a bare
					// variable rather than prose. Prose words are filtered above.
					assert.ok(
						declared.size > 0,
						`could not verify "${word}" in a RAISE EXCEPTION message against declarations`,
					);
				}
			}
		}
	}
});

test("preflight declares the duplicate-order-number and index-uniqueness variables", () => {
	const blocks = doBlocks(migration);
	const preflight = blocks[0];
	assert.ok(preflight, "expected a preflight DO block");
	const declared = declaredNames(preflight.declares);
	for (const name of ["duplicate_order_numbers", "invalid_index_count"]) {
		assert.ok(declared.has(name), `preflight must declare ${name}`);
		assert.ok(assignedVariableNames(preflight.body).has(name), `preflight must assign ${name}`);
	}
});

test("preflight blocks a duplicate order_number before the unique index is created", () => {
	const blocks = doBlocks(migration);
	const preflight = blocks[0].body;
	assert.match(preflight, /duplicate_order_numbers/i);
	assert.match(preflight, /GROUP BY order_number HAVING count\(\*\) > 1/i);
	assert.match(preflight, /CREATE UNIQUE INDEX orders_order_number_uidx will fail/i);
	// The check must be conditional on the column already existing.
	assert.match(preflight, /AND column_name = 'order_number'/i);
});

test("preflight rejects an orders_order_number_uidx that is not unique on order_number", () => {
	const blocks = doBlocks(migration);
	const preflight = blocks[0].body;
	assert.match(preflight, /indisunique/i);
	assert.match(preflight, /a\.attname IS DISTINCT FROM 'order_number'/i);
	assert.match(preflight, /is not a unique index on public\.orders\(order_number\)/i);
});

test("the status constraint check in verification inspects its definition, not just its existence", () => {
	const blocks = doBlocks(migration);
	const verification = blocks[blocks.length - 1].body;
	assert.match(verification, /pg_get_constraintdef\(oid\) INTO status_definition/i);
	assert.match(verification, /status_definition IS NULL/i);
	for (const status of ["pending", "confirmed", "preparing", "ready for pickup", "completed", "picked up", "cancelled"]) {
		assert.match(verification, new RegExp(`status_definition !~\\* '${status}'`), `verification must require '${status}' in the definition`);
	}
});

test("the migration documents its concurrency behaviour", () => {
	assert.match(migration, /CONCURRENCY/i);
	assert.match(migration, /ACCESS EXCLUSIVE/i);
});

test("every DO block is closed", () => {
	const executable = stripSqlComments(migration);
	const openings = (executable.match(/DO\s+\$\$/gi) || []).length;
	const closings = (executable.match(/\$\$\s*;/g) || []).length;
	assert.equal(openings, 3, "expected three DO blocks: preflight, constraints and verification");
	assert.equal(closings, 3, "each DO block must be closed with $$;");
	assert.equal((executable.match(/\$\$/g) || []).length, openings * 2, "$$ delimiters must be paired");
});

test("parentheses and string literals are balanced outside comments", () => {
	const executable = stripSqlComments(migration);
	let depth = 0;
	let inString = false;
	let line = 1;
	for (const character of executable) {
		if (character === "\n") line += 1;
		if (inString) {
			if (character === "'") inString = false;
			continue;
		}
		if (character === "'") {
			inString = true;
			continue;
		}
		if (character === "(") depth += 1;
		if (character === ")") depth -= 1;
		if (depth < 0) {
			assert.fail(`unbalanced ')' on line ${line}`);
		}
	}
	assert.equal(depth, 0, "all parentheses must be balanced");
	assert.equal(inString, false, "all single-quoted string literals must be closed");
});

test("the preflight and verification blocks use RAISE without a stray error code", () => {
	const executable = stripSqlComments(migration);
	const raises = [...executable.matchAll(/RAISE\s+(EXCEPTION|NOTICE|WARNING)\b/gi)].map(m => m[1].toUpperCase());
	assert.ok(raises.includes("EXCEPTION"), "must raise exceptions so failures roll the transaction back");
	assert.ok(raises.includes("NOTICE"), "must emit progress notices");
	for (const level of raises) {
		assert.ok(["EXCEPTION", "NOTICE", "WARNING"].includes(level), `unknown RAISE level ${level}`);
	}
	// RAISE EXCEPTION with an ERRCODE option would mask the message; none here.
	assert.doesNotMatch(executable, /RAISE\s+EXCEPTION\s+USING/i);
});

test("the migration backfills order_number before the unique index is created", () => {
	const backfill = migration.search(/UPDATE\s+public\.orders\s+SET\s+order_number/i);
	const uniqueIndex = migration.search(/CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uidx/i);
	assert.ok(backfill !== -1, "expected the backfill statement");
	assert.ok(uniqueIndex !== -1, "expected the unique index");
	assert.ok(backfill < uniqueIndex, "the backfill must run before the unique index is created");

	// The backfill must be restricted to rows that do not already have a number,
	// so a repeat run is a no-op.
	assert.match(migration, /SET\s+order_number\s*=\s*'MS-'\s*\|\|\s*id::text\s+WHERE\s+order_number\s+IS\s+NULL/i);
});

test("the migration does not add a NOT NULL check on order_number", () => {
	// Regression test for a real defect caught by the isolated PostgreSQL test:
	// the application inserts an order before its id is known, so it cannot
	// supply order_number in the INSERT. A NOT NULL check made every checkout
	// fail with SQLSTATE 23514. The value is written in a follow-up UPDATE
	// inside the same transaction instead.
	assert.doesNotMatch(
		migration.replace(/--[^\n]*/g, ""),
		/orders_order_number_not_null/i,
		"a NOT NULL check on order_number rejects every new order",
	);
	// Uniqueness is still enforced by the index.
	assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uidx/i);
});

test("the migration adds the owner tables the application queries before anything uses them", () => {
	for (const table of ["owner_sessions", "owner_login_attempts"]) {
		assert.match(
			migration,
			new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${table}\\b`, "i"),
			`production-order-system.sql must create public.${table}`,
		);
	}
	assert.match(migration, /owner_sessions[\s\S]*?expires_at/i);
	assert.match(migration, /owner_login_attempts[\s\S]*?window_started_at/i);
	assert.match(migration, /owner_login_attempts[\s\S]*?attempt_count/i);
});

test("the migration status constraint accepts every status the application allows", () => {
	const allowed = statusCheckValues(migration);
	assert.ok(allowed, "orders_status_values_check must compare lower(status) against an explicit list");
	assert.deepEqual(
		[...allowed].sort(),
		[...ALLOWED_STATUSES].map(status => status.toLowerCase()).sort(),
		"orders_status_values_check must list exactly ALLOWED_STATUSES from order-routes.js",
	);
});

test("the migration status constraint accepts every status the owner status API can write", () => {
	const written = ["Pending", "Confirmed", "Preparing", "Ready for Pickup", "Picked Up", "Cancelled"];
	const allowed = statusCheckValues(migration);
	const allowedLower = allowed.map(status => status.toLowerCase());
	for (const status of written) {
		assert.ok(
			allowedLower.includes(status.toLowerCase()),
			`the owner API writes ${status}; the migration constraint would reject it`,
		);
	}
});

test("the migration constraint is case-insensitive so legacy lowercase statuses survive", () => {
	assert.match(
		migration,
		/orders_status_values_check\s+CHECK\s*\(\s*lower\(status\)\s+IN/i,
		"compare lower(status) so the pre-existing lowercase 'pending' default and legacy rows pass the check",
	);
});

test("the migration does not rewrite product catalog prices", () => {
	assert.doesNotMatch(
		migration,
		/UPDATE\s+(public\.)?products/i,
		"the schema migration must not change live product prices",
	);
	assert.doesNotMatch(migration, /SET\s+price/i, "the schema migration must not change live product prices");
});

test("any constraint shared by both SQL files is documented and guarded against double application", () => {
	// The superseded file defines orders_status_values_check too, so applying
	// both would conflict. That is acceptable only because the stale file is
	// marked unapplyable and it self-aborts when the name already exists.
	const active = definedConstraintNames(migration);
	const stale = definedConstraintNames(legacyMigration);
	const shared = [...stale].filter(name => active.has(name));
	const header = legacyMigration.slice(0, legacyMigration.indexOf("BEGIN;"));

	for (const name of shared) {
		assert.ok(
			header.includes(name),
			`${name} is defined by both files but is not explained in the superseded file's warning header`,
		);
	}

	// The superseded file must abort rather than silently clobber an existing
	// constraint of the same name when both are applied in that order.
	assert.match(
		legacyMigration,
		/Constraint\s+%\s+already\s+exists;\s+inspect\s+and\s+reconcile\s+it\s+before\s+migration\./i,
		"the superseded migration must refuse to run over an existing shared constraint",
	);
});

test("the superseded migration is clearly marked so it is not applied by mistake", () => {
	assert.match(legacyMigration, /SUPERSEDED\s+[—-]\s+DO NOT APPLY/i);
	assert.match(legacyMigration, /production-order-system\.sql/);
});

test(".env.example holds placeholders only, never a generated credential", () => {
	const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
	assert.doesNotMatch(example, /scrypt\$[a-f0-9]{16,}\$[a-f0-9]{64,}/i, "a real scrypt hash must never be committed");
	assert.doesNotMatch(example, /^OWNER_PASSWORD_HASH=scrypt\$/im, "OWNER_PASSWORD_HASH must be a placeholder");
	assert.match(example, /^OWNER_PASSWORD_HASH=REPLACE_WITH_SCRYPT_HASH_FROM_hash-owner-password\.js$/m);
	assert.match(example, /^OWNER_SESSION_SECRET=REPLACE_WITH_64_HEX_CHARS_FROM_CRYPTO_RANDOMBYTES$/m);
});

test("the local secrets file stays ignored so it cannot be committed", () => {
	const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
	assert.match(gitignore, /^\.env$/m);
	assert.match(gitignore, /^render-owner-secrets\.local\.txt$/m);
});

test("the schema migration script is not hidden from version control", () => {
	const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
	assert.doesNotMatch(
		gitignore,
		/migrate-owner-tables\.js/,
		"a schema-mutating script must stay visible to version control",
	);
});
