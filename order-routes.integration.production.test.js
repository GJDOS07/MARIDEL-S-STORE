"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const express = require("express");
const { createOrderRouter } = require("./order-routes");
const { createApiErrorHandler } = require("./api-error-handler");

const scrypt = promisify(crypto.scrypt);
const OWNER_ORIGIN = "https://store.example";
const createIdempotencyKey = () => crypto.randomBytes(32).toString("base64url");
const ORDER = {
	customer_name: "Test Customer",
	customer_contact: "0400000000",
	pickup_date: "2099-06-15",
	pickup_time: "13:30",
	items: [{ product_id: 1, quantity: 2 }],
};

function createFakePool({
	failOrderItemInsert = false,
	legacyTrackingToken = null,
} = {}) {
	const events = [];
	const storedSessionHashes = new Set();
	const ownerState = { status: "Pending", cancellationReason: null, loginAttempts: 0 };
	let savedOrder = null;
	const savedItems = [];
	const client = {
		async query(sql, params = []) {
			const statement = sql.trim();
			if (statement === "BEGIN") {
				events.push("BEGIN");
				return { rows: [], rowCount: 0 };
			}
			if (statement === "COMMIT") {
				events.push("COMMIT");
				return { rows: [], rowCount: 0 };
			}
			if (statement === "ROLLBACK") {
				events.push("ROLLBACK");
				return { rows: [], rowCount: 0 };
			}
			if (statement.startsWith("SELECT pg_advisory_xact_lock")) {
				return { rows: [{}], rowCount: 1 };
			}
			if (statement.startsWith("SELECT id, customer_access_token, tracking_token_hash")) {
				const order = savedOrder && savedOrder.idempotency_key === params[0] ? savedOrder : null;
				return { rows: order ? [{
					id: order.id,
					customer_access_token: order.customer_access_token,
					tracking_token_hash: order.tracking_token_hash,
					idempotency_fingerprint: order.idempotency_fingerprint,
					customer_name: order.customer_name,
					customer_contact: order.customer_contact,
					pickup_date: order.pickup_date,
					pickup_time: order.pickup_time,
				}] : [], rowCount: order ? 1 : 0 };
			}
			if (statement.startsWith("SELECT product_id, quantity FROM order_items")) {
				return {
					rows: savedItems.filter(item => item.order_id === params[0])
						.map(({ product_id, quantity }) => ({ product_id, quantity })),
					rowCount: savedItems.filter(item => item.order_id === params[0]).length,
				};
			}
			if (statement.startsWith("SELECT id, name, price::text AS price FROM products")) {
				return { rows: [{ id: 1, name: "Example product", price: "2.50" }], rowCount: 1 };
			}
			if (statement.startsWith("INSERT INTO orders")) {
				events.push("INSERT_ORDER");
				savedOrder = {
					id: 42,
					customer_name: params[0],
					customer_contact: params[1],
					pickup_date: params[2],
					pickup_time: params[3],
					requested_pickup_time: params[3],
					total: params[4],
					status: "Pending",
					idempotency_key: params[5],
					idempotency_fingerprint: params[6],
					customer_access_token: null,
					tracking_token_hash: null,
				};
				return { rows: [{ id: savedOrder.id }], rowCount: 1 };
			}
			if (statement.startsWith("UPDATE orders SET tracking_token_hash")) {
				savedOrder.tracking_token_hash = params[0];
				return { rows: [], rowCount: 1 };
			}
			if (statement.startsWith("INSERT INTO order_items")) {
				events.push("INSERT_ORDER_ITEM");
				if (failOrderItemInsert) throw new Error("simulated item insert failure");
				savedItems.push({
					order_id: params[0],
					product_id: params[1],
					product_name: params[2],
					quantity: params[3],
					price: params[4],
					unit_price: params[4],
					subtotal: params[5],
				});
				return { rows: [], rowCount: 1 };
			}
			if (statement.startsWith("SELECT id::text AS id, pickup_date")) {
				return {
					rows: savedOrder ? [{
						id: String(savedOrder.id),
						pickup_date: savedOrder.pickup_date,
						pickup_time: savedOrder.pickup_time,
						total: savedOrder.total,
						status: savedOrder.status,
						cancellation_reason: ownerState.cancellationReason,
					}] : [],
					rowCount: savedOrder ? 1 : 0,
				};
			}
			if (
				statement.startsWith("SELECT oi.product_id::text AS product_id")
				|| statement.startsWith("SELECT COALESCE(oi.product_name")
			) {
				return {
					rows: savedItems.filter(item => item.order_id === params[0]).map(item => ({
						product_id: String(item.product_id),
						product_name: item.product_name,
						unit_price: item.unit_price,
						quantity: item.quantity,
						subtotal: item.subtotal,
					})),
					rowCount: savedItems.filter(item => item.order_id === params[0]).length,
				};
			}
			if (statement.startsWith("SELECT status, cancellation_reason FROM orders WHERE id = $1 FOR UPDATE")) {
				return { rows: [{ status: ownerState.status, cancellation_reason: ownerState.cancellationReason }], rowCount: 1 };
			}
			if (statement.startsWith("UPDATE orders SET status = $1 WHERE id = $2")) {
				ownerState.status = params[0];
				events.push("UPDATE_ORDER_STATUS");
				return { rows: [], rowCount: 1 };
			}
			if (statement.startsWith("UPDATE orders SET status = $1, cancellation_reason = $3 WHERE id = $2")) {
				ownerState.status = params[0];
				ownerState.cancellationReason = params[2];
				events.push("UPDATE_ORDER_STATUS");
				return { rows: [], rowCount: 1 };
			}
			if (statement.startsWith("SELECT id::text AS id, customer_name")) {
				return {
					rows: [{
						id: String(params[0]),
						customer_name: "Test Customer",
						customer_contact: "0400000000",
						pickup_date: ORDER.pickup_date,
						pickup_time: ORDER.pickup_time,
						total: "5.00",
						status: ownerState.status,
						cancellation_reason: ownerState.cancellationReason,
						created_at: "2099-01-01T00:00:00.000Z",
					}],
					rowCount: 1,
				};
			}
			throw new Error(`Unexpected test query: ${statement}`);
		},
		release() {},
	};
	return {
		events,
		async connect() {
			return client;
		},
		async query(sql, params = []) {
			const statement = sql.trim();
			if (statement.startsWith("SELECT o.id, o.pickup_date")) {
				const byExplicitOrderId = statement.includes("WHERE o.id = $1 AND");
				const candidates = params.slice(byExplicitOrderId ? 1 : 0);
				const matchedOrder = (savedOrder && (
					candidates.includes(savedOrder.customer_access_token)
					|| candidates.includes(savedOrder.tracking_token_hash)
				))
					|| (legacyTrackingToken && candidates.includes(legacyTrackingToken));
				const idMatch = !byExplicitOrderId || Number(params[0]) === (savedOrder ? savedOrder.id : 101);
				if (matchedOrder && idMatch) {
					events.push("TRACKING_ORDER_READ");
					return {
						rows: [{
							id: savedOrder ? savedOrder.id : 101,
							pickup_date: savedOrder ? savedOrder.pickup_date : ORDER.pickup_date,
							pickup_time: savedOrder ? savedOrder.pickup_time : ORDER.pickup_time,
							total: savedOrder ? savedOrder.total : "5.00",
							status: savedOrder ? savedOrder.status : "Pending",
						}],
						rowCount: 1,
					};
				}
				return { rows: [], rowCount: 0 };
			}
			if (
				statement.startsWith("SELECT oi.product_id::text AS product_id")
				|| statement.startsWith("SELECT COALESCE(oi.product_name")
			) {
				return {
					rows: savedItems.filter(item => item.order_id === params[0]).map(item => ({
						product_id: String(item.product_id),
						product_name: item.product_name,
						unit_price: item.unit_price,
						quantity: item.quantity,
						subtotal: item.subtotal,
					})),
					rowCount: savedItems.filter(item => item.order_id === params[0]).length,
				};
			}
			if (statement.startsWith("SELECT 1 FROM owner_sessions")) {
				return {
					rows: storedSessionHashes.has(params[0]) ? [{}] : [],
					rowCount: storedSessionHashes.has(params[0]) ? 1 : 0,
				};
			}
			if (statement.startsWith("INSERT INTO owner_sessions")) {
				storedSessionHashes.add(params[0]);
				events.push("INSERT_OWNER_SESSION");
				return { rows: [], rowCount: 1 };
			}
			if (statement.startsWith("DELETE FROM owner_sessions")) {
				storedSessionHashes.delete(params[0]);
				events.push("DELETE_OWNER_SESSION");
				return { rows: [], rowCount: 1 };
			}
			if (statement.startsWith("INSERT INTO owner_login_attempts")) {
				ownerState.loginAttempts += 1;
				return { rows: [{ attempt_count: ownerState.loginAttempts }], rowCount: 1 };
			}
			if (statement.startsWith("DELETE FROM owner_login_attempts")) {
				ownerState.loginAttempts = 0;
				return { rows: [], rowCount: 1 };
			}
			throw new Error(`Unexpected test pool query: ${statement}`);
		},
		ownerState,
		events,
		savedItems,
		getSavedOrder: () => savedOrder,
	};
}

