"use strict";
// Public product endpoints and the shared capability check they depend on.
//
// products.is_published only exists once owner-account-and-products.sql has
// been applied. Every reader therefore asks first, so a database without the
// column keeps serving exactly what it served before: no missing-column error,
// no change in behaviour. Server.js, the order router and the integration
// tests all call this one implementation, so the public listing, the single
// product read and the checkout guard can never drift apart.

const VISIBILITY_COLUMN_QUERY =
	"SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='is_published'";

// Vertical stock column. Stock only exists once stock-migration.sql has been
// applied, and until then the column simply is not selected: an old database
// keeps serving exactly the catalogue it served before. Every reader of the
// products table asks the same two capability questions, so the public listing,
// the single product read and the checkout guard can never drift apart.
const STOCK_COLUMN_QUERY =
	"SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='stock'";

// When the column exists a NULL or absent stock is reported as zero: the
// storefront always reads an integer and shows the honest state of the shelf.
const STOCK_COLUMN = "COALESCE(stock, 0) AS stock";

// The columns the public catalogue exposes. SELECT * is not used: it would
// hand out every column the table happens to carry, including ones added
// later for internal use.
const PUBLIC_PRODUCT_COLUMNS = "id, name, category, price, original_price, image, description";

// The visibility column is only selected when the database actually has it,
// so the same query keeps working before the migration.
const VISIBILITY_COLUMN = "is_published";

// Once a target has been seen to have the visibility column, that answer is
// cached for the life of the process. A later check that errors must not flip
// it back to "unsupported": the column was seen, so it is still there.
// WeakMap keyed by the pool (or transaction client) it was asked about, so a
// finished client is collected with the rest of its request.
const visibilitySupportByTarget = new WeakMap();

// True when products.is_published exists. Never throws: a database that cannot
// answer the capability question is treated as not supporting visibility, which
// is the pre-migration behaviour.
async function productVisibilitySupported(target) {
	if (!target || typeof target.query !== "function") return false;
	const cached = visibilitySupportByTarget.get(target);
	if (cached !== undefined) return cached;

	let supported = false;
	try {
		const row = await target.query(VISIBILITY_COLUMN_QUERY);
		supported = row.rows[0].n === 1;
	} catch {
		supported = false;
	}
	// Only a positive answer is remembered. Before the column has ever been
	// seen the check runs again on the next call, exactly as it always did.
	if (supported) visibilitySupportByTarget.set(target, true);
	return supported;
}

// Same caching rule for stock: once a positive answer is seen it is
// remembered for the life of the process and can never flip back.
const stockSupportByTarget = new WeakMap();

// True when products.stock exists. Never throws: a database that cannot answer
// the capability question is treated as not supporting stock, which is the
// pre-migration behaviour.
async function productStockSupported(target) {
	if (!target || typeof target.query !== "function") return false;
	const cached = stockSupportByTarget.get(target);
	if (cached !== undefined) return cached;

	let supported = false;
	try {
		const row = await target.query(STOCK_COLUMN_QUERY);
		supported = row.rows[0].n === 1;
	} catch {
		supported = false;
	}
	if (supported) stockSupportByTarget.set(target, true);
	return supported;
}

// The public column list for a given pair of capability answers.
function publicProductColumns(visibilitySupported, stockSupported = false) {
	const extras = [
		visibilitySupported ? VISIBILITY_COLUMN : "",
		stockSupported ? STOCK_COLUMN : "",
	].filter(Boolean);
	return extras.length ? `${PUBLIC_PRODUCT_COLUMNS}, ${extras.join(", ")}` : PUBLIC_PRODUCT_COLUMNS;
}

// A product id is a positive integer inside the PostgreSQL integer range.
// Anything else is answered with the same 404 as an unknown product, without
// querying the database at all.
const POSTGRES_INTEGER_MAX = 2147483647;

function parseProductId(rawId) {
	const value = String(rawId === undefined || rawId === null ? "" : rawId).trim();
	if (!/^\d+$/.test(value)) return null;
	const productId = Number(value);
	if (!Number.isSafeInteger(productId) || productId < 1 || productId > POSTGRES_INTEGER_MAX) return null;
	return productId;
}

// Registers GET /api/products and GET /api/products/:id on an Express app.
// Unpublished products are excluded once the column exists; before the
// migration the filter is simply omitted.
function mountPublicProductRoutes(app, pool) {
	app.get("/api/products", async (req, res, next) => {
		try {
			const visibilitySupported = await productVisibilitySupported(pool);
			const stockSupported = await productStockSupported(pool);
			const filter = visibilitySupported ? "WHERE is_published = true" : "";
			// The filter is a fixed literal from the check above, and the product
			// id stays a bound parameter, so nothing user supplied is interpolated.
			const result = await pool.query(
				`SELECT ${publicProductColumns(visibilitySupported, stockSupported)} FROM products ${filter} ORDER BY id`
			);
			res.json(result.rows);
		} catch (error) {
			next(error);
		}
	});

	app.get("/api/products/:id", async (req, res, next) => {
		try {
			const productId = parseProductId(req.params.id);
			if (productId === null) {
				return res.status(404).json({ error: "Product not found" });
			}

			const visibilitySupported = await productVisibilitySupported(pool);
			const stockSupported = await productStockSupported(pool);
			const filter = visibilitySupported ? "AND is_published = true" : "";
			const result = await pool.query(
				`SELECT ${publicProductColumns(visibilitySupported, stockSupported)} FROM products WHERE id = $1 ${filter}`,
				[productId],
			);

			if (result.rows.length === 0) {
				return res.status(404).json({ error: "Product not found" });
			}

			res.json(result.rows[0]);
		} catch (error) {
			next(error);
		}
	});
}

module.exports = { productVisibilitySupported, mountPublicProductRoutes };
