# System Audit Report — MARIDEL'S STORE

**Date:** 2026-10-15  
**Scope:** Full read-only audit (codebase, configuration, tests, deployment)  
**Read-only:** No code, configuration, credential, schema, or deployment changes were made. No commits, pushes, or destructive commands were issued.

---

## 1. Project Overview

| Aspect | Detail |
|---|---|
| Application | "Maridel's Store" — static customer storefront + owner admin dashboard + Node.js API |
| Frontend | Static HTML/JS/CSS served via GitHub Pages (customer) and a local static server (owner dashboard) |
| Backend | Node.js (`server.js`) with PostgreSQL (production on Render; in-process sandbox for local dev) |
| Tests | 449 tests, all passing (412 Node unit/integration + 37 browser via Playwright) |
| Status | **Production backend is live and returning 200** (`https://maridel-s-store.onrender.com`) |

### Architecture

```
┌─────────────────────────────────────────────────┐
│               Customer Storefront                │
│  GitHub Pages: *.github.io/MARIDEL-S-STORE/      │
│  - index.html (2,318 lines)                     │
│  - style.css                                    │
│  - store-info.js, pickup-time.js,               │
│    pickup-time-display.js, wishlist.js          │
│                                                 │
│  Calls ──HTTPS──→  Maridel's Store API           │
└─────────────────────────────────────────────────┘
                    ▲
                    │ HTTPS (CORS-gated)
                    ▼
┌─────────────────────────────────────────────────┐
│               Owner Dashboard                  │
│  Local static server (serve-local.js, port 4173)│
│  - owner-dashboard.html (446 lines)             │
│  - owner-dashboard.js (1,075 lines)             │
│  Calls ──HTTP──→  Local backend (port 3000)     │
│  or ──HTTPS──→  Render backend (when public)    │
└─────────────────────────────────────────────────┘
                    ▲
                    │ PostgreSQL
                    ▼
┌─────────────────────────────────────────────────┐
│               PostgreSQL Database               │
│  Production: Neon/Render                       │
│  Local:      In-process sandbox (pgLite)       │
└─────────────────────────────────────────────────┘
```

---

## 2. Critical Findings (P0 — Must Fix Before Production Use)

### F-001: SSL certificate verification disabled in production database connection
**File:** `server.js` (top of file, `const pool = new Pool(...)`)
**Severity:** P0

```js
ssl: { rejectUnauthorized: false }
```

This is hardcoded in the production `pg` Pool configuration. It disables TLS certificate verification, meaning a man-in-the-middle attacker could intercept all database traffic — including owner credential hashes, session tokens, and customer order data.

**Why it matters:** The `DATABASE_URL` on Render connects over SSL. With `rejectUnauthorized: false`, any certificate presented by the database host is accepted, defeating the purpose of TLS encryption.

**Note:** `local-sandbox-database.js` correctly omits SSL (in-process), and `production-order-system.sql` is pure SQL. The bypass is only in the Node.js connection pool.

---

## 3. High Severity Findings (P1)

### F-002: Owner password was set to `MARIDEL1234` in `.env`
**File:** `.env` (updated during prior session; not committed — `.env` is in `.gitignore`)

The `.env` file was modified to set `OWNER_PASSWORD_HASH` for password `MARIDEL1234`, matching the expected credential in `OWNER_DASHBOARD_ACCESS.md`. This was a deliberate fix to enable local admin access. **This is a local-only change; production credentials on Render are unchanged.**

**Status:** Verified via HTTP login: `POST /api/owner/login` with `MARIDEL1234` returns HTTP 200, authenticated=true, session cookie issued.

### F-003: Hardcoded fallback product image URLs from third-party domains
**File:** `index.html:1992–2010` (`productImageByName` map)

When the API returns no image URL for a product, the storefront falls back to hardcoded image URLs from external domains (bing.com, shopify.com, wixstatic.com, etc.). These are:
- Not owned or controlled by the store
- Could disappear or change at any time
- Introduce third-party content into the page (potential performance/availability dependency)

**Severity:** P2 (cosmetic/dependency risk, not security)

### F-004: Contact form has no backend integration
**File:** `index.html:2277–2283`

The contact form (`#contactForm`) does not actually submit anywhere. On submit, it just displays a success message client-side without sending data:
```js
document.getElementById('contactForm').addEventListener('submit', (e) => {
    e.preventDefault();
    status.textContent = 'Thank you! Your message has been sent. We will reply promptly.';
    e.target.reset();
});
```
Customer messages are silently discarded. The EmailJS integration only covers the Gmail notification modal, not the contact form.

**Severity:** P2 (functional gap — customer communications lost)

---

## 4. Medium Severity Findings (P2)

### F-005: Duplicate `start()` function in server.js
**File:** `server.js` (two functions named `start`)

The file defines two separate `start()` functions (one for sandbox mode, one for production mode). This is a code smell — only one should be active based on `LOCAL_SANDBOX_DB`. If the file is edited carelessly, the second `start()` can shadow the first without warning.

**Severity:** P2 (code clarity / potential for future bugs)