async function startTestServer(pool, routerOptions = {}) {
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		res.on("finish", () => pool.events.push("RESPONSE_FINISHED"));
		next();
	});
	app.use("/api", createOrderRouter(pool, { allowedOrigins: [OWNER_ORIGIN], ...routerOptions }));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
	};
}

test("only returns order success after the order transaction commits", async t => {
	const pool = createFakePool();
	const server = await startTestServer(pool);
	t.after(() => server.close());

	const response = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": createIdempotencyKey(),
		},
		body: JSON.stringify(ORDER),
	});
	const saved = await response.json();
	assert.equal(response.status, 201);
	assert.equal(saved.total, "5.00");
	assert.equal(saved.order_number, "MS-42");
	assert.equal(saved.pickup_date, ORDER.pickup_date);
	assert.equal(saved.pickup_time, ORDER.pickup_time);
	assert.match(saved.tracking_token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(pool.getSavedOrder().customer_access_token, null);
	assert.equal(
		pool.getSavedOrder().tracking_token_hash,
		crypto.createHash("sha256").update(saved.tracking_token).digest("hex"),
	);
	assert.ok(pool.events.indexOf("COMMIT") >= 0);
	assert.ok(pool.events.indexOf("COMMIT") < pool.events.indexOf("RESPONSE_FINISHED"));
});

