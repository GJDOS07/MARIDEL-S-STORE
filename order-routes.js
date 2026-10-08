const crypto = require("node:crypto");
const express = require("express");
const { promisify } = require("node:util");
const {
	validatePickupChoice,
} = require("./pickup-time");

const scrypt = promisify(crypto.scrypt);
const MAX_ORDER_ITEMS = 30;
const MAX_QUANTITY_PER_ITEM = 99;
const MAX_ORDER_QUANTITY = 200;
const ADMIN_SESSION_COOKIE = "maridel_admin_session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ADMIN_ORIGINS = [
	"https://gjdos07.github.io",
	"http://localhost:5500",
	"http://127.0.0.1:5500",
];
const ORDER_STATUSES = [
	"Pending",
	"Confirmed",
	"Preparing",
	"Ready for Pickup",
	"Completed",
	"Cancelled",
];
const STATUS_TRANSITIONS = {
	"Pending": ["Confirmed", "Cancelled"],
	"Confirmed": ["Preparing", "Cancelled"],
	"Preparing": ["Ready for Pickup", "Cancelled"],
	"Ready for Pickup": ["Completed", "Cancelled"],
	"Completed": [],
	"Cancelled": [],
};
const ADMIN_ORDER_FIELDS = `
	id::text AS order_id,
	customer_name,
	customer_contact,
	customer_email,
	status,
	pickup_type,
	to_char(requested_pickup_date, 'YYYY-MM-DD') AS requested_pickup_date,
	to_char(requested_pickup_time, 'HH24:MI') AS requested_pickup_time,
	requested_pickup_at,
	to_char(confirmed_pickup_date, 'YYYY-MM-DD') AS confirmed_pickup_date,
	to_char(confirmed_pickup_time, 'HH24:MI') AS confirmed_pickup_time,
	confirmed_pickup_at,
	subtotal::text AS subtotal,
	discount::text AS discount,
	shipping_fee::text AS shipping_fee,
	total::text AS total,
	created_at,
	updated_at
`;

function apiError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

function sha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeCheckout(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw apiError(400, "INVALID_ORDER", "Please check the order details and try again.");
	}

	const customerName = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
	const customerContact = typeof body.customer_contact === "string" ? body.customer_contact.trim() : "";
	const customerEmail = typeof body.customer_email === "string" ? body.customer_email.trim() : "";
	if (!customerName || customerName.length > 100) {
		throw apiError(400, "INVALID_CUSTOMER_NAME", "Enter your name (up to 100 characters).");
	}
	if (
		customerContact.length < 7
		|| customerContact.length > 25
		|| !/^\+?[0-9](?:[0-9\s().-]*[0-9])$/.test(customerContact)
	) {
		throw apiError(400, "INVALID_CUSTOMER_CONTACT", "Enter a valid contact number.");
	}
	if (customerEmail.length > 254 || (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) {
		throw apiError(400, "INVALID_CUSTOMER_EMAIL", "Enter a valid email address or leave the field blank.");
	}
	if (!Array.isArray(body.items) || body.items.length === 0) {
		throw apiError(400, "INVALID_ORDER_ITEMS", "Your cart is empty.");
	}
	if (body.items.length > MAX_ORDER_ITEMS) {
		throw apiError(400, "INVALID_ORDER_ITEMS", "Your cart contains too many items.");
	}

	const itemsById = new Map();
	let totalQuantity = 0;
	for (const item of body.items) {
		const rawProductId = item && item.product_id;
		const rawQuantity = item && item.quantity;
		const productId = typeof rawProductId === "number"
			? rawProductId
			: (typeof rawProductId === "string" && /^\d+$/.test(rawProductId) ? Number(rawProductId) : NaN);
		const quantity = typeof rawQuantity === "number"
			? rawQuantity
			: (typeof rawQuantity === "string" && /^\d+$/.test(rawQuantity) ? Number(rawQuantity) : NaN);
		if (!Number.isSafeInteger(productId) || productId <= 0) {
			throw apiError(400, "INVALID_PRODUCT", "One or more products are no longer available.");
		}
		if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
			throw apiError(400, "INVALID_QUANTITY", "Please enter a valid quantity.");
		}

		const combinedQuantity = (itemsById.get(productId) || 0) + quantity;
		if (combinedQuantity > MAX_QUANTITY_PER_ITEM) {
			throw apiError(400, "INVALID_QUANTITY", "Please enter a valid quantity.");
		}
		itemsById.set(productId, combinedQuantity);
		totalQuantity += quantity;
	}
	if (totalQuantity > MAX_ORDER_QUANTITY) {
		throw apiError(400, "INVALID_QUANTITY", "Please enter a valid quantity.");
	}

	const items = [...itemsById.entries()]
		.map(([productId, quantity]) => ({ productId, quantity }))
		.sort((a, b) => a.productId - b.productId);
	const pickupType = body.pickup_type;
	const pickupDate = body.pickup_date;
	const pickupTime = body.pickup_time;
	if (
		(pickupType === "ASAP" && (pickupDate || pickupTime))
		|| (pickupType === "SCHEDULED" && (typeof pickupDate !== "string" || typeof pickupTime !== "string"))
	) {
		throw apiError(400, "INVALID_PICKUP", "Please select a valid pickup option and schedule.");
	}

	return {
		customerName,
		customerContact,
		customerEmail: customerEmail || null,
		pickupType,
		pickupDate: pickupDate || null,
		pickupTime: pickupTime || null,
		items,
	};
}

