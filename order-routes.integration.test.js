const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createOrderRouter } = require("./order-routes");

const ADMIN_PASSWORD = "test-admin-password-long-enough";
const ADMIN_ORIGIN = "https://gjdos07.github.io";

class FakePostgresPool {
	constructor() {
		this.products = [
			{ id: "73", name: "Pocari Sweat 330ml", price: "1.50", image: null },
			{ id: "74", name: "Thai Coco Coconut Juice", price: "2.00", image: null },
		];
		this.orders = new Map();
		this.items = [];
		this.nextId = 1001;
		this.failItemInsert = false;
		this.adminListQuery = "";
		this.client = {
			query: (sql, values = []) => this.query(sql, values),
			release: () => {},
		};
	}

	async connect() {
		return this.client;
	}

	async query(sql, values = []) {
		if (sql === "BEGIN") {
			this.snapshot = structuredClone({ orders: this.orders, items: this.items });
			return { rows: [] };
		}
		if (sql === "COMMIT") return { rows: [] };
		if (sql === "ROLLBACK") {
			this.orders = this.snapshot.orders;
			this.items = this.snapshot.items;
			return { rows: [] };
		}
		if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
		if (sql.includes("FROM orders") && sql.includes("ORDER BY") && !sql.includes("WHERE")) {
			this.adminListQuery = sql;
			const priority = order => {
				if (order.status === "Pending" && order.pickup_type === "ASAP") return 0;
				if (order.status === "Pending" && order.pickup_type === "SCHEDULED") return 1;
				if (order.status === "Confirmed") return 2;
				if (["Preparing", "Ready for Pickup"].includes(order.status)) return 3;
				if (["Completed", "Cancelled"].includes(order.status)) return 4;
				return 5;
			};
			const pickupPriority = order => order.confirmed_pickup_at || order.requested_pickup_at || "";
			const rows = [...this.orders.values()]
				.sort((a, b) => priority(a) - priority(b)
					|| (priority(a) === 1 || priority(a) === 2 || priority(a) === 3
						? pickupPriority(a).localeCompare(pickupPriority(b))
						: 0)
					|| a.created_at.getTime() - b.created_at.getTime()
					|| Number(a.order_id) - Number(b.order_id))
				.map(order => this.adminOrderRow(order));
			return { rows };
		}
		if (sql.includes("SELECT id::text AS order_id, status FROM orders") && sql.includes("FOR UPDATE")) {
			const order = this.orders.get(String(values[0]));
			return { rows: order ? [{ order_id: order.order_id, status: order.status }] : [] };
		}
		if (sql.includes("UPDATE orders") && sql.includes("RETURNING")) {
			const orderId = String(values[values.length - 1]);
			const order = this.orders.get(orderId);
			const setClause = sql.split("SET")[1].split("WHERE")[0];
			for (const [, column, position] of setClause.matchAll(/(status|confirmed_pickup_date|confirmed_pickup_time|confirmed_pickup_at)\s*=\s*\$(\d+)/g)) {
				order[column] = values[Number(position) - 1];
			}
			order.updated_at = new Date("2026-10-07T01:00:00.000Z");
			return { rows: [this.adminOrderRow(order)] };
		}
		if (sql.includes("request_fingerprint FROM orders")) {
			const order = [...this.orders.values()].find(item => item.idempotencyKeyHash === values[0]);
			return { rows: order ? [{ order_id: order.order_id, request_fingerprint: order.requestFingerprint }] : [] };
		}
		if (sql.includes("FROM products WHERE id = ANY")) {
			const ids = values[0].map(String);
			return {
				rows: this.products.filter(product => ids.includes(product.id))
					.map(product => ({ ...product, id: product.id, price: product.price })),
			};
		}
		if (sql.includes("INSERT INTO orders")) {
			const orderId = String(this.nextId++);
			const order = {
				order_id: orderId,
				customer_id: null,
				customer_name: values[1],
				customer_contact: values[2],
				customer_email: values[3],
				pickup_type: values[4],
				requested_pickup_date: values[5],
				requested_pickup_time: values[6],
				requested_pickup_at: values[7],
				status: "Pending",
				subtotal: values[8],
				discount: "0",
				shipping_fee: "0",
				total_amount: values[8],
				customer_access_token_hash: values[9],
				idempotencyKeyHash: values[10],
				requestFingerprint: values[11],
				created_at: new Date("2026-10-07T00:00:00.000Z"),
			};
			this.orders.set(orderId, order);
			return { rows: [{ order_id: orderId }] };
		}
		if (sql.includes("INSERT INTO order_items")) {
			if (this.failItemInsert) {
				this.failItemInsert = false;
				throw new Error("simulated item insert failure");
			}
			this.items.push({
				order_id: values[0],
				product_id: String(values[1]),
				product_name_snapshot: values[2],
				unit_price_snapshot: values[3],
				quantity: values[4],
				subtotal: values[5],
			});
			return { rows: [] };
		}
		if (sql.includes("UPDATE orders SET customer_access_token_hash")) {
			const order = this.orders.get(String(values[1]));
			order.customer_access_token_hash = values[0];
			return { rows: [] };
		}
		if (sql.includes("customer_access_token_hash = $2")) {
			const order = this.orders.get(String(values[0]));
			return { rows: order?.customer_access_token_hash === values[1] ? [{ order_id: order.order_id }] : [] };
		}
		if (sql.includes("FROM order_items")) {
			if (Array.isArray(values[0])) {
				const orderIds = new Set(values[0].map(String));
				return {
					rows: this.items
						.filter(item => orderIds.has(item.order_id))
						.map(item => ({ order_id: item.order_id, ...this.adminItemRow(item) })),
				};
			}
			if (sql.includes("AS price")) {
				return {
					rows: this.items
						.filter(item => item.order_id === String(values[0]))
						.map(item => this.adminItemRow(item)),
				};
			}
			return { rows: this.items.filter(item => item.order_id === String(values[0])) };
		}
		if (sql.includes("FROM orders") && sql.includes("WHERE id = $1")) {
			const order = this.orders.get(String(values[0]));
			if (!order) return { rows: [] };
			return {
				rows: [{
					order_id: order.order_id,
					customer_name: order.customer_name,
					pickup_type: order.pickup_type,
					requested_pickup_date: order.requested_pickup_date,
					requested_pickup_time: order.requested_pickup_time,
					confirmed_pickup_date: null,
					confirmed_pickup_time: null,
					status: order.status,
					total_amount: order.total_amount,
					created_at: order.created_at,
				}],
			};
		}
		throw new Error(`Unexpected test SQL: ${sql}`);
	}

