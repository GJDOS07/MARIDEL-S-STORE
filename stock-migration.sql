-- ============================================================================
-- stock-migration.sql
--
-- STOCK COLUMNS FOR MARIDEL'S STORE
--
-- Run this manually (Neon SQL Editor or psql) as a single transaction, exactly
-- like production-order-system.sql. The application never runs migrations
-- itself and does not read this file at startup.
--
-- WHAT IT ADDS
--   Two columns on public.products:
--     stock                INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
--     low_stock_threshold  INTEGER NOT NULL DEFAULT 5
--
-- IDEMPOTENT
--   ADD COLUMN IF NOT EXISTS, so re-running the file is safe and it no-ops
--   cleanly on any database that already carries one or both columns. It never
--   rewrites or removes an existing column, and it changes no data. Products
--   that already have a stock value keep it; products on a database that gains
--   the column here start at 0 (sold out) with a default threshold of 5.
--
-- NOT APPLIED YET
--   Do not run against production until approved. The application detects the
--   threshold column at runtime (the same way products.is_published is
--   detected) and behaves with the built-in default of 5 until the column
--   exists, so applying this migration is not urgent for the code to run.
--
-- VERIFICATION (run after committing, read-only)
--   SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='products'
--     AND column_name IN ('stock', 'low_stock_threshold')
--   ORDER BY column_name;
-- ============================================================================

BEGIN;

ALTER TABLE public.products
	ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0);

ALTER TABLE public.products
	ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5;

COMMIT;
