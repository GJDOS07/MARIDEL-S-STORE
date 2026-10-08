# Gmail Notification Setup

The website now uses a manual Gmail input. It does not use Google OAuth, Google Sign-In, a Google icon, or a password field.

The form calls EmailJS only after a valid address ending in `@gmail.com` is entered. The recipient is configured in the EmailJS template as `gjalcantara24@gmail.com`. No success message is shown when the EmailJS configuration is missing or the request fails.

## Configure EmailJS

1. Create an account at EmailJS and verify the owner email address.
2. Create an email service connected to the mailbox that will send the notification.
3. Create an email template with these values:

   - To email: `gjalcantara24@gmail.com`
   - Subject: `New Customer Gmail Submission`
   - Body:

     ```text
     May customer na naglagay ng kanilang Gmail address sa website.

     Customer Gmail: {{customer_gmail}}
     Petsa/Oras: {{submission_time}}
     ```

4. Copy the EmailJS public key, service ID, and template ID.
5. In `index.html`, replace the three `YOUR_EMAILJS_*` values in `emailjsConfig`.

The EmailJS public key is intended for browser use. Do not put private API keys or server secrets in this file. For stronger control, move the send call to a backend endpoint and keep provider secrets in environment variables.

## Test the notification

1. Serve the folder from a real local web server or deploy it to the authorized EmailJS domain.
2. Open the login form and enter a real address such as `customer@gmail.com`.
3. Click `Continue`.
4. Confirm the success message appears only after EmailJS returns successfully.
5. Check the inbox and spam folder of `gjalcantara24@gmail.com` for `New Customer Gmail Submission`.
6. Test an invalid address such as `customer@yahoo.com`; it must show `Mangyaring maglagay ng valid na Gmail address.` and must not call EmailJS.

The current workspace cannot verify delivery until the owner supplies the EmailJS configuration. Without it, the site truthfully shows `May nangyaring problema. Pakisubukan muli.`.

## Customer orders

The Gmail notification modal remains a separate EmailJS feature and does not authenticate customers. Customer checkout accepts a name and contact number, with an optional email address.

The existing PostgreSQL schema was inspected read-only before preparing `migrations/001_customer_orders_and_aud_prices.sql`. The migration expects the existing `orders` and `order_items` tables and upgrades them in place; it preserves their integer primary keys, sequences, and existing foreign keys, and retains the legacy `discount` and `shipping_fee` columns. It verifies the expected product columns and checks that the 18 approved product IDs still have their approved names before updating only their `price` values. It does not modify product names, images, categories, descriptions, stock, or compare-at prices. This is a one-time schema upgrade, not a repeatable migration; do not run it until the live schema has been reviewed and the migration has been approved.

After the migration is applied to the existing database, deploy the backend and frontend together. The backend uses `Australia/Melbourne` for pickup validation. Set `FRONTEND_ORIGINS` in the Render service only if the frontend needs an additional trusted origin; separate multiple origins with commas. Do not put database credentials or authentication secrets in frontend files.

The customer receives a random order access token once after checkout. The database stores only its SHA-256 hash. Customers need both the order ID and this private token to retrieve an order. The checkout uses a browser-generated, cryptographically random idempotency key so a network retry does not create another order.

Run the local checks with `npm test`. These tests cover input validation, decimal-to-cents handling, Melbourne opening hours, and daylight-saving gap/ambiguity cases. They do not connect to the live database; an authorized database-backed integration test is still needed after schema review and migration.

## Local admin order API

Set `ADMIN_PASSWORD` in the backend's local `.env` to a unique password of at least 12 characters. Do not reuse a personal password, and never put it in frontend code, source control, or logs. The password is required at backend startup; if it is missing or too short, admin login is disabled. Restart the backend after changing it.

First request `GET /api/admin/csrf` from an allowlisted frontend origin. Send its short-lived `csrf_token` in the `X-CSRF-Token` header for `POST /api/admin/login`, `POST /api/admin/logout`, and admin order `PATCH` requests. These state-changing endpoints also require an exact allowlisted `Origin`; customer checkout is not subject to this admin-only CSRF check.

Log in with `POST /api/admin/login` and JSON `{ "password": "<ADMIN_PASSWORD>" }`. A successful response sets an eight-hour `HttpOnly` session cookie scoped to `/api/admin`. Local cookies use `SameSite=Strict`; production cookies use `SameSite=None; Secure` to support the GitHub Pages-to-Render cross-site requests. Admin requests must send that cookie and use credentialed CORS. Failed login and unauthenticated requests receive HTTP 401. Login is rate-limited to five attempts per 15 minutes per client IP. `POST /api/admin/logout` invalidates the session and clears the cookie. Session records are stored in memory and are lost when the backend restarts.

`GET /api/admin/orders` includes order details and item snapshots, sorted by pending ASAP, pending scheduled pickup time, confirmed pickup time, other active orders, then completed/cancelled orders.

`PATCH /api/admin/orders/:orderId` accepts only `status` and/or the paired `confirmed_pickup_date` and `confirmed_pickup_time` fields; send both pickup fields as `null` to clear a confirmation. Statuses follow Pending → Confirmed → Preparing → Ready for Pickup → Completed; Cancelled is allowed from active statuses, and Completed/Cancelled are terminal. Confirmed pickup values must be a valid future Melbourne local pickup time (7:00 AM–5:00 PM), including daylight-saving validation. Updates lock the target order in a transaction and do not change prices or totals. The CORS allowlist supports credentialed requests only from its explicitly configured origins.

The local admin interface is served at `http://localhost:5500/admin.html`; after login it redirects to `admin-dashboard.html`. Admin pages select `http://localhost:3000` on localhost and `https://maridel-s-store.onrender.com` on deployed hosts. The dashboard redirects to the login page if its session is missing or expired. Do not add the admin password to either admin page or any browser storage.