	adminOrderRow(order) {
		return {
			order_id: order.order_id,
			customer_name: order.customer_name,
			customer_contact: order.customer_contact,
			customer_email: order.customer_email,
			status: order.status,
			pickup_type: order.pickup_type,
			requested_pickup_date: order.requested_pickup_date,
			requested_pickup_time: order.requested_pickup_time,
			requested_pickup_at: order.requested_pickup_at,
			confirmed_pickup_date: order.confirmed_pickup_date,
			confirmed_pickup_time: order.confirmed_pickup_time,
			confirmed_pickup_at: order.confirmed_pickup_at,
			subtotal: order.subtotal || "5.50",
			discount: order.discount || "0.00",
			shipping_fee: order.shipping_fee || "0.00",
			total: order.total_amount || "5.50",
			created_at: order.created_at,
			updated_at: order.updated_at || order.created_at,
		};
	}

	adminItemRow(item) {
		return {
			product_id: item.product_id,
			product_name_snapshot: item.product_name_snapshot,
			quantity: item.quantity,
			price: item.unit_price_snapshot,
			subtotal: item.subtotal,
		};
	}
}

async function withApi(run, routerOptions = {}) {
	const pool = new FakePostgresPool();
	const app = express();
	app.use(express.json());
	app.use("/api", createOrderRouter(pool, {
		adminPassword: ADMIN_PASSWORD,
		adminAllowedOrigins: [ADMIN_ORIGIN],
		...routerOptions,
	}));
	app.use((error, req, res, next) => res.status(500).json({ error: "An internal server error occurred" }));
	const server = app.listen(0);
	await new Promise(resolve => server.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
	try {
		await run({ baseUrl, pool });
	} finally {
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

function checkoutPayload() {
	return {
		customer_name: "Maridel Customer",
		customer_contact: "+61 400 123 456",
		pickup_type: "SCHEDULED",
		pickup_date: "2099-10-08",
		pickup_time: "09:30",
		items: [
			{ product_id: 73, quantity: 1, price: 999, subtotal: 999 },
			{ product_id: 74, quantity: 2, price: 999, subtotal: 999 },
		],
		total: 1,
	};
}

function idempotencyKey() {
	return require("node:crypto").randomBytes(32).toString("base64url");
}

function seedAdminOrders(pool) {
	const orders = [
		{ order_id: "20", status: "Completed", pickup_type: "SCHEDULED", requested_pickup_at: "2026-10-08T01:00:00.000Z" },
		{ order_id: "19", status: "Preparing", pickup_type: "SCHEDULED", requested_pickup_at: "2026-10-08T00:00:00.000Z" },
		{ order_id: "18", status: "Confirmed", pickup_type: "SCHEDULED", confirmed_pickup_at: "2026-10-08T03:00:00.000Z" },
		{ order_id: "17", status: "Pending", pickup_type: "SCHEDULED", requested_pickup_at: "2026-10-08T02:00:00.000Z" },
		{ order_id: "16", status: "Pending", pickup_type: "ASAP", requested_pickup_at: "2026-10-08T00:30:00.000Z" },
		{ order_id: "15", status: "Cancelled", pickup_type: "ASAP", requested_pickup_at: "2026-10-08T00:15:00.000Z" },
		{ order_id: "14", status: "Ready for Pickup", pickup_type: "SCHEDULED", requested_pickup_at: "2026-10-08T01:30:00.000Z" },
		{ order_id: "13", status: "Pending", pickup_type: "SCHEDULED", requested_pickup_at: "2026-10-08T01:00:00.000Z" },
	].map((order, index) => ({
		customer_name: `Customer ${order.order_id}`,
		customer_contact: "+61 400 123 456",
		customer_email: "customer@example.com",
		requested_pickup_date: "2026-10-08",
		requested_pickup_time: "09:30",
		confirmed_pickup_date: null,
		confirmed_pickup_time: null,
		confirmed_pickup_at: null,
		subtotal: "5.50",
		discount: "0.00",
		shipping_fee: "0.00",
		total_amount: "5.50",
		created_at: new Date(`2026-10-07T00:0${index}:00.000Z`),
		...order,
	}));
	for (const order of orders) {
		pool.orders.set(order.order_id, order);
		pool.items.push({
			order_id: order.order_id,
			product_id: "73",
			product_name_snapshot: "Pocari Sweat 330ml",
			unit_price_snapshot: "1.50",
			quantity: 1,
			subtotal: "1.50",
		});
	}
}

async function adminHeaders(baseUrl) {
	const csrfToken = await fetchCsrfToken(baseUrl);
	const response = await fetch(`${baseUrl}/admin/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: ADMIN_ORIGIN,
			"X-CSRF-Token": csrfToken,
		},
		body: JSON.stringify({ password: ADMIN_PASSWORD }),
	});
	assert.equal(response.status, 200);
	const cookie = response.headers.get("set-cookie");
	assert.ok(cookie);
	return {
		Cookie: cookie.split(";")[0],
		Origin: ADMIN_ORIGIN,
		"X-CSRF-Token": csrfToken,
	};
}

async function fetchCsrfToken(baseUrl, origin = ADMIN_ORIGIN) {
	const response = await fetch(`${baseUrl}/admin/csrf`, { headers: { Origin: origin } });
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(typeof result.csrf_token, "string");
	return result.csrf_token;
}

test("order creation uses database prices and permits token-protected customer tracking", async () => {
	await withApi(async ({ baseUrl, pool }) => {
		const key = idempotencyKey();
		const response = await fetch(`${baseUrl}/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": key },
			body: JSON.stringify(checkoutPayload()),
		});
		assert.equal(response.status, 201);
		const created = await response.json();
		assert.equal(created.total_amount, "5.50");
		assert.equal(created.status, "Pending");
		assert.equal(created.items[0].unit_price, "1.50");
		assert.equal(created.items[1].subtotal, "4.00");
		assert.equal(pool.orders.size, 1);
		assert.equal(pool.items.length, 2);
		const savedOrder = [...pool.orders.values()][0];
		assert.equal(savedOrder.customer_id, null);
		assert.equal(savedOrder.subtotal, "5.50");
		assert.equal(savedOrder.discount, "0");
		assert.equal(savedOrder.shipping_fee, "0");
		assert.equal(savedOrder.total_amount, "5.50");
		assert.equal(pool.items[0].unit_price_snapshot, "1.50");

		const tracking = await fetch(`${baseUrl}/orders/${created.order_id}`, {
			headers: { Authorization: `Bearer ${created.customer_access_token}` },
		});
		assert.equal(tracking.status, 200);
		assert.equal((await tracking.json()).total_amount, "5.50");
		const denied = await fetch(`${baseUrl}/orders/${created.order_id}`, {
			headers: { Authorization: `Bearer ${"x".repeat(43)}` },
		});
		assert.equal(denied.status, 404);
	});
});

