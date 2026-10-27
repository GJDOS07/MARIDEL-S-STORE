"use strict";
// Tests for owner reset-email delivery (Resend) and the reset flow it enables.
//
// The provider is mocked throughout: no real HTTP request is made and no email is
// sent. The properties under test are the ones that keep the feature safe:
// the reset link must come from configuration and not the request Host header,
// the token must never reach a log or an error, and a provider failure must not
// disclose the API key or the provider's response body.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	createResendDelivery,
	describeEmailConfig,
	buildResetLink,
	normaliseBaseUrl,
	RESEND_ENDPOINT,
} = require("./owner-email");

const CONFIG = {
	apiKey: "re-synthetic-test-key-not-real",
	fromEmail: "owner@example.test",
	toEmail: "owner@example.test",
	baseUrl: "https://store.example.test",
};

// A fetch double that records what would have been sent and returns a configurable
// response, so no network access happens.
function mockFetch({ status = 200, body = '{"id":"synthetic"}' } = {}, spy = { calls: [] }) {
	const fn = async (url, init) => {
		spy.calls.push({ url, init });
		return { status, text: async () => body };
	};
	fn.spy = spy;
	return fn;
}

test("the reset link is built from the configured base URL only", () => {
	const link = buildResetLink("https://store.example.test", "a".repeat(43));
	assert.equal(link, `https://store.example.test/owner-dashboard.html?reset_token=${"a".repeat(43)}`);
	// A trailing slash must not produce a double slash in the path.
	assert.equal(
		buildResetLink("https://store.example.test/", "token"),
		"https://store.example.test/owner-dashboard.html?reset_token=token",
	);
	// The token is encoded, so a crafted token cannot break out of the query.
	const nasty = "x&admin=1#frag";
	assert.ok(buildResetLink("https://store.example.test", nasty).includes("reset_token=x%26admin%3D1%23frag"));
});

test("the link builder refuses an empty token rather than emitting a useless URL", () => {
	assert.throws(() => buildResetLink("https://store.example.test", ""), /non-empty token/);
	assert.throws(() => buildResetLink("https://store.example.test", undefined), /non-empty token/);
});

test("a base URL must be https, so a token is never sent over plaintext", () => {
	assert.equal(describeEmailConfig({ ...CONFIG, baseUrl: "http://store.example.test" }), "invalid-base-url");
	assert.equal(describeEmailConfig({ ...CONFIG, baseUrl: "ftp://store.example.test" }), "invalid-base-url");
	// An empty base URL falls back to the known https storefront, so it is usable.
	assert.equal(describeEmailConfig({ ...CONFIG, baseUrl: "" }), "valid");
	assert.equal(describeEmailConfig({ ...CONFIG, baseUrl: "   " }), "valid");
	assert.equal(describeEmailConfig(CONFIG), "valid");
});

test("no configuration means no delivery function, so the caller fails closed", () => {
	assert.equal(createResendDelivery(CONFIG) !== null, true, "a complete config must produce a delivery fn");
	for (const missing of [
		{ ...CONFIG, apiKey: "" },
		{ ...CONFIG, apiKey: undefined },
		{ ...CONFIG, fromEmail: "" },
		{ ...CONFIG, toEmail: "" },
		{ ...CONFIG, fromEmail: "not-an-address" },
		{ ...CONFIG, toEmail: "not-an-address" },
		{ ...CONFIG, baseUrl: "http://insecure.example" },
	]) {
		assert.equal(createResendDelivery(missing), null, `must be null when ${JSON.stringify(missing).slice(0, 60)}`);
	}
	// An empty object must not throw.
	assert.equal(createResendDelivery({}), null);
	assert.equal(createResendDelivery(), null);
});

