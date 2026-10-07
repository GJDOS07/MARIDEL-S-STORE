require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
	throw new Error("DATABASE_URL is not set. Add your Neon connection string as an environment variable.");
}

// Neon connections use SSL. Keep the connection string in the environment, not in this file.
const pool = new Pool({
	connectionString: DATABASE_URL,
	ssl: { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());

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

// Return a clear response for routes that do not exist.
app.use((req, res) => {
	res.status(404).json({ error: "Route not found" });
});

// Handle errors raised by API routes without exposing database details to clients.
app.use((error, req, res, next) => {
	console.error("API error:", error);
	res.status(500).json({ error: "An internal server error occurred" });
});

app.listen(PORT, () => {
	console.log(`MARIDEL'S STORE backend is running on port ${PORT}`);
});