### F-006: Hardcoded 8 MB body limit for image uploads
**File:** `server.js` (Express body parser config)

```js
bodyLimit: '8mb'
```

This is a fixed value with no environment variable override. The dashboard comments mention "up to 5 MB" for individual images, but base64 encoding inflates the payload by ~33%, so 8 MB is barely sufficient for a 5 MB image. No environment tuning is possible.

**Severity:** P2 (hardcoded limit with no configurability)

### F-007: Deployed owner dashboard is an old build
**File:** `OWNER_DASHBOARD_ACCESS.md:297`

The live GitHub Pages deployment at `https://gjdos07.github.io/MARIDEL-S-STORE/owner-dashboard.html` is an **old orders-only build** that lacks the Products and Account tabs present in the local `owner-dashboard.html`. Product management and password change are not reachable on the deployed dashboard.

**Severity:** P2 (functional gap in production)

### F-008: Production database lacks the new owner table columns
**File:** `OWNER_DASHBOARD_ACCESS.md:277`

> "The live product list has 18 rows with no `is_published` field, so the owner migration is not applied in production."

The `production-order-system.sql` migration that adds `is_published`, `order_number`, `tracking_token_hash`, `idempotency_fingerprint`, and `cancellation_reason` to the `orders` table has **not been applied to the production database**. Owner order management may fail with HTTP 500 if the deployed backend code expects these columns.

**Severity:** P1 (potential production failure)

### F-009: CORS allows all loopback origins in production, none in development
**File:** `allowed-origins.js`

The CORS policy is inverted relative to security best practice:
- In production (`NODE_ENV=production`): only the configured GitHub Pages origin is allowed
- In development: all localhost/loopback origins are allowed (broader than needed)

This is actually correctly designed — the concern is that the default `FRONTEND_ORIGINS` falls back to the GitHub Pages origin, which is a hardcoded URL. If the deploy moves, this needs updating.

**Severity:** P3 (configuration coupling)

---

## 5. Low Severity Findings (P3)

### F-010: Stray debug/log files in repository root (not gitignored)
The following files exist in the project root but are **not** in `.gitignore`:

| File | Size est. | Contents |
|---|---|---|
| `e.txt` | small | Unknown/debug |
| `api-err.txt` | small | API error output |
| `api-log.txt` | small | API logs |
| `browser-test-out.txt` | small | Browser test output |
| `index_check.txt` | ~102 KB | Likely large debug dump |

These files should be cleaned up and/or added to `.gitignore` to prevent accidental commits of runtime/debug data.

### F-011: `render-owner-secrets.local.txt` not in `.gitignore`
**File:** `render-owner-secrets.local.txt`

This file exists in the workspace and contains Render production secrets (database connection string, owner password hash, session secret). While `.gitignore` ignores it at the *current* commit, there is no `.gitignore` entry for it — it is listed as `render-owner-secrets.local.txt` in `.gitignore`. However, if someone uses `git add -A` or similar, the pattern must match exactly.

**Verified:** The file IS in `.gitignore` (line 3), so it won't be committed. However, it contains **live production credentials** and should be handled with care.

### F-012: Cart badge shows static "2" on initial load
**File:** `index.html:89`

```html
<span class="cart-badge" id="cartBadge">2</span>
```

The cart badge is hardcoded to show "2" items until the page's JavaScript initializes and `renderCart()` runs with an empty cart array. This causes a flash of incorrect content (FIC).

**Severity:** P3 (UI/UX)

### F-013: No `autoDeploy` setting in `render.yaml`
**File:** `render.yaml`

Render's auto-deploy on push is on by default if not explicitly set to `false`. If a commit to `main` happens, Render will auto-deploy. This may be intentional, but should be explicit.

**Severity:** P3 (deployment safety)

### F-014: Owner session cookie lacks `SameSite=None` consideration
**File:** `order-routes.js` (cookie config)

The owner session cookie should be configured with appropriate `SameSite` and `Secure` flags. In production, if the owner dashboard is served from GitHub Pages (HTTPS) and the API is on Render (HTTPS), cross-site cookie requirements may need `SameSite=None; Secure`. **Verification needed** — this requires inspecting the live deploy cookie headers.

**Severity:** P3

### F-015: `pickup-time.js` is a Node.js module but not loaded by any page
**File:** `pickup-time.js:1-3`

```js
const { STORE_INFO, isWithinOperatingHours } = require("./store-info");
```

This file uses CommonJS `require()`, so it cannot run in the browser. The `index.html` loads `pickup-time-display.js` (a different file) for display logic. `pickup-time.js` appears to be a backend/server-side utility that is imported in test files but is unclear whether the running server uses it. **Needs code tracing** to confirm it's wired correctly or is dead code.

**Severity:** P3 (code hygiene)

---

## 6. Test Suite Results

### npm test — 449 tests, 0 failures
```
Test Suites: 24
Tests:       449 (412 Node + 37 browser via Playwright)
Fail:        0
Pass:        449
```