test("repeating an idempotent checkout does not create a duplicate order", async () => {
	await withApi(async ({ baseUrl, pool }) => {
		const key = idempotencyKey();
		const submit = () => fetch(`${baseUrl}/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": key },
			body: JSON.stringify(checkoutPayload()),
		});
		const first = await (await submit()).json();
		const replayResponse = await submit();
		const replay = await replayResponse.json();
		assert.equal(replayResponse.status, 200);
		assert.equal(replay.order_id, first.order_id);
		assert.notEqual(replay.customer_access_token, first.customer_access_token);
		assert.equal(pool.orders.size, 1);
		assert.equal(pool.items.length, 2);
	});
});

test("failed order-item insertion rolls the order back", async () => {
	await withApi(async ({ baseUrl, pool }) => {
		pool.failItemInsert = true;
		const response = await fetch(`${baseUrl}/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey() },
			body: JSON.stringify(checkoutPayload()),
		});
		assert.equal(response.status, 500);
		assert.equal(pool.orders.size, 0);
		assert.equal(pool.items.length, 0);
	});
});

test("admin order listing requires authentication and returns private staff order and item data by pickup priority", async () => {
	await withApi(async ({ baseUrl, pool }) => {
		seedAdminOrders(pool);
		const unauthenticated = await fetch(`${baseUrl}/admin/orders`);
		assert.equal(unauthenticated.status, 401);

		const wrongPassword = await fetch(`${baseUrl}/admin/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ADMIN_ORIGIN,
				"X-CSRF-Token": await fetchCsrfToken(baseUrl),
			},
			body: JSON.stringify({ password: "incorrect-password" }),
		});
		assert.equal(wrongPassword.status, 401);
		assert.equal(wrongPassword.headers.get("set-cookie"), null);

		const csrfToken = await fetchCsrfToken(baseUrl);
		const login = await fetch(`${baseUrl}/admin/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ADMIN_ORIGIN,
				"X-CSRF-Token": csrfToken,
			},
			body: JSON.stringify({ password: ADMIN_PASSWORD }),
		});
		assert.equal(login.status, 200);
		const setCookie = login.headers.get("set-cookie");
		assert.match(setCookie, /HttpOnly/i);
		assert.match(setCookie, /SameSite=Strict/i);
		assert.doesNotMatch(setCookie, /; Secure/i);
		assert.match(setCookie, /Path=\/api\/admin/i);
		assert.match(setCookie, /Max-Age=28800/i);
		assert.equal((await login.json()).authenticated, true);
		const headers = {
			Cookie: setCookie.split(";")[0],
			Origin: ADMIN_ORIGIN,
			"X-CSRF-Token": csrfToken,
		};
		const response = await fetch(`${baseUrl}/admin/orders`, { headers });
		assert.equal(response.status, 200);
		const orders = await response.json();
		assert.deepEqual(orders.map(order => order.order_id), ["16", "13", "17", "18", "19", "14", "20", "15"]);
		const pending = orders[1];
		assert.equal(pending.customer_contact, "+61 400 123 456");
		assert.equal(pending.customer_email, "customer@example.com");
		assert.equal(pending.requested_pickup_date, "2026-10-08");
		assert.equal(pending.requested_pickup_time, "09:30");
		assert.equal(pending.subtotal, "5.50");
		assert.equal(pending.total, "5.50");
		assert.equal(pending.items[0].product_id, "73");
		assert.equal(pending.items[0].product_name_snapshot, "Pocari Sweat 330ml");
		assert.equal(pending.items[0].quantity, 1);
		assert.equal(pending.items[0].price, "1.50");
		assert.equal(pending.items[0].subtotal, "1.50");
		assert.equal(JSON.stringify(orders).includes("customer_access_token"), false);
		assert.equal(JSON.stringify(orders).includes("customer_access_token_hash"), false);
		assert.match(pool.adminListQuery, /CASE\s+WHEN status = 'Pending' AND pickup_type = 'ASAP' THEN 0/s);
		assert.match(pool.adminListQuery, /WHEN status = 'Pending' AND pickup_type = 'SCHEDULED' THEN 1/s);
		assert.match(pool.adminListQuery, /WHEN status = 'Confirmed' THEN 2/s);

		const logout = await fetch(`${baseUrl}/admin/logout`, { method: "POST", headers });
		assert.equal(logout.status, 200);
		assert.equal((await fetch(`${baseUrl}/admin/orders`, { headers })).status, 401);
	});
});

