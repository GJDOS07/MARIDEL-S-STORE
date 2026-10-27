# Opening the Owner Dashboard and Logging In

Working instructions for reaching the owner dashboard, and for diagnosing the
errors that get in the way.

**Owner Admin URL: <http://localhost:4173/owner-dashboard.html>**

---

## 1. The URLs

| What | URL | Status |
|---|---|---|
| **Owner dashboard** | `http://localhost:4173/owner-dashboard.html` | ✅ verified served locally |
| Customer store | `http://localhost:4173/index.html` | ✅ verified served locally |
| Local API backend | `http://localhost:3000` | ✅ used automatically when the page is opened from localhost |

`owner-dashboard.js:3-5` picks the backend from the page's own hostname:

```js
const API_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
	? "http://localhost:3000"
	: "https://maridel-s-store.onrender.com";
```

Opened from localhost it calls `localhost:3000`; opened from anywhere else it
calls Render. No configuration needed either way.

---

## 2. Step-by-step: open the dashboard locally

Prerequisites: Node.js installed, and this folder on your machine.

```bash
# 1. Install dependencies once.
npm ci

# 2. Set the local owner credentials. SKIP this if they are already configured;
#    step 3 will tell you. It prompts for a password, then writes
#    OWNER_PASSWORD_HASH and OWNER_SESSION_SECRET into .env, leaving
#    DATABASE_URL and every other line untouched.
npm run set-owner-password -- --write-env

# 3. Confirm both are accepted.
npm run check-owner-config
#    OWNER_PASSWORD_HASH : valid
#    OWNER_SESSION_SECRET: valid

# 4. Start the API backend against the isolated sandbox database.
#    Leave it running.
LOCAL_SANDBOX_DB=1 npm start

# 5. In a SECOND terminal, start the static site server.
npm run serve
```

Then open **http://localhost:4173/owner-dashboard.html** and log in with the
password you chose in step 2.

### Use `LOCAL_SANDBOX_DB=1`

The `DATABASE_URL` in this workspace points at the production database, so a
plain `npm start` connects to production. The sandbox is an in-process PostgreSQL
built from this project's own migrations with a synthetic catalog: nothing is
contacted over the network and no production row is read or written. With
`LOCAL_SANDBOX_DB` unset, `server.js` uses `DATABASE_URL` exactly as before.

### Two ports, two variables

| Server | Script | Default port | Variable |
|---|---|---|---|
| API backend | `npm start` → `server.js` | 3000 | `PORT` |
| Static site | `npm run serve` → `serve-local.js` | 4173 | `SITE_PORT` |

They are deliberately separate. `PORT` is the backend service port — `render.yaml`
maps it to the API — and the static server used to read it too, so starting both
made them compete for one port and the dashboard failed in a way that looked like
a backend fault. `serve-local.js` now reads only `SITE_PORT`.

To change either:

```bash
LOCAL_SANDBOX_DB=1 PORT=4000 npm start
SITE_PORT=4273 npm run serve   # then open http://localhost:4273/owner-dashboard.html
```

The static server binds `127.0.0.1` only and refuses to serve dotfiles, so `.env`
cannot be downloaded. If its port is in use it moves to the next one and prints
the URL it actually bound.

`.env` is gitignored, so local credentials are never committed. `.env.example`
documents every variable as a placeholder and names the command that produces real
values.

---

## 3. Diagnosing errors

### If `check-owner-config` reports something other than `valid`

| Report | Meaning | Fix |
|---|---|---|
| `missing` | The variable is not in `.env` at all | `npm run set-owner-password -- --write-env` |
| `has-whitespace` | The value has a stray space or newline | Re-copy it with nothing around it |
| `malformed` | The hash is not `scrypt$salt$key` shaped | Generate one with the command above |
| `too-short` | The session secret is under 32 characters | Generate one with `--secret` |

### If login says `Invalid owner credentials.` but the config check is valid

