-- ============================================================================
-- owner-account-and-products.sql
--
-- PREPARED MIGRATION - NOT YET APPLIED TO PRODUCTION.
--
-- Adds the minimum schema required by the owner Account Settings (change and
-- reset password) and Product Management sections of the owner dashboard.
-- Five additive objects only; nothing existing is removed or rewritten.
--
--   1. public.owner_credentials        where the owner password hash lives,
--                                      so it can be changed without a redeploy
--   2. public.owner_reset_tokens       single-use, hashed, expiring reset tokens
--   3. public.products.is_published    hide/unpublish without deleting a row
--   4. public.owner_contact            the owner email a reset link is sent to
--   5. public.product_images           uploaded product photos, stored in the
--                                      database so they survive a redeploy
--
-- The application does NOT run this file at startup. Apply it manually in the
-- Neon SQL Editor as one transaction, exactly like production-order-system.sql.
-- Every statement is guarded so the file is safe to re-run: the catalog may
-- grow or shrink through the owner dashboard and a rerun will still succeed.
-- The whole file is one transaction, so any failing check aborts it whole and
-- leaves nothing behind. That also means a failed run leaves the SQL Editor
-- session holding an aborted transaction, so issue a ROLLBACK before running
-- anything else in that session. Nothing in this file changes existing rows.
--
-- WHY EACH IS NEEDED
--
--   owner_credentials  Today the owner password hash is read from the
--                      OWNER_PASSWORD_HASH environment variable, which cannot
--                      be changed from inside the application. A change-password
--                      feature needs a mutable store. The environment variable
--                      remains the fallback, so existing deployments keep
--                      working if this migration has not been applied.
--
--   owner_reset_tokens A reset flow must store only a hash of each token, must
--                      expire it, and must mark it consumed after one use.
--
--   is_published       The products table has no visibility column, so
--                      hide/unpublish is impossible without one.
--
--   product_images     An uploaded product photo has to live somewhere that
--                      survives a redeploy. The bytes are kept in the database
--                      with the name and MIME type the server derived from the
--                      file's own leading bytes, so neither can be spoofed.
--
-- ROLLBACK
--   Redeploying the previous application release is the preferred recovery:
--   all five objects are inert to code that does not read them. If the schema
--   itself must be reverted, restore to a restore point taken before applying,
--   or drop the five objects explicitly. Dropping public.owner_reset_tokens
--   only invalidates outstanding reset links. Dropping public.owner_credentials
--   returns the owner to logging in with the OWNER_PASSWORD_HASH environment
--   variable. Dropping products.is_published makes every product publishable
--   again, which restores rows to their current visible state. Dropping
--   public.product_images removes the uploaded photos, so the products that
--   point at them lose their image. Never drop
--   public.orders or public.order_items as part of this rollback.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- PREFLIGHT (read-only)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
	IF to_regclass('public.products') IS NULL THEN
		RAISE EXCEPTION 'Preflight failed: public.products does not exist.';
	END IF;

	-- the owner auth tables this work depends on must already exist
	IF to_regclass('public.owner_sessions') IS NULL
		OR to_regclass('public.owner_login_attempts') IS NULL THEN
		RAISE EXCEPTION 'Preflight failed: apply production-order-system.sql first; owner_sessions and owner_login_attempts are required.';
	END IF;

	-- is_published must not already exist with a different type
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema='public' AND table_name='products' AND column_name='is_published'
	) THEN
		DECLARE existing_type TEXT;
		BEGIN
			SELECT data_type INTO existing_type
			FROM information_schema.columns
			WHERE table_schema='public' AND table_name='products' AND column_name='is_published';
			IF existing_type IS DISTINCT FROM 'boolean' THEN
				RAISE EXCEPTION 'Preflight failed: products.is_published already exists as %, expected boolean.', existing_type;
			END IF;
		END;
	END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. Owner credentials
--    password_hash has exactly the same scrypt$salt$hash shape the existing
--    auth code parses, so there is one format in the system.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.owner_credentials (
	singleton BOOLEAN PRIMARY KEY DEFAULT true,
	password_hash TEXT NOT NULL CHECK (password_hash ~ '^scrypt\$[a-f0-9]{32,}\$[a-f0-9]{128}$'),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT owner_credentials_singleton CHECK (singleton)
);