function moneyToCents(amount) {
	if (typeof amount !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(amount)) {
		throw new Error("A database product price is not a valid AUD amount.");
	}
	const [whole, fraction = ""] = amount.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function centsToAmount(cents) {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function generateAccessToken() {
	return crypto.randomBytes(32).toString("base64url");
}

function createOrderRouter(pool, {
	adminPassword,
	secureCookies = process.env.NODE_ENV === "production",
	adminAllowedOrigins = DEFAULT_ADMIN_ORIGINS,
} = {}) {
	const router = express.Router();
	const rateLimits = new Map();
	const sessions = new Map();
	const passwordSalt = crypto.randomBytes(16);
	const csrfSigningKey = crypto.randomBytes(32);
	const configuredPasswordHash = typeof adminPassword === "string" && adminPassword.length >= 12
		? crypto.scryptSync(adminPassword, passwordSalt, 64)
		: null;

	function requireAllowedOrigin(req, res, next) {
		const origin = req.get("Origin");
		if (!origin || !adminAllowedOrigins.includes(origin)) {
			return res.status(403).json({ error: "This admin request origin is not allowed." });
		}
		next();
	}

	function createCsrfToken(origin) {
		const expiresAt = Date.now() + CSRF_TOKEN_TTL_MS;
		const nonce = crypto.randomBytes(24).toString("base64url");
		const payload = `${expiresAt}.${nonce}.${origin}`;
		const signature = crypto.createHmac("sha256", csrfSigningKey).update(payload).digest("base64url");
		return `${expiresAt}.${nonce}.${signature}`;
	}

	function requireCsrfToken(req, res, next) {
		const token = req.get("X-CSRF-Token") || "";
		const [expiresAtText, nonce, signature, ...extra] = token.split(".");
		const expiresAt = Number(expiresAtText);
		const origin = req.get("Origin");
		if (
			extra.length > 0
			|| !/^\d{13}$/.test(expiresAtText || "")
			|| !/^[A-Za-z0-9_-]{32}$/.test(nonce || "")
			|| !/^[A-Za-z0-9_-]{43}$/.test(signature || "")
			|| !Number.isSafeInteger(expiresAt)
			|| expiresAt <= Date.now()
			|| expiresAt > Date.now() + CSRF_TOKEN_TTL_MS
		) {
			return res.status(403).json({ error: "A valid CSRF token is required." });
		}

		const payload = `${expiresAtText}.${nonce}.${origin}`;
		const expected = crypto.createHmac("sha256", csrfSigningKey).update(payload).digest();
		const supplied = Buffer.from(signature, "base64url");
		if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
			return res.status(403).json({ error: "A valid CSRF token is required." });
		}
		next();
	}

	function requireAdmin(req, res, next) {
		const sessionId = getSessionId(req);
		if (!sessionId) {
			return res.status(401).json({ error: "Admin authentication is required." });
		}
		const now = Date.now();
		pruneExpiredSessions(now);
		const session = sessions.get(sha256(sessionId));
		if (!session || session.expiresAt <= now) {
			return res.status(401).json({ error: "Admin authentication is required." });
		}
		next();
	}

	function rateLimit({ limit, windowMs, key }) {
		return (req, res, next) => {
			const now = Date.now();
			const bucketKey = `${key}:${req.ip}`;
			let bucket = rateLimits.get(bucketKey);
			if (!bucket || bucket.expiresAt <= now) {
				bucket = { count: 0, expiresAt: now + windowMs };
				rateLimits.set(bucketKey, bucket);
			}
			bucket.count += 1;
			if (rateLimits.size > 10000) {
				for (const [entryKey, entry] of rateLimits) {
					if (entry.expiresAt <= now) rateLimits.delete(entryKey);
				}
			}

			if (bucket.count > limit) {
				return res.status(429).json({
					error: "Too many requests. Please wait a moment and try again.",
					code: "RATE_LIMITED",
				});
			}
			next();
		};
	}

	function serializeAdminCookie(sessionId, maxAgeSeconds) {
		return [
			`${ADMIN_SESSION_COOKIE}=${sessionId}`,
			"HttpOnly",
			secureCookies ? "SameSite=None" : "SameSite=Strict",
			"Path=/api/admin",
			`Max-Age=${maxAgeSeconds}`,
			...(secureCookies ? ["Secure"] : []),
		].join("; ");
	}

	function getSessionId(req) {
		for (const part of (req.get("Cookie") || "").split(";")) {
			const separator = part.indexOf("=");
			if (separator < 0 || part.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
			const sessionId = part.slice(separator + 1).trim();
			return /^[A-Za-z0-9_-]{43}$/.test(sessionId) ? sessionId : null;
		}
		return null;
	}

	function pruneExpiredSessions(now = Date.now()) {
		for (const [sessionHash, session] of sessions) {
			if (session.expiresAt <= now) sessions.delete(sessionHash);
		}
	}

	router.get("/admin/csrf", requireAllowedOrigin, (req, res) => {
		res.set("Cache-Control", "no-store");
		res.json({ csrf_token: createCsrfToken(req.get("Origin")) });
	});

	router.post(
		"/admin/login",
		requireAllowedOrigin,
		requireCsrfToken,
		rateLimit({ limit: 5, windowMs: 15 * 60 * 1000, key: "admin-login" }),
		async (req, res, next) => {
			try {
				if (!configuredPasswordHash) {
					return res.status(503).json({ error: "Admin password authentication is not configured." });
				}
				const password = req.body && typeof req.body.password === "string"
					? req.body.password
					: "";
				if (password.length > 1024) {
					return res.status(401).json({ error: "Invalid admin credentials." });
				}
				const suppliedPasswordHash = await scrypt(password, passwordSalt, 64);
				if (!crypto.timingSafeEqual(suppliedPasswordHash, configuredPasswordHash)) {
					return res.status(401).json({ error: "Invalid admin credentials." });
				}

				const now = Date.now();
				pruneExpiredSessions(now);
				const sessionId = crypto.randomBytes(32).toString("base64url");
				sessions.set(sha256(sessionId), { expiresAt: now + ADMIN_SESSION_TTL_MS });
				return res
					.set("Cache-Control", "no-store")
					.set("Set-Cookie", serializeAdminCookie(sessionId, ADMIN_SESSION_TTL_MS / 1000))
					.json({ authenticated: true });
			} catch (error) {
				next(error);
			}
		},
	);

	router.use("/admin", requireAdmin);

	router.post("/admin/logout", requireAllowedOrigin, requireCsrfToken, (req, res) => {
		const sessionId = getSessionId(req);
		if (sessionId) sessions.delete(sha256(sessionId));
		return res
			.set("Cache-Control", "no-store")
			.set("Set-Cookie", `${serializeAdminCookie("", 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
			.json({ authenticated: false });
	});

	router.post(
		"/orders",
		rateLimit({ limit: 10, windowMs: 10 * 60 * 1000, key: "create-order" }),
		async (req, res, next) => {
			let client;
			let transactionStarted = false;
			try {
				const checkout = normalizeCheckout(req.body);
				const rawIdempotencyKey = req.get("Idempotency-Key") || "";
				if (!/^[A-Za-z0-9_-]{43}$/.test(rawIdempotencyKey)) {
					throw apiError(400, "INVALID_IDEMPOTENCY_KEY", "Please retry checkout.");
				}
				const idempotencyKeyHash = sha256(rawIdempotencyKey);
				const requestFingerprint = sha256(JSON.stringify(checkout));

				client = await pool.connect();
				await client.query("BEGIN");
				transactionStarted = true;
				await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKeyHash]);

				const priorOrder = await client.query(
					"SELECT id::text AS order_id, request_fingerprint FROM orders WHERE idempotency_key_hash = $1 FOR UPDATE",
					[idempotencyKeyHash],
				);
				if (priorOrder.rows.length > 0) {
					if (priorOrder.rows[0].request_fingerprint !== requestFingerprint) {
						throw apiError(409, "IDEMPOTENCY_CONFLICT", "This checkout was already submitted. Start a new checkout to place another order.");
					}

					const accessToken = generateAccessToken();
					await client.query(
						"UPDATE orders SET customer_access_token_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
						[sha256(accessToken), priorOrder.rows[0].order_id],
					);
					const order = await loadCustomerOrder(client, priorOrder.rows[0].order_id);
					await client.query("COMMIT");
					transactionStarted = false;
					return res.status(200).json({ ...order, customer_access_token: accessToken });
				}

				let pickup;
				try {
					pickup = validatePickupChoice(
						checkout.pickupType,
						checkout.pickupDate,
						checkout.pickupTime,
						new Date(),
					);
				} catch (error) {
					throw apiError(400, error.code || "INVALID_PICKUP", error.message);
				}

				const productIds = checkout.items.map(item => item.productId);
				const productsResult = await client.query(
					"SELECT id::text, name, price::text AS price, image FROM products WHERE id = ANY($1) ORDER BY id FOR SHARE",
					[productIds],
				);
				const products = new Map(productsResult.rows.map(product => [Number(product.id), product]));
				if (products.size !== productIds.length) {
					throw apiError(400, "PRODUCT_UNAVAILABLE", "One or more products are no longer available.");
				}

				let totalCents = 0;
				const pricedItems = checkout.items.map(item => {
					const product = products.get(item.productId);
					const unitPriceCents = moneyToCents(product.price);
					const subtotalCents = unitPriceCents * item.quantity;
					totalCents += subtotalCents;
					return {
						...item,
						productName: product.name,
						image: product.image,
						unitPrice: centsToAmount(unitPriceCents),
						subtotal: centsToAmount(subtotalCents),
					};
				});
				const accessToken = generateAccessToken();
				const orderResult = await client.query(
					`INSERT INTO orders (
						customer_id, customer_name, customer_contact, customer_email, pickup_type,
						requested_pickup_date, requested_pickup_time, requested_pickup_at,
						subtotal, discount, shipping_fee, total, status,
						customer_access_token_hash,
						idempotency_key_hash, request_fingerprint
					) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, 'Pending', $10, $11, $12)
					RETURNING id::text AS order_id`,
					[
						checkout.customerName,
						checkout.customerContact,
						checkout.customerEmail,
						pickup.pickupType,
						pickup.requestedPickupDate,
						pickup.requestedPickupTime,
						pickup.requestedPickupAt,
						centsToAmount(totalCents),
						centsToAmount(totalCents),
						sha256(accessToken),
						idempotencyKeyHash,
						requestFingerprint,
					],
				);
				const orderId = orderResult.rows[0].order_id;

				for (const item of pricedItems) {
					await client.query(
						`INSERT INTO order_items (
							order_id, product_id, product_name_snapshot,
							price, quantity, subtotal
						) VALUES ($1, $2, $3, $4, $5, $6)`,
						[
							orderId,
							item.productId,
							item.productName,
							item.unitPrice,
							item.quantity,
							item.subtotal,
						],
					);
				}

				const order = await loadCustomerOrder(client, orderId);
				await client.query("COMMIT");
				transactionStarted = false;
				return res.status(201).json({ ...order, customer_access_token: accessToken });
			} catch (error) {
				if (transactionStarted && client) {
					try {
						await client.query("ROLLBACK");
					} catch (rollbackError) {
						console.error("Order transaction rollback failed:", rollbackError.code || rollbackError.name);
					}
				}
				if (error.status) {
					return res.status(error.status).json({ error: error.message, code: error.code });
				}
				next(error);
			} finally {
				if (client) client.release();
			}
		},
	);

	router.get("/admin/orders", async (req, res, next) => {
		try {
			const ordersResult = await pool.query(
				`SELECT ${ADMIN_ORDER_FIELDS}
				FROM orders
				ORDER BY
					CASE
						WHEN status = 'Pending' AND pickup_type = 'ASAP' THEN 0
						WHEN status = 'Pending' AND pickup_type = 'SCHEDULED' THEN 1
						WHEN status = 'Confirmed' THEN 2
						WHEN status IN ('Preparing', 'Ready for Pickup') THEN 3
						WHEN status IN ('Completed', 'Cancelled') THEN 4
						ELSE 5
					END,
					CASE
						WHEN status = 'Pending' AND pickup_type = 'SCHEDULED' THEN requested_pickup_at
					END ASC NULLS LAST,
					CASE WHEN status = 'Confirmed' THEN confirmed_pickup_at END ASC NULLS LAST,
					CASE
						WHEN status IN ('Preparing', 'Ready for Pickup')
						THEN COALESCE(confirmed_pickup_at, requested_pickup_at)
					END ASC NULLS LAST,
					created_at ASC,
					id ASC`,
			);
			const orders = ordersResult.rows;
			if (orders.length === 0) return res.json([]);

			const orderIds = orders.map(order => order.order_id);
			const itemsResult = await pool.query(
				`SELECT
					order_id::text AS order_id,
					product_id::text AS product_id,
					product_name_snapshot,
					quantity,
					price::text AS price,
					subtotal::text AS subtotal
				FROM order_items
				WHERE order_id = ANY($1::integer[])
				ORDER BY order_id, id`,
				[orderIds],
			);
			const itemsByOrderId = new Map(orderIds.map(orderId => [orderId, []]));
			for (const item of itemsResult.rows) {
				itemsByOrderId.get(item.order_id)?.push({
					product_id: item.product_id,
					product_name_snapshot: item.product_name_snapshot,
					quantity: item.quantity,
					price: item.price,
					subtotal: item.subtotal,
				});
			}

			return res.json(orders.map(order => ({
				...order,
				items: itemsByOrderId.get(order.order_id),
			})));
		} catch (error) {
			next(error);
		}
	});

	router.patch("/admin/orders/:orderId", requireAllowedOrigin, requireCsrfToken, async (req, res, next) => {
		const allowedFields = new Set(["status", "confirmed_pickup_date", "confirmed_pickup_time"]);
		const body = req.body;
		if (!/^[1-9]\d{0,9}$/.test(req.params.orderId) || Number(req.params.orderId) > 2147483647) {
			return res.status(400).json({ error: "Enter a valid order ID.", code: "INVALID_ORDER_ID" });
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return res.status(400).json({ error: "Provide valid order update details.", code: "INVALID_ORDER_UPDATE" });
		}
		const fields = Object.keys(body);
		if (
			fields.length === 0
			|| fields.some(field => !allowedFields.has(field))
			|| (Object.hasOwn(body, "confirmed_pickup_date") !== Object.hasOwn(body, "confirmed_pickup_time"))
		) {
			return res.status(400).json({ error: "Only status and a paired confirmed pickup date/time can be updated.", code: "INVALID_ORDER_UPDATE" });
		}
		if (Object.hasOwn(body, "status") && !ORDER_STATUSES.includes(body.status)) {
			return res.status(400).json({ error: "Choose a valid order status.", code: "INVALID_ORDER_STATUS" });
		}

		let confirmedPickup;
		if (Object.hasOwn(body, "confirmed_pickup_date")) {
			const pickupDate = body.confirmed_pickup_date;
			const pickupTime = body.confirmed_pickup_time;
			if (pickupDate === null && pickupTime === null) {
				confirmedPickup = null;
			} else if (typeof pickupDate !== "string" || typeof pickupTime !== "string") {
				return res.status(400).json({ error: "Confirmed pickup date and time must both be provided.", code: "INVALID_PICKUP" });
			} else {
				try {
					confirmedPickup = validatePickupChoice("SCHEDULED", pickupDate, pickupTime, new Date());
				} catch (error) {
					return res.status(400).json({
						error: error.message,
						code: error.code || "INVALID_PICKUP",
					});
				}
			}
		}

		let client;
		let transactionStarted = false;
		try {
			client = await pool.connect();
			await client.query("BEGIN");
			transactionStarted = true;

			const currentResult = await client.query(
				"SELECT id::text AS order_id, status FROM orders WHERE id = $1 FOR UPDATE",
				[req.params.orderId],
			);
			if (currentResult.rows.length === 0) {
				throw apiError(404, "ORDER_NOT_FOUND", "Order not found.");
			}
			const current = currentResult.rows[0];
			if (
				Object.hasOwn(body, "status")
				&& body.status !== current.status
				&& !STATUS_TRANSITIONS[current.status]?.includes(body.status)
			) {
				throw apiError(400, "INVALID_STATUS_TRANSITION", "That order status transition is not allowed.");
			}

			const assignments = [];
			const values = [];
			if (Object.hasOwn(body, "status")) {
				values.push(body.status);
				assignments.push(`status = $${values.length}`);
			}
			if (Object.hasOwn(body, "confirmed_pickup_date")) {
				values.push(confirmedPickup?.requestedPickupDate || null);
				assignments.push(`confirmed_pickup_date = $${values.length}`);
				values.push(confirmedPickup?.requestedPickupTime || null);
				assignments.push(`confirmed_pickup_time = $${values.length}`);
				values.push(confirmedPickup?.requestedPickupAt || null);
				assignments.push(`confirmed_pickup_at = $${values.length}`);
			}
			assignments.push("updated_at = CURRENT_TIMESTAMP");
			values.push(req.params.orderId);

			const updateResult = await client.query(
				`UPDATE orders
				SET ${assignments.join(", ")}
				WHERE id = $${values.length}
				RETURNING ${ADMIN_ORDER_FIELDS}`,
				values,
			);
			const order = updateResult.rows[0];
			const itemsResult = await client.query(
				`SELECT
					order_id::text AS order_id,
					product_id::text AS product_id,
					product_name_snapshot,
					quantity,
					price::text AS price,
					subtotal::text AS subtotal
				FROM order_items
				WHERE order_id = $1
				ORDER BY id`,
				[req.params.orderId],
			);
			await client.query("COMMIT");
			transactionStarted = false;
			return res.json({
				...order,
				items: itemsResult.rows.map(item => ({
					product_id: item.product_id,
					product_name_snapshot: item.product_name_snapshot,
					quantity: item.quantity,
					price: item.price,
					subtotal: item.subtotal,
				})),
			});
		} catch (error) {
			if (transactionStarted && client) {
				try {
					await client.query("ROLLBACK");
				} catch (rollbackError) {
					console.error("Admin order transaction rollback failed:", rollbackError.code || rollbackError.name);
				}
			}
			if (error.status) {
				return res.status(error.status).json({ error: error.message, code: error.code });
			}
			next(error);
		} finally {
			if (client) client.release();
		}
	});

	router.get(
		"/orders/:orderId",
		rateLimit({ limit: 20, windowMs: 15 * 60 * 1000, key: "track-order" }),
		async (req, res, next) => {
			try {
				if (
					!/^[1-9]\d{0,18}$/.test(req.params.orderId)
					|| BigInt(req.params.orderId) > 2147483647n
				) {
					return res.status(404).json({ error: "Order not found or access token is invalid." });
				}
				const authorization = req.get("Authorization") || "";
				const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
				if (!match) {
					return res.status(404).json({ error: "Order not found or access token is invalid." });
				}

				const result = await pool.query(
					"SELECT id FROM orders WHERE id = $1 AND customer_access_token_hash = $2",
					[req.params.orderId, sha256(match[1])],
				);
				if (result.rows.length === 0) {
					return res.status(404).json({ error: "Order not found or access token is invalid." });
				}
				const order = await loadCustomerOrder(pool, req.params.orderId);
				return res.json(order);
			} catch (error) {
				next(error);
			}
		},
	);

	return router;
}

async function loadCustomerOrder(db, orderId) {
	const orderResult = await db.query(
		`SELECT
			id::text AS order_id,
			customer_name,
			pickup_type,
			to_char(requested_pickup_date, 'YYYY-MM-DD') AS requested_pickup_date,
			to_char(requested_pickup_time, 'HH24:MI') AS requested_pickup_time,
			to_char(confirmed_pickup_date, 'YYYY-MM-DD') AS confirmed_pickup_date,
			to_char(confirmed_pickup_time, 'HH24:MI') AS confirmed_pickup_time,
			status,
			total::text AS total_amount,
			created_at
		FROM orders
		WHERE id = $1`,
		[orderId],
	);
	if (orderResult.rows.length === 0) {
		throw apiError(404, "ORDER_NOT_FOUND", "Order not found or access token is invalid.");
	}

	const itemsResult = await db.query(
		`SELECT
			product_id::text,
			product_name_snapshot,
			price::text AS unit_price_snapshot,
			quantity,
			subtotal::text
		FROM order_items
		WHERE order_id = $1
		ORDER BY id`,
		[orderId],
	);
	const order = orderResult.rows[0];
	return {
		order_id: order.order_id,
		customer_name: order.customer_name,
		items: itemsResult.rows.map(item => ({
			product_id: item.product_id,
			product_name: item.product_name_snapshot,
			unit_price: item.unit_price_snapshot,
			quantity: item.quantity,
			subtotal: item.subtotal,
		})),
		pickup_type: order.pickup_type,
		requested_pickup_date: order.requested_pickup_date,
		requested_pickup_time: order.requested_pickup_time,
		confirmed_pickup_date: order.confirmed_pickup_date,
		confirmed_pickup_time: order.confirmed_pickup_time,
		status: order.status,
		status_workflow: ORDER_STATUSES,
		total_amount: order.total_amount,
		created_at: order.created_at,
	};
}

module.exports = {
	createOrderRouter,
	moneyToCents,
	normalizeCheckout,
	ORDER_STATUSES,
};
