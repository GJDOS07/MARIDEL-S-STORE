"use strict";
// Product-management validation and normalisation for the owner dashboard.
//
// Pure functions in the project's dual-export style (see store-info.js,
// wishlist.js) so both the server and the Node test runner use the same rules.
//
// SECURITY: nothing here touches the database. The key invariants enforced are:
//   * prices are positive AUD amounts matching the app's existing cents model
//   * stock is a non-negative whole number
//   * images must be http(s) URLs only - no local paths, no javascript:, no
//     unrestricted remote-URL fetch
//   * unknown/extra fields are dropped rather than passed through to SQL

const MAX_NAME_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_IMAGE_URL_LENGTH = 2000;
const MAX_STOCK = 1000000;
// The default low-stock threshold the database's column default also uses, so
// the validator, the column and the dashboard never disagree.
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
// AUD amounts the app already accepts: "12", "12.5", "12.50".
const PRICE_PATTERN = /^\d{1,9}(?:\.\d{1,2})?$/;
const MAX_PRICE_CENTS = 100000000;

function normalizeText(value, maxLength) {
	if (typeof value !== "string") return "";
	return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function validatePrice(value) {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) {
			return { valid: false, error: "Enter a price greater than 0." };
		}
		if (value > MAX_PRICE_CENTS / 100) {
			return { valid: false, error: "That price is too large." };
		}
		return { valid: true };
	}
	if (typeof value !== "string") {
		return { valid: false, error: "Enter a price greater than 0." };
	}
	const trimmed = value.trim();
	if (!PRICE_PATTERN.test(trimmed)) {
		return { valid: false, error: "Enter a price like 2.50." };
	}
	const cents = Math.round(Number(trimmed) * 100);
	if (!Number.isSafeInteger(cents) || cents <= 0) {
		return { valid: false, error: "Enter a price greater than 0." };
	}
	if (cents > MAX_PRICE_CENTS) {
		return { valid: false, error: "That price is too large." };
	}
	return { valid: true, cents };
}

function priceToCents(value) {
	const result = validatePrice(value);
	return result.valid ? (result.cents ?? Math.round(Number(String(value).trim()) * 100)) : null;
}

function validateStock(value) {
	if (value === undefined || value === null || value === "") {
		return { valid: true, value: 0 };
	}
	const parsed = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		return { valid: false, error: "Stock must be a whole number of 0 or more." };
	}
	if (parsed > MAX_STOCK) {
		return { valid: false, error: "That stock quantity is too large." };
	}
	return { valid: true, value: parsed };
}

function validateLowStockThreshold(value) {
	if (value === undefined || value === null || value === "") {
		return { valid: true, value: DEFAULT_LOW_STOCK_THRESHOLD };
	}
	const parsed = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		return { valid: false, error: "The low-stock threshold must be a whole number of 0 or more." };
	}
	if (parsed > MAX_STOCK) {
		return { valid: false, error: "That low-stock threshold is too large." };
	}
	return { valid: true, value: parsed };
}

// Images are stored as URLs. Only http(s) is accepted, because the storefront
// renders them directly in an <img src>. Anything else (local file paths,
// javascript:, data: URIs, protocol-relative URLs) is refused.
// The prefix under which this application serves images it uploaded itself.
// An uploaded image is stored by the server and referenced by that path, so it is
// same-origin by construction and needs no scheme or host.
const UPLOADED_IMAGE_PREFIX = "/product-images/";

function validateImageUrl(value) {
	if (value === undefined || value === null) return { valid: true, value: null };
	if (typeof value !== "string") return { valid: false, error: "The image must be a URL." };
	const trimmed = value.trim();
	if (trimmed.length === 0) return { valid: true, value: null };
	if (trimmed.length > MAX_IMAGE_URL_LENGTH) {
		return { valid: false, error: "The image URL is too long." };
	}
	if (/^\/\//.test(trimmed)) {
		return { valid: false, error: "Use a full image URL starting with https://" };
	}
	// An image uploaded through this application. It is a server-generated path, so
	// it cannot point at another origin and is accepted without a scheme or host.
	if (trimmed.startsWith(UPLOADED_IMAGE_PREFIX)) {
		const rest = trimmed.slice(UPLOADED_IMAGE_PREFIX.length);
		// Exactly "products/<random>.<ext>" and nothing that looks like traversal.
		if (!/^products\/[A-Za-z0-9_-]{8,64}\.(png|jpe?g|webp|gif|avif)$/i.test(rest)) {
			return { valid: false, error: "That uploaded image path is not valid." };
		}
		return { valid: true, value: trimmed };
	}
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { valid: false, error: "Use a full image URL starting with https://" };
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { valid: false, error: "Only http and https image URLs are supported." };
	}
	if (!parsed.hostname.includes(".")) {
		return { valid: false, error: "Use a full image URL with a domain name." };
	}
	return { valid: true, value: trimmed };
}

// Allowed image extensions, consistent with what browsers render in <img>.
const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function validateUploadedImage({ filename, mimetype, size }) {
	if (!filename || typeof filename !== "string") {
		return { valid: false, error: "Choose an image file." };
	}
	const ext = (/\.([a-z0-9]+)$/i.exec(filename) || [])[1];
	if (!ext || !SUPPORTED_IMAGE_EXTENSIONS.includes(`.${ext.toLowerCase()}`)) {
		return {
			valid: false,
			error: `Use one of: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}.`,
		};
	}
	const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
	if (mimetype && !allowedTypes.includes(mimetype)) {
		return { valid: false, error: "That file type is not an allowed image." };
	}
	if (typeof size === "number" && size > MAX_IMAGE_BYTES) {
		return { valid: false, error: "Images must be 5 MB or smaller." };
	}
	return { valid: true };
}