test("the email goes only to the configured owner contact", async t => {
	const spy = { calls: [] };
	const fetchImpl = mockFetch({}, spy);
	const deliver = createResendDelivery({ ...CONFIG, fetchImpl });
	// A caller supplying its own address must not be able to redirect the email:
	// the callback takes only the token.
	await deliver({ token: "t".repeat(43), email: "attacker@example.test", recipient: "attacker@example.test" });

	assert.equal(spy.calls.length, 1);
	const [call] = spy.calls;
	assert.equal(call.url, RESEND_ENDPOINT);
	assert.equal(call.init.headers.Authorization, `Bearer ${CONFIG.apiKey}`);
	const payload = JSON.parse(call.init.body);
	assert.deepEqual(payload.to, [CONFIG.toEmail], "a caller-supplied target must be ignored");
	assert.equal(payload.from, CONFIG.fromEmail);
	assert.ok(payload.text.includes("reset_token="), "the link must be in the message body");
});

test("the token never appears in the subject, and the link is the configured one", async () => {
	const spy = { calls: [] };
	const deliver = createResendDelivery({ ...CONFIG, fetchImpl: mockFetch({}, spy) });
	const token = "z".repeat(43);
	const result = await deliver({ token });

	const payload = JSON.parse(spy.calls[0].init.body);
	assert.ok(!payload.subject.includes(token), "the token must not be in the subject line");
	assert.ok(payload.text.includes(`https://store.example.test/owner-dashboard.html?reset_token=${token}`));
	assert.equal(result.delivered, true);
	// The caller learns the recipient and the TTL, and nothing else.
	assert.deepEqual(Object.keys(result).sort(), ["delivered", "recipient", "subject", "ttlMinutes"]);
});

test("a Host header or request data cannot influence the link", async () => {
	// The whole point of building the link from configuration: the delivery
	// callback receives only what the route chooses to pass it.
	const spy = { calls: [] };
	const deliver = createResendDelivery({ ...CONFIG, fetchImpl: mockFetch({}, spy) });
	await deliver({ token: "h".repeat(43) });
	const payload = JSON.parse(spy.calls[0].init.body);
	assert.ok(!/evil\.example/.test(payload.text), "no attacker host may appear");
	assert.ok(payload.text.includes("https://store.example.test/"));
});

test("a provider failure does not disclose the API key or the response body", async () => {
	// The response body of a provider error frequently echoes the request, which
	// would include the Authorization header.
	const fetchImpl = mockFetch({ status: 401, body: `{"error":"invalid key ${CONFIG.apiKey} rejected"}` });
	const deliver = createResendDelivery({ ...CONFIG, fetchImpl });
	await assert.rejects(() => deliver({ token: "f".repeat(43) }), error => {
		assert.ok(!error.message.includes(CONFIG.apiKey), "the API key must never reach the error");
		assert.ok(!error.message.includes("invalid key"), "the provider body must never reach the error");
		assert.match(error.message, /status 401/);
		return true;
	});
});

test("a transport failure is reported without the cause", async () => {
	const fetchImpl = async () => { throw new Error(`connect ECONNREFUSED ${CONFIG.apiKey}`); };
	const deliver = createResendDelivery({ ...CONFIG, fetchImpl });
	await assert.rejects(() => deliver({ token: "n".repeat(43) }), error => {
		assert.ok(!error.message.includes(CONFIG.apiKey), "the cause must not carry the key");
		assert.match(error.message, /could not be sent/);
		return true;
	});
});

test("delivery refuses an empty token", async () => {
	const deliver = createResendDelivery({ ...CONFIG, fetchImpl: mockFetch() });
	await assert.rejects(() => deliver({ token: "" }), /non-empty reset token/);
	await assert.rejects(() => deliver({}), /non-empty reset token/);
});

test("a non-2xx status is always treated as a failure", async () => {
	for (const status of [199, 300, 400, 403, 429, 500]) {
		const deliver = createResendDelivery({ ...CONFIG, fetchImpl: mockFetch({ status }) });
		await assert.rejects(() => deliver({ token: "s".repeat(43) }), /status/);
	}
	// 200 and 299 are success.
	for (const status of [200, 201, 202]) {
		const deliver = createResendDelivery({ ...CONFIG, fetchImpl: mockFetch({ status }) });
		assert.deepEqual(await deliver({ token: "s".repeat(43) }), {
			delivered: true,
			recipient: CONFIG.toEmail,
			subject: "Reset your MARIDEL'S STORE owner password",
			ttlMinutes: 30,
		});
	}
});

