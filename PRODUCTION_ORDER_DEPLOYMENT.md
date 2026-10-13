# Production order system deployment

This runbook documents the additive database change required by the owner dashboard and the updated customer-tracking implementation. The SQL has not been executed. Never run it automatically from the application or as part of a deploy.

## Read-only production observations

The public Render endpoints returned HTTP 200 during the latest check for `/`, `/api/products`, and `/api/products/73`. A read-only PostgreSQL catalog query authenticated successfully and found:

- `products` has the fields used by the storefront (`id`, `name`, `category`, `price`, `original_price`, `image`, `description`) and an existing `stock` integer with default `0`.
- `orders` has the legacy `pickup_date` DATE, `pickup_time` TEXT, `requested_pickup_time` TEXT, `idempotency_key` TEXT, and `customer_access_token` TEXT fields. A unique index exists on `idempotency_key`; a unique index also exists on `customer_access_token`.
- `order_items` has `product_name`, `price`, `unit_price`, and `subtotal`; `product_name_snapshot` is not present.
- The queried schema did not include `tracking_token_hash`, `idempotency_fingerprint`, or `cancellation_reason`, and did not include `owner_sessions` or `owner_login_attempts`.
- An aggregate-only query found two orders with status `Pending`. No order/customer details were read.

The previous `28P01 invalid_password` report is not reproduced by the current configured database connection. Do not expose or copy connection values when checking it again.

### Re-verified read-only, 2026-10-12

A second read-only inspection (`BEGIN; SET TRANSACTION READ ONLY;` … `ROLLBACK`; catalog and aggregate queries only; no row values, order details, or credential values read) confirmed the observations above and added:

- The objects the deployed application requires are still **missing**: `orders.tracking_token_hash`, `orders.idempotency_fingerprint`, `orders.cancellation_reason`, `orders.order_number`, and the `owner_sessions` and `owner_login_attempts` tables.
- Live impact while the code is deployed ahead of the schema: `POST /api/orders` fails on the `idempotency_fingerprint` insert (customer checkout), `POST /api/orders/track` and `GET /api/orders/:orderId` fail on the `tracking_token_hash` predicate (customer tracking), `GET /api/owner/orders` and `GET /api/owner/orders/:orderId` fail on the `cancellation_reason` select (owner dashboard), and `POST /api/owner/login` fails on `owner_login_attempts` and `owner_sessions` (owner authentication). `GET /` and `GET /api/products` stay healthy because the `products` table is complete.
- Aggregate counts: 18 products, 2 orders (both `Pending`), 2 order items. Both existing orders have a non-null `customer_access_token` between 40 and 512 characters, so the tracking length gate already accepts every legacy credential.
- `orders.status` still defaults to lowercase `pending`; the migration below corrects the default.

### Corrections applied to the migration files

- `production-order-system.sql`'s `orders_status_values_check` originally listed only `Pending`, `Confirmed`, `Ready for Pickup`, `Picked Up`, `Cancelled`. That omits `Preparing`, which the owner status API writes in the normal `Pending → Confirmed → Preparing → Ready for Pickup` flow, and `Completed`, which legacy rows can hold. Applying it would have failed those updates. It now compares `lower(status)` against the full `ALLOWED_STATUSES` set from `order-routes.js`. `migration-contract.test.js` enforces that parity.
- `migrations/001_customer_orders_and_aud_prices.sql` is a stale, never-applied design. None of its columns exist, and it must not be applied: it rewrites the prices of 18 approved products, it creates columns the application does not use while omitting the ones it does, and it defines `orders_status_values_check` with a list that omits `picked up`, colliding with the active migration. It is now marked superseded in place; it was not deleted.

### Confirmed live failure - 2026-10-12

The reported `An internal server error occurred` was reproduced against the live API with GET-only requests plus one SELECT-only lookup. **`POST /api/orders/track` returns HTTP 500 with `{"error":"An internal server error occurred","code":"INTERNAL_ERROR"}`.**

