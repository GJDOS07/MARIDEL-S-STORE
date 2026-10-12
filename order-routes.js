"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { promisify } = require("node:util");
const { validatePickupChoice, melbourneNow, BUSINESS_TIME_ZONE, OPENING_MINUTES, CLOSING_MINUTES } = require("./pickup-time");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "maridel_owner_session";
const CSRF_COOKIE = "maridel_owner_csrf";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_ATTEMPT_LIMIT = 5;
const DEFAULT_PUBLIC_RATE_LIMITS = {
	order: { limit: 10, windowMs: 10 * 60 * 1000 },
	tracking: { limit: 30, windowMs: 15 * 60 * 1000 },
};
const MAX_PUBLIC_RATE_LIMIT_CLIENTS = 10000;
const ALLOWED_STATUSES = new Set(["Pending", "Confirmed", "Preparing", "Ready for Pickup", "Completed", "Picked Up", "Cancelled"]);
const STATUS_TRANSITIONS = {
	Pending: new Set(["Confirmed", "Cancelled"]),
	Confirmed: new Set(["Preparing", "Ready for Pickup", "Cancelled"]),
	Preparing: new Set(["Ready for Pickup", "Cancelled"]),
	"Ready for Pickup": new Set(["Completed", "Picked Up", "Cancelled"]),
	Completed: new Set(),
	"Picked Up": new Set(),
	Cancelled: new Set(),
};
const LEGACY_STATUS_ALIASES = new Map([
	["completed", "Completed"],
	["picked up", "Picked Up"],
]);

function apiError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

function sha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function trackingTokenForOrder(idempotencyKey, orderId) {
	const keyBytes = Buffer.from(idempotencyKey, "base64url");
	return crypto.createHmac("sha256", keyBytes)
		.update(`maridel-order-tracking:${orderId}`)
		.digest("base64url");
}

function safeEqual(left, right) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeOrderRequest(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw apiError(400, "INVALID_ORDER", "Provide valid pickup order details.");
	}

	const customerName = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
	const customerContact = typeof body.customer_contact === "string" ? body.customer_contact.trim() : "";
	if (customerName.length < 1 || customerName.length > 100) {
		throw apiError(400, "INVALID_CUSTOMER_NAME", "Enter your full name (up to 100 characters).");
	}
	const digitCount = customerContact.replace(/\D/g, "").length;
	if (
		customerContact.length < 7
		|| customerContact.length > 25
		|| !/^[+()\d\s.-]+$/.test(customerContact)
		|| digitCount < 7
	) {
		throw apiError(400, "INVALID_CUSTOMER_CONTACT", "Enter a valid contact number.");
	}

	try {
		validatePickupChoice(body.pickup_date, body.pickup_time);
	} catch (error) {
		throw apiError(400, "INVALID_PICKUP", error.message);
	}

	if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
		throw apiError(400, "INVALID_ITEMS", "Add between 1 and 50 different products.");
	}

	const seenProductIds = new Set();
	const items = body.items.map(item => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw apiError(400, "INVALID_ITEMS", "Provide valid product and quantity details.");
		}
		const productId = Number(item.product_id);
		const quantity = Number(item.quantity);
		if (!Number.isSafeInteger(productId) || productId < 1 || productId > 2147483647) {
			throw apiError(400, "INVALID_PRODUCT", "One or more products are invalid.");
		}
		if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
			throw apiError(400, "INVALID_QUANTITY", "Each product quantity must be between 1 and 99.");
		}
		if (seenProductIds.has(productId)) {
			throw apiError(400, "DUPLICATE_PRODUCT", "Each product should appear only once in the order.");
		}
		seenProductIds.add(productId);
		return { productId, quantity };
	}).sort((left, right) => left.productId - right.productId);

	const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
	if (totalQuantity > 200) {
		throw apiError(400, "ORDER_QUANTITY_LIMIT", "The total order quantity cannot exceed 200 items.");
	}

	return {
		customerName,
		customerContact,
		pickupDate: body.pickup_date,
		pickupTime: body.pickup_time,
		items,
	};
}

function amountToCents(amount) {
	if (typeof amount !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(amount)) {
		throw new Error("A database product price is not a valid AUD amount.");
	}
	const [whole, fraction = ""] = amount.split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	if (!Number.isSafeInteger(cents) || cents < 0) {
		throw new Error("A database product price is outside the supported range.");
	}
	return cents;
}