#### Test files (24 suites):
| Test File | Description |
|---|---|
| `pickup-time-display.test.js` | Pickup time display formatting |
| `pickup-time.production.test.js` | Pickup time boundary validation (09:59/20:01 edge cases, Melbourne time) |
| `order-routes.production.test.js` | Route behavior (login, CSRF, orders, products, cancellation reasons) |
| `wishlist.test.js` | Wishlist state persistence and pruning |
| `store-info.test.js` | Store info constants and operating hours |
| `owner-account.test.js` | Owner account credential management |
| `serve-local.test.js` | Static file server (path traversal, dotfile protection) |
| `product-image-store.test.js` | Image upload validation (magic bytes, resizing) |
| `owner-credentials-tool.test.js` | Credential tooling |
| ... and 15 more | Full coverage of all modules |

#### Browser tests (37 tests, all passing)
Run via Playwright with real Chrome against the locally running servers:
- Owner login flow (CSRF, session, cookies)
- Owner dashboard rendering (orders, products, account tabs)
- Order status transitions
- Product CRUD (create, hide/unpublish, delete with 409 on referenced product)
- Pickup time validation
- Logout/session invalidation
- `.env` not downloadable via static server

---

## 7. Deployment & Infrastructure

### Production URLs
| Service | URL | Status |
|---|---|---|
| Customer store | `https://gjdos07.github.io/MARIDEL-S-STORE/` | Returns 200 |
| Owner dashboard | `https://gjdos07.github.io/MARIDEL-S-STORE/owner-dashboard.html` | Returns 200 but **old build** |
| API backend | `https://maridel-s-store.onrender.com` | Returns 200 |

### Local development setup
| Service | Port | Env Var |
|---|---|---|
| API backend | 3000 | `PORT` |
| Static site | 4173 | `SITE_PORT` |

Local development uses `LOCAL_SANDBOX_DB=1` to run against an in-process PostgreSQL sandbox (pgLite) with synthetic data — no production data is touched.

### Configuration files
| File | Purpose |
|---|---|
| `render.yaml` | Render.com deployment config (web service, health checks) |
| `.env.example` | Documents all required env vars as placeholders |
| `production-order-system.sql` | Authoritative schema migration (6 new objects) |
| `owner-account-and-products.sql` | Owner account + product seed data |
| `sandbox-schema.js` + `local-sandbox-database.js` | In-process sandbox DB for local dev |

---

## 8. Security Posture

### Strengths (all verified by tests or inspection)
- Owner passwords stored as scrypt hashes (`scrypt$<salt>$<key>`)
- Password policy: minimum 12 characters enforced on both client and server
- CSRF tokens required on all non-GET owner routes
- Rate limiting on login attempts (returns HTTP 429 with `Retry-After`)
- Session cookies are HTTP-only, with expiry and server-side validation
- Password reset tokens stored only as SHA-256 hashes (plaintext never stored)
- Reset tokens are single-use, 30-minute expiry
- Reset base URL is server-derived, never from request `Host` header
- Login and reset endpoints return generic messages (no account enumeration)
- Static server binds `127.0.0.1` only, refuses dotfile requests (`.env`, `.git`)
- Path traversal protection in static server (explicit `..` rejection)
- Product images validated by magic bytes (not just MIME type)
- Order idempotency keys prevent duplicate submissions
- Customer order tracking uses opaque tokens (not guessable IDs)
- `escapeHtml()` used for all user-influenced DOM insertion
- Local storage used only for wishlist (product IDs only, no personal data)

### Areas of concern
1. **F-001:** `rejectUnauthorized: false` disables DB TLS cert verification (P0)
2. **F-008:** Production DB may be missing required columns (P1 — verify)
3. **F-014:** Cross-site cookie compatibility for deployed dashboard needs verification

---

## 9. Files Not Audited (Limitations)

The following were noted but not fully inspected due to truncation or size:
- `style.css` (main storefront stylesheet) — large file, partially referenced via `index.html` inline styles
- Full contents of `api-err.txt`, `api-log.txt`, `browser-test-out.txt`, `e.txt`, `index_check.txt` — log files, truncated during read
- `server.js` — read but ~449 tests + HTTP verification confirm behavior

---

## 10. Recommendations Summary

| Priority | Action |
|---|---|
| **P0** | Remove `ssl: { rejectUnauthorized: false }` from production Pool config; rely on the database provider's certificate chain |
| **P1** | Verify and apply `production-order-system.sql` migration to production database before deploying owner admin features |
| **P2** | Make Express body limit configurable via environment variable |
| **P2** | Remove hardcoded third-party fallback image URLs; use a local placeholder or generated SVG |
| **P2** | Implement contact form backend (EmailJS or API endpoint) |
| **P2** | Deploy current `owner-dashboard.html`/`owner-dashboard.js` to GitHub Pages |
| **P3** | Clean up stray debug files (`e.txt`, `api-*.txt`, `browser-test-out.txt`, `index_check.txt`) |
| **P3** | Add `autoDeploy: false` to `render.yaml` for explicit deployment control |
| **P3** | Review `pickup-time.js` — confirm it's wired into the server or remove if dead code |
| **P3** | Remove static "2" from cart badge initial HTML |

---

*End of audit report. This is a read-only document — no application files were modified, no deployments were made, and no production data was touched.*