| Workflow | Endpoint | Live result | Cause |
|---|---|---|---|
| Customer order tracking | `POST /api/orders/track` | **500 confirmed live** | SQLSTATE `42703` - `column "tracking_token_hash" does not exist` |
| Customer order lookup | `GET /api/orders/:orderId` | same query shape | `42703` - `column "tracking_token_hash" does not exist` |
| Customer checkout | `POST /api/orders` | 500 (schema) | `42703` - `column "idempotency_fingerprint" does not exist` |
| Owner order list / detail | `GET /api/owner/orders`, `/api/owner/orders/:id` | 500 (schema) | `42703` - `column "cancellation_reason" does not exist` |
| Owner status update / cancel | `POST /api/owner/orders/:id/status` | 500 (schema) | `42703` - `column "cancellation_reason" does not exist` |
| Owner authentication | every `/api/owner/*` route via `requireOwner()` | 500 (schema) | `42P01` - `relation "owner_sessions" does not exist` |
| Owner login | `POST /api/owner/login` | 500 (schema) | `42P01` - `relation "owner_login_attempts" does not exist` |

`GET /`, `GET /api/products` and `GET /api/pickup/availability` all return 200, which is why the storefront looks healthy while tracking, checkout and all owner features are broken.

Corrections to the earlier audit:

- **`orders.order_number` is missing, but it is not a cause of any failure.** No SQL statement in `order-routes.js` references an `order_number` column; the order number is derived in JavaScript as a template literal producing `MS-<id>`. The migration still adds the column for its unique index, but it is not required for the application to work. A regression test now asserts the column is never referenced in application SQL.
- **The owner routes were not verifiable by live probe.** `GET /api/owner/*` without a session cookie returns a clean 401, because `requireOwner()` short-circuits before it queries `owner_sessions`. Those workflows are diagnosed from the schema and the exact PostgreSQL error messages, not from a live request.

### Diagnostic improvement in `api-error-handler.js`

Previously a `42P01` was logged as only `{ method, code: '42P01' }`, which does not name the missing table. `node-postgres` does not populate `error.table`/`error.column` for a simple query, so the object name was unrecoverable from the log. The handler now recognises SQLSTATE `42703` and `42P01`, extracts the object name from the message under a strict identifier pattern, and records `missing_object` plus a `remediation` pointer to this migration. The client response is unchanged and remains the generic 500. Unrecognised codes and non-conforming messages are still logged without any detail.

## Before the production change

1. Confirm the exact public storefront origin (including scheme and hostname) for `FRONTEND_ORIGINS`. The production fallback is `https://gjdos07.github.io`; set the verified origin explicitly in Render.
2. Create an approved Neon restore point/branch. If unavailable, use an approved encrypted backup process and verify that the backup can be read. A database backup contains customer information; do not send or upload it to an unapproved service.
3. Record only aggregate counts for `products`, `orders`, and `order_items`. Do not copy customer records, order details, product prices, or credentials into deployment notes.
4. Recheck existing order statuses before applying the status constraint in `production-order-system.sql`. The prior aggregate query found only `Pending`.
5. Generate and configure `OWNER_PASSWORD_HASH` and `OWNER_SESSION_SECRET` as Render secrets. Do not place these values in source control.
6. Confirm `DATABASE_URL`, `FRONTEND_ORIGINS`, `OWNER_PASSWORD_HASH`, and `OWNER_SESSION_SECRET` are configured as appropriate.

## Preflight steps before running the migration

The migration file performs its own preflight and verification, so these steps are a confirmation, not a requirement. Run them read-only first and record the results.

1. Confirm the migration has not already been applied. Every row must report 0.

```sql
SELECT * FROM (VALUES
  ('orders.order_number',            (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='order_number')),
  ('orders.tracking_token_hash',     (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='tracking_token_hash')),
  ('orders.idempotency_fingerprint', (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='idempotency_fingerprint')),
  ('orders.cancellation_reason',     (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'  AND column_name='cancellation_reason')),
  ('public.owner_sessions',          (SELECT count(*) FROM information_schema.tables   WHERE table_schema='public' AND table_name='owner_sessions')),
  ('public.owner_login_attempts',    (SELECT count(*) FROM information_schema.tables   WHERE table_schema='public' AND table_name='owner_login_attempts'))
) AS p(object, found);
```

Verified read-only on 2026-10-12: all six reported 0.

2. Confirm every existing `orders.status` value is inside the permitted set, so the new constraint validates existing rows.

```sql
SELECT status, count(*) FROM public.orders GROUP BY status ORDER BY status;
```

Verified read-only on 2026-10-12: only `Pending`, 2 rows.

3. Confirm no name collision with the constraints and indexes the migration creates.

```sql
SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid='public.orders'::regclass ORDER BY conname;
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='orders' ORDER BY indexname;
```