test("rolls back a partially inserted order and does not return success", async t => {
	const pool = createFakePool({ failOrderItemInsert: true });
	const server = await startTestServer(pool);
	t.after(() => server.close());

	const response = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": createIdempotencyKey(),
		},
		body: JSON.stringify(ORDER),
	});

	assert.equal(response.status, 500);
	assert.ok(pool.events.includes("ROLLBACK"));
	assert.ok(!pool.events.includes("COMMIT"));
});

test("stores request fingerprints and tracking-token hashes without new plaintext tokens", async t => {
	const pool = createFakePool();
	const server = await startTestServer(pool);
	t.after(() => server.close());

	const response = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": createIdempotencyKey(),
		},
		body: JSON.stringify(ORDER),
	});

	assert.equal(response.status, 201);
	assert.ok(pool.events.includes("INSERT_ORDER"));
	assert.match(pool.getSavedOrder().idempotency_fingerprint, /^[a-f0-9]{64}$/);
	assert.match(pool.getSavedOrder().tracking_token_hash, /^[a-f0-9]{64}$/);
	assert.equal(pool.getSavedOrder().customer_access_token, null);
});

test("returns the same secure tracking credential for an identical idempotent retry", async t => {
	const pool = createFakePool();
	const server = await startTestServer(pool);
	t.after(() => server.close());
	const headers = {
		"Content-Type": "application/json",
		"Idempotency-Key": createIdempotencyKey(),
	};

	const first = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers,
		body: JSON.stringify(ORDER),
	});
	const original = await first.json();
	const retry = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers,
		body: JSON.stringify(ORDER),
	});
	const replay = await retry.json();

	assert.equal(first.status, 201);
	assert.equal(retry.status, 200);
	assert.equal(replay.tracking_token, original.tracking_token);
	assert.match(replay.tracking_token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(pool.events.filter(event => event === "INSERT_ORDER").length, 1);
	assert.equal(pool.events.filter(event => event === "INSERT_ORDER_ITEM").length, 1);
	assert.equal(pool.getSavedOrder().customer_access_token, null);
	assert.equal(
		pool.getSavedOrder().tracking_token_hash,
		crypto.createHash("sha256").update(original.tracking_token).digest("hex"),
	);
	const tracking = await fetch(`${server.url}/api/orders/track`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: replay.tracking_token }),
	});
	assert.equal(tracking.status, 200);
});