function centsToAmount(cents) {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function parsePasswordHash(encoded) {
	if (typeof encoded !== "string") return null;
	const match = /^scrypt\$([a-f0-9]{32,})\$([a-f0-9]{128})$/i.exec(encoded);
	if (!match || match[1].length % 2 !== 0) return null;
	return { salt: Buffer.from(match[1], "hex"), hash: Buffer.from(match[2], "hex") };
}

function parseCookies(header = "") {
	const cookies = new Map();
	for (const entry of header.split(";")) {
		const separator = entry.indexOf("=");
		if (separator < 0) continue;
		const key = entry.slice(0, separator).trim();
		const value = entry.slice(separator + 1).trim();
		if (key) {
			try {
				cookies.set(key, decodeURIComponent(value));
			} catch {
				cookies.set(key, "");
			}
		}
	}
	return cookies;
}

function serializeCookie(name, value, { maxAge, httpOnly = false, secure }) {
	return [
		`${name}=${encodeURIComponent(value)}`,
		"Path=/",
		`Max-Age=${maxAge}`,
		`SameSite=${secure ? "None" : "Lax"}`,
		...(httpOnly ? ["HttpOnly"] : []),
		...(secure ? ["Secure"] : []),
	].join("; ");
}

function createPublicRateLimiter(limits = DEFAULT_PUBLIC_RATE_LIMITS) {
	const buckets = new Map();
	let requestsSinceCleanup = 0;

	return (key, { limit, windowMs }) => (req, res, next) => {
		const now = Date.now();
		requestsSinceCleanup += 1;
		if (requestsSinceCleanup >= 256) {
			for (const [existingKey, bucket] of buckets) {
				if (bucket.resetAt <= now) buckets.delete(existingKey);
			}
			requestsSinceCleanup = 0;
		}

		const clientKey = `${key}:${req.ip || req.socket.remoteAddress || "unknown"}`;
		let bucket = buckets.get(clientKey);
		if (!bucket) {
			if (buckets.size >= MAX_PUBLIC_RATE_LIMIT_CLIENTS) {
				for (const [existingKey, existingBucket] of buckets) {
					if (existingBucket.resetAt <= now) buckets.delete(existingKey);
				}
				if (buckets.size >= MAX_PUBLIC_RATE_LIMIT_CLIENTS) {
					res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
					return res.status(503).json({ error: "Order service is temporarily busy.", code: "RATE_LIMIT_CAPACITY" });
				}
			}
			bucket = { count: 0, resetAt: now + windowMs };
			buckets.set(clientKey, bucket);
		}

		if (bucket.count >= limit) {
			res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
			return res.status(429).json({ error: "Too many requests. Please try again later.", code: "RATE_LIMITED" });
		}

		bucket.count += 1;
		res.set("RateLimit-Limit", String(limit));
		res.set("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
		res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
		next();
	};
}

function createOrderRouter(pool, {
	ownerPasswordHash = process.env.OWNER_PASSWORD_HASH,
	sessionSecret = process.env.OWNER_SESSION_SECRET,
	allowedOrigins = [],
	secureCookies = process.env.NODE_ENV === "production",
	publicRateLimits = DEFAULT_PUBLIC_RATE_LIMITS,
} = {}) {
	const router = express.Router();
	const allowedOriginSet = new Set(allowedOrigins);
	const passwordHash = parsePasswordHash(ownerPasswordHash);
	const rateLimit = createPublicRateLimiter(publicRateLimits);
	const configuredSessionSecret = typeof sessionSecret === "string" && sessionSecret.length >= 32
		? sessionSecret
		: null;

	function requireAllowedOrigin(req, res, next) {
		const origin = req.get("Origin");
		if (!origin || !allowedOriginSet.has(origin)) {
			return next(apiError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed."));
		}
		next();
	}

	function csrfForSession(sessionId) {
		return crypto.createHmac("sha256", configuredSessionSecret)
			.update(`csrf:${sessionId}`)
			.digest("base64url");
	}

	function requireCsrf(req, res, next) {
		const cookies = parseCookies(req.get("Cookie"));
		const cookieToken = cookies.get(CSRF_COOKIE) || "";
		const headerToken = req.get("X-CSRF-Token") || "";
		if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
			return next(apiError(403, "CSRF_INVALID", "A valid CSRF token is required."));
		}

		const sessionId = cookies.get(SESSION_COOKIE);
		if (sessionId && configuredSessionSecret) {
			if (!safeEqual(headerToken, csrfForSession(sessionId))) {
				return next(apiError(403, "CSRF_INVALID", "A valid CSRF token is required."));
			}
		}
		next();
	}

	function requireOwner(req, res, next) {
		const sessionId = parseCookies(req.get("Cookie")).get(SESSION_COOKIE);
		if (!sessionId) return next(apiError(401, "OWNER_LOGIN_REQUIRED", "Owner login is required."));
		if (!configuredSessionSecret) {
			return next(apiError(503, "OWNER_AUTH_NOT_CONFIGURED", "Owner authentication is not configured."));
		}

		pool.query(
			"SELECT 1 FROM owner_sessions WHERE session_hash = $1 AND expires_at > CURRENT_TIMESTAMP",
			[sha256(sessionId)],
		).then(result => {
			if (result.rowCount === 0) {
				res.set("Set-Cookie", [
					serializeCookie(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: secureCookies }),
					serializeCookie(CSRF_COOKIE, "", { maxAge: 0, secure: secureCookies }),
				]);
				return next(apiError(401, "OWNER_LOGIN_REQUIRED", "Owner login is required."));
			}
			req.ownerSessionId = sessionId;
			next();
		}).catch(next);
	}

	async function applyLoginRateLimit(req) {
		if (!configuredSessionSecret) {
			throw apiError(503, "OWNER_AUTH_NOT_CONFIGURED", "Owner authentication is not configured.");
		}
		const clientKeyHash = crypto.createHmac("sha256", configuredSessionSecret)
			.update(`login-ip:${req.ip || "unknown"}`)
			.digest("hex");
		const result = await pool.query(
			`INSERT INTO owner_login_attempts (client_key_hash, window_started_at, attempt_count)
			VALUES ($1, CURRENT_TIMESTAMP, 1)
			ON CONFLICT (client_key_hash) DO UPDATE SET
				attempt_count = CASE
					WHEN owner_login_attempts.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '${LOGIN_WINDOW_MINUTES} minutes'
					THEN 1
					ELSE owner_login_attempts.attempt_count + 1
				END,
				window_started_at = CASE
					WHEN owner_login_attempts.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '${LOGIN_WINDOW_MINUTES} minutes'
					THEN CURRENT_TIMESTAMP
					ELSE owner_login_attempts.window_started_at
				END
			RETURNING attempt_count`,
			[clientKeyHash],
		);
		if (result.rows[0].attempt_count > LOGIN_ATTEMPT_LIMIT) {
			throw apiError(429, "LOGIN_RATE_LIMITED", "Too many login attempts. Try again in 15 minutes.");
		}
		return clientKeyHash;
	}

	router.post("/orders", rateLimit("order", publicRateLimits.order), async (req, res, next) => {
		let client;
		let transactionStarted = false;
		try {
			const order = normalizeOrderRequest(req.body);
			const idempotencyKey = req.get("Idempotency-Key") || "";
			const idempotencyKeyBytes = Buffer.from(idempotencyKey, "base64url");
			if (
				!/^[A-Za-z0-9_-]{43}$/.test(idempotencyKey)
				|| idempotencyKeyBytes.length !== 32
				|| idempotencyKeyBytes.toString("base64url") !== idempotencyKey
			) {
				throw apiError(400, "INVALID_IDEMPOTENCY_KEY", "Please retry checkout.");
			}

			const idempotencyHash = sha256(idempotencyKey);
			const requestFingerprint = sha256(JSON.stringify(order));
			client = await pool.connect();
			await client.query("BEGIN");
			transactionStarted = true;
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyHash]);

			const existing = await client.query(
				`SELECT id, customer_access_token, tracking_token_hash, idempotency_fingerprint,
					customer_name, customer_contact,
					pickup_date::text AS pickup_date,
					COALESCE(NULLIF(pickup_time::text, ''), requested_pickup_time::text) AS pickup_time
				FROM orders WHERE idempotency_key = $1 FOR UPDATE`,
				[idempotencyHash],
			);
			if (existing.rowCount > 1) {
				throw apiError(409, "IDEMPOTENCY_CONFLICT", "This checkout key cannot be safely reused.");
			}
			let trackingToken;
			let orderId;
			let responseStatus = 201;

			if (existing.rowCount > 0) {
				const priorOrder = existing.rows[0];
				if (!(await orderMatchesRequest(client, priorOrder, requestFingerprint))) {
					throw apiError(409, "IDEMPOTENCY_CONFLICT", "This checkout key was already used for different order details.");
				}
				orderId = priorOrder.id;
				if (typeof priorOrder.customer_access_token === "string" && priorOrder.customer_access_token) {
					trackingToken = priorOrder.customer_access_token;
				} else {
					trackingToken = trackingTokenForOrder(idempotencyKey, orderId);
					const trackingTokenHash = sha256(trackingToken);
					const storedTrackingTokenHash = typeof priorOrder.tracking_token_hash === "string"
						? priorOrder.tracking_token_hash.trim()
						: "";
					if (storedTrackingTokenHash && !safeEqual(storedTrackingTokenHash, trackingTokenHash)) {
						throw apiError(409, "TRACKING_CREDENTIAL_UNAVAILABLE", "This order's tracking credential cannot be safely recovered.");
					}
					if (!storedTrackingTokenHash) {
						await client.query(
							"UPDATE orders SET tracking_token_hash = $1 WHERE id = $2",
							[trackingTokenHash, orderId],
						);
					}
				}
				responseStatus = 200;
			} else {
				const productIds = order.items.map(item => item.productId);
				const productsResult = await client.query(
					"SELECT id, name, price::text AS price FROM products WHERE id = ANY($1::integer[]) ORDER BY id FOR SHARE",
					[productIds],
				);
				const products = new Map(productsResult.rows.map(product => [Number(product.id), product]));
				if (products.size !== productIds.length) {
					throw apiError(400, "PRODUCT_UNAVAILABLE", "One or more products are no longer available.");
				}

				let totalCents = 0;
				const pricedItems = order.items.map(item => {
					const product = products.get(item.productId);
					const unitPriceCents = amountToCents(product.price);
					const subtotalCents = unitPriceCents * item.quantity;
					totalCents += subtotalCents;
					if (!Number.isSafeInteger(totalCents)) {
						throw apiError(400, "ORDER_TOTAL_LIMIT", "The order total is outside the supported range.");
					}
					return {
						...item,
						productName: product.name,
						unitPrice: centsToAmount(unitPriceCents),
						subtotal: centsToAmount(subtotalCents),
					};
				});
				const total = centsToAmount(totalCents);
				const inserted = await client.query(
					`INSERT INTO orders (
						customer_name, customer_contact, pickup_type, pickup_date, pickup_time,
						requested_pickup_time, subtotal, discount, shipping_fee, total, total_amount,
						status, idempotency_key, idempotency_fingerprint
					) VALUES ($1, $2, 'SCHEDULED', $3, $4, $4, $5, 0, 0, $5, $5, 'Pending', $6, $7)
					RETURNING id`,
					[
						order.customerName,
						order.customerContact,
						order.pickupDate,
						order.pickupTime,
						total,
						idempotencyHash,
						requestFingerprint,
					],
				);
				orderId = inserted.rows[0].id;
				trackingToken = trackingTokenForOrder(idempotencyKey, orderId);
				await client.query(
					"UPDATE orders SET tracking_token_hash = $1 WHERE id = $2",
					[sha256(trackingToken), orderId],
				);

				for (const item of pricedItems) {
					await client.query(
						`INSERT INTO order_items (
							order_id, product_id, product_name, quantity, price, unit_price, subtotal
						) VALUES ($1, $2, $3, $4, $5, $5, $6)`,
						[orderId, item.productId, item.productName, item.quantity, item.unitPrice, item.subtotal],
					);
				}
			}

			const saved = await loadOrder(client, orderId);
			await client.query("COMMIT");
			transactionStarted = false;
			res.set("Cache-Control", "no-store");
			return res.status(responseStatus).json({ ...saved, tracking_token: trackingToken });
		} catch (error) {
			if (transactionStarted && client) {
				try {
					await client.query("ROLLBACK");
				} catch (rollbackError) {
					console.error("Order transaction rollback failed:", safeDatabaseErrorCode(rollbackError));
				}
			}
			next(error);
		} finally {
			if (client) client.release();
		}
	});

	router.post("/orders/track", rateLimit("tracking", publicRateLimits.tracking), async (req, res, next) => {
		try {
			const token = req.body && typeof req.body.token === "string" ? req.body.token : "";
			if (token.length < 40 || token.length > 512) {
				throw apiError(404, "ORDER_NOT_FOUND", "Order not found or tracking credential is invalid.");
			}
			const result = await pool.query(
				`SELECT o.id, o.pickup_date::text AS pickup_date,
					COALESCE(NULLIF(o.pickup_time::text, ''), o.requested_pickup_time::text) AS pickup_time,
					o.total::text AS total, o.status
				FROM orders o
				WHERE o.tracking_token_hash = $1 OR o.customer_access_token = $2
				LIMIT 2`,
				[sha256(token), token],
			);
			if (result.rowCount !== 1) {
				throw apiError(404, "ORDER_NOT_FOUND", "Order not found or tracking credential is invalid.");
			}
			const order = result.rows[0];
			const items = await pool.query(
				`SELECT oi.product_id::text AS product_id,
					COALESCE(oi.product_name, p.name, 'Product') AS product_name,
					COALESCE(oi.unit_price, oi.price)::text AS unit_price,
					oi.quantity, COALESCE(oi.subtotal, oi.price * oi.quantity)::text AS subtotal
				FROM order_items oi
				LEFT JOIN products p ON p.id = oi.product_id
				WHERE oi.order_id = $1
				ORDER BY oi.id`,
				[order.id],
			);
			res.set("Cache-Control", "no-store");
			return res.json({
				order_number: `MS-${order.id}`,
				pickup_date: order.pickup_date,
				pickup_time: order.pickup_time,
				total: order.total,
				status: order.status,
				items: items.rows,
			});
		} catch (error) {
			next(error);
		}
	});

	router.get("/orders/:orderId", rateLimit("tracking", publicRateLimits.tracking), async (req, res, next) => {
		try {
			const orderId = parseOrderId(req.params.orderId);
			const authorization = req.get("Authorization") || "";
			const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(authorization);
			if (!match) {
				throw apiError(404, "ORDER_NOT_FOUND", "Order not found or tracking credential is invalid.");
			}
			const result = await pool.query(
				`SELECT o.id, o.pickup_date::text AS pickup_date,
					COALESCE(NULLIF(o.pickup_time::text, ''), o.requested_pickup_time::text) AS pickup_time,
					o.total::text AS total, o.status
				FROM orders o
				WHERE o.id = $1 AND (o.tracking_token_hash = $2 OR o.customer_access_token = $3)
				LIMIT 1`,
				[orderId, sha256(match[1]), match[1]],
			);
			if (result.rowCount === 0) {
				throw apiError(404, "ORDER_NOT_FOUND", "Order not found or tracking credential is invalid.");
			}
			const order = result.rows[0];
			const items = await pool.query(
				`SELECT COALESCE(oi.product_name, p.name, 'Product') AS product_name,
					COALESCE(oi.unit_price, oi.price)::text AS unit_price,
					oi.quantity, COALESCE(oi.subtotal, oi.price * oi.quantity)::text AS subtotal
				FROM order_items oi
				LEFT JOIN products p ON p.id = oi.product_id
				WHERE oi.order_id = $1
				ORDER BY oi.id`,
				[order.id],
			);
			res.set("Cache-Control", "no-store");
			return res.json({
				order_number: `MS-${order.id}`,
				pickup_date: order.pickup_date,
				pickup_time: order.pickup_time,
				total: order.total,
				status: order.status,
				items: items.rows,
			});
		} catch (error) {
			next(error);
		}
	});

	router.get("/owner/csrf", requireAllowedOrigin, (req, res) => {
		const token = crypto.randomBytes(32).toString("base64url");
		res.set("Cache-Control", "no-store");
		res.set("Set-Cookie", serializeCookie(CSRF_COOKIE, token, {
			maxAge: 10 * 60,
			secure: secureCookies,
		}));
		return res.json({ csrf_token: token });
	});

	router.post("/owner/login", requireAllowedOrigin, requireCsrf, async (req, res, next) => {
		let clientKeyHash;
		try {
			if (!passwordHash || !configuredSessionSecret) {
				throw apiError(503, "OWNER_AUTH_NOT_CONFIGURED", "Owner authentication is not configured.");
			}
			clientKeyHash = await applyLoginRateLimit(req);
			const suppliedPassword = req.body && typeof req.body.password === "string" ? req.body.password : "";
			if (suppliedPassword.length > 1024) {
				throw apiError(401, "INVALID_OWNER_CREDENTIALS", "Invalid owner credentials.");
			}
			const suppliedHash = await scrypt(suppliedPassword, passwordHash.salt, passwordHash.hash.length);
			if (!safeEqual(suppliedHash, passwordHash.hash)) {
				throw apiError(401, "INVALID_OWNER_CREDENTIALS", "Invalid owner credentials.");
			}

			const sessionId = crypto.randomBytes(32).toString("base64url");
			await pool.query(
				"INSERT INTO owner_sessions (session_hash, expires_at) VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '8 hours')",
				[sha256(sessionId)],
			);
			await pool.query("DELETE FROM owner_login_attempts WHERE client_key_hash = $1", [clientKeyHash]);
			const csrfToken = csrfForSession(sessionId);
			res.set("Cache-Control", "no-store");
			res.set("Set-Cookie", [
				serializeCookie(SESSION_COOKIE, sessionId, {
					maxAge: SESSION_TTL_SECONDS,
					httpOnly: true,
					secure: secureCookies,
				}),
				serializeCookie(CSRF_COOKIE, csrfToken, {
					maxAge: SESSION_TTL_SECONDS,
					secure: secureCookies,
				}),
			]);
			return res.json({ authenticated: true, csrf_token: csrfToken });
		} catch (error) {
			next(error);
		}
	});

	router.get("/owner/session", requireAllowedOrigin, requireOwner, (req, res) => {
		const csrfToken = csrfForSession(req.ownerSessionId);
		res.set("Cache-Control", "no-store");
		res.set("Set-Cookie", serializeCookie(CSRF_COOKIE, csrfToken, {
			maxAge: SESSION_TTL_SECONDS,
			secure: secureCookies,
		}));
		return res.json({ authenticated: true, csrf_token: csrfToken });
	});

	router.use("/owner", requireAllowedOrigin, requireOwner);

	router.post("/owner/logout", requireCsrf, async (req, res, next) => {
		try {
			await pool.query("DELETE FROM owner_sessions WHERE session_hash = $1", [sha256(req.ownerSessionId)]);
			res.set("Cache-Control", "no-store");
			res.set("Set-Cookie", [
				serializeCookie(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: secureCookies }),
				serializeCookie(CSRF_COOKIE, "", { maxAge: 0, secure: secureCookies }),
			]);
			return res.json({ authenticated: false });
		} catch (error) {
			next(error);
		}
	});

	router.get("/owner/orders", async (req, res, next) => {
		try {
			const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
			const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
			const status = typeof req.query.status === "string" ? req.query.status : "";
			if (status && !ALLOWED_STATUSES.has(status)) {
				throw apiError(400, "INVALID_STATUS", "Select a valid order status.");
			}
			const params = status ? [status, limit, offset] : [limit, offset];
			const filter = status ? "WHERE status = $1" : "";
			const result = await pool.query(
				`SELECT id::text AS id, customer_name, customer_contact,
					pickup_date::text AS pickup_date,
					COALESCE(NULLIF(pickup_time::text, ''), requested_pickup_time::text) AS pickup_time,
					total::text AS total, status, cancellation_reason, created_at
				FROM orders ${filter}
				ORDER BY CASE WHEN status = 'Pending' THEN 0 WHEN status = 'Confirmed' THEN 1
					WHEN status = 'Ready for Pickup' THEN 2 ELSE 3 END,
					pickup_date ASC NULLS LAST, pickup_time ASC NULLS LAST, created_at ASC, id ASC
				LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
				params,
			);
			res.set("Cache-Control", "no-store");
			return res.json(result.rows.map(order => ({ ...order, order_number: `MS-${order.id}` })));
		} catch (error) {
			next(error);
		}
	});

	router.get("/owner/orders/:orderId", async (req, res, next) => {
		try {
			const orderId = parseOrderId(req.params.orderId);
			const order = await loadOwnerOrder(pool, orderId);
			if (!order) throw apiError(404, "ORDER_NOT_FOUND", "Order not found.");
			res.set("Cache-Control", "no-store");
			return res.json(order);
		} catch (error) {
			next(error);
		}
	});

	router.post("/owner/orders/:orderId/status", requireCsrf, async (req, res, next) => {
		let client;
		try {
			const orderId = parseOrderId(req.params.orderId);
			const status = normalizeStatusInput(req.body && typeof req.body.status === "string" ? req.body.status : "");
			const confirmedDate = req.body && (typeof req.body.confirmed_pickup_date === "string" || req.body.confirmed_pickup_date === null)
				? req.body.confirmed_pickup_date
				: undefined;
			const confirmedTime = req.body && (typeof req.body.confirmed_pickup_time === "string" || req.body.confirmed_pickup_time === null)
				? req.body.confirmed_pickup_time
				: undefined;
			const hasConfirmationFields = confirmedDate !== undefined || confirmedTime !== undefined;
			const cancellationReason = req.body && typeof req.body.cancellation_reason === "string"
				? req.body.cancellation_reason.trim()
				: "";
			if (!ALLOWED_STATUSES.has(status)) {
				throw apiError(400, "INVALID_STATUS", "Select a valid order status.");
			}
			if (status === "Cancelled" && (cancellationReason.length < 3 || cancellationReason.length > 500)) {
				throw apiError(400, "INVALID_CANCELLATION_REASON", "Enter a cancellation reason between 3 and 500 characters.");
			}
			if (status !== "Cancelled" && cancellationReason) {
				throw apiError(400, "UNEXPECTED_CANCELLATION_REASON", "A cancellation reason is only valid when cancelling an order.");
			}
			let confirmedPickup = null;
			if (hasConfirmationFields) {
				const clearConfirmation = confirmedDate === null && confirmedTime === null;
				if (!clearConfirmation) {
					if (typeof confirmedDate !== "string" || typeof confirmedTime !== "string") {
						throw apiError(400, "INVALID_CONFIRMED_PICKUP", "Provide both confirmed pickup date and time, or clear both.");
					}
					try {
						confirmedPickup = validatePickupChoice("SCHEDULED", confirmedDate, confirmedTime, new Date());
					} catch (error) {
						throw apiError(400, "INVALID_CONFIRMED_PICKUP", error.message);
					}
				}
			}

			client = await pool.connect();
			await client.query("BEGIN");
			const current = await client.query(
				"SELECT status, cancellation_reason FROM orders WHERE id = $1 FOR UPDATE",
				[orderId],
			);
			if (current.rowCount === 0) throw apiError(404, "ORDER_NOT_FOUND", "Order not found.");
			const currentStatus = canonicalStatus(current.rows[0].status);
			if (status !== currentStatus && !STATUS_TRANSITIONS[currentStatus]?.has(status)) {
				throw apiError(409, "INVALID_STATUS_TRANSITION", "That order status transition is not allowed.");
			}
			if (
				status === "Cancelled"
				&& currentStatus === "Cancelled"
				&& current.rows[0].cancellation_reason !== cancellationReason
			) {
				throw apiError(409, "CANCELLATION_REASON_IMMUTABLE", "The cancellation reason cannot be changed after cancellation.");
			}
			if (status === "Cancelled") {
				await client.query(
					"UPDATE orders SET status = $1, cancellation_reason = $3 WHERE id = $2",
					[status, orderId, cancellationReason],
				);
			} else if (hasConfirmationFields) {
				if (confirmedPickup) {
					await client.query(
						"UPDATE orders SET status = $1, pickup_date = $3, pickup_time = $4 WHERE id = $2",
						[status, orderId, confirmedPickup.requestedPickupDate, confirmedPickup.requestedPickupTime],
					);
				} else {
					await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, orderId]);
				}
			} else {
				await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, orderId]);
			}
			const order = await loadOwnerOrder(client, orderId);
			await client.query("COMMIT");
			res.set("Cache-Control", "no-store");
			return res.json(order);
		} catch (error) {
			if (client) {
				try {
					await client.query("ROLLBACK");
				} catch (rollbackError) {
					console.error("Order status rollback failed:", safeDatabaseErrorCode(rollbackError));
				}
			}
			next(error);
		} finally {
			if (client) client.release();
		}
	});

	router.get("/pickup/availability", (req, res) => {
		const now = melbourneNow(new Date());
		const minutes = now.hour * 60 + now.minute;
		const isOpen = minutes >= OPENING_MINUTES && minutes <= CLOSING_MINUTES;
		res.set("Cache-Control", "no-store");
		return res.json({
			time_zone: BUSINESS_TIME_ZONE,
			local_date: now.date,
			local_time: `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,
			is_open: isOpen,
			pickup_hours: { opens: "10:00", closes: "20:00" },
		});
	});

	router.use("/admin", (req, res) => {
		res.set("Cache-Control", "no-store");
		return res.status(410).json({
			error: "The legacy admin API has moved to /api/owner. Use the owner dashboard.",
			code: "LEGACY_ADMIN_REMOVED",
		});
	});

	return router;
}

