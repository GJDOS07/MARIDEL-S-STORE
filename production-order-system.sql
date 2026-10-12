BEGIN;

ALTER TABLE public.orders
	ADD COLUMN IF NOT EXISTS order_number TEXT,
	ADD COLUMN IF NOT EXISTS tracking_token_hash CHAR(64),
	ADD COLUMN IF NOT EXISTS idempotency_fingerprint CHAR(64),
	ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

UPDATE public.orders
SET order_number = 'MS-' || id::text
WHERE order_number IS NULL;

ALTER TABLE public.orders
	ALTER COLUMN status SET DEFAULT 'Pending';

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'public.orders'::regclass
			AND conname = 'orders_order_number_not_null'
	) THEN
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_order_number_not_null CHECK (order_number IS NOT NULL);
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'public.orders'::regclass
			AND conname = 'orders_status_values_check'
	) THEN
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_status_values_check CHECK (
				status IN ('Pending', 'Confirmed', 'Ready for Pickup', 'Picked Up', 'Cancelled')
			);
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'public.orders'::regclass
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
		WHERE conrelid = 'public.orders'::regclass
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
		WHERE conrelid = 'public.orders'::regclass
			AND conname = 'orders_cancellation_reason_check'
	) THEN
		ALTER TABLE public.orders
			ADD CONSTRAINT orders_cancellation_reason_check CHECK (
				cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 3 AND 500
			);
	END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uidx
	ON public.orders (order_number);

CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_token_hash_uidx
	ON public.orders (tracking_token_hash)
	WHERE tracking_token_hash IS NOT NULL;

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