test("rejects reuse of an idempotency key for different order details", async t => {
	const pool = createFakePool();
	const server = await startTestServer(pool);
	t.after(() => server.close());
	const headers = {
		"Content-Type": "application/json",
		"Idempotency-Key": createIdempotencyKey(),
	};
	assert.equal((await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers,
		body: JSON.stringify(ORDER),
	})).status, 201);

	const conflictingOrder = { ...ORDER, pickup_time: "13:45" };
	const conflict = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers,
		body: JSON.stringify(conflictingOrder),
	});
	assert.equal(conflict.status, 409);
	assert.equal(pool.events.filter(event => event === "INSERT_ORDER").length, 1);
});

test("tracks a created order only with its bearer token, never its numeric ID", async t => {
	const pool = createFakePool();
	const server = await startTestServer(pool);
	t.after(() => server.close());
	const created = await fetch(`${server.url}/api/orders`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": createIdempotencyKey(),
		},
		body: JSON.stringify(ORDER),
	});
	const order = await created.json();

	const tracked = await fetch(`${server.url}/api/orders/track`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: order.tracking_token }),
	});
	assert.equal(tracked.status, 200);
	assert.equal((await tracked.json()).order_number, "MS-42");

	const numericLookup = await fetch(`${server.url}/api/orders/42`);
	assert.equal(numericLookup.status, 404);
	const invalidCredential = await fetch(`${server.url}/api/orders/track`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: "A".repeat(43) }),
	});
	assert.equal(invalidCredential.status, 404);
});

test("rejects unauthenticated owner order-list and status requests", async t => {
	const pool = createFakePool();
	const server = await startTestServer(pool);
	t.after(() => server.close());

	for (const [path, method] of [
		["/api/owner/orders", "GET"],
		["/api/owner/orders/42/status", "POST"],
	]) {
		const response = await fetch(`${server.url}${path}`, {
			method,
			headers: {
				Origin: OWNER_ORIGIN,
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
			},
			...(method === "POST" ? { body: JSON.stringify({ status: "Confirmed" }) } : {}),
		});
		assert.equal(response.status, 401);
	}
});

test("limits public order creation and tracking requests with Retry-After", async t => {
			const pool = createFakePool();
			const server = await startTestServer(pool, {
				publicRateLimits: {
					order: { limit: 1, windowMs: 60_000 },
					tracking: { limit: 1, windowMs: 60_000 },
				},
});
			t.after(() => server.close());

			const submitOrder = () => fetch(`${server.url}/api/orders`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(32).toString("base64url") },
				body: JSON.stringify(ORDER),
			});
			assert.equal((await submitOrder()).status, 201);
			const limitedOrder = await submitOrder();
			assert.equal(limitedOrder.status, 429);
			assert.ok(Number(limitedOrder.headers.get("retry-after")) > 0);

			const trackRequest = () => fetch(`${server.url}/api/orders/track`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			assert.equal((await trackRequest()).status, 404);
			const limitedTracking = await trackRequest();
			assert.equal(limitedTracking.status, 429);
			assert.ok(Number(limitedTracking.headers.get("retry-after")) > 0);
		});

test("secure order tracking requires the stored customer access token and matching order ID", async t => {
			const legacyToken = crypto.randomBytes(32).toString("base64url");
			const pool = createFakePool({ legacyTrackingToken: legacyToken });
			const server = await startTestServer(pool);
			t.after(() => server.close());

			const response = await fetch(`${server.url}/api/orders/track`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: legacyToken }),
			});
			assert.equal(response.status, 200);
			const trackedOrder = await response.json();
			assert.equal(trackedOrder.order_number, "MS-101");
			assert.ok(Array.isArray(trackedOrder.items));

			const legacyBearer = await fetch(`${server.url}/api/orders/101`, {
				headers: { Authorization: `Bearer ${legacyToken}` },
			});
			assert.equal(legacyBearer.status, 200);
			assert.equal((await legacyBearer.json()).order_number, "MS-101");

			const wrongOrderId = await fetch(`${server.url}/api/orders/102`, {
				headers: { Authorization: `Bearer ${legacyToken}` },
			});
			assert.equal(wrongOrderId.status, 404);

			const unmatched = await fetch(`${server.url}/api/orders/track`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: crypto.randomBytes(32).toString("base64url") }),
			});
			assert.equal(unmatched.status, 404);
			assert.equal(pool.events.filter(event => event === "TRACKING_ORDER_READ").length, 2);
		});