function parseOrderId(value) {
	if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) {
		throw apiError(400, "INVALID_ORDER_ID", "Enter a valid order ID.");
	}
	return Number(value);
}

function canonicalStatus(value) {
	if (typeof value !== "string") return "";
	const normalized = value.trim().toLowerCase();
	if (LEGACY_STATUS_ALIASES.has(normalized)) return LEGACY_STATUS_ALIASES.get(normalized);
	return [...ALLOWED_STATUSES].find(status => status.toLowerCase() === normalized) || "";
}

function normalizeStatusInput(value) {
	const canonical = canonicalStatus(value);
	if (!canonical) return "";
	if (canonical === "Completed") return "Picked Up";
	return canonical;
}

function safeDatabaseErrorCode(error) {
	if (error && typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)) {
		return error.code;
	}
	if (error && typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) {
		return error.name;
	}
	return "UnknownError";
}

async function loadOrder(queryable, orderId) {
	const result = await queryable.query(
		`SELECT id::text AS id, pickup_date::text AS pickup_date,
			COALESCE(NULLIF(pickup_time::text, ''), requested_pickup_time::text) AS pickup_time,
			total::text AS total, status
		FROM orders WHERE id = $1`,
		[orderId],
	);
	if (result.rowCount === 0) throw apiError(404, "ORDER_NOT_FOUND", "Order not found.");
	const order = result.rows[0];
	const items = await queryable.query(
		`SELECT COALESCE(oi.product_name, p.name, 'Product') AS product_name,
			COALESCE(oi.unit_price, oi.price)::text AS unit_price,
			oi.quantity, COALESCE(oi.subtotal, oi.price * oi.quantity)::text AS subtotal
		FROM order_items oi
		LEFT JOIN products p ON p.id = oi.product_id
		WHERE oi.order_id = $1
		ORDER BY oi.id`,
		[orderId],
	);
	return { ...order, order_number: `MS-${order.id}`, items: items.rows };
}