**Check which credential the login route is actually using.** The startup log
prints it, and it prints no hash, password or token:

```
Owner credential source: OWNER_PASSWORD_HASH environment variable
```

Possible causes, in the order worth checking:

1. **A stale backend.** `OWNER_PASSWORD_HASH` is read on every login, so rotating
   `.env` takes effect without a restart — but a backend still running an older
   copy of the code keeps the value it captured at startup. The log warns about
   this directly:
   ```
   OWNER_PASSWORD_HASH changed after this process started. Restart the backend...
   ```
   Restart it and the current value is used.
2. **An `owner_credentials` database row overriding the variable.** The log will
   say `Owner credential source: owner_credentials table` if so. A row left behind
   by a password reset keeps working even after the variable changes. To go back
   to using only the variable, remove the row.
3. **The password typed is not the one the hash was built from.** The fix is
   `npm run set-owner-password -- --write-env` with the password you want.

### The two error messages

| Response | Meaning |
|---|---|
| `Invalid owner credentials.` (401) | A hash **is** configured, but the password does not match it. |
| `Owner authentication is not configured.` (503) | **No usable hash**, or the session secret is missing or under 32 characters. |

Both are the same for a wrong password and a missing account, on purpose, so
neither can be used to probe the system.

### Which credential source wins

1. **`owner_credentials.password_hash`** (a database row) — wins if present.
2. **`OWNER_PASSWORD_HASH`** (environment variable) — the fallback.

`readOwnerPasswordHash()` in `order-routes.js` reads the database on every login
and falls back to the environment, also per login. An explicitly supplied
`ownerPasswordHash` option wins over both, which is what the integration tests use.

---

## 4. Setting a new owner password

```bash
npm run set-owner-password              # print the values, change nothing
npm run set-owner-password -- --secret  # also print a new session secret
npm run set-owner-password -- --write-env  # write them into local .env
```

`--write-env` prompts for the password, writes both variables, and **reuses an
existing session secret** rather than rotating it. It preserves every other line
in `.env` byte-for-byte, including `DATABASE_URL`, and prints no value.

Guard rails, all built in:

- It writes nothing to the database, to Render, or to any environment other than
  the local `.env`.
- The password is never echoed, printed or written to a file.
- The password must satisfy the same policy the API enforces, so anything accepted
  here is accepted at login.
- A value containing a newline is refused — that truncation is what made
  hand-editing `.env` unreliable.
- The generated hash is tested against the exact parser the login route uses, so a
  hash in the wrong format cannot silently lock you out.

---

## 5. Forgot password

The login page has a **Forgot password?** link below the Log in button. It opens a
request form, and a reset link (`?reset_token=...`) opens a second form for
choosing a new password.

**The request form does not ask for an email address, deliberately.** The route
reads the owner address from the `owner_contact` table rather than from anything
the browser sends, so the form cannot be used to test whether an address exists.
The reply is identical either way.

**Email delivery is not configured, so a link is never sent.** All four of
`RESEND_API_KEY`, `OWNER_RESET_FROM_EMAIL`, `OWNER_CONTACT_EMAIL` and
`OWNER_RESET_BASE_URL` must be present, and the base URL must be `https`. When any
is missing the route fails closed: same generic message, and **no token issued at
all**. The startup log states it:

```
Owner password reset by email: not configured.
  Reset requests will be accepted generically and no link can be sent.
```

The reset itself is fully implemented and tested: 32 random bytes, stored only as a
SHA-256 hash, single use, 30-minute expiry, all owner sessions revoked on success,
and the link built from `OWNER_RESET_BASE_URL` — never from the request Host
header, so a crafted `Host` cannot point a reset link at an attacker's site.

**Until email is configured, `npm run set-owner-password -- --write-env` remains
the only way back in.**

---

