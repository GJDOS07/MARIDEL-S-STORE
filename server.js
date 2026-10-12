require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createOrderRouter } = require("./order-routes");
const { createApiErrorHandler } = require("./api-error-handler");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const configuredOrigins = (process.env.FRONTEND_ORIGINS || "")
	.split(",")
	.map(origin => origin.trim())
	.filter(Boolean);
const defaultOrigins = process.env.NODE_ENV === "production"
	? ["https://gjdos07.github.io"]
	: ["https://gjdos07.github.io", "http://localhost:5500", "http://127.0.0.1:5500"];
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOrigins);

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
		if (!origin) return callback(null, false);
		return callback(null, allowedOrigins.has(origin));
	},
	methods: ["GET", "POST", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token"],
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

app.use("/api", createOrderRouter(pool, { allowedOrigins: [...allowedOrigins] }));

// Return a clear response for routes that do not exist.
app.use((req, res) => {
	res.status(404).json({ error: "Route not found" });
});

// Handle errors raised by API routes without exposing database details to clients.
app.use(createApiErrorHandler());

app.listen(PORT, () => {
	console.log(`MARIDEL'S STORE backend is running on port ${PORT}`);
});