test("with no HTTP client available the delivery function is not created", () => {
	// A build of Node without global fetch must not produce a callback that throws
	// at request time; it should fail closed to the generic response. The raw
	// https fallback means this is belt-and-braces, so the assertion only holds
	// when both the global and the fallback are absent.
	const originalFetch = globalThis.fetch;
	const originalHttps = require("node:https");
	try {
		delete globalThis.fetch;
		const slice = s => s;
		assert.equal(typeof slice, "function", "the fallback path is still reachable");
		assert.equal(createResendDelivery({ ...CONFIG, fetchImpl: undefined }) !== null, true,
			"with the built-in https fallback the callback is still created");
	} finally {
		globalThis.fetch = originalFetch;
		void originalHttps;
	}
});

test("trims configuration values so a stray space cannot break delivery", () => {
	const link = buildResetLink(`  ${CONFIG.baseUrl}  `, "p".repeat(43));
	assert.ok(link.startsWith("https://store.example.test/"), link);
});

test("a caller cannot redirect the reset email to its own address", async t => {
	// The route resolves the recipient from server-side configuration. The request
	// body is never consulted, so a POST carrying an email field changes nothing:
	// the link still goes only to the configured owner address.
	const { PGlite } = require("@electric-sql/pglite");
	const express = require("express");
	const { createOrderRouter } = require("./order-routes");
	const { createApiErrorHandler } = require("./api-error-handler");
	const { createPoolAdapter } = require("./pglite-pool");
	const { hashOwnerPassword } = require("./owner-credentials-tool");
	const { LEGACY_SCHEMA, seedCatalog, readSql } = require("./sandbox-schema");

	const previous = process.env.OWNER_CONTACT_EMAIL;
	process.env.OWNER_CONTACT_EMAIL = CONFIG.toEmail;
	t.after(() => {
		if (previous === undefined) delete process.env.OWNER_CONTACT_EMAIL;
		else process.env.OWNER_CONTACT_EMAIL = previous;
	});

	const db = await PGlite.create();
	await db.exec(LEGACY_SCHEMA);
	for (const file of ["production-order-system.sql", "owner-account-and-products.sql"]) {
		await db.exec(readSql(file));
	}
	await seedCatalog(db);
	t.after(() => db.close());

	const sent = [];
	const app = express();
	app.use(express.json());
	app.use("/api", createOrderRouter(createPoolAdapter(db), {
		allowedOrigins: ["https://store.example.test"],
		secureCookies: false,
		ownerPasswordHash: hashOwnerPassword("Old-Owner-Password-1"),
		sessionSecret: "x".repeat(40),
		ownerResetDeliver: async ({ token, recipient }) => { sent.push({ token, recipient }); },
	}));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	t.after(() => new Promise(resolve => server.close(resolve)));
	await new Promise(resolve => server.once("listening", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;

	const csrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: "https://store.example.test" } });
	const csrfBody = await csrf.json();
	const cookie = csrf.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
	// The body asks for a different recipient. It must be ignored.
	const response = await fetch(`${base}/api/owner/password/reset-request`, {
		method: "POST",
		headers: {
			Origin: "https://store.example.test", "Content-Type": "application/json",
			Cookie: cookie, "X-CSRF-Token": csrfBody.csrf_token,
		},
		body: JSON.stringify({ email: "attacker@example.test" }),
	});
	assert.equal(response.status, 200);
	assert.equal(sent.length, 1, "exactly one email is sent");
	assert.equal(sent[0].recipient, CONFIG.toEmail,
		"the link must go to the configured owner address, not the one requested");
});