// Builds a storage name that never trusts the uploaded filename: a random
// identifier plus the validated extension.
function safeStorageName(filename, randomBytes = 16) {
	const ext = (/\.([a-z0-9]+)$/i.exec(String(filename || "")) || [])[1];
	if (!ext) return null;
	const crypto = require("node:crypto");
	const stem = crypto.randomBytes(randomBytes).toString("hex");
	return `products/${stem}.${ext.toLowerCase()}`;
}

// Normalises a create/update payload into exactly the columns the products
// table has. Anything not listed here is dropped.
function normalizeProductPayload(body, { partial = false, currentImage = undefined } = {}) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { valid: false, error: "Provide product details." };
	}

	const result = {};

	if (!partial || body.name !== undefined) {
		const name = normalizeText(body.name, MAX_NAME_LENGTH);
		if (name.length === 0) return { valid: false, error: "Enter a product name." };
		result.name = name;
	}

	if (!partial || body.price !== undefined) {
		const price = validatePrice(body.price);
		if (!price.valid) return { valid: false, error: price.error };
		// Keep the same cents-rounded text the checkout expects from the DB.
		result.price = (price.cents / 100).toFixed(2);
	}

	if (!partial || body.category !== undefined) {
		result.category = normalizeText(body.category, MAX_CATEGORY_LENGTH) || null;
	}

	if (!partial || body.description !== undefined) {
		result.description = normalizeText(body.description, MAX_DESCRIPTION_LENGTH) || null;
	}

	if (!partial || body.image !== undefined) {
		// An update that echoes the product's stored image back is unchanged by
		// definition: the owner dashboard always sends the existing value along
		// with the rest of the form. Legacy rows keep plain relative paths in
		// this column, which the image validator below would reject, so an
		// exact match of the current value is accepted as-is. Any new or
		// changed value still has to pass the full validation.
		if (currentImage !== undefined && typeof body.image === "string" && body.image === currentImage) {
			result.image = body.image;
		} else {
			const image = validateImageUrl(body.image);
			if (!image.valid) return { valid: false, error: image.error };
			result.image = image.value;
		}
	}

	// The compare-at price is optional. Only touch it when the caller supplied
	// it; a create that omits it must not be rejected for having no value.
	if (body.original_price !== undefined) {
		// A compare-at price is optional; an empty value clears it.
		if (body.original_price === null || body.original_price === "") {
			result.original_price = null;
		} else {
			const original = validatePrice(body.original_price);
			if (!original.valid) return { valid: false, error: "Enter a compare-at price greater than 0." };
			result.original_price = (original.cents / 100).toFixed(2);
		}
	}

	if (!partial || body.stock !== undefined) {
		const stock = validateStock(body.stock);
		if (!stock.valid) return { valid: false, error: stock.error };
		result.stock = stock.value;
	}

	// The low-stock threshold is optional: it is only carried when the caller
	// supplies it, so a database without the column yet (before the stock
	// migration is applied) never receives it and older payloads keep their
	// exact previous shape. An empty value stores the built-in default.
	if (body.low_stock_threshold !== undefined) {
		const threshold = validateLowStockThreshold(body.low_stock_threshold);
		if (!threshold.valid) return { valid: false, error: threshold.error };
		result.low_stock_threshold = threshold.value;
	}

	// A compare-at price below the sale price would render a "discount" that is
	// actually a surcharge.
	if (result.price !== undefined && result.original_price !== undefined
		&& result.original_price !== null) {
		if (Number(result.original_price) <= Number(result.price)) {
			return { valid: false, error: "The compare-at price must be higher than the price." };
		}
	}

	return { valid: true, value: result };
}

function normalizeProductSearch(query) {
	if (typeof query !== "string") return "";
	return query.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 100);
}

function filterProducts(products, { search = "", category = "" } = {}) {
	const needle = normalizeProductSearch(search);
	const cat = normalizeText(category, MAX_CATEGORY_LENGTH).toLowerCase();
	return (products || []).filter(product => {
		if (cat && String(product.category || "").toLowerCase() !== cat) return false;
		if (!needle) return true;
		const haystack = `${product.name || ""} ${product.category || ""} ${product.description || ""}`.toLowerCase();
		return haystack.includes(needle);
	});
}

const api = {
	MAX_NAME_LENGTH,
	MAX_CATEGORY_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_STOCK,
	DEFAULT_LOW_STOCK_THRESHOLD,
	MAX_PRICE_CENTS,
	MAX_IMAGE_BYTES,
	SUPPORTED_IMAGE_EXTENSIONS,
	PRICE_PATTERN,
	validatePrice,
	priceToCents,
	validateStock,
	validateLowStockThreshold,
	validateImageUrl,
	validateUploadedImage,
	safeStorageName,
	normalizeProductPayload,
	normalizeProductSearch,
	filterProducts,
};

if (typeof module === "object" && module.exports) {
	module.exports = api;
} else if (typeof globalThis !== "undefined") {
	globalThis.ProductAdmin = api;
}
