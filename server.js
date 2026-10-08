require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createOrderRouter } = require("./order-routes");
const { melbourneNow } = require("./pickup-time");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const allowedOrigins = new Set([
	"https://gjdos07.github.io",
	"http://localhost:5500",
	"http://127.0.0.1:5500",
	...(process.env.FRONTEND_ORIGINS || "")
		.split(",")
		.map(origin => origin.trim())
		.filter(Boolean),
]);

if (!DATABASE_URL) {
	throw new Error("DATABASE_URL is not set. Add your Neon connection string as an environment variable.");
}

// Neon connections use SSL. Keep the connection string in the environment, not in this file.
const pool = new Pool({
	connectionString: DATABASE_URL,
	ssl: { rejectUnauthorized: false },
});

app.set("trust proxy", 1);
app.use(cors({
	origin(origin, callback) {
		if (!origin || allowedOrigins.has(origin)) return callback(null, true);
		return callback(null, false);
	},
	methods: ["GET", "POST", "PATCH", "OPTIONS"],
	allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-CSRF-Token"],
	credentials: true,
}));
app.use(express.json({ limit: "32kb" }));

// Basic check that the backend is running.
app.get("/", (req, res) => {
	res.send("MARIDEL'S STORE backend is running!");
});

// Return all products stored in the database.
app.get("/api/products", async (req, res, next) => {
	try {
		const result = await pool.query("SELECT * FROM products ORDER BY id");
		res.json(result.rows);
	} catch (error) {
		next(error);
	}
});

// Return one product by its ID. The $1 placeholder keeps the query parameterized.
app.get("/api/products/:id", async (req, res, next) => {
	try {
		const result = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);

		if (result.rows.length === 0) {
			return res.status(404).json({ error: "Product not found" });
		}

		res.json(result.rows[0]);
	} catch (error) {
		next(error);
	}
});

app.get("/api/pickup/availability", (req, res) => {
	const now = melbourneNow(new Date());
	const isOpen = now.minutes >= 7 * 60 && now.minutes < 17 * 60;
	res.set("Cache-Control", "no-store");
	res.json({
		time_zone: "Australia/Melbourne",
		local_date: now.date,
		local_time: `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,
		is_open: isOpen,
		pickup_hours: { opens: "07:00", closes: "17:00" },
	});
});

app.use("/api", createOrderRouter(pool, {
	adminPassword: ADMIN_PASSWORD,
	adminAllowedOrigins: [...allowedOrigins],
}));

// Return a clear response for routes that do not exist.
app.use((req, res) => {
	res.status(404).json({ error: "Route not found" });
});

// Handle errors raised by API routes without exposing database details to clients.
app.use((error, req, res, next) => {
	console.error("API error:", error.code || error.name || "UnknownError");
	if (error.type === "entity.too.large") {
		return res.status(413).json({ error: "The request is too large." });
	}
	if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
		return res.status(400).json({ error: "The request body is not valid JSON." });
	}
	res.status(500).json({ error: "An internal server error occurred" });
});

app.listen(PORT, () => {
	console.log(`MARIDEL'S STORE backend is running on port ${PORT}`);
});