test("owner login issues secure server-side sessions; CSRF protects updates and logout revokes sessions", async t => {
			const salt = crypto.randomBytes(16);
			const password = "fake-test-owner-password";
			const passwordDigest = await scrypt(password, salt, 64);
			const passwordHash = `scrypt$${salt.toString("hex")}$${passwordDigest.toString("hex")}`;
			const sessionSecret = crypto.randomBytes(32).toString("base64url");
			const pool = createFakePool();
			const server = await startTestServer(pool, {
				ownerPasswordHash: passwordHash,
				sessionSecret,
				secureCookies: true,
});
			t.after(() => server.close());

			const csrfResponse = await fetch(`${server.url}/api/owner/csrf`, {
				headers: { Origin: OWNER_ORIGIN },
			});
			assert.equal(csrfResponse.status, 200);
			const csrfBody = await csrfResponse.json();
			const initialCookies = csrfResponse.headers.getSetCookie().map(cookie => cookie.split(";")[0]);
			const csrfCookie = initialCookies.find(cookie => cookie.startsWith("maridel_owner_csrf="));
			assert.ok(csrfCookie);

			const loginResponse = await fetch(`${server.url}/api/owner/login`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: csrfCookie,
					"X-CSRF-Token": csrfBody.csrf_token,
				},
				body: JSON.stringify({ password }),
			});
			assert.equal(loginResponse.status, 200);
			const loginBody = await loginResponse.json();
			const loginCookies = loginResponse.headers.getSetCookie();
			const sessionCookie = loginCookies.find(cookie => cookie.startsWith("maridel_owner_session="));
			const ownerCsrfCookie = loginCookies.find(cookie => cookie.startsWith("maridel_owner_csrf="));
			assert.ok(sessionCookie.includes("HttpOnly"));
			assert.ok(sessionCookie.includes("Secure"));
			assert.ok(sessionCookie.includes("SameSite=None"));
			assert.ok(ownerCsrfCookie.includes("Secure"));
			assert.ok(pool.events.includes("INSERT_OWNER_SESSION"));

			const sessionPair = sessionCookie.split(";")[0];
			const csrfPair = ownerCsrfCookie.split(";")[0];
			const unauthorizedCsrf = await fetch(`${server.url}/api/owner/orders/42/status`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${sessionPair}; ${csrfPair}`,
					"X-CSRF-Token": "invalid-csrf-token",
				},
				body: JSON.stringify({ status: "Confirmed" }),
			});
			assert.equal(unauthorizedCsrf.status, 403);
			assert.equal(pool.ownerState.status, "Pending");

			const forgedCsrf = await fetch(`${server.url}/api/owner/orders/42/status`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${sessionPair}; maridel_owner_csrf=forged-token`,
					"X-CSRF-Token": "forged-token",
				},
				body: JSON.stringify({ status: "Confirmed" }),
			});
			assert.equal(forgedCsrf.status, 403);
			assert.equal(pool.ownerState.status, "Pending");

			const sessionResponse = await fetch(`${server.url}/api/owner/session`, {
				headers: { Origin: OWNER_ORIGIN, Cookie: sessionPair },
			});
			assert.equal(sessionResponse.status, 200);
			const refreshedCsrfCookie = sessionResponse.headers.getSetCookie()
				.find(cookie => cookie.startsWith("maridel_owner_csrf="))
				.split(";")[0];
			const sessionBody = await sessionResponse.json();

			const confirmed = await fetch(`${server.url}/api/owner/orders/42/status`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${sessionPair}; ${refreshedCsrfCookie}`,
					"X-CSRF-Token": sessionBody.csrf_token,
				},
				body: JSON.stringify({ status: "Confirmed" }),
			});
			assert.equal(confirmed.status, 200);
			assert.equal(pool.ownerState.status, "Confirmed");

			const logout = await fetch(`${server.url}/api/owner/logout`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${sessionPair}; ${refreshedCsrfCookie}`,
					"X-CSRF-Token": sessionBody.csrf_token,
				},
				body: "{}",
			});
			assert.equal(logout.status, 200);
			assert.ok(pool.events.includes("DELETE_OWNER_SESSION"));

			const afterLogout = await fetch(`${server.url}/api/owner/orders`, {
				headers: { Origin: OWNER_ORIGIN, Cookie: sessionPair },
			});
			assert.equal(afterLogout.status, 401);
			assert.equal(loginBody.authenticated, true);
		});

