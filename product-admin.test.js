"use strict";
// Unit tests for product-admin.js: price/stock validation, image URL and
// upload validation, safe storage names, payload normalisation and search.
// All pure functions; no database, no production access.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	validatePrice,
	priceToCents,
	validateStock,
	validateImageUrl,
	validateUploadedImage,
	safeStorageName,
	normalizeProductPayload,
	normalizeProductSearch,
	filterProducts,
	PRICE_PATTERN,
	SUPPORTED_IMAGE_EXTENSIONS,
	MAX_IMAGE_BYTES,
	MAX_STOCK,
} = require("./product-admin");

// --- price validation -------------------------------------------------------

test("accepts the AUD price formats the checkout already handles", () => {
	for (const value of ["2", "2.5", "2.50", "12.00", "0.01", 1.5, 3]) {
		assert.equal(validatePrice(value).valid, true, `price ${value} should be accepted`);
	}
});

test("rejects prices that are zero, negative or non-numeric", () => {
	for (const value of ["0", "-1", "0.00", "abc", "", " ", "1.234", null, undefined, {}, true, Number.NaN, -5]) {
		assert.equal(validatePrice(value).valid, false, `price ${JSON.stringify(value)} should be rejected`);
	}
});

test("rejects a price above the supported range", () => {
	const result = validatePrice("999999999.99");
	assert.equal(result.valid, false);
	assert.match(result.error, /too large/i);
});

test("priceToCents converts without floating-point drift", () => {
	assert.equal(priceToCents("0.07"), 7);
	assert.equal(priceToCents("0.29"), 29);
	assert.equal(priceToCents("55.00"), 5500);
	assert.equal(priceToCents("110.00"), 11000);
	// The exact case a naive Number()*100 would get wrong.
	assert.equal(priceToCents("8.19"), 819);
	assert.equal(priceToCents("bad"), null);
});

test("the price pattern rejects more than two decimal places", () => {
	assert.ok(PRICE_PATTERN.test("2.50"));
	assert.ok(!PRICE_PATTERN.test("2.501"));
	assert.ok(!PRICE_PATTERN.test(".50"));
	assert.ok(!PRICE_PATTERN.test("2."));
});

// --- stock validation -------------------------------------------------------

test("stock defaults to 0 and accepts whole non-negative numbers", () => {
	assert.deepEqual(validateStock(undefined), { valid: true, value: 0 });
	assert.deepEqual(validateStock(null), { valid: true, value: 0 });
	assert.deepEqual(validateStock(""), { valid: true, value: 0 });
	assert.deepEqual(validateStock("12"), { valid: true, value: 12 });
	assert.deepEqual(validateStock(0), { valid: true, value: 0 });
	assert.deepEqual(validateStock(" 5 "), { valid: true, value: 5 });
});

test("stock rejects negative, fractional and non-numeric values", () => {
	for (const value of [-1, -0.5, "1.5", "abc", Number.NaN, {}, true]) {
		assert.equal(validateStock(value).valid, false, `stock ${JSON.stringify(value)} should be rejected`);
	}
	assert.match(validateStock(-1).error, /whole number/i);
});

test("stock rejects an implausibly large value", () => {
	assert.equal(validateStock(MAX_STOCK).valid, true);
	assert.equal(validateStock(MAX_STOCK + 1).valid, false);
});

// --- image URL validation ---------------------------------------------------

test("accepts http and https image URLs", () => {
	for (const url of [
		"https://example.com/p.jpg",
		"http://example.com/p.png",
		"https://cdn.example.com/a/b/product-1.webp?v=2",
	]) {
		const result = validateImageUrl(url);
		assert.equal(result.valid, true, `URL ${url} should be accepted`);
		assert.equal(result.value, url);
	}
});

test("an empty or absent image clears the field", () => {
	assert.deepEqual(validateImageUrl(null), { valid: true, value: null });
	assert.deepEqual(validateImageUrl(undefined), { valid: true, value: null });
	assert.deepEqual(validateImageUrl("   "), { valid: true, value: null });
});

test("rejects image URLs that are not absolute http(s) links", () => {
	const dangerous = [
		"javascript:alert('x')",
		"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
		"file:///etc/passwd",
		"//example.com/p.jpg",
		"example.com/p.jpg",
		"/images/p.jpg",
		"not a url at all",
		// hostname with no dot, so it cannot be a real public host
		"https://localhost",
		"https://intranet/p.jpg",
	];
	for (const url of dangerous) {
		assert.equal(validateImageUrl(url).valid, false, `URL ${url} should be refused`);
	}
});

