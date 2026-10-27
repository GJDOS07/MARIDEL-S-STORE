require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createOrderRouter } = require("./order-routes");
const { createApiErrorHandler } = require("./api-error-handler");
const { mountPublicProductRoutes } = require("./public-product-routes");
const { startupNoticeLines, isOwnerAuthConfigured } = require("./owner-config-check");
const {
	createOriginChecker,
	defaultOriginsFor,
	PRODUCTION_FRONTEND_ORIGIN,
} = require("./allowed-origins");
const {
	createSandboxDatabaseOrThrow,
	isSandboxRequested,
} = require("./local-sandbox-database");
const { createResendDelivery, describeEmailConfig } = require("./owner-email");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const configuredOrigins = (process.env.FRONTEND_ORIGINS || "")
	.split(",")
	.map(origin => origin.trim())
	.filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOriginsFor({ isProduction }));

// Decides which browser origins may call the API. In production only the
// explicit list is honoured. Outside production, loopback is accepted on any
// port, so the owner dashboard opens from whatever local web server is already
// in use: Live Server on 5500, python -m http.server on 8000, npx serve, and so
// on. A loopback origin is not reachable from the public internet, so this
// widens nothing that matters. See allowed-origins.js and its tests.
const isOriginAllowed = createOriginChecker({ allowedOrigins: [...allowedOrigins], isProduction });

// The name of the session cookie the owner dashboard sends. The route that
// reads it is in order-routes.js; only the presence of the cookie matters here.
const OWNER_SESSION_COOKIE = "maridel_owner_session";

// True when the request carries the owner session cookie. The value is not
// inspected: only its presence is checked here, the real validation happens in
// the route.
function hasSessionCookie(cookieHeader) {
	return String(cookieHeader || "")
		.split(";")
		.some(part => part.trim().startsWith(`${OWNER_SESSION_COOKIE}=`));
}

// The body limit in bytes, for the "8mb" style limit express accepts.
function bodyLimitBytes(limit) {
	const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(limit || "").trim());
	if (!match) return 8 * 1024 * 1024;
	const units = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
	const value = Number(match[1]) * (units[(match[2] || "b").toLowerCase()] || 1);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 8 * 1024 * 1024;
}

// Set once createOrderRouter has been built, so the startup log can report which
// credential source the login route will actually use.
let orderRouter = null;

// The database. Two modes, and only two:
//
//   1. LOCAL_SANDBOX_DB is set: an isolated in-process PostgreSQL built from the
//      project's own migrations and a synthetic catalog. Nothing is contacted
//      over the network. This exists because DATABASE_URL in this workspace
//      points at production, and there was previously no way to run the backend
//      locally without reading and writing production rows.
//
//   2. Otherwise, exactly as before: a pg Pool against DATABASE_URL.
//
// The sandbox is never selected implicitly, so a deployment that does not set it
// keeps the production path byte for byte.
const usingSandbox = isSandboxRequested();

// The sandbox instance, when one was built. Declared here so the assignment
// inside resolveDatabase() is a normal module binding and not an accidental
// global.
let sandbox = null;

if (!usingSandbox && !DATABASE_URL) {
	throw new Error("DATABASE_URL is not set. Add your Neon connection string as an environment variable.");
}

// The database, then everything that depends on it. Route registration needs a
// pool, so it happens inside start() rather than at module level. When
// LOCAL_SANDBOX_DB is unset this is exactly the previous behaviour: a pg Pool
// against DATABASE_URL, constructed synchronously.
async function resolveDatabase() {
	if (usingSandbox) {
		// Built from the project's own migrations. A failure here throws before
		// the socket is opened, so the process exits with a named cause instead
		// of answering 500 on the first request.
		sandbox = await createSandboxDatabaseOrThrow();
		return sandbox.pool;
	}
	// Neon connections use SSL. The connection string carries sslmode=require,
	// so SSL is negotiated and verified through Node's default CA store. The SSL
	// option is passed explicitly as `true` to make the intent unambiguous: the
	// connection is encrypted and the server certificate is validated, never
	// downgraded to a blind trust. Keep the connection string in the environment.
	return new Pool({
		connectionString: DATABASE_URL,
		ssl: true,
	});
}