Verified read-only on 2026-10-12: nothing in common with `orders_status_values_check`, `orders_tracking_token_hash_check`, `orders_idempotency_fingerprint_check`, `orders_cancellation_reason_check`, `orders_order_number_uidx` or `orders_tracking_token_hash_uidx`.

4. Confirm the primary key is the single integer `orders.id` that the order-number backfill depends on.

```sql
SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
WHERE i.indrelid = 'public.orders'::regclass AND i.indisprimary;
```

Verified read-only on 2026-10-12: `id, integer`.

5. Record aggregate counts before the change so they can be compared afterwards.

```sql
SELECT (SELECT count(*) FROM products) AS products,
       (SELECT count(*) FROM orders) AS orders,
       (SELECT count(*) FROM order_items) AS order_items;
```

Verified read-only on 2026-10-12: 18, 2, 2.

6. Confirm that if `orders.order_number` already exists it holds no duplicates, and that no non-unique index already occupies the name `orders_order_number_uidx`.

```sql
SELECT order_number, count(*) AS n
FROM public.orders
WHERE order_number IS NOT NULL
GROUP BY order_number HAVING count(*) > 1;
```

Every result row is a duplicate the backfill cannot repair, because the backfill only fills NULL rows. If any exist, reconcile them before running the migration.

```sql
SELECT i.indisunique, a.attname
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = ic.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
WHERE n.nspname = 'public' AND ic.relname = 'orders_order_number_uidx';
```

No rows is the expected result. If a row reports `indisunique = false`, or an `attname` other than `order_number`, the name is occupied by the wrong index and `CREATE UNIQUE INDEX IF NOT EXISTS` would silently skip creating the real one.

Verified read-only on 2026-10-12: `orders.order_number` does not exist at all, so neither check has anything to report.

7. Take an approved Neon restore point or branch. A database backup contains customer information; do not send or upload it to an unapproved service.

## What the migration now guarantees by itself

`production-order-system.sql` is a single transaction that cannot be half-applied:

- **Preflight** runs before any DDL and is read-only. It confirms the expected tables exist, the primary key is `orders.id`, every existing status is inside the permitted set, and the owner tables either do not exist or already carry the required columns. It also detects an `orders_status_values_check` left behind by an earlier, narrower version of this file, because the guarded `CREATE` would otherwise skip it and the owner status API would keep failing.
- **Verification** runs inside the same transaction immediately before `COMMIT`. It re-checks every required column, table, index and constraint, and every invariant on existing rows: no NULL or duplicate `order_number`, every status inside the permitted set, valid `idempotency_fingerprint` and `tracking_token_hash` formats, valid `cancellation_reason` length, and no orphaned order items. Any failure raises an exception and rolls the entire transaction back.
- Every check is stated so it stays correct when new orders are placed during the migration window. No check pins a row count; a regression test enforces this.
- The only data change is the one-time `orders.order_number` backfill, restricted to rows where the column is new and therefore NULL. It runs before the `NOT NULL` constraint is added.

## Rollback plan

Reverting is safe because the objects this migration adds carry no data until the application starts using them.

1. **Preferred:** redeploy the previous application release and leave the schema additions in place. Additive columns and two empty tables are inert to older code.
2. **Resetting production from the `pre-checkout-repair-20261010` branch, or from any restore point taken before the migration, must NOT be used if it would lose newer orders.** That branch is a snapshot of `production` cut at 2026-10-11 03:33:49 UTC. Resetting production from it rolls the whole database back to that instant, which **discards every order, order item, product-price change and owner session created after the snapshot/cut point**. Resetting production to it is therefore only safe while no order newer than the snapshot exists. Confirm with `SELECT id, created_at FROM public.orders ORDER BY id;` that no order is newer than the snapshot cut point before using this method. If any newer order exists, use option 1 instead, or take a **fresh** restore point/branch first and restore to that. This method also discards any new `orders.id` sequence values above the snapshot.
3. **Manual removal** must only be attempted after no order has been created with the new application, because removing the new columns discards the tracking credential hash, the idempotency fingerprint, the cancellation reason and the order number of those orders. Orders placed before the migration are unaffected either way. Never remove or rewrite `orders.customer_access_token`; it holds the legacy tracking credentials that must keep working.

## Post-migration verification steps

Run these read-only after committing. They mirror the checks the migration performs on itself.