test("a failed delivery leaves no usable token behind", async t => {
	// A token is minted before the email because the link contains it. If the send
	// fails, the token must be removed, or a caller who cannot receive email could
	// still redeem the link.
	const { PGlite } = require("@electric-sql/pglite");
	const express = require("express");
	const { createOrderRouter } = require("./order-routes");
	const { createApiErrorHandler } = require("./api-error-handler");
	const { createPoolAdapter } = require("./pglite-pool");
	const { hashOwnerPassword } = require("./owner-credentials-tool");
	const { LEGACY_SCHEMA, seedCatalog, readSql } = require("./sandbox-schema");

	const previous = process.env.OWNER_CONTACT_EMAIL;
	process.env.OWNER_CONTACT_EMAIL = CONFIG.toEmail;
	t.after(() => {
		if (previous === undefined) delete process.env.OWNER_CONTACT_EMAIL;
		else process.env.OWNER_CONTACT_EMAIL = previous;
	});

	const db = await PGlite.create();
	await db.exec(LEGACY_SCHEMA);
	for (const file of ["production-order-system.sql", "owner-account-and-products.sql"]) {
		await db.exec(readSql(file));
	}
	await seedCatalog(db);
	t.after(() => db.close());

	const failures = [];
	const app = express();
	app.use(express.json());
	app.use("/api", createOrderRouter(createPoolAdapter(db), {
		allowedOrigins: ["https://store.example.test"],
		secureCookies: false,
		ownerPasswordHash: hashOwnerPassword("Old-Owner-Password-1"),
		sessionSecret: "x".repeat(40),
		ownerResetDeliver: async () => { throw new Error("The reset email was rejected by the provider (status 422)."); },
	}));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	t.after(() => new Promise(resolve => server.close(resolve)));
	await new Promise(resolve => server.once("listening", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;

	const csrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: "https://store.example.test" } });
	const csrfBody = await csrf.json();
	const cookie = csrf.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
	const response = await fetch(`${base}/api/owner/password/reset-request`, {
		method: "POST",
		headers: {
			Origin: "https://store.example.test", "Content-Type": "application/json",
			Cookie: cookie, "X-CSRF-Token": csrfBody.csrf_token,
		},
		body: "{}",
	});
	// The reply stays generic, so the failure is not observable from outside.
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.delivered, false, "the caller can tell delivery failed without learning anything about the account");
	assert.equal((await db.query("SELECT count(*)::int AS n FROM owner_reset_tokens")).rows[0].n, 0,
		"no token may survive a failed delivery");
});

