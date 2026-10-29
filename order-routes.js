"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const express = require("express");
const { promisify } = require("node:util");
const { validatePickupChoice, melbourneNow, BUSINESS_TIME_ZONE, OPENING_MINUTES, CLOSING_MINUTES } = require("./pickup-time");
const {
	normalizeProductPayload,
	validateImageUrl,
	MAX_STOCK,
} = require("./product-admin");
const {
	decodeDataUrl,
	validateImageBytes,
	storeImage,
	saveImageToDatabase,
	deleteImageIfUnused,
	imageNameFromPublicPath,
	MAX_IMAGE_BYTES,
} = require("./product-image-store");
const {
	validatePasswordChange,
	validatePasswordPolicy,
	generateResetToken,
	hashResetToken,
	resetTokenExpiry,
	GENERIC_RESET_REQUEST_MESSAGE,
} = require("./owner-account");
const { productVisibilitySupported } = require("./public-product-routes");
const { hashOwnerPassword } = require("./owner-credentials-tool");

const scrypt = promisify(crypto.scrypt);
// The decoded size an uploaded image may not exceed. The same limit the
// storage table enforces, named here so the route that checks it is obvious.
const MAX_PRODUCT_IMAGE_BYTES = MAX_IMAGE_BYTES;
const SESSION_COOKIE = "maridel_owner_session";
const CSRF_COOKIE = "maridel_owner_csrf";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_ATTEMPT_LIMIT = 5;
const DEFAULT_PUBLIC_RATE_LIMITS = {
	order: { limit: 10, windowMs: 10 * 60 * 1000 },
	tracking: { limit: 30, windowMs: 15 * 60 * 1000 },
	reset: { limit: 5, windowMs: 15 * 60 * 1000 },
};
const MAX_PUBLIC_RATE_LIMIT_CLIENTS = 10000;
// PostgreSQL reports a missing relation as SQLSTATE 42P01. The PGlite sandbox
// raises the same code for a missing table (verified against the sandbox), and
// the message has the same shape, so both are recognised here. Nothing else
// counts as "the table is not there yet".
const MISSING_RELATION_PATTERN = /^relation "?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)"? does not exist$/;

// products.low_stock_threshold only exists once stock-migration.sql has been
// applied. Exactly like the is_published check in public-product-routes.js,
// the question is asked per database and cached once it is answered with
// "yes", so a not-yet-migrated database keeps working with the built-in
// default threshold instead of failing a whole owner request on a missing
// column.
const LOW_STOCK_THRESHOLD_COLUMN_QUERY =
	"SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='low_stock_threshold'";
const lowStockThresholdSupportByTarget = new WeakMap();

async function productLowStockThresholdSupported(target) {
	if (!target || typeof target.query !== "function") return false;
	const cached = lowStockThresholdSupportByTarget.get(target);
	if (cached !== undefined) return cached;
	let supported = false;
	try {
		const row = await target.query(LOW_STOCK_THRESHOLD_COLUMN_QUERY);
		supported = row.rows[0].n === 1;
	} catch {
		supported = false;
	}
	if (supported) lowStockThresholdSupportByTarget.set(target, true);
	return supported;
}

function isMissingRelationError(error) {
	if (!error || typeof error !== "object") return false;
	if (error.code === "42P01") return true;
	// A driver that reports the cause in the message only is still understood.
	return typeof error.message === "string" && MISSING_RELATION_PATTERN.test(error.message.trim());
}
const DEFAULT_OWNER_PASSWORD_HASH = Symbol("default owner password hash");
// One message for every unusable reset link: unknown, already used or expired.
// The three cases are indistinguishable to the caller on purpose.
const RESET_TOKEN_UNUSABLE_MESSAGE = "This reset link is not valid, has expired, or has already been used.";
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