1. Every required object exists:

```sql
SELECT 'orders.tracking_token_hash' AS object,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='orders'
                 AND column_name='tracking_token_hash') AS present
UNION ALL SELECT 'orders.idempotency_fingerprint',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='orders'
                 AND column_name='idempotency_fingerprint')
UNION ALL SELECT 'orders.cancellation_reason',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='orders'
                 AND column_name='cancellation_reason')
UNION ALL SELECT 'orders.order_number',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='orders'
                 AND column_name='order_number')
UNION ALL SELECT 'public.owner_sessions', to_regclass('public.owner_sessions') IS NOT NULL
UNION ALL SELECT 'public.owner_login_attempts', to_regclass('public.owner_login_attempts') IS NOT NULL;
```

2. The four constraints and three indexes exist, and the status constraint lists all seven statuses:

```sql
SELECT conname FROM pg_constraint
WHERE connamespace='public'::regnamespace
  AND conname IN ('orders_status_values_check',
                 'orders_tracking_token_hash_check','orders_idempotency_fingerprint_check',
                 'orders_cancellation_reason_check')
ORDER BY conname;

SELECT indexname FROM pg_indexes WHERE schemaname='public'
  AND indexname IN ('orders_order_number_uidx','orders_tracking_token_hash_uidx',
                    'owner_sessions_expires_at_idx')
ORDER BY indexname;

SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE connamespace='public'::regnamespace AND conname='orders_status_values_check';
```

3. The backfill and the corrected default are in place:

```sql
SELECT id, order_number, status FROM public.orders ORDER BY id;
SELECT column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='orders' AND column_name='status';
```

4. Aggregate counts are unchanged for products and order items:

```sql
SELECT (SELECT count(*) FROM products) AS products,
       (SELECT count(*) FROM orders) AS orders,
       (SELECT count(*) FROM order_items) AS order_items;
```

5. Legacy tracking credentials are preserved, without exposing their values:

```sql
SELECT count(*) AS total_orders,
       count(*) FILTER (WHERE customer_access_token IS NOT NULL) AS with_legacy_credential,
       count(*) FILTER (WHERE tracking_token_hash IS NOT NULL) AS with_hashed_credential
FROM public.orders;
```

6. Then verify through the API, in this order:

```bash
# Catalog and health stay green
curl -s https://maridel-s-store.onrender.com/
curl -s https://maridel-s-store.onrender.com/api/products -o /dev/null -w '%{http_code}\n'
curl -s https://maridel-s-store.onrender.com/api/pickup/availability

# Customer order tracking: an invalid credential must return 404, not 500
curl -s -X POST https://maridel-s-store.onrender.com/api/orders/track \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://gjdos07.github.io' \
  -d '{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'

# Owner routes: without a session cookie these must return 401, not 500
curl -s -o /dev/null -w '%{http_code}\n' https://maridel-s-store.onrender.com/api/owner/session \
  -H 'Origin: https://gjdos07.github.io'
curl -s -o /dev/null -w '%{http_code}\n' https://maridel-s-store.onrender.com/api/owner/orders \
  -H 'Origin: https://gjdos07.github.io'
```

Before the migration these return 500, 500, 401, 401 respectively; the first one must become 404 and the owner routes must stay 401. A 200 on the owner routes requires a valid owner session, which only the owner dashboard can supply.

## Apply the production SQL

Only after explicit approval to modify production:

1. Use the Neon SQL Editor or an approved PostgreSQL client to apply `production-order-system.sql` as a single transaction.
2. The SQL adds order display/tracking/idempotency metadata, cancellation-reason storage, and owner session/rate-limit tables. It does not delete products, orders, order items, or legacy `customer_access_token` values.
3. If a statement fails, stop and inspect the error before retrying; the transaction should roll back.
4. Confirm aggregate product/order/order-item counts are unchanged, existing order IDs and customer tracking still work, and existing order numbers are derived as `MS-<id>`.

The updated checkout stores the SHA-256 idempotency-key hash in the existing unique `orders.idempotency_key` field and stores a request fingerprint in `idempotency_fingerprint`. New tracking credentials are derived from the one-time client idempotency key and order ID, returned only after commit, and stored as `tracking_token_hash`; the raw bearer is not stored in `customer_access_token`. Existing legacy plaintext tracking credentials are not rewritten and remain accepted for tracking. Do not drop or rewrite that legacy column or expose its values. The one-time key must remain available in the browser for a safe retry; the storefront displays the resulting tracking credential after a successful response.