test("rejects an over-long image URL", () => {
	const long = `https://example.com/${"a".repeat(2100)}.jpg`;
	assert.equal(validateImageUrl(long).valid, false);
});

test("rejects a non-string image value", () => {
	assert.equal(validateImageUrl(42).valid, false);
	assert.equal(validateImageUrl({}).valid, false);
});

// --- upload validation ------------------------------------------------------

test("accepts supported image files", () => {
	const ok = [
		{ filename: "product.jpg", mimetype: "image/jpeg", size: 1024 },
		{ filename: "product.PNG", mimetype: "image/png", size: 1024 },
		{ filename: "photo.webp", mimetype: "image/webp" },
		{ filename: "pic.gif", mimetype: "image/gif", size: 1 },
	];
	for (const file of ok) {
		assert.equal(validateUploadedImage(file).valid, true, `${file.filename} should be accepted`);
	}
});

test("rejects unsupported and executable file types on upload", () => {
	for (const file of [
		{ filename: "evil.js", mimetype: "application/javascript" },
		{ filename: "payload.exe", mimetype: "application/octet-stream" },
		{ filename: "noextension" },
		{ filename: "" },
		{},
	]) {
		assert.equal(validateUploadedImage(file).valid, false, `${file.filename} should be rejected`);
	}
});

test("rejects an oversized image", () => {
	const result = validateUploadedImage({ filename: "big.jpg", mimetype: "image/jpeg", size: MAX_IMAGE_BYTES + 1 });
	assert.equal(result.valid, false);
	assert.match(result.error, /5 MB/i);
});

test("accepts exactly the maximum image size", () => {
	assert.equal(validateUploadedImage({ filename: "ok.jpg", mimetype: "image/jpeg", size: MAX_IMAGE_BYTES }).valid, true);
});

test("every supported extension round-trips through upload validation", () => {
	for (const ext of SUPPORTED_IMAGE_EXTENSIONS) {
		assert.equal(validateUploadedImage({ filename: `x${ext}` }).valid, true, `${ext} should be supported`);
	}
});

// --- safe storage names -----------------------------------------------------

test("storage names never contain the uploaded filename", () => {
	const name = safeStorageName("../../etc/evil photo.jpg");
	assert.ok(name.startsWith("products/"));
	assert.ok(name.endsWith(".jpg"));
	assert.ok(!/evil/i.test(name), "the original filename must not appear");
	assert.ok(!/\.\./.test(name), "path traversal must be stripped");
});

test("storage names are unique per call", () => {
	const a = safeStorageName("a.jpg");
	const b = safeStorageName("a.jpg");
	assert.notEqual(a, b);
});

test("storage names are refused for files without a safe extension", () => {
	assert.equal(safeStorageName("noext"), null);
	assert.equal(safeStorageName(""), null);
	assert.equal(safeStorageName(null), null);
});

// --- payload normalisation --------------------------------------------------

test("normalizes a complete create payload to exactly the product columns", () => {
	const result = normalizeProductPayload({
		name: "  Pocari   Sweat   330ml ",
		category: "  Drinks ",
		price: "2.50",
		original_price: "3.00",
		stock: "12",
		image: "https://example.com/p.jpg",
		description: "  Ion supply drink. ",
	});
	assert.equal(result.valid, true);
	assert.deepEqual(result.value, {
		name: "Pocari Sweat 330ml",
		category: "Drinks",
		price: "2.50",
		original_price: "3.00",
		stock: 12,
		image: "https://example.com/p.jpg",
		description: "Ion supply drink.",
	});
});

test("drops unknown fields instead of passing them to SQL", () => {
	const result = normalizeProductPayload({
		name: "X",
		price: "1.00",
		is_admin: true,
		password: "secret",
		id: 99,
	});
	assert.equal(result.valid, true);
	// Only real product columns survive; injected fields are dropped.
	assert.deepEqual(Object.keys(result.value).sort(), ["category", "description", "image", "name", "price", "stock"]);
	for (const forbidden of ["is_admin", "password", "id"]) {
		assert.ok(!(forbidden in result.value), `${forbidden} must not reach the payload`);
	}
});

test("a create payload requires a name and a price", () => {
	assert.equal(normalizeProductPayload({ price: "1.00" }).valid, false);
	assert.equal(normalizeProductPayload({ name: "X" }).valid, false);
	assert.equal(normalizeProductPayload({}).valid, false);
	assert.equal(normalizeProductPayload(null).valid, false);
	assert.equal(normalizeProductPayload([1, 2]).valid, false);
});