test("admin PATCH requires authentication, updates status and confirmed pickup, and preserves protected fields", async () => {
	await withApi(async ({ baseUrl, pool }) => {
		seedAdminOrders(pool);
		const headers = await adminHeaders(baseUrl);
		const unauthenticated = await fetch(`${baseUrl}/admin/orders/16`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "Confirmed" }),
		});
		assert.equal(unauthenticated.status, 401);

		const statusResponse = await fetch(`${baseUrl}/admin/orders/16`, {
			method: "PATCH",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ status: "Confirmed" }),
		});
		assert.equal(statusResponse.status, 200);
		assert.equal((await statusResponse.json()).status, "Confirmed");

		const pickupResponse = await fetch(`${baseUrl}/admin/orders/16`, {
			method: "PATCH",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ confirmed_pickup_date: "2099-10-08", confirmed_pickup_time: "09:30" }),
		});
		assert.equal(pickupResponse.status, 200);
		const updated = await pickupResponse.json();
		assert.equal(updated.confirmed_pickup_date, "2099-10-08");
		assert.equal(updated.confirmed_pickup_time, "09:30");
		assert.equal(updated.status, "Confirmed");
		assert.equal(updated.total, "5.50");
		assert.equal(updated.items[0].price, "1.50");
	});
});

test("admin PATCH validates status, pickup pairs, valid future pickup, and order existence", async () => {
	await withApi(async ({ baseUrl, pool }) => {
		seedAdminOrders(pool);
		const headers = await adminHeaders(baseUrl);
		const patch = (orderId, body) => fetch(`${baseUrl}/admin/orders/${orderId}`, {
			method: "PATCH",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal((await patch("16", { status: "Unknown" })).status, 400);
		assert.equal((await patch("16", { status: "Preparing" })).status, 400);
		assert.equal((await patch("16", { confirmed_pickup_date: "2099-10-08" })).status, 400);
		assert.equal((await patch("16", { confirmed_pickup_date: "2026-02-31", confirmed_pickup_time: "09:30" })).status, 400);
		assert.equal((await patch("16", { confirmed_pickup_date: "2099-10-08", confirmed_pickup_time: "18:00" })).status, 400);
		assert.equal((await patch("999", { status: "Confirmed" })).status, 404);
		assert.equal((await patch("0", { status: "Confirmed" })).status, 400);
	});
});

test("admin state changes require an allowlisted origin and valid origin-bound CSRF token", async () => {
	await withApi(async ({ baseUrl }) => {
		const deniedToken = await fetch(`${baseUrl}/admin/csrf`, {
			headers: { Origin: "https://attacker.example" },
		});
		assert.equal(deniedToken.status, 403);

		const missingToken = await fetch(`${baseUrl}/admin/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ADMIN_ORIGIN,
			},
			body: JSON.stringify({ password: ADMIN_PASSWORD }),
		});
		assert.equal(missingToken.status, 403);

		const csrfToken = await fetchCsrfToken(baseUrl);
		const wrongOriginLogin = await fetch(`${baseUrl}/admin/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://attacker.example",
				"X-CSRF-Token": csrfToken,
			},
			body: JSON.stringify({ password: ADMIN_PASSWORD }),
		});
		assert.equal(wrongOriginLogin.status, 403);
	});
});

test("production admin cookies support cross-site use and remain Secure and HttpOnly", async () => {
	await withApi(async ({ baseUrl }) => {
		const csrfToken = await fetchCsrfToken(baseUrl);
		const login = await fetch(`${baseUrl}/admin/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ADMIN_ORIGIN,
				"X-CSRF-Token": csrfToken,
			},
			body: JSON.stringify({ password: ADMIN_PASSWORD }),
		});
		assert.equal(login.status, 200);
		const cookie = login.headers.get("set-cookie");
		assert.match(cookie, /HttpOnly/i);
		assert.match(cookie, /SameSite=None/i);
		assert.match(cookie, /; Secure/i);

		const authenticated = { Cookie: cookie.split(";")[0], Origin: ADMIN_ORIGIN };
		const withoutCsrf = await fetch(`${baseUrl}/admin/logout`, {
			method: "POST",
			headers: authenticated,
		});
		assert.equal(withoutCsrf.status, 403);
	}, { secureCookies: true });
});