Cancellation requires a reason of 3–500 characters. The owner API persists it in `cancellation_reason`, keeps it immutable after cancellation, and the owner dashboard displays it. This workflow requires the SQL migration first; do not deploy code that enables cancellation against a schema without that column.

The public order-creation and customer-tracking endpoints use per-process IP rate limits. These counters reset on restart and are not shared across Render instances. Use a shared rate-limit store or gateway-level limits before relying on global quotas or scaling horizontally.

Owner cookies use `Secure; SameSite=None` in production for cross-origin requests from the storefront/dashboard. Browser privacy policies can still block third-party cookies. Test login, session refresh, logout, and authenticated dashboard requests in supported browsers. If those browsers block the cookies, use an approved same-site proxy or serve the dashboard from the API site rather than weakening authentication.

## Deployment method and order

The service is defined in `render.yaml` as a Render web service named
`maridel-s-store-api-gjdos07`, with `buildCommand: npm ci` and
`startCommand: node server.js`. Render builds from the GitHub repository
`GJDOS07/MARIDEL-S-STORE` on the `main` branch.

**Order is fixed: schema first, then code.** The schema must be migrated before
the new application code is live, because the new `POST /api/orders` writes
`order_number`, and the older code would leave it NULL on every new order.

1. **Migrate the schema** (this file, `## Apply the production SQL`).
2. **Verify the schema** (`## Post-migration verification steps`).
3. **Commit** the working-tree changes. The commit that carries the code fix is
   the deployment artifact. It must contain at minimum:
   - `order-routes.js` (writes `order_number` in the checkout transaction)
   - `api-error-handler.js` (names the missing object in logs)
   - `package.json` and `package-lock.json` (`pg` is a runtime dependency)
   - `production-order-system.sql` and the test files that guard it
   - `index.html` and `style.css` only if the wishlist work is being released
     at the same time
4. **Push** `main` to `origin`, which triggers Render's auto-deploy.
5. **Confirm the deployed revision** in the Render dashboard, then run the
   verification steps below.

Render has no separate deploy hook or API token configured in this workspace,
so a commit and push is the only available deployment path. Both require
explicit approval; neither has been performed.

### Deploying only the backend

If the storefront (GitHub Pages) should not change in the same release, commit
and push only the backend files listed above and leave `index.html` and
`style.css` unmodified. The frontend and backend deploy independently: the
frontend is served by GitHub Pages from `main`, the backend by Render from the
same repository.

## Deploy and verify

After separate approval to deploy:

1. Apply the reviewed SQL first, then deploy the code. The application does not run migrations automatically.
2. Confirm `GET /` and `GET /api/products` respond normally. Confirm `GET /api/products/73` returns the expected product if it remains present; do not create or fabricate products.
3. Confirm unauthenticated owner order-list requests return 401. Verify owner login, listing/viewing orders, status transitions, logout revocation, and saved cancellation reasons.
4. Verify pickup boundaries at 09:59 (reject), 10:00 (accept), 12:00 (accept), 20:00 (accept), and 20:01 (reject) Melbourne time, plus invalid dates and past date/time rejection.
5. Test checkout only with an explicitly authorized production test order. Confirm success is sent after commit, a retry does not create a duplicate, a changed request with the same key conflicts, tracking returns only that order, and an unrelated credential/numeric ID cannot retrieve it.
6. Verify CORS preflight and credentialed owner requests from the exact configured origin. Confirm rate limiting returns HTTP 429 with `Retry-After`.

## Tests and limitations

`npm test` runs Node unit tests and HTTP integration tests with an in-memory fake pool. Those tests verify route behavior but are not PostgreSQL integration tests. No isolated PostgreSQL test credentials were available in this worktree; its configured database target is remote and must not be used for destructive tests. Before a production migration, run the test suite against a disposable local/isolated PostgreSQL schema with synthetic data. Never use production credentials for that test.

No production migration, order, product, commit, push, or deployment has been performed as part of this work.

## Recovery

If the application deployment must be rolled back, redeploy the prior application while leaving additive schema objects in place. Do not drop tracking hashes, cancellation reasons, order numbers, or owner session data after the updated application has accepted orders. A Neon restore can discard writes after the restore point and requires an explicitly approved recovery decision.
