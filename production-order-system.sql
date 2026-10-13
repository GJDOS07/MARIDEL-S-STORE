-- ============================================================================
-- production-order-system.sql
--
-- RECOMMENDED PRODUCTION MIGRATION FOR MARIDEL'S STORE
--
-- Run this manually in the Neon SQL Editor (or an approved PostgreSQL client)
-- as a single transaction. The application never runs migrations itself; it
-- does not read this file at startup.
--
-- WHY THIS IS REQUIRED
--   The deployed application (order-routes.js) queries six schema objects that
--   the live database does not have. Until they exist these requests fail with
--   HTTP 500 "An internal server error occurred":
--     POST /api/orders                  -> INSERT ... idempotency_fingerprint
--     POST /api/orders/track            -> WHERE tracking_token_hash = ...
--     GET  /api/orders/:orderId         -> WHERE tracking_token_hash = ...
--     GET  /api/owner/orders            -> SELECT ... cancellation_reason
--     POST /api/owner/orders/:id/status -> SELECT ... cancellation_reason
--     every /api/owner/* route          -> requireOwner() SELECT 1 FROM owner_sessions
--     POST /api/owner/login             -> INSERT INTO owner_login_attempts
--
-- WHAT THIS MIGRATION DOES
--   Additive only. It adds four columns to orders, two unique indexes, four
--   CHECK constraints, and two tables. It applies exactly one data change: a
--   one-time backfill of orders.order_number, restricted to rows where that
--   column is new and therefore NULL. It also corrects the cold default for
--   orders.status from lowercase 'pending' to 'Pending'.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   It does not remove, recreate or rename any existing table, column, index,
--   constraint or row. It does not touch the existing `cart`, `customers`,
--   `contact_messages` or `promo_codes` tables, which the application does not
--   use. It does not rewrite, hash or remove the existing plaintext
--   `orders.customer_access_token` values: legacy tracking credentials keep
--   working, and the application accepts either the new hashed credential or
--   the stored legacy one. It does not change product prices or the catalog.
--
-- SAFETY
--   The whole file is one transaction. Any preflight or verification failure
--   raises an exception and rolls the transaction back, so it is not possible
--   to half-apply this migration. Every statement is guarded with
--   IF NOT EXISTS, so re-running the file is safe.
--
-- CONCURRENCY
--   ALTER TABLE holds an ACCESS EXCLUSIVE lock on public.orders until the
--   transaction commits, so concurrent INSERTs and UPDATEs on orders are
--   blocked for the duration rather than interleaving with the backfill. On
--   the current table size this is a sub-second window. Run it during a quiet
--   period. No order can be lost: a blocked write either commits after the
--   migration or fails visibly and can be retried by the customer.
--
-- ROLLBACK / RECOVERY
--   Because the objects this migration adds carry no data before the
--   application starts using them, reverting is safe and cannot lose order
--   history. Preferred order of recovery:
--     1. Redeploy the previous application release and leave the schema
--        additions in place. Additive columns and two empty tables are inert
--        to older code.
--     2. If the schema itself must be reverted, take an approved Neon restore
--        point/branch and restore to it, or run the removal statements listed
--        in the runbook section "Rollback plan". Only do this after no order
--        has been created with the new application, because removing the new
--        columns removes the tracking credential hash, the idempotency
--        fingerprint, the cancellation reason and the order number for any
--        order created afterwards. Existing orders placed before the migration
--        are unaffected either way.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- PREFLIGHT
-- Fails fast with an explicit message instead of a raw PostgreSQL error. Every
-- statement here is a read-only query; nothing is modified.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
	missing_table TEXT;
	orders_pk_columns TEXT[];
	existing_statuses TEXT;
	owner_table TEXT;
	bad_column TEXT;
	status_definition TEXT;
	duplicate_order_numbers BIGINT;
	invalid_index_count BIGINT;
BEGIN
	-- The tables this migration extends must exist and must not be created here.
	FOREACH missing_table IN ARRAY ARRAY['orders', 'order_items', 'products'] LOOP
		IF to_regclass('public.' || missing_table) IS NULL THEN
			RAISE EXCEPTION 'Preflight failed: expected table public.% does not exist. Inspect the schema before running this migration.', missing_table;
		END IF;
	END LOOP;

	-- The order_number backfill derives the value from the primary key, so the
	-- primary key must be exactly the single integer column orders.id.
	SELECT array_agg(a.attname ORDER BY a.attnum)::TEXT[]
	INTO orders_pk_columns
	FROM pg_index i
	JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
	WHERE i.indrelid = 'public.orders'::regclass AND i.indisprimary;

	IF orders_pk_columns IS DISTINCT FROM ARRAY['id'] THEN
		RAISE EXCEPTION 'Preflight failed: expected public.orders primary key on a single id column, found %. Inspect the schema before running this migration.', coalesce(orders_pk_columns::text, 'no primary key');
	END IF;

	-- The status constraint validates existing rows. Check them first so the
	-- failure explains the cause rather than surfacing as a raw constraint
	-- violation. This is deliberately range-independent so new rows created
	-- between this preflight and the commit do not affect it.
	IF EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conrelid = 'public.orders'::regclass
			AND conname = 'orders_status_values_check'
	) THEN
		-- The constraint already exists and has already validated its rows, so
		-- re-validating them here would be redundant work.
		RAISE NOTICE 'Preflight: orders_status_values_check already present; skipping validation of existing rows.';
	ELSE
		SELECT string_agg(DISTINCT quote_literal(status), ', ') INTO existing_statuses
		FROM public.orders
		WHERE lower(status) NOT IN (
			'pending', 'confirmed', 'preparing', 'ready for pickup',
			'completed', 'picked up', 'cancelled'
		);
		IF existing_statuses IS NOT NULL THEN
			RAISE EXCEPTION 'Preflight failed: existing orders.status values are outside the permitted set: %. Reconcile the data, or widen orders_status_values_check, before running this migration.', existing_statuses;
		END IF;
	END IF;

	-- If an earlier, narrower version of the status constraint was already
	-- applied, the guarded CREATE below would skip it and the owner status API
	-- would keep failing. Detect that explicitly instead of silently passing.
	-- LIMIT 1 is defensive: a constraint name can only appear once per table.
	SELECT pg_get_constraintdef(oid) INTO status_definition
	FROM pg_constraint
	WHERE connamespace = 'public'::regnamespace
		AND conrelid = 'public.orders'::regclass
		AND conname = 'orders_status_values_check'
	LIMIT 1;

	IF status_definition IS NOT NULL
		AND (status_definition !~* 'preparing'
			OR status_definition !~* 'ready for pickup'
			OR status_definition !~* 'picked up'
			OR status_definition !~* 'completed'
			OR status_definition !~* 'cancelled'
			OR status_definition !~* 'confirmed'
			OR status_definition !~* 'pending') THEN
		RAISE EXCEPTION 'Preflight failed: orders_status_values_check already exists but its permitted status list is narrower than the application writes: %. The owner status API writes Preparing, Ready for Pickup, Picked Up and Completed. Widen the constraint before running this migration.', status_definition;
	END IF;

	-- The unique index on order_number can only be created when the values are
	-- unique. If the column already exists from a partial earlier attempt and
	-- already holds duplicates, the backfill below cannot repair them because
	-- it only fills NULL rows, so fail here with an explicit message rather
	-- than a raw duplicate-key error from CREATE UNIQUE INDEX.
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_number'
	) THEN
		SELECT count(*)::BIGINT INTO duplicate_order_numbers
		FROM (SELECT 1 FROM public.orders WHERE order_number IS NOT NULL GROUP BY order_number HAVING count(*) > 1) AS d;
		IF duplicate_order_numbers > 0 THEN
			RAISE EXCEPTION 'Preflight failed: public.orders.order_number already exists and % value(s) are duplicated. The backfill only fills NULL rows and cannot repair these. Reconcile the duplicates before running this migration, otherwise CREATE UNIQUE INDEX orders_order_number_uidx will fail.', duplicate_order_numbers;
		END IF;
	END IF;

	-- If an index of that name already exists, it must be unique and must be on
	-- order_number, otherwise CREATE UNIQUE INDEX IF NOT EXISTS would silently
	-- skip creating the real one and uniqueness would never be enforced.
	IF EXISTS (
		SELECT 1 FROM pg_indexes
		WHERE schemaname = 'public' AND indexname = 'orders_order_number_uidx'
	) THEN
		SELECT count(*)::BIGINT INTO invalid_index_count
		FROM pg_index i
		JOIN pg_class ic ON ic.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = ic.relnamespace
		LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
		WHERE n.nspname = 'public' AND ic.relname = 'orders_order_number_uidx'
			AND (NOT i.indisunique OR a.attname IS DISTINCT FROM 'order_number');
		IF invalid_index_count > 0 THEN
			RAISE EXCEPTION 'Preflight failed: an index named orders_order_number_uidx already exists but is not a unique index on public.orders(order_number). Reconcile it before running this migration.';
		END IF;
	END IF;

	-- If the owner tables already exist from a partial earlier attempt, verify
	-- they carry the columns the application queries, because
	-- CREATE TABLE IF NOT EXISTS would otherwise silently skip creating them.
	--
	-- The VALUES aliases are deliberately named owner_table/owner_column: naming
	-- them table_name/column_name collides with the PL/pgSQL loop variable and
	-- makes the comparison ambiguous, which PostgreSQL rejects. Real PostgreSQL
	-- and PGlite both reject it; the isolated migration test covers it.
	FOREACH owner_table IN ARRAY ARRAY['owner_sessions', 'owner_login_attempts'] LOOP
		IF to_regclass('public.' || owner_table) IS NULL THEN
			CONTINUE;
		END IF;

		SELECT string_agg(wanted.check_column, ', ')
		INTO bad_column
		FROM (VALUES
			('owner_sessions', 'session_hash'),
			('owner_sessions', 'expires_at'),
			('owner_sessions', 'created_at'),
			('owner_login_attempts', 'client_key_hash'),
			('owner_login_attempts', 'window_started_at'),
			('owner_login_attempts', 'attempt_count')
		) AS wanted(check_table, check_column)
		WHERE wanted.check_table = owner_table
			AND NOT EXISTS (
				SELECT 1 FROM information_schema.columns c
				WHERE c.table_schema = 'public'
					AND c.table_name = wanted.check_table
					AND c.column_name = wanted.check_column
			);

		IF bad_column IS NOT NULL THEN
			RAISE EXCEPTION 'Preflight failed: public.% already exists but is missing required columns: %. Resolve this before running this migration.', owner_table, bad_column;
		END IF;
	END LOOP;

	RAISE NOTICE 'Preflight passed: required tables present, primary key is id, statuses compatible, no name collisions.';
END;
$$;

-- ----------------------------------------------------------------------------
-- ADDITIVE COLUMNS
-- order_number is not referenced by application SQL (the order number is
-- derived as 'MS-' || id in JavaScript); it is added for the unique index and
-- for readable reporting.
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
	ADD COLUMN IF NOT EXISTS order_number TEXT,
	ADD COLUMN IF NOT EXISTS tracking_token_hash CHAR(64),
	ADD COLUMN IF NOT EXISTS idempotency_fingerprint CHAR(64),
	ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- One-time backfill. Restricted to rows where the column is new and therefore
-- NULL, so re-running this file changes nothing. It runs before the unique
-- index orders_order_number_uidx is created below.
UPDATE public.orders
SET order_number = 'MS-' || id::text
WHERE order_number IS NULL;

-- Correct the cold default so rows inserted without an explicit status get
-- 'Pending' rather than lowercase 'pending'. Existing rows are not rewritten;
-- the status constraint below is case-insensitive and accepts both.
ALTER TABLE public.orders
	ALTER COLUMN status SET DEFAULT 'Pending';

-- ----------------------------------------------------------------------------
-- CONSTRAINTS
-- Added only if absent, so the file is repeatable. The status list must stay
-- in exact parity with ALLOWED_STATUSES in order-routes.js; it is compared
-- case-insensitively because the previous default was lowercase.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
	-- Orders are inserted before their id is known, so order_number cannot be
	-- populated by the INSERT statement. A NOT NULL check here would therefore
	-- reject every new order, which the isolated migration test proved by
	-- running the real checkout route against a migrated database (SQLSTATE
	-- 23514 on orders_order_number_not_null).
	--
	-- Instead:
	--   * every existing row is backfilled below, so legacy orders carry a real
	--   order number;
	--   * the application writes order_number for new orders in the same
	--   transaction that inserts them (see the UPDATE in POST /api/orders);
	--   * the unique index below still enforces uniqueness for any non-NULL
	--     value, and permits NULLs, so a partially written row cannot ever
	--     violate it.
	--
	-- Nothing in the application reads this column: the API derives the order
	-- number it returns to customers as 'MS-' || id in JavaScript. It exists
	-- for reporting and for the unique index.

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conrelid = 'public.orders'::regclass
			AND conname = 'orders_status_values_check'
	) THEN
		-- Must stay in exact parity with ALLOWED_STATUSES in order-routes.js.
		-- The owner API writes Pending, Confirmed, Preparing, Ready for Pickup,
		-- Picked Up and Cancelled, and legacy rows may hold Completed.
		-- Extending this list is safe; narrowing it is not.
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_status_values_check CHECK (
				lower(status) IN ('pending', 'confirmed', 'preparing', 'ready for pickup', 'completed', 'picked up', 'cancelled')
			);
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conrelid = 'public.orders'::regclass
			AND conname = 'orders_tracking_token_hash_check'
	) THEN
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_tracking_token_hash_check CHECK (
				tracking_token_hash IS NULL OR tracking_token_hash ~ '^[a-f0-9]{64}$'
			);
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conrelid = 'public.orders'::regclass
			AND conname = 'orders_idempotency_fingerprint_check'
	) THEN
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_idempotency_fingerprint_check CHECK (
				idempotency_fingerprint IS NULL OR idempotency_fingerprint ~ '^[a-f0-9]{64}$'
			);
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
			AND conrelid = 'public.orders'::regclass
			AND conname = 'orders_cancellation_reason_check'
	) THEN
		-- Mirrors the 3-500 character rule enforced by the order status API.
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_cancellation_reason_check CHECK (
				cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 3 AND 500
			);
	END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- INDEXES
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uidx
	ON public.orders (order_number);

CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_token_hash_uidx
	ON public.orders (tracking_token_hash)
	WHERE tracking_token_hash IS NOT NULL;

-- ----------------------------------------------------------------------------
-- OWNER AUTHENTICATION TABLES
-- The application hashes session identifiers and login client keys with
-- SHA-256 and never stores the raw value. Sessions expire after 8 hours.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION
-- Runs inside the same transaction, immediately before COMMIT. Any failure
-- raises an exception, which rolls back every change above, so a partially
-- applied migration cannot be committed.
--
-- Every check is stated so that it stays correct when new orders are created
-- between the preflight and the commit. Nothing here depends on a specific row
-- count, so ordinary store activity during the migration window cannot fail it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
	absent_object TEXT;
	status_definition TEXT;
	null_order_numbers BIGINT;
	duplicate_order_numbers BIGINT;
	bad_statuses BIGINT;
	bad_fingerprints BIGINT;
	bad_tracking_hashes BIGINT;
	bad_cancellation_reasons BIGINT;
	orphaned_order_items BIGINT;
BEGIN
	-- Every required column and table must now exist.
	--
	-- ELSE FALSE matters: without it a new entry added to the VALUES list below
	-- that has no matching WHEN branch makes CASE return NULL, NOT NULL is NULL,
	-- and the WHERE clause drops the row, so a genuinely missing object would
	-- be silently reported as present and verification would falsely pass.
	SELECT string_agg(wanted.object, ', ')
	INTO absent_object
	FROM (VALUES
		('orders.tracking_token_hash'),
		('orders.idempotency_fingerprint'),
		('orders.cancellation_reason'),
		('orders.order_number'),
		('owner_sessions table'),
		('owner_login_attempts table')
	) AS wanted(object)
	WHERE NOT CASE wanted.object
		WHEN 'orders.tracking_token_hash' THEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='tracking_token_hash')
		WHEN 'orders.idempotency_fingerprint' THEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='idempotency_fingerprint')
		WHEN 'orders.cancellation_reason' THEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='cancellation_reason')
		WHEN 'orders.order_number' THEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='order_number')
		WHEN 'owner_sessions table' THEN to_regclass('public.owner_sessions') IS NOT NULL
		WHEN 'owner_login_attempts table' THEN to_regclass('public.owner_login_attempts') IS NOT NULL
		ELSE FALSE
	END;

	IF absent_object IS NOT NULL THEN
		RAISE EXCEPTION 'Verification failed: required objects are still absent: %', absent_object;
	END IF;

	-- Every required index must now exist.
	SELECT string_agg(wanted.name, ', ')
	INTO absent_object
	FROM (VALUES
		('orders_order_number_uidx'),
		('orders_tracking_token_hash_uidx'),
		('owner_sessions_expires_at_idx')
	) AS wanted(name)
	WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname = wanted.name);

	IF absent_object IS NOT NULL THEN
		RAISE EXCEPTION 'Verification failed: required indexes are still absent: %', absent_object;
	END IF;

	-- Every required constraint must now exist.
	SELECT string_agg(wanted.name, ', ')
	INTO absent_object
	FROM (VALUES
		('orders_status_values_check'),
		('orders_tracking_token_hash_check'),
		('orders_idempotency_fingerprint_check'),
		('orders_cancellation_reason_check')
	) AS wanted(name)
	WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname = wanted.name);

	IF absent_object IS NOT NULL THEN
		RAISE EXCEPTION 'Verification failed: required constraints are still absent: %', absent_object;
	END IF;

	-- Existence alone is not enough for the status constraint: a narrow one left
	-- by an earlier partial run would let the owner status API keep failing, so
	-- its definition is checked too. The preflight blocks this earlier, but
	-- verification is deliberately independent of it.
	SELECT pg_get_constraintdef(oid) INTO status_definition
	FROM pg_constraint
	WHERE connamespace = 'public'::regnamespace
		AND conrelid = 'public.orders'::regclass
		AND conname = 'orders_status_values_check'
	LIMIT 1;

	IF status_definition IS NULL THEN
		RAISE EXCEPTION 'Verification failed: orders_status_values_check is absent';
	END IF;

	IF status_definition !~* 'pending'
		OR status_definition !~* 'confirmed'
		OR status_definition !~* 'preparing'
		OR status_definition !~* 'ready for pickup'
		OR status_definition !~* 'completed'
		OR status_definition !~* 'picked up'
		OR status_definition !~* 'cancelled' THEN
		RAISE EXCEPTION 'Verification failed: orders_status_values_check does not permit every status the application writes: %', status_definition;
	END IF;

	-- Existing order data must satisfy everything added above.
	-- Every row must have received an order number from the backfill above.
	SELECT count(*) INTO null_order_numbers FROM public.orders WHERE order_number IS NULL;
	IF null_order_numbers > 0 THEN
		RAISE EXCEPTION 'Verification failed: % order(s) still have a NULL order_number, so the backfill did not cover every row', null_order_numbers;
	END IF;

	SELECT count(*) INTO duplicate_order_numbers FROM (
		SELECT 1 FROM public.orders WHERE order_number IS NOT NULL GROUP BY order_number HAVING count(*) > 1
	) AS duplicates;
	IF duplicate_order_numbers > 0 THEN
		RAISE EXCEPTION 'Verification failed: % duplicate order_number value(s); the unique index cannot be created', duplicate_order_numbers;
	END IF;

	SELECT count(*) INTO bad_statuses
	FROM public.orders
	WHERE lower(status) NOT IN ('pending', 'confirmed', 'preparing', 'ready for pickup', 'completed', 'picked up', 'cancelled');
	IF bad_statuses > 0 THEN
		RAISE EXCEPTION 'Verification failed: % order(s) carry a status outside the permitted set', bad_statuses;
	END IF;

	SELECT count(*) INTO bad_fingerprints
	FROM public.orders
	WHERE idempotency_fingerprint IS NOT NULL AND idempotency_fingerprint !~ '^[a-f0-9]{64}$';
	IF bad_fingerprints > 0 THEN
		RAISE EXCEPTION 'Verification failed: % order(s) carry a malformed idempotency_fingerprint', bad_fingerprints;
	END IF;

	SELECT count(*) INTO bad_tracking_hashes
	FROM public.orders
	WHERE tracking_token_hash IS NOT NULL AND tracking_token_hash !~ '^[a-f0-9]{64}$';
	IF bad_tracking_hashes > 0 THEN
		RAISE EXCEPTION 'Verification failed: % order(s) carry a malformed tracking_token_hash', bad_tracking_hashes;
	END IF;

	SELECT count(*) INTO bad_cancellation_reasons
	FROM public.orders
	WHERE cancellation_reason IS NOT NULL AND char_length(btrim(cancellation_reason)) NOT BETWEEN 3 AND 500;
	IF bad_cancellation_reasons > 0 THEN
		RAISE EXCEPTION 'Verification failed: % order(s) carry a cancellation_reason outside 3-500 characters', bad_cancellation_reasons;
	END IF;

	-- Referential integrity of existing order items must be intact.
	SELECT count(*) INTO orphaned_order_items
	FROM public.order_items oi
	WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = oi.order_id);
	IF orphaned_order_items > 0 THEN
		RAISE EXCEPTION 'Verification failed: % order item(s) have no parent order; inspect before running this migration', orphaned_order_items;
	END IF;

	RAISE NOTICE 'Verification passed: all required columns, tables, indexes and constraints are present, and existing order data satisfies them.';
END;
$$;

COMMIT;

-- ----------------------------------------------------------------------------
-- STANDALONE VERIFICATION QUERIES (run after committing, read-only)
--
-- 1. Confirm every required object exists. Every row must report true.
--    SELECT 'orders.tracking_token_hash' AS object,
--           EXISTS (SELECT 1 FROM information_schema.columns
--                   WHERE table_schema='public' AND table_name='orders'
--                     AND column_name='tracking_token_hash') AS present
--    UNION ALL SELECT 'orders.idempotency_fingerprint',
--           EXISTS (SELECT 1 FROM information_schema.columns
--                   WHERE table_schema='public' AND table_name='orders'
--                     AND column_name='idempotency_fingerprint')
--    UNION ALL SELECT 'orders.cancellation_reason',
--           EXISTS (SELECT 1 FROM information_schema.columns
--                   WHERE table_schema='public' AND table_name='orders'
--                     AND column_name='cancellation_reason')
--    UNION ALL SELECT 'orders.order_number',
--           EXISTS (SELECT 1 FROM information_schema.columns
--                   WHERE table_schema='public' AND table_name='orders'
--                     AND column_name='order_number')
--    UNION ALL SELECT 'public.owner_sessions', to_regclass('public.owner_sessions') IS NOT NULL
--    UNION ALL SELECT 'public.owner_login_attempts', to_regclass('public.owner_login_attempts') IS NOT NULL;
--
-- 2. Confirm the four constraints and three indexes exist, and that the status
--    constraint lists all seven statuses.
--    SELECT conname FROM pg_constraint
--    WHERE connamespace='public'::regnamespace
--      AND conname IN ('orders_status_values_check',
--                     'orders_tracking_token_hash_check','orders_idempotency_fingerprint_check',
--                     'orders_cancellation_reason_check')
--    ORDER BY conname;
--    SELECT indexname FROM pg_indexes WHERE schemaname='public'
--      AND indexname IN ('orders_order_number_uidx','orders_tracking_token_hash_uidx',
--                        'owner_sessions_expires_at_idx')
--      ORDER BY indexname;
--    SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE connamespace='public'::regnamespace AND conname='orders_status_values_check';
--
-- 3. Confirm the backfilled order numbers and the corrected default.
--    SELECT id, order_number, status FROM public.orders ORDER BY id;
--    SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='orders' AND column_name='status';
--
-- 4. Confirm aggregate counts before and after are unchanged for products.
--    SELECT (SELECT count(*) FROM products) AS products,
--           (SELECT count(*) FROM orders) AS orders,
--           (SELECT count(*) FROM order_items) AS order_items;
--
-- 5. Confirm legacy tracking credentials were preserved, without exposing them.
--    SELECT count(*) AS total_orders,
--           count(*) FILTER (WHERE customer_access_token IS NOT NULL) AS with_legacy_credential,
--           count(*) FILTER (WHERE tracking_token_hash IS NOT NULL) AS with_hashed_credential
--    FROM public.orders;
-- ----------------------------------------------------------------------------