function registerRoutes(database) {
	app.set("trust proxy", 1);
	app.use(cors({
		origin(origin, callback) {
			return callback(null, isOriginAllowed(origin));
		},
		// PATCH and DELETE are required by the owner product endpoints (edit,
		// hide/unpublish, delete). Without them the browser preflight fails and
		// those operations cannot work from the frontend at all.
		methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token"],
		credentials: true,
	}));
	// Product photo uploads carry a base64 image, which is ~33% larger than the
	// file itself, so the general 32kb body limit rejects them with
	// "The request is too large" before the route is ever reached.
	//
	// This dedicated parser runs FIRST for that one path and sets its own limit.
	// Express records that the body was already parsed, so the general parser
	// below skips it: every other route keeps its tight limit, and only the upload
	// endpoint accepts a larger body. The route still enforces the real 5MB
	// decoded size, so a larger body limit is not an unbounded acceptance.
	const imageBodyLimit = (process.env.PRODUCT_IMAGE_BODY_LIMIT || "8mb").trim();

	// The upload path accepts a large body, so it is guarded BEFORE the body is
	// read. An unauthenticated caller must not be able to make the server
	// buffer megabytes: the origin and the presence of a session cookie are
	// checked here, and the full session and CSRF validation still happens in
	// the route itself.
	app.use("/api/owner/product-images", (req, res, next) => {
		if (req.method !== "POST") return next();
		const origin = req.get("Origin");
		if (!origin || !isOriginAllowed(origin)) {
			return res.status(403).json({
				error: "This request origin is not allowed.",
				code: "ORIGIN_NOT_ALLOWED",
			});
		}
		if (!hasSessionCookie(req.get("Cookie"))) {
			return res.status(401).json({
				error: "An owner session is required.",
				code: "OWNER_SESSION_REQUIRED",
			});
		}
		const contentLength = Number(req.get("Content-Length") || 0);
		if (Number.isFinite(contentLength) && contentLength > bodyLimitBytes(imageBodyLimit)) {
			return res.status(413).json({
				error: "The image is too large.",
				code: "IMAGE_TOO_LARGE",
			});
		}
		next();
	});

	app.use("/api/owner/product-images", express.json({ limit: imageBodyLimit }));

	app.use(express.json({ limit: "32kb" }));

	// Basic check that the backend is running.
	app.get("/", (req, res) => {
		res.send("MARIDEL'S STORE backend is running!");
	});

	// Public product endpoints live in their own module so server.js, the order
	// router and the tests all share one implementation of the visibility filter.
	mountPublicProductRoutes(app, database);

	// Uploaded product photos are served from the database, so they survive a
	// redeploy. The file name is validated against the same pattern the storage
	// table enforces, and the content type comes from the row, never from the
	// request, so a stored file can never be served as something else.
	app.get("/product-images/products/:file", async (req, res, next) => {
		try {
			const name = String(req.params.file || "");
			if (!/^[a-f0-9]{32}\.(png|jpg|webp|gif|avif)$/.test(name)) {
				return res.status(404).json({ error: "Product image not found", code: "IMAGE_NOT_FOUND" });
			}
			const result = await database.query(
				"SELECT mime, data FROM product_images WHERE name = $1",
				[name],
			);
			if (result.rows.length === 0) {
				return res.status(404).json({ error: "Product image not found", code: "IMAGE_NOT_FOUND" });
			}
			const row = result.rows[0];
			res.set("Content-Type", String(row.mime || "application/octet-stream"));
			res.set("X-Content-Type-Options", "nosniff");
			res.set("Content-Disposition", "inline");
			// The name never changes, so the bytes may be cached for a year.
			res.set("Cache-Control", "public, max-age=31536000, immutable");
			return res.send(Buffer.from(row.data));
		} catch (error) {
			next(error);
		}
	});

	orderRouter = createOrderRouter(database, {
		allowedOrigins: [...allowedOrigins],
		// The same checker the CORS middleware above uses. See order-routes.js:
		// passing it is what stops the route guard from disagreeing with CORS.
		isOriginAllowed,
		// Password-reset email delivery. Built only when every Resend variable is
		// present; otherwise it stays null and the reset request route answers
		// generically without issuing a token, which is the fail-closed behaviour.
		// The token is never logged and the reset link is built from the
		// configured base URL, never from the request Host header.
		ownerResetDeliver: createResendDelivery({
			apiKey: process.env.RESEND_API_KEY,
			fromEmail: process.env.OWNER_RESET_FROM_EMAIL,
			toEmail: process.env.OWNER_CONTACT_EMAIL,
			baseUrl: process.env.OWNER_RESET_BASE_URL,
		}),
	});
	app.use("/api", orderRouter);

	// Return a clear response for routes that do not exist.
	app.use((req, res) => {
		res.status(404).json({ error: "Route not found" });
	});

	// Handle errors raised by API routes without exposing database details to clients.
	app.use(createApiErrorHandler());
}