-- ----------------------------------------------------------------------------
-- 2. Password reset tokens
--    Only the SHA-256 digest of each token is stored. consumed_at enforces
--    single use; expires_at enforces expiry.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.owner_reset_tokens (
	token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
	expires_at TIMESTAMPTZ NOT NULL,
	consumed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS owner_reset_tokens_expires_at_idx
	ON public.owner_reset_tokens (expires_at);

-- ----------------------------------------------------------------------------
-- 3. Product visibility
--    Defaults to true so every existing product stays published, exactly as it
--    is today, with no action required.
-- ----------------------------------------------------------------------------
ALTER TABLE public.products
	ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT true;

-- ----------------------------------------------------------------------------
-- 4. Owner email (used by the password-reset request flow once a delivery
--    provider is configured). Stored as TEXT with no verification of its own;
--    the application must confirm the address out of band. Nullable, because
--    no verified owner email exists in this project yet.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.owner_contact (
	singleton BOOLEAN PRIMARY KEY DEFAULT true,
	email TEXT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT owner_contact_singleton CHECK (singleton)
);

-- ----------------------------------------------------------------------------
-- 5. Uploaded product photos
--    The bytes live in the database so they survive a redeploy. The name is the
--    server-generated one (32 hex characters and the extension derived from the
--    file's own leading bytes), and the MIME type is one of the five the
--    sniffer accepts, so neither can be chosen by the browser. size_bytes is
--    checked against the same 5 MB limit the upload route enforces.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_images (
	name TEXT PRIMARY KEY CHECK (name ~ '^[a-f0-9]{32}\.(png|jpg|webp|gif|avif)$'),
	mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif')),
	data BYTEA NOT NULL,
	size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
	created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS product_images_created_at_idx
	ON public.product_images (created_at);

-- ----------------------------------------------------------------------------
-- VERIFICATION (read the values back and fail loudly)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
	absent_object TEXT;
	visibility_default TEXT;
	visibility_nullable TEXT;
	null_visibility BIGINT;
	invalid_prices BIGINT;
BEGIN
	SELECT string_agg(wanted.name, ', ')
	INTO absent_object
	FROM (VALUES
		('owner_credentials'),
		('owner_reset_tokens'),
		('owner_contact'),
		('products.is_published'),
		('product_images')
	) AS wanted(name)
	WHERE NOT CASE wanted.name
		WHEN 'owner_credentials' THEN to_regclass('public.owner_credentials') IS NOT NULL
		WHEN 'owner_reset_tokens' THEN to_regclass('public.owner_reset_tokens') IS NOT NULL
		WHEN 'owner_contact' THEN to_regclass('public.owner_contact') IS NOT NULL
		WHEN 'product_images' THEN to_regclass('public.product_images') IS NOT NULL
		WHEN 'products.is_published' THEN EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name='products' AND column_name='is_published')
		ELSE FALSE
	END;

	IF absent_object IS NOT NULL THEN
		RAISE EXCEPTION 'Verification failed: required objects are still absent: %', absent_object;
	END IF;

	-- The backfill is what makes this migration safe: existing products are
	-- filled with true, so nothing becomes hidden. That property comes from the
	-- column being NOT NULL with a true default, which is a schema invariant and
	-- can therefore be re-checked on every run without caring how the catalog
	-- has changed since.
	SELECT information_schema.columns.column_default,
	       information_schema.columns.is_nullable
	  INTO visibility_default, visibility_nullable
	FROM information_schema.columns
	WHERE table_schema='public' AND table_name='products' AND column_name='is_published';
	IF visibility_default IS DISTINCT FROM 'true' OR visibility_nullable IS DISTINCT FROM 'NO' THEN
		RAISE EXCEPTION 'Verification failed: products.is_published must be NOT NULL DEFAULT true (found default %, nullable %).', visibility_default, visibility_nullable;
	END IF;

	-- A NULL would only come from a write that bypassed the default, which is a
	-- genuine defect. Unlike a row count this is unaffected by the owner adding
	-- or removing products, so it stays valid on every rerun.
	SELECT count(*) INTO null_visibility FROM public.products WHERE is_published IS NULL;
	IF null_visibility > 0 THEN
		RAISE EXCEPTION 'Verification failed: % product(s) have a NULL is_published value.', null_visibility;
	END IF;

	-- Every product must carry a usable price. Products are added and removed
	-- through the owner dashboard, so the catalog count is expected to change
	-- and the migration deliberately does not depend on it. A missing or
	-- non-positive price is a genuine defect the migration would expose, so it
	-- is still checked.
	SELECT count(*) INTO invalid_prices FROM public.products WHERE price IS NULL OR price <= 0;
	IF invalid_prices > 0 THEN
		RAISE EXCEPTION 'Verification failed: % product(s) have a missing or non-positive price. Inspect the catalog before running this migration.', invalid_prices;
	END IF;

	RAISE NOTICE 'Verification passed: owner credentials, reset tokens, owner contact, product visibility and stored product images are in place.';
END;
$$;

COMMIT;

-- ----------------------------------------------------------------------------
-- STANDALONE VERIFICATION QUERIES (read-only, after committing)
--
-- SELECT to_regclass('public.owner_credentials'),
--        to_regclass('public.owner_reset_tokens'),
--        to_regclass('public.owner_contact'),
--        to_regclass('public.product_images');
--
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='products' AND column_name='is_published';
--
-- SELECT count(*) AS products,
--        count(*) FILTER (WHERE is_published) AS published
-- FROM public.products;   -- expect every product to be published on the
--                          -- first run; later runs may legitimately be less
-- ----------------------------------------------------------------------------