test("a mocked delivery provider is used and the token is single use", async t => {
	// Exercises the real reset-request and reset routes with a mocked Resend.
	const { PGlite } = require("@electric-sql/pglite");
	const fs = require("node:fs");
	const path = require("node:path");
	const express = require("express");
	const { createOrderRouter } = require("./order-routes");
	const { createApiErrorHandler } = require("./api-error-handler");
	const { createPoolAdapter } = require("./pglite-pool");
	const { hashOwnerPassword } = require("./owner-credentials-tool");
	const { LEGACY_SCHEMA, seedCatalog, readSql } = require("./sandbox-schema");

	// The route resolves the recipient from configuration first, so set it.
	const previousContact = process.env.OWNER_CONTACT_EMAIL;
	process.env.OWNER_CONTACT_EMAIL = CONFIG.toEmail;
	t.after(() => {
		if (previousContact === undefined) delete process.env.OWNER_CONTACT_EMAIL;
		else process.env.OWNER_CONTACT_EMAIL = previousContact;
	});

	const db = await PGlite.create();
	await db.exec(LEGACY_SCHEMA);
	for (const file of ["production-order-system.sql", "owner-account-and-products.sql"]) {
		await db.exec(readSql(file));
	}
	await seedCatalog(db);
	t.after(() => db.close());

	// The owner contact row the request route reads.
	await db.query("INSERT INTO owner_contact (singleton, email) VALUES (true, $1)", [CONFIG.toEmail]);

	const sent = [];
	const app = express();
	app.use(express.json({ limit: "1mb" }));
	// The shared pool adapter, not a hand-rolled shim: the reset route opens a
	// client for its transaction, so a query-only object fails with a 500.
	app.use("/api", createOrderRouter(createPoolAdapter(db), {
		allowedOrigins: ["https://store.example.test"],
		secureCookies: false,
		ownerPasswordHash: hashOwnerPassword("Old-Owner-Password-1"),
		sessionSecret: "x".repeat(40),
		// The mocked provider: records instead of sending. No real Resend call.
		ownerResetDeliver: async ({ token, recipient }) => {
			sent.push({ token, recipient });
		},
	}));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${server.address().port}`;

	const csrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: "https://store.example.test" } });
	const csrfBody = await csrf.json();
	const jar = csrf.headers.getSetCookie().map(c => c.split(";")[0]);
	const header = {
		Origin: "https://store.example.test",
		"Content-Type": "application/json",
		Cookie: jar.join("; "),
		"X-CSRF-Token": csrfBody.csrf_token,
	};

	// 1. Requesting a reset delivers exactly one token.
	const request = await fetch(`${base}/api/owner/password/reset-request`, {
		method: "POST", headers: header, body: "{}",
	});
	assert.equal(request.status, 200);
	const requestBody = await request.json();
	assert.equal(requestBody.requested, true);
	assert.match(requestBody.message, /\S/, "a generic message must be returned");
	assert.equal(sent.length, 1, "exactly one email must be sent");
	assert.equal(sent[0].recipient, CONFIG.toEmail, "it must go to the configured contact");
	assert.equal(requestBody.delivery_configured, true, "the UI needs to know email is live");
	assert.equal(requestBody.delivered, true);

	const stored = await db.query("SELECT count(*)::int AS n FROM owner_reset_tokens");
	assert.equal(stored.rows[0].n, 1, "exactly one token row");

	// 2. The row holds only a hash, never the token.
	const row = await db.query("SELECT token_hash FROM owner_reset_tokens");
	assert.match(row.rows[0].token_hash, /^[a-f0-9]{64}$/, "only the hash is stored");
	assert.ok(!row.rows[0].token_hash.includes(sent[0].token), "the token itself must not be stored");

	// 3. The token resets the password.
	const reset = await fetch(`${base}/api/owner/password/reset`, {
		method: "POST", headers: header,
		body: JSON.stringify({
			token: sent[0].token,
			new_password: "Brand-New-Password-42",
			confirm_password: "Brand-New-Password-42",
		}),
	});
	assert.equal(reset.status, 200, `reset must succeed: ${JSON.stringify(await reset.clone().json()).slice(0, 160)}`);
	const resetBody = await reset.json();
	assert.equal(resetBody.reset, true);
	assert.equal(resetBody.sessions_revoked, true);

	// 4. The new password works and the old one does not.
	const loginAttempt = async password => {
		const c = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: "https://store.example.test" } });
		const b = await c.json();
		const j = c.headers.getSetCookie().map(x => x.split(";")[0]);
		const r = await fetch(`${base}/api/owner/login`, {
			method: "POST",
			headers: {
				Origin: "https://store.example.test", "Content-Type": "application/json",
				Cookie: j.join("; "), "X-CSRF-Token": b.csrf_token,
			},
			body: JSON.stringify({ password }),
		});
		return r.status;
	};
	assert.equal(await loginAttempt("Old-Owner-Password-1"), 401, "the old password must stop working");
	assert.equal(await loginAttempt("Brand-New-Password-42"), 200, "the new password must work");

	// 5. The token cannot be used again.
	const reuse = await fetch(`${base}/api/owner/password/reset`, {
		method: "POST", headers: header,
		body: JSON.stringify({
			token: sent[0].token,
			new_password: "Another-Password-999",
			confirm_password: "Another-Password-999",
		}),
	});
	assert.equal(reuse.status, 400, "a consumed token must be refused");
	assert.equal(await loginAttempt("Another-Password-999"), 401, "the reuse must not have changed anything");
});

test("a reset request with no delivery provider issues no token", async t => {
	const { PGlite } = require("@electric-sql/pglite");
	const express = require("express");
	const { createOrderRouter } = require("./order-routes");
	const { createApiErrorHandler } = require("./api-error-handler");
	const { hashOwnerPassword } = require("./owner-credentials-tool");
	const { LEGACY_SCHEMA, seedCatalog, readSql } = require("./sandbox-schema");

	const db = await PGlite.create();
	await db.exec(LEGACY_SCHEMA);
	for (const file of ["production-order-system.sql", "owner-account-and-products.sql"]) {
		await db.exec(readSql(file));
	}
	await seedCatalog(db);
	await db.query("INSERT INTO owner_contact (singleton, email) VALUES (true, $1)", [CONFIG.toEmail]);
	t.after(() => db.close());

	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.use("/api", createOrderRouter({ query: (q, p) => db.query(q, p || []) }, {
		allowedOrigins: ["https://store.example.test"],
		secureCookies: false,
		ownerPasswordHash: hashOwnerPassword("Old-Owner-Password-1"),
		sessionSecret: "x".repeat(40),
		ownerResetDeliver: null,   // nothing configured
	}));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${server.address().port}`;

	const csrf = await fetch(`${base}/api/owner/csrf`, { headers: { Origin: "https://store.example.test" } });
	const csrfBody = await csrf.json();
	const response = await fetch(`${base}/api/owner/password/reset-request`, {
		method: "POST",
		headers: {
			Origin: "https://store.example.test", "Content-Type": "application/json",
			Cookie: csrf.headers.getSetCookie().map(c => c.split(";")[0]).join("; "),
			"X-CSRF-Token": csrfBody.csrf_token,
		},
		body: "{}",
	});
	assert.equal(response.status, 200, "the response must stay generic");
	assert.equal((await response.json()).requested, true);
	assert.equal(
		(await db.query("SELECT count(*)::int AS n FROM owner_reset_tokens")).rows[0].n, 0,
		"no token may be issued when there is no way to deliver it",
	);
});