## 6. Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | Backend startup | Without it `server.js` refuses to start (unless the sandbox is used). |
| `OWNER_PASSWORD_HASH` | Login | `scrypt$<32+ hex salt>$<128 hex key>`. |
| `OWNER_SESSION_SECRET` | Login | **At least 32 characters.** Shorter means 503 and no login at all. |
| `FRONTEND_ORIGINS` | CORS | Optional. Defaults to the GitHub Pages origin in production. |
| `NODE_ENV` | Cookies, CORS | `production` on Render. |
| `LOCAL_SANDBOX_DB` | Local only | `1` uses the isolated in-process database. Leave unset in production. |
| `SITE_PORT` | Local only | Port for `npm run serve`. Default 4173. |
| `LOCAL_SANDBOX_DATA_DIR` | Local only | Persists the sandbox locally instead of in memory. |
| `RESEND_API_KEY` | Reset email | Optional. |
| `OWNER_RESET_FROM_EMAIL` | Reset email | Verified sender address. |
| `OWNER_CONTACT_EMAIL` | Reset email | The only recipient of a reset link. |
| `OWNER_RESET_BASE_URL` | Reset email | Must be `https`. Source of the reset link. |

Owner credentials live in the local `.env` and nowhere else — they are not
committed, and no password or hash appears in any source file.

---

## 7. Verifying locally

```bash
# Prove the real login, session, protected data, product administration and
# logout, running both real servers. Prompts for the password and reads it from
# stdin; it is never printed or written anywhere.
npm run verify:admin

# Prove the stored credential authenticates without starting the full stack.
npm run verify-local-login
```

Both use the isolated sandbox. Neither contacts production.

---

## 8. Verified versus unverified

**Verified in this session, by running the real application**

Both processes were started exactly as documented and driven over real HTTP,
cross-origin, the way a browser does. **42/42 checks passed**, covering: startup
and health; the login page and its assets; unauthenticated and bogus-cookie
requests refused with 401; an incorrect password refused with
`INVALID_OWNER_CREDENTIALS`; correct login returning session and CSRF cookies;
protected `/api/owner/orders`, `/api/owner/session` and `/api/owner/products`
returning the seeded rows; product creation, hide/unpublish with the storefront
excluding hidden items, deletion of an unreferenced product and 409 for an
order-referenced one; order history preserved; logout invalidating the session;
customer routes unaffected; `.env` not downloadable.

A separate test run proves the recovery flow end to end **with a mocked Resend
provider**: exactly one token created, only its SHA-256 hash stored, single use
honoured, new password works and old one does not. No real email was sent.

**Verified by inspection only**

- The real CORS policy: the published origin allowed, an unrelated origin refused,
  loopback refused in production and allowed outside it.
- The live backend answers 200 on `/` and returns a CSRF token.
- The live product list has 18 rows with no `is_published` field, so the owner
  migration is not applied in production.
- The deployed dashboard is an old orders-only build.

**Not verified, and not claimed**

- **The browser UI.** No browser automation was run. The page's own JavaScript has
  not been executed in a real browser, so login through the dashboard HTML has not
  been observed directly.
- Whether `OWNER_PASSWORD_HASH` and `OWNER_SESSION_SECRET` are set on Render.
- That the current frontend or backend is deployed to GitHub Pages or Render.
- Password recovery with real email delivery — no Resend credentials exist, so only
  the mocked path has been verified.

---

## 9. Deployed URLs

| What | URL | Status |
|---|---|---|
| Customer store | `https://gjdos07.github.io/MARIDEL-S-STORE/` | ✅ returns 200 |
| Owner dashboard | `https://gjdos07.github.io/MARIDEL-S-STORE/owner-dashboard.html` | ⚠️ exists but is an **old orders-only build** with no Products or Account tab |
| API backend | `https://maridel-s-store.onrender.com` | ✅ returns 200 |

The deployed dashboard file is far smaller than the current one because it predates
the Products and Account tabs. Product management and password change are not
reachable there until the current frontend is committed, pushed and published.