// Diagnostics printed once the socket is open. Async because the credential
// source has to be read from the database to be accurate.
async function logStartup() {
	// Diagnostics first, the ready signal last. A supervisor that watches for
	// "running on port" should see the configuration lines already written, so
	// the first thing in the log after that is a complete description.
	if (usingSandbox) {
		const described = sandbox.describe();
		console.log(`Database: ${described.engine}, ${described.migrationsApplied} migration(s) applied.`);
		console.log("This is the local sandbox. It is isolated: nothing here is production data.");
	} else {
		console.log("Database: DATABASE_URL (the configured connection string).");
	}

	for (const line of startupNoticeLines({
		passwordHash: process.env.OWNER_PASSWORD_HASH,
		sessionSecret: process.env.OWNER_SESSION_SECRET,
	})) {
		console.log(line);
	}
	const ownerConfigured = isOwnerAuthConfigured({
		passwordHash: process.env.OWNER_PASSWORD_HASH,
		sessionSecret: process.env.OWNER_SESSION_SECRET,
	});
	if (!ownerConfigured) {
		console.warn("Owner dashboard login is unavailable until that is fixed.");
	}

	// Which credential the login route will actually use, and whether it rotated
	// since this process started. This is the line that answers "why is my new
	// password rejected?" without exposing any value.
	try {
		const credential = await orderRouter.describeOwnerCredentialSource();
		console.log(`Owner credential source: ${credential.source}${credential.usable ? "" : " (unusable)"}.`);
		if (credential.changedSinceStartup) {
			console.warn("OWNER_PASSWORD_HASH changed after this process started. Restart the backend so login uses the current value.");
		}
	} catch {
		console.warn("Owner credential source could not be determined.");
	}

	// Password reset is a separate capability. Reporting it means a deployment
	// that "works" but cannot send a reset link is visible without the owner
	// having to discover it by requesting a reset.
	const emailState = describeEmailConfig({
		apiKey: process.env.RESEND_API_KEY,
		fromEmail: process.env.OWNER_RESET_FROM_EMAIL,
		toEmail: process.env.OWNER_CONTACT_EMAIL,
		baseUrl: process.env.OWNER_RESET_BASE_URL,
	});
	console.log(`Owner password reset by email: ${emailState === "valid" ? "configured" : "not configured"}.`);
	if (emailState !== "valid") {
		console.log("  Reset requests will be accepted generically and no link can be sent.");
	}

	console.log(`MARIDEL'S STORE backend is running on port ${PORT}`);
}

async function start() {
	const database = await resolveDatabase();
	registerRoutes(database);
	app.listen(PORT, logStartup);
	return app;
}

if (require.main === module) {
	start().catch(error => {
		// Name the cause rather than dumping a stack trace that hides it.
		console.error(`MARIDEL'S STORE backend failed to start: ${error && error.message ? error.message : error}`);
		process.exitCode = 1;
	});
}
