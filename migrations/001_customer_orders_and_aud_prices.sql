BEGIN;

DO $$
DECLARE
	column_type TEXT;
	product_rows INTEGER;
	orders_primary_key BOOLEAN;
	order_items_foreign_key BOOLEAN;
BEGIN
	IF to_regclass('public.products') IS NULL
		OR to_regclass('public.orders') IS NULL
		OR to_regclass('public.order_items') IS NULL THEN
		RAISE EXCEPTION 'Expected existing public.products, public.orders, and public.order_items tables were not all found; no migration applied.';
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM pg_constraint con
		WHERE con.conrelid = 'public.orders'::regclass
			AND con.contype = 'p'
			AND con.conkey = ARRAY[
				(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.orders'::regclass AND attname = 'id')
			]::SMALLINT[]
	) INTO orders_primary_key;
	IF NOT orders_primary_key THEN
		RAISE EXCEPTION 'Expected public.orders primary key on id was not found; inspect schema before migration.';
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM pg_constraint con
		WHERE con.conrelid = 'public.order_items'::regclass
			AND con.confrelid = 'public.orders'::regclass
			AND con.contype = 'f'
			AND con.conkey = ARRAY[
				(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.order_items'::regclass AND attname = 'order_id')
			]::SMALLINT[]
			AND con.confkey = ARRAY[
				(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.orders'::regclass AND attname = 'id')
			]::SMALLINT[]
	) INTO order_items_foreign_key;
	IF NOT order_items_foreign_key THEN
		RAISE EXCEPTION 'Expected existing order_items.order_id foreign key to orders.id was not found; inspect schema before migration.';
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.products'::regclass AND a.attname = 'id'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type IS DISTINCT FROM 'int4' THEN
		RAISE EXCEPTION 'Expected public.products.id to be INTEGER; found %. No migration applied.', column_type;
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.products'::regclass AND a.attname = 'name'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type NOT IN ('varchar', 'text', 'bpchar') THEN
		RAISE EXCEPTION 'Expected public.products.name to be a string column; found %. No migration applied.', column_type;
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.products'::regclass AND a.attname = 'price'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type IS DISTINCT FROM 'numeric' THEN
		RAISE EXCEPTION 'Expected public.products.price to be NUMERIC; found %. No migration applied.', column_type;
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.products'::regclass AND a.attname = 'original_price'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type IS DISTINCT FROM 'numeric' THEN
		RAISE EXCEPTION 'Expected public.products.original_price to be NUMERIC; found %. No migration applied.', column_type;
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.orders'::regclass AND a.attname = 'id'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type IS DISTINCT FROM 'int4' THEN
		RAISE EXCEPTION 'Expected public.orders.id to be INTEGER; found %. No migration applied.', column_type;
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.order_items'::regclass AND a.attname = 'id'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type IS DISTINCT FROM 'int4' THEN
		RAISE EXCEPTION 'Expected public.order_items.id to be INTEGER; found %. No migration applied.', column_type;
	END IF;

	SELECT t.typname INTO column_type
	FROM pg_attribute a
	JOIN pg_type t ON t.oid = a.atttypid
	WHERE a.attrelid = 'public.order_items'::regclass AND a.attname = 'order_id'
		AND a.attnum > 0 AND NOT a.attisdropped;
	IF column_type IS DISTINCT FROM 'int4' THEN
		RAISE EXCEPTION 'Expected public.order_items.order_id to be INTEGER; found %. No migration applied.', column_type;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (VALUES
			('orders', 'customer_id', 'int4'),
			('orders', 'subtotal', 'numeric'),
			('orders', 'discount', 'numeric'),
			('orders', 'shipping_fee', 'numeric'),
			('orders', 'total', 'numeric'),
			('orders', 'status', 'varchar'),
			('order_items', 'product_id', 'int4'),
			('order_items', 'quantity', 'int4'),
			('order_items', 'price', 'numeric')
		) AS expected(table_name, column_name, type_name)
		LEFT JOIN pg_attribute a
			ON a.attrelid = to_regclass('public.' || expected.table_name)
			AND a.attname = expected.column_name
			AND a.attnum > 0
			AND NOT a.attisdropped
		LEFT JOIN pg_type t ON t.oid = a.atttypid
		WHERE t.typname IS DISTINCT FROM expected.type_name
	) THEN
		RAISE EXCEPTION 'Existing order columns do not match the inspected schema; no migration applied.';
	END IF;

	IF EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid = 'public.orders'::regclass
			AND attname = 'customer_id'
			AND attnum > 0
			AND NOT attisdropped
			AND attnotnull
	) THEN
		RAISE EXCEPTION 'Expected public.orders.customer_id to allow NULL for guest checkout; no migration applied.';
	END IF;

	SELECT COUNT(*) INTO product_rows
	FROM public.products p
	JOIN (VALUES
		(73, 'Pocari Sweat 330ml'),
		(74, 'Thai Coco Coconut Juice'),
		(75, 'Jufran Banana Sauce 560g'),
		(76, 'Angel Evaporated Filled Milk 370ml'),
		(77, 'Angel Kremdensada 410ml'),
		(78, 'Angel All Purpose Creamer 370ml'),
		(79, 'Magnolia Gold Label Macapuno Ube Swirl'),
		(80, 'FIC Pinoy Sorbetes Ube Queso de Bola 460ml'),
		(81, 'FIC Pinoy Sorbetes Buko Pandan 460ml'),
		(82, 'FIC Pinoy Sorbetes Mango 460ml'),
		(83, 'FIC Pinoy Sorbetes Ube Macapuno 460ml'),
		(84, 'Cooked Peanut 500g'),
		(85, 'Special Odong 12 Packs'),
		(86, 'Dr. Korean Sliced Kimchi'),
		(87, 'Reno Liver Spread 85g'),
		(88, 'Purefoods Liver Spread 85g'),
		(89, 'Lucky Me! Pancit Canton Chilimansi 60g x 6'),
		(90, 'Coco Mama Fresh Gata')
	) AS approved(id, name) ON p.id = approved.id AND p.name = approved.name;
	IF product_rows <> 18 THEN
		RAISE EXCEPTION 'Expected all 18 approved product IDs/names; found % matching rows. No migration applied.', product_rows;
	END IF;

	IF EXISTS (
		SELECT 1 FROM public.order_items
		WHERE quantity <= 0 OR price < 0
	) THEN
		RAISE EXCEPTION 'Existing order_items contain non-positive quantities or negative prices; inspect data before migration.';
	END IF;