test("requires owner authorization, enforces status transitions, and persists cancellation reasons", async t => {
			const salt = crypto.randomBytes(16);
			const passwordDigest = await scrypt("fake-test-owner-password", salt, 64);
			const pool = createFakePool();
			const server = await startTestServer(pool, {
				ownerPasswordHash: `scrypt$${salt.toString("hex")}$${passwordDigest.toString("hex")}`,
				sessionSecret: crypto.randomBytes(32).toString("base64url"),
				secureCookies: true,
});
			t.after(() => server.close());

			const csrfResponse = await fetch(`${server.url}/api/owner/csrf`, { headers: { Origin: OWNER_ORIGIN } });
			const csrfBody = await csrfResponse.json();
			const csrfCookie = csrfResponse.headers.getSetCookie()[0].split(";")[0];
			const login = await fetch(`${server.url}/api/owner/login`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: csrfCookie,
					"X-CSRF-Token": csrfBody.csrf_token,
				},
				body: JSON.stringify({ password: "fake-test-owner-password" }),
			});
			assert.equal(login.status, 200);
			const loginBody = await login.json();
			const cookies = login.headers.getSetCookie();
			const sessionCookie = cookies.find(cookie => cookie.startsWith("maridel_owner_session=")).split(";")[0];
			const ownerCsrfCookie = cookies.find(cookie => cookie.startsWith("maridel_owner_csrf=")).split(";")[0];

			const updateStatus = async (status, cancellationReason) => fetch(`${server.url}/api/owner/orders/42/status`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${sessionCookie}; ${ownerCsrfCookie}`,
					"X-CSRF-Token": loginBody.csrf_token,
				},
				body: JSON.stringify({
					status,
					...(cancellationReason === undefined ? {} : { cancellation_reason: cancellationReason }),
				}),
			});

			assert.equal((await updateStatus("Picked Up")).status, 409);
			assert.equal(pool.ownerState.status, "Pending");
			assert.equal((await updateStatus("Cancelled", "x")).status, 400);
			assert.equal(pool.ownerState.status, "Pending");
			assert.equal((await updateStatus("Confirmed")).status, 200);
			assert.equal(pool.ownerState.status, "Confirmed");
			const cancelled = await updateStatus("Cancelled", "Customer request");
			assert.equal(cancelled.status, 200);
			assert.equal(pool.ownerState.status, "Cancelled");
			assert.equal(pool.ownerState.cancellationReason, "Customer request");
			assert.equal((await cancelled.json()).cancellation_reason, "Customer request");
			assert.equal((await updateStatus("Cancelled", "Different reason")).status, 409);
			assert.equal(pool.ownerState.cancellationReason, "Customer request");
		});

test("rejects owner login and dashboard requests from unapproved origins", async t => {
			const pool = createFakePool();
			const server = await startTestServer(pool, {
				ownerPasswordHash: `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`,
				sessionSecret: crypto.randomBytes(32).toString("base64url"),
});
			t.after(() => server.close());

			const response = await fetch(`${server.url}/api/owner/csrf`, {
				headers: { Origin: "https://unapproved.example" },
			});
			assert.equal(response.status, 403);
		});

test("rate-limits owner login attempts before password verification", async t => {
			const salt = crypto.randomBytes(16);
			const passwordDigest = await scrypt("fake-test-owner-password", salt, 64);
			const pool = createFakePool();
			const server = await startTestServer(pool, {
				ownerPasswordHash: `scrypt$${salt.toString("hex")}$${passwordDigest.toString("hex")}`,
				sessionSecret: crypto.randomBytes(32).toString("base64url"),
			});
			t.after(() => server.close());

			const csrfResponse = await fetch(`${server.url}/api/owner/csrf`, {
				headers: { Origin: OWNER_ORIGIN },
			});
			const csrfBody = await csrfResponse.json();
			const csrfCookie = csrfResponse.headers.getSetCookie()[0].split(";")[0];

			for (let attempt = 0; attempt < 5; attempt += 1) {
				const response = await fetch(`${server.url}/api/owner/login`, {
					method: "POST",
					headers: {
						Origin: OWNER_ORIGIN,
						"Content-Type": "application/json",
						Cookie: csrfCookie,
						"X-CSRF-Token": csrfBody.csrf_token,
					},
					body: JSON.stringify({ password: "wrong-fake-password" }),
				});
				assert.equal(response.status, 401);
			}

			const limited = await fetch(`${server.url}/api/owner/login`, {
				method: "POST",
				headers: {
					Origin: OWNER_ORIGIN,
					"Content-Type": "application/json",
					Cookie: csrfCookie,
					"X-CSRF-Token": csrfBody.csrf_token,
				},
				body: JSON.stringify({ password: "wrong-fake-password" }),
			});
			assert.equal(limited.status, 429);
});