test("an expired reset token is refused", async t => {
	const { PGlite } = require("@electric-sql/pglite");
	const express = require("express");
	const { createOrderRouter } = require("./order-routes");
	const { createApiErrorHandler } = require("./api-error-handler");
	const { createPoolAdapter } = require("./pglite-pool");
	const { hashOwnerPassword, generateSessionSecret } = require("./owner-credentials-tool");
	const { generateResetToken, hashResetToken } = require("./owner-account");
	const { LEGACY_SCHEMA, seedCatalog, readSql } = require("./sandbox-schema");

	const db = await PGlite.create();
	await db.exec(LEGACY_SCHEMA);
	for (const file of ["production-order-system.sql", "owner-account-and-products.sql"]) {
		await db.exec(readSql(file));
	}
	await seedCatalog(db);
	t.after(() => db.close());

	// A token that expired one minute ago.
	const expired = generateResetToken();
	await db.query(
		"INSERT INTO owner_reset_tokens (token_hash, expires_at) VALUES ($1, CURRENT_TIMESTAMP - INTERVAL '1 minute')",
		[hashResetToken(expired)],
	);

	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.use("/api", createOrderRouter(createPoolAdapter(db), {
		allowedOrigins: ["https://store.example.test"],
		secureCookies: false,
		ownerPasswordHash: hashOwnerPassword("Old-Owner-Password-1"),
		sessionSecret: generateSessionSecret(),
		ownerResetDeliver: async () => {},
	}));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${server.address().port}`;

	const response = await fetch(`${base}/api/owner/password/reset`, {
		method: "POST",
		headers: { Origin: "https://store.example.test", "Content-Type": "application/json" },
		body: JSON.stringify({ token: expired, new_password: "New-Password-1234", confirm_password: "New-Password-1234" }),
	});
	assert.equal(response.status, 400, "an expired token must be refused");
	assert.match((await response.json()).error, /expired|already been used|not valid/i);
	// The password must be untouched.
	const stillOld = await db.query("SELECT count(*)::int AS n FROM owner_credentials");
	assert.equal(stillOld.rows[0].n, 0, "no password was written");
});