END
$$;

ALTER TABLE public.orders
	ADD COLUMN IF NOT EXISTS customer_name TEXT,
	ADD COLUMN IF NOT EXISTS customer_contact TEXT,
	ADD COLUMN IF NOT EXISTS customer_email TEXT,
	ADD COLUMN IF NOT EXISTS pickup_type TEXT,
	ADD COLUMN IF NOT EXISTS requested_pickup_date DATE,
	ADD COLUMN IF NOT EXISTS requested_pickup_time TIME WITHOUT TIME ZONE,
	ADD COLUMN IF NOT EXISTS requested_pickup_at TIMESTAMPTZ,
	ADD COLUMN IF NOT EXISTS confirmed_pickup_date DATE,
	ADD COLUMN IF NOT EXISTS confirmed_pickup_time TIME WITHOUT TIME ZONE,
	ADD COLUMN IF NOT EXISTS confirmed_pickup_at TIMESTAMPTZ,
	ADD COLUMN IF NOT EXISTS customer_access_token_hash CHAR(64),
	ADD COLUMN IF NOT EXISTS idempotency_key_hash CHAR(64),
	ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64),
	ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE public.order_items
	ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT,
	ADD COLUMN IF NOT EXISTS subtotal NUMERIC;

UPDATE public.order_items item
SET subtotal = item.price * item.quantity
WHERE item.subtotal IS NULL;

UPDATE public.order_items item
SET product_name_snapshot = product.name
FROM public.products product
WHERE item.product_name_snapshot IS NULL
	AND item.product_id = product.id;

DO $$
DECLARE
	constraint_name TEXT;
BEGIN
	FOREACH constraint_name IN ARRAY ARRAY[
		'orders_customer_name_check',
		'orders_customer_contact_check',
		'orders_customer_email_check',
		'orders_pickup_type_check',
		'orders_requested_pickup_check',
		'orders_confirmed_pickup_check',
		'orders_status_values_check',
		'orders_access_token_hash_check',
		'orders_idempotency_hash_check',
		'orders_request_fingerprint_check',
		'order_items_quantity_positive_check',
		'order_items_price_nonnegative_check',
		'order_items_subtotal_matches_check'
	]
	LOOP
		IF EXISTS (
			SELECT 1 FROM pg_constraint con
			WHERE con.conrelid IN ('public.orders'::regclass, 'public.order_items'::regclass)
				AND con.conname = constraint_name
		) THEN
			RAISE EXCEPTION 'Constraint % already exists; inspect and reconcile it before migration.', constraint_name;
		END IF;
	END LOOP;
END
$$;