// Calendar-day arithmetic on a YYYY-MM-DD date. It deliberately works in UTC:
// the value is a date, not an instant, so the server's own time zone never
// enters the calculation.
function addCalendarDays(date, days) {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Calendar-month arithmetic on YYYY-MM keys, same UTC-first rule as
// addCalendarDays. These feed the monthly sales history: the window of charted
// months, the previous month's boundaries, and the same-days comparison end.
function formatMonthKey(year, month) {
	return `${year}-${String(month).padStart(2, "0")}`;
}

function previousMonthKey(year, month) {
	return month === 1 ? formatMonthKey(year - 1, 12) : formatMonthKey(year, month - 1);
}

// The oldest month whose full context makes sense to chart: 11 months before
// the current one, so the window never exceeds 12 entries including now.
function monthWindowFloor(year, month) {
	const floorDate = new Date(Date.UTC(year, month - 1 - 11, 1));
	return formatMonthKey(floorDate.getUTCFullYear(), floorDate.getUTCMonth() + 1);
}

// Days in a YYYY-MM month: day 0 of the following month is its last day.
function daysInMonth(monthKey) {
	const [year, month] = monthKey.split("-").map(Number);
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Every YYYY-MM key from start to end inclusive; start must not be after end.
function enumerateMonths(startKey, endKey) {
	const [startYear, startMonth] = startKey.split("-").map(Number);
	const months = [];
	for (let year = startYear, month = startMonth; ;) {
		months.push(formatMonthKey(year, month));
		const current = `${year}-${String(month).padStart(2, "0")}`;
		if (current >= endKey) break;
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	return months;
}

// Zero-valued period in the same shape the sales response already uses:
// amounts as numeric text with two decimals, counts as integers.
function emptyPeriod() {
	return { sales: "0.00", orders: 0, collected: "0.00" };
}

// Adds one grouped day row (the same SQL alias shapes as emptyPeriod) into an
// accumulating period.
function addPeriod(period, row) {
	return {
		sales: centsToAmount(amountToCents(period.sales) + amountToCents(row.sales)),
		orders: period.orders + Number(row.orders),
		collected: centsToAmount(amountToCents(period.collected) + amountToCents(row.collected)),
	};
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
	ownerPasswordHash = DEFAULT_OWNER_PASSWORD_HASH,
	sessionSecret = process.env.OWNER_SESSION_SECRET,
	allowedOrigins = [],
	isOriginAllowed = null,
	secureCookies = isCrossOriginDeployment(),
	publicRateLimits = DEFAULT_PUBLIC_RATE_LIMITS,
	ownerResetDeliver,
} = {}) {
	const router = express.Router();
	const allowedOriginSet = new Set(allowedOrigins);
	const passwordHash = null;
	const initialPasswordHash = ownerPasswordHash !== DEFAULT_OWNER_PASSWORD_HASH ? parsePasswordHash(ownerPasswordHash) : parsePasswordHash(process.env.OWNER_PASSWORD_HASH);

	// Reads the owner password credential on each call. When an explicit hash
	// was passed to the router constructor (as in tests), use it directly.
	// Otherwise read the environment variable so changes to OWNER_PASSWORD_HASH
	// take effect without restarting the router.
	async function readOwnerPasswordHash() {
		// Database credential row wins over the environment variable.
		try {
			const row = await pool.query("SELECT password_hash FROM owner_credentials WHERE singleton = true");
			if (row.rowCount === 1 && row.rows[0].password_hash) {
				return { hash: parsePasswordHash(row.rows[0].password_hash), source: "owner_credentials table" };
			}
		} catch (error) {
			// Only a database that does not have the owner_credentials table yet
			// may fall back to the configured password. Every other failure (a
			// connection problem, a permission error, a broken query) must
			// surface, so a stale environment password can never be accepted
			// because the credential lookup quietly failed.
			if (!isMissingRelationError(error)) throw error;
		}
		// Explicit constructor-supplied credential takes precedence over env.
		if (ownerPasswordHash !== DEFAULT_OWNER_PASSWORD_HASH) {
			return { hash: parsePasswordHash(ownerPasswordHash), source: "explicit constructor option" };
		}
		// Otherwise read the environment variable so changes to
		// OWNER_PASSWORD_HASH take effect without restarting the router.
		const hash = process.env.OWNER_PASSWORD_HASH;
		return hash ? { hash: parsePasswordHash(hash), source: "OWNER_PASSWORD_HASH environment variable" } : { hash: null, source: "none" };
	}
	const rateLimit = createPublicRateLimiter(publicRateLimits);
	// A caller that supplies its own limits may leave the reset entry out. The
	// default still applies, so the password reset routes are never unlimited.
	const resetRateLimit = rateLimit("reset", publicRateLimits.reset || DEFAULT_PUBLIC_RATE_LIMITS.reset);
	// The missing-provider and missing-recipient warnings are logged once per
	// process rather than once per request: the reset request route is
	// unauthenticated, so a caller could otherwise flood the log.
	const resetWarnings = new Set();
	function warnResetOnce(key, message) {
		if (resetWarnings.has(key)) return;
		resetWarnings.add(key);
		console.warn(message);
	}
	const configuredSessionSecret = typeof sessionSecret === "string" && sessionSecret.length >= 32
		? sessionSecret
		: null;

	function requireAllowedOrigin(req, res, next) {
		const origin = req.get("Origin");
		// A request without an Origin header is not a browser request from an
		// allowed page, so it is refused exactly as before.
		if (!origin) {
			return next(apiError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed."));
		}
		// When the server hands in its own checker, it is the one that decides:
		// it is the same function the CORS middleware uses, so the route guard
		// can never disagree with CORS. In production that checker accepts only
		// the explicit origin list, so nothing is widened there. Without it only
		// the configured origin list is accepted.
		const allowed = typeof isOriginAllowed === "function"
			? isOriginAllowed(origin)
			: allowedOriginSet.has(origin);
		if (!allowed) {
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
				// An unpublished product must not be orderable, even when the
				// customer still has it in a cart. The column only exists once the
				// owner migration has been applied, so the filter is added only
				// when the database actually has it.
				const visibilitySupported = await productVisibilitySupported(client);
				const visibilityFilter = visibilitySupported ? "AND is_published = true" : "";
				const productsResult = await client.query(
					`SELECT id, name, price::text AS price FROM products WHERE id = ANY($1::integer[]) ${visibilityFilter} ORDER BY id FOR SHARE`,
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
				// Stock is deducted inside this same transaction, one guarded
				// UPDATE per item: the WHERE requires the quantity to still be in
				// stock, so a row is only touched when the deduction succeeds.
				// The retry path above (an order that already existed under this
				// idempotency key) returns early and never reaches this loop, so a
				// retried checkout never deducts twice. Concurrent checkouts of
				// the same product serialise on the row lock, and the SQL re-checks
				// its stock-above-quantity condition against the latest committed
				// row when the lock is granted.
				for (const item of pricedItems) {
					const deducted = await client.query(
						"UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock",
						[item.quantity, item.productId],
					);
					if (deducted.rowCount === 0) {
						// Fetch the current stock so the response can say what the
						// customer could actually order. A missing row means the
						// product vanished between the pricing read and this write.
						const available = await client.query(
							"SELECT stock::int AS stock FROM products WHERE id = $1",
							[item.productId],
						);
						const conflict = new Error("insufficient_stock");
						conflict.stockConflict = {
							product_id: item.productId,
							product_name: item.productName,
							available: available.rows.length ? available.rows[0].stock : null,
						};
						throw conflict;
					}
				}
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
				// order_number is populated here, in the same transaction, using
				// the same 'MS-<id>' form the API already returns to customers.
				// It cannot be set by the INSERT because the value depends on the
				// generated id. The column is never read by application SQL; it
				// exists for reporting and for the unique index.
				await client.query(
					"UPDATE orders SET tracking_token_hash = $1, order_number = 'MS-' || $2::text WHERE id = $2",
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
			// An out-of-stock conflict is a documented, client-answerable
			// outcome, not a server fault: the whole order (including every item
			// deducted so far) rolled back above, and the payload names the
			// product and its real remaining stock.
			if (error && error.stockConflict) {
				return res.status(409).json({ error: "insufficient_stock", ...error.stockConflict });
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

	router.get("/owner/csrf", requireAllowedOrigin, async (req, res) => {
		// When the caller already holds a live session, refresh the exact pair
		// requireCsrf expects: the token derived from that session, with the
		// session's lifetime. This is what lets the dashboard heal a broken
		// token-cookie pair (a cookie that expired, or was overwritten by
		// another tab) with its one automatic retry instead of failing every
		// press until the page is reloaded. Without a session, or when the
		// session cannot be verified, the answer stays exactly as before: a
		// fresh random token for the login form.
		const cookies = parseCookies(req.get("Cookie"));
		const sessionId = cookies.get(SESSION_COOKIE);
		if (sessionId && configuredSessionSecret) {
			try {
				const result = await pool.query(
					"SELECT 1 FROM owner_sessions WHERE session_hash = $1 AND expires_at > CURRENT_TIMESTAMP",
					[sha256(sessionId)],
				);
				if (result.rowCount === 1) {
					const csrfToken = csrfForSession(sessionId);
					res.set("Cache-Control", "no-store");
					res.set("Set-Cookie", serializeCookie(CSRF_COOKIE, csrfToken, {
						maxAge: SESSION_TTL_SECONDS,
						secure: secureCookies,
					}));
					return res.json({ csrf_token: csrfToken });
				}
			} catch {
				// The database being unreachable must not break the bootstrap: an
				// unknown or unverified caller still gets the random token below,
				// and requireCsrf keeps enforcing the pair on every protected POST.
			}
		}
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
			const { hash: currentHash } = await readOwnerPasswordHash();
				if (!currentHash || !configuredSessionSecret) {
				throw apiError(503, "OWNER_AUTH_NOT_CONFIGURED", "Owner authentication is not configured.");
			}
			clientKeyHash = await applyLoginRateLimit(req);
			const suppliedPassword = req.body && typeof req.body.password === "string" ? req.body.password : "";
			if (suppliedPassword.length > 1024) {
				throw apiError(401, "INVALID_OWNER_CREDENTIALS", "Invalid owner credentials.");
			}
			const suppliedHash = await scrypt(suppliedPassword, currentHash.salt, currentHash.hash.length);
			if (!safeEqual(suppliedHash, currentHash.hash)) {
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

	router.post("/owner/password/reset-request", resetRateLimit, requireAllowedOrigin, async (req, res, next) => {
		try {
			const contactRow = await pool.query("SELECT email FROM owner_contact WHERE singleton = true");
			let recipientEmail = contactRow.rowCount === 1 ? contactRow.rows[0].email : null;
			if (!recipientEmail) {
				recipientEmail = process.env.OWNER_CONTACT_EMAIL || null;
			}
			// A reset link can only be sent when there is both a provider and
			// somewhere to send it.
			const deliveryConfigured = Boolean(ownerResetDeliver) && Boolean(recipientEmail);
			// Every outcome answers with the same generic message and the same
			// shape, so a caller can never learn whether a reset was possible,
			// whether a mail was sent, or anything about the owner account.
			const respond = (delivered) => res.status(200).json({
				message: GENERIC_RESET_REQUEST_MESSAGE,
				requested: true,
				delivery_configured: deliveryConfigured,
				delivered,
			});

			if (!ownerResetDeliver) {
				warnResetOnce(
					"no-delivery-provider",
					"Owner password reset requests are accepted, but no delivery provider is configured, so no reset link can be sent.",
				);
				return respond(false);
			}
			if (!recipientEmail) {
				warnResetOnce(
					"no-recipient-address",
					"Owner password reset requests are accepted, but no recipient address is configured, so no reset link can be sent.",
				);
				return respond(false);
			}

			const token = generateResetToken();
			const tokenHash = hashResetToken(token);
			const expiresAt = resetTokenExpiry();

			// A pool owns no transaction of its own: BEGIN and COMMIT issued as
			// separate pool.query calls run on different connections, so they
			// cannot wrap the cleanup and the insert. Both statements stand on
			// their own instead.
			await pool.query("DELETE FROM owner_reset_tokens WHERE consumed_at IS NOT NULL");
			await pool.query(
				"INSERT INTO owner_reset_tokens (token_hash, expires_at) VALUES ($1, $2)",
				[tokenHash, expiresAt]
			);

			try {
				await ownerResetDeliver({ token, recipient: recipientEmail });
				return respond(true);
			} catch (deliveryError) {
				// The link was never sent, so the token must not stay usable.
				await pool.query("DELETE FROM owner_reset_tokens WHERE token_hash = $1", [tokenHash]);
				// Only a non-sensitive code is logged. The token, the recipient
				// and anything the provider said about the message never are.
				console.warn("Owner password reset email could not be sent.", {
					code: deliveryError && deliveryError.code
						? String(deliveryError.code).slice(0, 32)
						: "DELIVERY_FAILED",
				});
				return respond(false);
			}
		} catch (error) {
			next(error);
		}
	});

	router.post("/owner/password/reset", resetRateLimit, requireAllowedOrigin, async (req, res, next) => {
		let client;
		try {
			const { token, new_password, confirm_password } = req.body || {};
			if (!token || typeof token !== "string") {
				throw apiError(400, "RESET_TOKEN_REQUIRED", "A reset token is required.");
			}

			client = await pool.connect();
			try {
				await client.query("BEGIN");

				const tokenRow = await client.query(
					"SELECT token_hash, expires_at, consumed_at FROM owner_reset_tokens WHERE token_hash = $1 FOR UPDATE",
					[hashResetToken(token)]
				);
				// One message for every way a link can be unusable, so a caller
				// cannot tell a used link from an expired one.
				if (tokenRow.rowCount === 0) {
					throw apiError(400, "INVALID_RESET_TOKEN", RESET_TOKEN_UNUSABLE_MESSAGE);
				}
				const stored = tokenRow.rows[0];
				if (stored.consumed_at !== null) {
					throw apiError(400, "RESET_TOKEN_CONSUMED", RESET_TOKEN_UNUSABLE_MESSAGE);
				}
				const expiry = new Date(stored.expires_at);
				if (expiry <= new Date()) {
					throw apiError(400, "RESET_TOKEN_EXPIRED", RESET_TOKEN_UNUSABLE_MESSAGE);
				}

				const passwordValidation = validatePasswordPolicy(new_password);
				if (!passwordValidation.valid) {
					throw apiError(400, "WEAK_PASSWORD", passwordValidation.reason);
				}
				if (new_password !== confirm_password) {
					throw apiError(400, "PASSWORD_MISMATCH", "The new password and confirmation do not match.");
				}

				const newSalt = crypto.randomBytes(16);
				const newHash = await scrypt(new_password, newSalt, 64);
				const newEncodedHash = `scrypt$${newSalt.toString("hex")}$${newHash.toString("hex")}`;

				const consumedResult = await client.query(
					"DELETE FROM owner_reset_tokens WHERE token_hash = $1 AND consumed_at IS NULL",
					[hashResetToken(token)]
				);
				if (consumedResult.rowCount === 0) {
					throw apiError(400, "RESET_TOKEN_CONSUMED", "This reset token has already been used.");
				}

				await client.query(
					"INSERT INTO owner_credentials (singleton, password_hash, updated_at) VALUES (true, $1, CURRENT_TIMESTAMP) ON CONFLICT (singleton) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = CURRENT_TIMESTAMP",
					[newEncodedHash]
				);
				await client.query("DELETE FROM owner_sessions");

				await client.query("COMMIT");

				res.set("Cache-Control", "no-store");
				return res.json({ reset: true, message: "Password reset successfully.", sessions_revoked: true });
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
		} catch (error) {
			next(error);
		}
	});

	router.use("/owner", requireAllowedOrigin, requireOwner);

	// --- product images --------------------------------------------------------
	// The photo is uploaded first and the SAVED path is what goes into the
	// product, never a blob URL. The bytes are stored in the database so they
	// survive a redeploy.
	router.post("/owner/product-images", requireCsrf, async (req, res, next) => {
		try {
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const decoded = decodeDataUrl(body.image);
			if (decoded.error) {
				return res.status(400).json({ error: decoded.error, code: "INVALID_IMAGE_DATA" });
			}
			const validated = validateImageBytes(decoded.bytes);
			if (!validated.valid) {
				return res.status(400).json({ error: validated.error, code: "INVALID_IMAGE" });
			}
			// The decoded size is the limit that matters, never the body size.
			if (validated.bytes.length > MAX_PRODUCT_IMAGE_BYTES) {
				return res.status(400).json({
					error: "Images must be 5 MB or smaller.",
					code: "IMAGE_TOO_LARGE",
				});
			}
			const stored = await saveImageToDatabase(pool, {
				bytes: validated.bytes,
				ext: validated.ext,
				mime: validated.mime,
			});
			if (!stored.ok) {
				// A store that is not configured is a server-side gap, not a bad
				// request: the file was fine, there is just nowhere to put it.
				const status = stored.code === "IMAGE_STORE_UNAVAILABLE" ? 503 : 400;
				return res.status(status).json({ error: stored.error, code: stored.code });
			}
			return res.status(201).json({ image: stored.publicPath });
		} catch (error) {
			next(error);
		}
	});

	// --- product management ----------------------------------------------------
	// The dashboard sends the filters it uses: search, category,
	// include_unpublished, limit and offset. "include_unpublished" is only
	// sent when the owner does NOT want hidden products, so an absent
	// parameter means "include them".

	function productIdFromParam(value) {
		if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) {
			throw apiError(400, "INVALID_PRODUCT_ID", "Enter a valid product ID.");
		}
		return Number(value);
	}

	function productListLimit(value) {
		const parsed = Number.parseInt(String(value === undefined || value === null ? "" : value), 10);
		if (!Number.isInteger(parsed) || parsed < 1) return 100;
		return Math.min(parsed, 500);
	}

	function productListOffset(value) {
		const parsed = Number.parseInt(String(value === undefined || value === null ? "" : value), 10);
		if (!Number.isInteger(parsed) || parsed < 0) return 0;
		return parsed;
	}

	// The columns the owner dashboard reads. The visibility and threshold
	// columns only exist once their migrations have been applied, so each is
	// only selected when the database actually has it.
	function productColumns(visibilitySupported, thresholdSupported = false) {
		const columns = "id, name, category, price::text AS price, original_price::text AS original_price, stock, image, description";
		const extras = [visibilitySupported ? "is_published" : "", thresholdSupported ? "low_stock_threshold" : ""]
			.filter(Boolean);
		return extras.length ? `${columns}, ${extras.join(", ")}` : columns;
	}

	function normalizeProductRow(row, visibilitySupported, thresholdSupported = false) {
		const product = {
			id: Number(row.id),
			name: row.name,
			category: row.category,
			price: row.price,
			original_price: row.original_price,
			stock: Number(row.stock || 0),
			image: row.image,
			description: row.description,
		};
		if (visibilitySupported) product.is_published = row.is_published !== false;
		if (thresholdSupported) product.low_stock_threshold = Number(row.low_stock_threshold ?? 5);
		return product;
	}

	async function readProductRow(id, visibilitySupported, thresholdSupported = false) {
		const result = await pool.query(
			`SELECT ${productColumns(visibilitySupported, thresholdSupported)} FROM products WHERE id = $1`,
			[id],
		);
		return result.rows[0] || null;
	}

	// A product may only point at an image that was really uploaded, so the
	// path has to exist in the store.
	async function confirmStoredImage(imagePath) {
		if (typeof imagePath !== "string" || !imagePath.startsWith("/product-images/")) {
			return { ok: true };
		}
		const name = imageNameFromPublicPath(imagePath);
		if (!name) {
			return { ok: false, error: "That uploaded image path is not valid.", code: "INVALID_IMAGE_PATH" };
		}
		try {
			const result = await pool.query(
				"SELECT count(*)::int AS n FROM product_images WHERE name = $1",
				[name],
			);
			if (!result.rows[0] || Number(result.rows[0].n) === 0) {
				return { ok: false, error: "That image has not been uploaded.", code: "IMAGE_NOT_FOUND" };
			}
		} catch {
			return { ok: false, error: "That image has not been uploaded.", code: "IMAGE_NOT_FOUND" };
		}
		return { ok: true };
	}

	router.get("/owner/products", async (req, res, next) => {
		try {
			const visibilitySupported = await productVisibilitySupported(pool);
			const thresholdSupported = await productLowStockThresholdSupported(pool);
			const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
			const category = typeof req.query.category === "string" ? req.query.category.trim().slice(0, 100) : "";
			const includeUnpublished = req.query.include_unpublished !== "false";
			const limit = productListLimit(req.query.limit);
			const offset = productListOffset(req.query.offset);

			const conditions = [];
			const params = [];
			if (!includeUnpublished && visibilitySupported) {
				conditions.push("is_published = true");
			}
			if (search) {
				params.push(`%${search.toLowerCase()}%`);
				const needle = `$${params.length}`;
				conditions.push(
					`(lower(name) LIKE ${needle} OR lower(COALESCE(category, '')) LIKE ${needle} OR lower(COALESCE(description, '')) LIKE ${needle})`,
				);
			}
			if (category) {
				params.push(category.toLowerCase());
				conditions.push(`lower(COALESCE(category, '')) = $${params.length}`);
			}
			params.push(limit);
			const limitParam = params.length;
			params.push(offset);
			const offsetParam = params.length;
			const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
			// Every value is a bound parameter; nothing from the request is
			// interpolated into the statement.
			const result = await pool.query(
				`SELECT ${productColumns(visibilitySupported, thresholdSupported)} FROM products ${where} ORDER BY id LIMIT $${limitParam} OFFSET $${offsetParam}`,
				params,
			);
			return res.json({
				visibility_supported: visibilitySupported,
				low_stock_threshold_supported: thresholdSupported,
				products: result.rows.map(row => normalizeProductRow(row, visibilitySupported, thresholdSupported)),
			});
		} catch (error) {
			next(error);
		}
	});

	router.post("/owner/products", requireCsrf, async (req, res, next) => {
		try {
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const normalized = normalizeProductPayload(body, { partial: false });
			if (!normalized.valid) {
				return res.status(400).json({ error: normalized.error, code: "INVALID_PRODUCT" });
			}
			const value = normalized.value;
			const visibilitySupported = await productVisibilitySupported(pool);
			const thresholdSupported = await productLowStockThresholdSupported(pool);
			// A new product is published unless the owner says otherwise.
			const isPublished = body.is_published === undefined ? true : body.is_published !== false;
			if (value.image) {
				const imageCheck = await confirmStoredImage(value.image);
				if (!imageCheck.ok) {
					return res.status(400).json({ error: imageCheck.error, code: imageCheck.code });
				}
			}

			const columns = ["name", "category", "price", "original_price", "stock", "image", "description"];
			const params = [
				value.name,
				value.category === undefined ? null : value.category,
				value.price,
				value.original_price === undefined ? null : value.original_price,
				value.stock,
				value.image === undefined ? null : value.image,
				value.description === undefined ? null : value.description,
			];
			if (visibilitySupported) {
				columns.push("is_published");
				params.push(isPublished);
			}
			// An initial low-stock threshold is only written when the column
			// exists; the database default (5) covers an omitted value.
			if (thresholdSupported && value.low_stock_threshold !== undefined) {
				columns.push("low_stock_threshold");
				params.push(value.low_stock_threshold);
			}
			const placeholders = columns.map((column, index) => `$${index + 1}`).join(", ");
			const inserted = await pool.query(
				`INSERT INTO products (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`,
				params,
			);
			const created = await readProductRow(inserted.rows[0].id, visibilitySupported, thresholdSupported);
			return res.status(201).json({ product: normalizeProductRow(created, visibilitySupported, thresholdSupported) });
		} catch (error) {
			next(error);
		}
	});

	router.patch("/owner/products/:id", requireCsrf, async (req, res, next) => {
		try {
			const id = productIdFromParam(req.params.id);
			const body = req.body && typeof req.body === "object" ? req.body : {};
			// Editing keeps the product's existing photo: the dashboard round-trips
			// the stored value back in the PATCH body. A value exactly equal to the
			// stored image is a no-op and skips URL validation, because legacy rows
			// carry plain relative paths that the validator rejects. New or changed
			// values are still fully validated. Creates are not affected.
			const currentImageQuery = await pool.query("SELECT image FROM products WHERE id = $1", [id]);
			const currentImage = currentImageQuery.rows.length === 1 ? currentImageQuery.rows[0].image : undefined;
			const normalized = normalizeProductPayload(body, { partial: true, currentImage });
			if (!normalized.valid) {
				return res.status(400).json({ error: normalized.error, code: "INVALID_PRODUCT" });
			}
			const value = normalized.value;
			const visibilitySupported = await productVisibilitySupported(pool);
			const thresholdSupported = await productLowStockThresholdSupported(pool);
			// A threshold can only be stored once the column exists; before the
			// stock migration it is dropped exactly like an unknown field.
			if (!thresholdSupported) delete value.low_stock_threshold;
			const existing = await readProductRow(id, visibilitySupported, thresholdSupported);
			if (!existing) {
				return res.status(404).json({ error: "Product not found", code: "PRODUCT_NOT_FOUND" });
			}
			if (value.image) {
				const imageCheck = await confirmStoredImage(value.image);
				if (!imageCheck.ok) {
					return res.status(400).json({ error: imageCheck.error, code: imageCheck.code });
				}
			}

			const sets = [];
			const params = [];
			// The column names come from the normaliser, never from the request.
			for (const [column, entry] of Object.entries(value)) {
				params.push(entry === undefined ? null : entry);
				sets.push(`${column} = $${params.length}`);
			}
			if (visibilitySupported && body.is_published !== undefined) {
				params.push(body.is_published !== false);
				sets.push(`is_published = $${params.length}`);
			}
			if (sets.length > 0) {
				params.push(id);
				await pool.query(`UPDATE products SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
			}
			const updated = await readProductRow(id, visibilitySupported, thresholdSupported);
			// The photo the product no longer uses may be free to go.
			if (value.image !== undefined && existing.image && existing.image !== value.image) {
				await deleteImageIfUnused(pool, existing.image);
			}
			return res.status(200).json({ product: normalizeProductRow(updated, visibilitySupported, thresholdSupported) });
		} catch (error) {
			next(error);
		}
	});

	// --- corrective stock changes ----------------------------------------------
	// A dedicated stock endpoint so a quick +/- can never be coupled to a whole
	// product payload: one small, validated UPDATE per call, and the floor at
	// zero is enforced in the SQL itself, so a concurrent checkout deducting
	// the last unit cannot push the number negative between the validation and
	// the write. The response is the same product shape the list route sends.
	router.patch("/owner/products/:id/stock", requireCsrf, async (req, res, next) => {
		try {
			const id = productIdFromParam(req.params.id);
			const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
			const hasDelta = body.delta !== undefined;
			const hasSet = body.set !== undefined;
			if (hasDelta && hasSet) {
				return res.status(400).json({
					error: "Provide either a stock delta or a stock set value, not both.",
					code: "INVALID_STOCK_CHANGE",
				});
			}
			if (!hasDelta && !hasSet) {
				return res.status(400).json({
					error: "Provide a stock change as either a delta or a set value.",
					code: "INVALID_STOCK_CHANGE",
				});
			}
			const change = Number(hasDelta ? body.delta : body.set);
			if (typeof change !== "number" || !Number.isSafeInteger(change)) {
				return res.status(400).json({
					error: "The stock change must be a whole number.",
					code: "INVALID_STOCK_CHANGE",
				});
			}
			if (hasSet && change < 0) {
				return res.status(400).json({
					error: "The stock quantity cannot be negative.",
					code: "INVALID_STOCK_CHANGE",
				});
			}
			if (Math.abs(change) > MAX_STOCK) {
				return res.status(400).json({
					error: "That stock change is too large.",
					code: "INVALID_STOCK_CHANGE",
				});
			}

			const visibilitySupported = await productVisibilitySupported(pool);
			const thresholdSupported = await productLowStockThresholdSupported(pool);
			const statement = hasDelta
				? `UPDATE products SET stock = GREATEST(stock + $1, 0) WHERE id = $2 RETURNING ${productColumns(visibilitySupported, thresholdSupported)}`
				: `UPDATE products SET stock = $1 WHERE id = $2 RETURNING ${productColumns(visibilitySupported, thresholdSupported)}`;
			const updated = await pool.query(statement, [change, id]);
			if (updated.rowCount === 0) {
				return res.status(404).json({ error: "Product not found", code: "PRODUCT_NOT_FOUND" });
			}
			return res.json({
				product: normalizeProductRow(updated.rows[0], visibilitySupported, thresholdSupported),
			});
		} catch (error) {
			next(error);
		}
	});

	router.delete("/owner/products/:id", requireCsrf, async (req, res, next) => {
		let client;
		try {
			const id = productIdFromParam(req.params.id);
			const body = req.body && typeof req.body === "object" ? req.body : {};
			if (body.confirm !== "DELETE") {
				return res.status(400).json({
					error: 'Type DELETE to confirm removing this product.',
					code: "CONFIRMATION_REQUIRED",
				});
			}
			client = await pool.connect();
			await client.query("BEGIN");
			// The row is locked for the rest of the transaction, and the checkout
			// locks products FOR SHARE, so an order arriving at the same moment
			// cannot slip between the reference check and the delete.
			const locked = await client.query(
				"SELECT id, image FROM products WHERE id = $1 FOR UPDATE",
				[id],
			);
			if (locked.rows.length === 0) {
				await client.query("ROLLBACK");
				return res.status(404).json({ error: "Product not found", code: "PRODUCT_NOT_FOUND" });
			}
			const referenced = await client.query(
				"SELECT count(*)::int AS n FROM order_items WHERE product_id = $1",
				[id],
			);
			if (referenced.rows[0] && Number(referenced.rows[0].n) > 0) {
				await client.query("ROLLBACK");
				return res.status(409).json({
					error: "This product is referenced by an order item and cannot be deleted.",
					code: "PRODUCT_IN_USE",
				});
			}
			await client.query("DELETE FROM products WHERE id = $1", [id]);
			await client.query("COMMIT");
			const image = locked.rows[0].image;
			if (image) {
				await deleteImageIfUnused(pool, image);
			}
			return res.json({ deleted: true, id });
		} catch (error) {
			if (client) {
				try {
					await client.query("ROLLBACK");
				} catch {
					// The transaction is already gone; the original error is what matters.
				}
			}
			next(error);
		} finally {
			if (client) client.release();
		}
	});

	// --- password change -------------------------------------------------------
	// The owner changes the password from the dashboard, so the current one must
	// be proven and every session is revoked afterwards.
	router.post("/owner/password", requireCsrf, async (req, res, next) => {
		let clientKeyHash;
		try {
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
			const newPassword = typeof body.new_password === "string" ? body.new_password : "";
			const confirmation = typeof body.confirm_password === "string" ? body.confirm_password : "";
			const validation = validatePasswordChange(currentPassword, newPassword, confirmation);
			if (!validation.valid) {
				return res.status(400).json({ error: validation.error, code: validation.code });
			}
			const { hash: currentHash } = await readOwnerPasswordHash();
			if (!currentHash) {
				throw apiError(503, "OWNER_AUTH_NOT_CONFIGURED", "Owner authentication is not configured.");
			}
			// The same limit the login uses: a stolen session must not be able to
			// brute force the current password.
			clientKeyHash = await applyLoginRateLimit(req);
			const suppliedHash = await scrypt(currentPassword, currentHash.salt, currentHash.hash.length);
			if (!safeEqual(suppliedHash, currentHash.hash)) {
				return res.status(401).json({
					error: "The current password is not correct.",
					code: "INVALID_CURRENT_PASSWORD",
				});
			}

			const newHash = await hashOwnerPassword(newPassword);
			await pool.query(
				"INSERT INTO owner_credentials (singleton, password_hash, updated_at) VALUES (true, $1, CURRENT_TIMESTAMP) ON CONFLICT (singleton) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at",
				[newHash],
			);
			// Every session is revoked, including the caller's.
			await pool.query("DELETE FROM owner_sessions");
			await pool.query("DELETE FROM owner_login_attempts WHERE client_key_hash = $1", [clientKeyHash]);

			res.set("Cache-Control", "no-store");
			res.set("Set-Cookie", [
				serializeCookie(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: secureCookies }),
				serializeCookie(CSRF_COOKIE, "", { maxAge: 0, secure: secureCookies }),
			]);
			return res.json({
				changed: true,
				sessions_revoked: true,
				message: "Your password has been changed. Please log in again.",
			});
		} catch (error) {
			next(error);
		}
	});

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

	router.get("/owner/sales", async (req, res, next) => {
		try {
			// Orders are counted by the date they were placed, in the business
			// time zone. orders.created_at is TIMESTAMP WITHOUT TIME ZONE and
			// stores UTC, so it is read as UTC first and then converted to
			// Australia/Melbourne. All boundaries are worked out once, in
			// Melbourne, and handed to the database as date parameters so a
			// daylight-saving change is resolved by the database zone data.
			const melbourneToday = melbourneNow().date;
			const weekday = new Date(`${melbourneToday}T00:00:00.000Z`).getUTCDay();
			const weekStart = addCalendarDays(melbourneToday, -((weekday + 6) % 7));
			const monthStart = `${melbourneToday.slice(0, 8)}01`;
			const dailyStart = addCalendarDays(melbourneToday, -13);

			const totals = await pool.query(
				`WITH dated AS (
					SELECT total, status,
						(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date AS order_date
					FROM orders
				)
				SELECT
					COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled' AND order_date = $1::date), 0)::numeric(18,2)::text AS today_sales,
					COUNT(*) FILTER (WHERE status <> 'Cancelled' AND order_date = $1::date)::int AS today_orders,
					COALESCE(SUM(total) FILTER (WHERE status = 'Picked Up' AND order_date = $1::date), 0)::numeric(18,2)::text AS today_collected,
					COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled' AND order_date >= $2::date AND order_date <= $1::date), 0)::numeric(18,2)::text AS week_sales,
					COUNT(*) FILTER (WHERE status <> 'Cancelled' AND order_date >= $2::date AND order_date <= $1::date)::int AS week_orders,
					COALESCE(SUM(total) FILTER (WHERE status = 'Picked Up' AND order_date >= $2::date AND order_date <= $1::date), 0)::numeric(18,2)::text AS week_collected,
					COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled' AND order_date >= $3::date AND order_date <= $1::date), 0)::numeric(18,2)::text AS month_sales,
					COUNT(*) FILTER (WHERE status <> 'Cancelled' AND order_date >= $3::date AND order_date <= $1::date)::int AS month_orders,
					COALESCE(SUM(total) FILTER (WHERE status = 'Picked Up' AND order_date >= $3::date AND order_date <= $1::date), 0)::numeric(18,2)::text AS month_collected,
					COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled'), 0)::numeric(18,2)::text AS all_sales,
					COUNT(*) FILTER (WHERE status <> 'Cancelled')::int AS all_orders,
					COALESCE(SUM(total) FILTER (WHERE status = 'Picked Up'), 0)::numeric(18,2)::text AS all_collected
				FROM dated`,
				[melbourneToday, weekStart, monthStart],
			);

			const dailySales = await pool.query(
				`SELECT to_char(
						(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date,
						'YYYY-MM-DD'
					) AS date,
					SUM(total)::numeric(18,2)::text AS sales
				FROM orders
				WHERE status <> 'Cancelled'
					AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date BETWEEN $2::date AND $1::date
				GROUP BY 1
				ORDER BY 1`,
				[melbourneToday, dailyStart],
			);
			const salesByDate = new Map(dailySales.rows.map(row => [row.date, row.sales]));
			const daily = [];
			for (let offset = 0; offset < 14; offset += 1) {
				const date = addCalendarDays(dailyStart, offset);
				daily.push({ date, sales: salesByDate.get(date) || "0.00" });
			}

			// Monthly history for the last 12 Melbourne calendar months. The
			// window starts at the month of the first order, but never further
			// back than 11 months before the current one, so the chart stays
			// bounded even for an old store. Buckets use the same Melbourne
			// order date as every other figure in this response, and the same
			// status rules: sales and counts exclude Cancelled, collected
			// counts Picked Up only.
			const currentYear = Number(melbourneToday.slice(0, 4));
			const currentMonth = Number(melbourneToday.slice(5, 7));
			const currentMonthKey = formatMonthKey(currentYear, currentMonth);
			const firstOrderMonthResult = await pool.query(
				"SELECT to_char(MIN((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date), 'YYYY-MM') AS first_order_month FROM orders",
			);
			const firstOrderMonth = firstOrderMonthResult.rows.length === 1
				&& typeof firstOrderMonthResult.rows[0].first_order_month === "string"
				? firstOrderMonthResult.rows[0].first_order_month
				: null;
			// No orders at all means nothing to chart or compare; the dashboard
			// renders its friendly empty message instead.
			const monthlyWindowStart = firstOrderMonth === null
				? null
				: (firstOrderMonth > monthWindowFloor(currentYear, currentMonth)
					? firstOrderMonth
					: monthWindowFloor(currentYear, currentMonth));
			let monthlyMonths = [];
			let monthlyPeriods = {
				this_month_so_far: emptyPeriod(),
				last_month: emptyPeriod(),
				last_month_same_days: emptyPeriod(),
			};
			if (monthlyWindowStart !== null) {
				// The previous month's length clamps the same-days comparison:
				// a 31st compares against a 28-day February's last day, the
				// honest latest point the two months share.
				const previousMonth = previousMonthKey(currentYear, currentMonth);
				const lastMonthStart = `${previousMonth}-01`;
				const sameDaysEnd = `${previousMonth}-${String(Math.min(Number(melbourneToday.slice(8, 10)), daysInMonth(previousMonth))).padStart(2, "0")}`;

				const monthlyRows = await pool.query(
					`WITH dated AS (
						SELECT total, status,
							(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date AS order_date
						FROM orders
					)
					SELECT to_char(order_date, 'YYYY-MM') AS ym,
						COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled'), 0)::numeric(18,2)::text AS sales,
						COUNT(*) FILTER (WHERE status <> 'Cancelled')::int AS orders,
						COALESCE(SUM(total) FILTER (WHERE status = 'Picked Up'), 0)::numeric(18,2)::text AS collected
					FROM dated
					WHERE order_date >= $1::date AND order_date <= $2::date
					GROUP BY 1
					ORDER BY 1`,
					[`${monthlyWindowStart}-01`, melbourneToday],
				);
				const salesByMonth = new Map(monthlyRows.rows.map(row => [row.ym, row]));
				monthlyMonths = enumerateMonths(monthlyWindowStart, currentMonthKey).map(ym => {
					const row = salesByMonth.get(ym);
					return {
						month: ym,
						sales: row ? row.sales : "0.00",
						orders: row ? Number(row.orders) : 0,
						collected: row ? row.collected : "0.00",
					};
				});

				// One per-day pass over the two comparison months, aggregated
				// here: the running current month, last month in full, and last
				// month up to today's equivalent day.
				const dayRows = await pool.query(
					`WITH dated AS (
						SELECT total, status,
							(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Melbourne')::date AS order_date
						FROM orders
					)
					SELECT to_char(order_date, 'YYYY-MM-DD') AS order_date,
						COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled'), 0)::numeric(18,2)::text AS sales,
						COUNT(*) FILTER (WHERE status <> 'Cancelled')::int AS orders,
						COALESCE(SUM(total) FILTER (WHERE status = 'Picked Up'), 0)::numeric(18,2)::text AS collected
					FROM dated
					WHERE order_date >= $1::date AND order_date <= $2::date
					GROUP BY 1
					ORDER BY 1`,
					[lastMonthStart, melbourneToday],
				);
				let thisMonthSoFar = emptyPeriod();
				let lastMonthFull = emptyPeriod();
				let lastMonthSameDays = emptyPeriod();
				for (const row of dayRows.rows) {
					// Plain string comparison is safe on YYYY-MM-DD dates.
					if (row.order_date >= monthStart) thisMonthSoFar = addPeriod(thisMonthSoFar, row);
					else lastMonthFull = addPeriod(lastMonthFull, row);
					if (row.order_date <= sameDaysEnd) {
						lastMonthSameDays = addPeriod(lastMonthSameDays, row);
					}
				}
				monthlyPeriods = {
					this_month_so_far: thisMonthSoFar,
					last_month: lastMonthFull,
					last_month_same_days: lastMonthSameDays,
				};
			}

			const summary = totals.rows[0];
			res.set("Cache-Control", "no-store");
			return res.json({
				today: {
					sales: summary.today_sales,
					orders: summary.today_orders,
					collected: summary.today_collected,
				},
				this_week: {
					sales: summary.week_sales,
					orders: summary.week_orders,
					collected: summary.week_collected,
				},
				this_month: {
					sales: summary.month_sales,
					orders: summary.month_orders,
					collected: summary.month_collected,
				},
				all_time: {
					sales: summary.all_sales,
					orders: summary.all_orders,
					collected: summary.all_collected,
				},
				daily,
				monthly: {
					window_start_month: monthlyWindowStart,
					months: monthlyMonths,
					this_month_so_far: monthlyPeriods.this_month_so_far,
					last_month: monthlyPeriods.last_month,
					last_month_same_days: monthlyPeriods.last_month_same_days,
				},
				melbourne_today: melbourneToday,
			});
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
			const itemsByOrder = new Map();
			if (result.rows.length > 0) {
				const items = await pool.query(
					`SELECT oi.order_id::text AS order_id,
						COALESCE(oi.product_name, p.name, 'Product') AS product_name,
						COALESCE(oi.unit_price, oi.price)::text AS unit_price,
						oi.quantity, oi.subtotal::text AS subtotal
					FROM order_items oi
					LEFT JOIN products p ON p.id = oi.product_id
					WHERE oi.order_id::text = ANY($1::text[])
					ORDER BY oi.order_id, oi.id`,
					[result.rows.map(order => order.id)],
				);
				for (const item of items.rows) {
					const { order_id: orderId, ...orderItem } = item;
					const existing = itemsByOrder.get(orderId);
					if (existing) {
						existing.push(orderItem);
					} else {
						itemsByOrder.set(orderId, [orderItem]);
					}
				}
			}
			res.set("Cache-Control", "no-store");
			return res.json(result.rows.map(order => ({
				...order,
				order_number: `MS-${order.id}`,
				items: itemsByOrder.get(String(order.id)) || [],
			})));
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
			if (status === "Cancelled" && currentStatus !== "Cancelled") {
				// Stock returns to the shelf exactly once: only when the order
				// moves to Cancelled from a live status, inside this same
				// transaction. Cancelled is terminal in STATUS_TRANSITIONS, so a
				// later write cannot re-run this. Items are ordered by product id
				// so concurrent restores always lock rows in the same sequence.
				const items = await client.query(
					"SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
					[orderId],
				);
				for (const item of items.rows) {
					const productId = Number(item.product_id);
					const quantity = Number(item.quantity);
					if (!Number.isSafeInteger(productId) || productId < 1
						|| !Number.isSafeInteger(quantity) || quantity < 1) {
						continue;
					}
					// A deleted product updates zero rows, which is correct: there
				// is no shelf to return it to. A legacy row whose stock is NULL
				// stays NULL (stock + NULL = NULL), matching the checkout rule
				// that untracked stock is never deducted.
				await client.query(
					"UPDATE products SET stock = stock + $1 WHERE id = $2",
					[quantity, productId],
				);
				}
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

	// Describes the credential source in use, without exposing any secret value.
	// Used by server.js startup logging and by operational checks.
	router.describeOwnerCredentialSource = async function describeOwnerCredentialSource() {
		const { hash: current, source } = await readOwnerPasswordHash();
		const initial = initialPasswordHash;
		return {
			source: source || "none",
			usable: !!current,
			changedSinceStartup: initial && current ? !safeEqual(current.hash, initial.hash) : false,
		};
	};

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
		`SELECT id::text AS id, customer_name, customer_contact, customer_email,
			pickup_date::text AS pickup_date,
			COALESCE(NULLIF(pickup_time::text, ''), requested_pickup_time::text) AS pickup_time,
			total::text AS total, subtotal::text AS subtotal,
			discount::text AS discount, shipping_fee::text AS shipping_fee,
			status, cancellation_reason, created_at
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


function sameSiteFor(secure) {
	return secure ? "None" : "Lax";
}

function isCrossOriginDeployment() {
	const origins = (process.env.FRONTEND_ORIGINS || "")
		.split(",")
		.map(origin => origin.trim())
		.filter(Boolean);
	if (origins.length === 0) return true;
	return origins.some(origin => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin));
}

module.exports = {
	ALLOWED_STATUSES,
	STATUS_TRANSITIONS,
	amountToCents,
	centsToAmount,
	createOrderRouter,
	normalizeOrderRequest,
	parsePasswordHash,
	isCrossOriginDeployment,
	sameSiteFor,
	serializeCookie,
};