async function orderMatchesRequest(queryable, existingOrder, requestFingerprint) {
	if (typeof existingOrder.idempotency_fingerprint === "string" && existingOrder.idempotency_fingerprint.trim()) {
		return safeEqual(existingOrder.idempotency_fingerprint.trim(), requestFingerprint);
	}
	const items = await queryable.query(
		"SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
		[existingOrder.id],
	);
	const pickupTime = typeof existingOrder.pickup_time === "string"
		? /^(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}(?::?\d{2})?)?$/.exec(existingOrder.pickup_time)?.[1]
		: null;
	if (!pickupTime || !existingOrder.pickup_date || !existingOrder.customer_name || !existingOrder.customer_contact) {
		return false;
	}
	const storedOrder = {
		customerName: existingOrder.customer_name,
		customerContact: existingOrder.customer_contact,
		pickupDate: existingOrder.pickup_date,
		pickupTime,
		items: items.rows.map(item => ({
			productId: Number(item.product_id),
			quantity: Number(item.quantity),
		})),
	};
	if (storedOrder.items.some(item => !Number.isSafeInteger(item.productId) || !Number.isSafeInteger(item.quantity))) {
		return false;
	}
	return sha256(JSON.stringify(storedOrder)) === requestFingerprint;
}

async function loadOwnerOrder(queryable, orderId) {
	const result = await queryable.query(
		`SELECT id::text AS id, customer_name, customer_contact,
			pickup_date::text AS pickup_date,
			COALESCE(NULLIF(pickup_time::text, ''), requested_pickup_time::text) AS pickup_time,
			total::text AS total, status, cancellation_reason, created_at
		FROM orders WHERE id = $1`,
		[orderId],
	);
	if (result.rowCount === 0) return null;
	const items = await queryable.query(
		`SELECT COALESCE(oi.product_name, p.name, 'Product') AS product_name,
			COALESCE(oi.unit_price, oi.price)::text AS unit_price,
			oi.quantity, oi.subtotal::text AS subtotal
		FROM order_items oi
		LEFT JOIN products p ON p.id = oi.product_id
		WHERE oi.order_id = $1
		ORDER BY oi.id`,
		[orderId],
	);
	const order = result.rows[0];
	return { ...order, order_number: `MS-${order.id}`, items: items.rows };
}

module.exports = {
	ALLOWED_STATUSES,
	STATUS_TRANSITIONS,
	amountToCents,
	centsToAmount,
	createOrderRouter,
	normalizeOrderRequest,
	parsePasswordHash,
};