ALTER TABLE public.orders
	ADD CONSTRAINT orders_customer_name_check
		CHECK (customer_name IS NULL OR char_length(btrim(customer_name)) BETWEEN 1 AND 100),
	ADD CONSTRAINT orders_customer_contact_check
		CHECK (customer_contact IS NULL OR char_length(customer_contact) BETWEEN 7 AND 25),
	ADD CONSTRAINT orders_customer_email_check
		CHECK (customer_email IS NULL OR char_length(customer_email) <= 254),
	ADD CONSTRAINT orders_pickup_type_check
		CHECK (pickup_type IS NULL OR pickup_type IN ('ASAP', 'SCHEDULED')),
	ADD CONSTRAINT orders_requested_pickup_check
		CHECK (
			pickup_type IS NULL
			OR (pickup_type = 'ASAP' AND requested_pickup_date IS NOT NULL AND requested_pickup_time IS NULL AND requested_pickup_at IS NOT NULL)
			OR (pickup_type = 'SCHEDULED' AND requested_pickup_date IS NOT NULL AND requested_pickup_time IS NOT NULL AND requested_pickup_at IS NOT NULL)
		),
	ADD CONSTRAINT orders_confirmed_pickup_check
		CHECK (
			(confirmed_pickup_date IS NULL AND confirmed_pickup_time IS NULL AND confirmed_pickup_at IS NULL)
			OR (confirmed_pickup_date IS NOT NULL AND confirmed_pickup_time IS NOT NULL AND confirmed_pickup_at IS NOT NULL)
		),
	ADD CONSTRAINT orders_status_values_check
		CHECK (lower(status) IN ('pending', 'confirmed', 'preparing', 'ready for pickup', 'completed', 'cancelled')),
	ADD CONSTRAINT orders_access_token_hash_check
		CHECK (customer_access_token_hash IS NULL OR customer_access_token_hash ~ '^[a-f0-9]{64}$'),
	ADD CONSTRAINT orders_idempotency_hash_check
		CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[a-f0-9]{64}$'),
	ADD CONSTRAINT orders_request_fingerprint_check
		CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$');

ALTER TABLE public.order_items
	ALTER COLUMN subtotal SET NOT NULL,
	ADD CONSTRAINT order_items_quantity_positive_check CHECK (quantity BETWEEN 1 AND 99),
	ADD CONSTRAINT order_items_price_nonnegative_check CHECK (price >= 0),
	ADD CONSTRAINT order_items_subtotal_matches_check CHECK (subtotal = price * quantity);

CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_access_token_hash_uidx
	ON public.orders (customer_access_token_hash)
	WHERE customer_access_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_hash_uidx
	ON public.orders (idempotency_key_hash)
	WHERE idempotency_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_status_pickup_priority_idx
	ON public.orders (status, pickup_type, requested_pickup_date, requested_pickup_time, created_at);
CREATE INDEX IF NOT EXISTS orders_effective_pickup_priority_idx
	ON public.orders ((COALESCE(confirmed_pickup_at, requested_pickup_at)), created_at);
CREATE INDEX IF NOT EXISTS orders_created_at_idx
	ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx
	ON public.order_items (order_id);

DO $$
DECLARE
	updated_count INTEGER;
BEGIN
	UPDATE public.products AS product
	SET price = approved.price
	FROM (VALUES
		(73, 'Pocari Sweat 330ml', 1.50::NUMERIC),
		(74, 'Thai Coco Coconut Juice', 2.00::NUMERIC),
		(75, 'Jufran Banana Sauce 560g', 2.50::NUMERIC),
		(76, 'Angel Evaporated Filled Milk 370ml', 2.00::NUMERIC),
		(77, 'Angel Kremdensada 410ml', 2.50::NUMERIC),
		(78, 'Angel All Purpose Creamer 370ml', 2.50::NUMERIC),
		(79, 'Magnolia Gold Label Macapuno Ube Swirl', 8.50::NUMERIC),
		(80, 'FIC Pinoy Sorbetes Ube Queso de Bola 460ml', 4.50::NUMERIC),
		(81, 'FIC Pinoy Sorbetes Buko Pandan 460ml', 4.50::NUMERIC),
		(82, 'FIC Pinoy Sorbetes Mango 460ml', 4.50::NUMERIC),
		(83, 'FIC Pinoy Sorbetes Ube Macapuno 460ml', 4.50::NUMERIC),
		(84, 'Cooked Peanut 500g', 3.50::NUMERIC),
		(85, 'Special Odong 12 Packs', 2.50::NUMERIC),
		(86, 'Dr. Korean Sliced Kimchi', 5.50::NUMERIC),
		(87, 'Reno Liver Spread 85g', 1.50::NUMERIC),
		(88, 'Purefoods Liver Spread 85g', 1.50::NUMERIC),
		(89, 'Lucky Me! Pancit Canton Chilimansi 60g x 6', 2.00::NUMERIC),
		(90, 'Coco Mama Fresh Gata', 2.00::NUMERIC)
	) AS approved(id, name, price)
	WHERE product.id = approved.id
		AND product.name = approved.name;

	GET DIAGNOSTICS updated_count = ROW_COUNT;
	IF updated_count <> 18 THEN
		RAISE EXCEPTION 'Expected to update exactly 18 approved products, updated %; transaction rolled back.', updated_count;
	END IF;
END
$$;

COMMIT;