test("a partial update only carries the fields supplied", () => {
	const result = normalizeProductPayload({ price: "3.75" }, { partial: true });
	assert.equal(result.valid, true);
	assert.deepEqual(result.value, { price: "3.75" });
	assert.ok(!("name" in result.value), "a partial update must not invent a name");
});

test("a partial update rejecting an empty body", () => {
	const result = normalizeProductPayload({}, { partial: true });
	assert.equal(result.valid, true);
	assert.deepEqual(result.value, {});
});

test("an empty string clears the compare-at price and the image", () => {
	const result = normalizeProductPayload({ original_price: "", image: "" }, { partial: true });
	assert.equal(result.valid, true);
	assert.deepEqual(result.value, { original_price: null, image: null });
});

test("a compare-at price must be higher than the price", () => {
	const bad = normalizeProductPayload({ name: "X", price: "5.00", original_price: "4.00" });
	assert.equal(bad.valid, false);
	assert.match(bad.error, /higher/i);

	const equal = normalizeProductPayload({ name: "X", price: "5.00", original_price: "5.00" });
	assert.equal(equal.valid, false);

	const good = normalizeProductPayload({ name: "X", price: "5.00", original_price: "5.01" });
	assert.equal(good.valid, true);
});

test("normalises long names, categories and descriptions to their caps", () => {
	const result = normalizeProductPayload({
		name: "n".repeat(500),
		category: "c".repeat(500),
		description: "d".repeat(5000),
		price: "1.00",
	});
	assert.equal(result.valid, true);
	assert.equal(result.value.name.length, 200);
	assert.equal(result.value.category.length, 100);
	assert.equal(result.value.description.length, 2000);
});

test("collapses internal whitespace so the storefront renders one line", () => {
	const result = normalizeProductPayload({ name: "\tSauce\n\n Drum  ", price: "1.00" });
	assert.equal(result.valid, true);
	assert.equal(result.value.name, "Sauce Drum");
});

// --- search and filter ------------------------------------------------------

test("search matches name, category and description case-insensitively", () => {
	const products = [
		{ id: 1, name: "Pocari Sweat 330ml", category: "Drinks", description: "Ion supply drink." },
		{ id: 2, name: "Jufran Banana Sauce", category: "Sauces", description: "Banana ketchup." },
	];
	assert.deepEqual(filterProducts(products, { search: "pocari" }).map(p => p.id), [1]);
	assert.deepEqual(filterProducts(products, { search: "POCARI" }).map(p => p.id), [1]);
	assert.deepEqual(filterProducts(products, { search: "sauces" }).map(p => p.id), [2]);
	assert.deepEqual(filterProducts(products, { search: "ketchup" }).map(p => p.id), [2]);
	assert.deepEqual(filterProducts(products, { search: "" }).map(p => p.id), [1, 2]);
});

test("category filter is exact and case-insensitive", () => {
	const products = [
		{ id: 1, name: "A", category: "Drinks" },
		{ id: 2, name: "B", category: "Sauces" },
		{ id: 3, name: "C", category: "drinks" },
	];
	assert.deepEqual(filterProducts(products, { category: "Drinks" }).map(p => p.id), [1, 3]);
	assert.deepEqual(filterProducts(products, { category: "drinks" }).map(p => p.id), [1, 3]);
	assert.deepEqual(filterProducts(products, { category: "snacks" }).map(p => p.id), []);
});

test("search and category filter combine, and an empty query returns everything", () => {
	const products = [
		{ id: 1, name: "Pocari Sweat", category: "Drinks" },
		{ id: 2, name: "Pocari Sauce", category: "Sauces" },
	];
	assert.deepEqual(filterProducts(products, { search: "pocari", category: "Drinks" }).map(p => p.id), [1]);
	assert.deepEqual(filterProducts(products, {}).map(p => p.id), [1, 2]);
	assert.deepEqual(filterProducts(products).map(p => p.id), [1, 2]);
});

test("normalizeProductSearch trims, collapses and bounds the input", () => {
	assert.equal(normalizeProductSearch("  Pocari   Sweat  "), "pocari sweat");
	assert.equal(normalizeProductSearch("A".repeat(200)).length, 100);
	assert.equal(normalizeProductSearch(null), "");
	assert.equal(normalizeProductSearch(42), "");
});

test("filterProducts tolerates a missing or empty list", () => {
	assert.deepEqual(filterProducts(null, { search: "x" }), []);
	assert.deepEqual(filterProducts(undefined), []);
	assert.deepEqual(filterProducts([]), []);
});

test("filterProducts does not throw on products missing fields", () => {
	assert.deepEqual(filterProducts([{ id: 1 }, { id: 2, name: "ok" }], { search: "ok" }).map(p => p.id), [2]);
});
