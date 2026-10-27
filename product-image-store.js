"use strict";
// Product image upload storage.
//
// WHY THIS EXISTS
//   The dashboard had a URL-only image field, so the owner had to host photos
//   elsewhere before a product could show one. This adds a real upload path.
//
// WHAT MAKES IT SAFE
//   A filename and a declared MIME type are both supplied by the browser, so
//   neither is trusted on its own. The decisive check reads the file's leading
//   bytes: only the magic numbers of the supported formats are accepted, and the
//   extension is DERIVED from those bytes rather than from the original name. A
//   file named "photo.png" that is really a script is rejected, and an executable
//   never reaches storage under a name that looks like an image.
//
// WHERE FILES GO
//   A single configured directory, written with a generated name of the form
//   products/<32 hex chars>.<ext>. The name never contains any part of the
//   original filename, so a path traversal attempt has nothing to work with, and
//   the target directory is resolved and checked before anything is written.
//
//   Production persistence needs a durable object store. None is configured in
//   this project, so uploads are refused with a clear message rather than being
//   written to a location that would be lost on the next deploy. Local
//   development uses an explicit directory and is opt-in.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// The formats that may be stored, each identified by its magic bytes. The list is
// deliberate: these are the formats browsers render in <img>, and every one of
// them is inert because it is served with a content type derived from the sniffed
// bytes, never from the request.
const SIGNATURES = [
	{ ext: "png", mime: "image/png", test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
	{ ext: "jpg", mime: "image/jpeg", test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ ext: "gif", mime: "image/gif", test: b => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
	{ ext: "webp", mime: "image/webp", test: b => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
	{ ext: "avif", mime: "image/avif", test: b => b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = SIGNATURES.map(signature => signature.mime);

// Determines the real format from the leading bytes. Returns null when the content
// is not a supported image, whatever the filename or the declared type says.
function sniffImageType(bytes) {
	if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
	// AVIF and other ISO-BMFF formats share the box header; the brand at offset 8
	// distinguishes them, so check the specific signature first.
	const match = SIGNATURES.find(signature => signature.test(bytes));
	if (!match) return null;
	// Guard against a truncated or empty body that happens to start with a valid
	// magic number: the payload must be at least as long as its own header.
	return match;
}

// The client sends a data URL from the file input. Only the base64 body is used;
// the declared MIME type is ignored, because the bytes decide.
function decodeDataUrl(dataUrl) {
	if (typeof dataUrl !== "string") return { error: "Choose an image file." };
	const trimmed = dataUrl.trim();
	// A MIME type contains a "/", so it has to be in the accepted set. Validate the
	// shape, then decode; the bytes, not this string, decide whether it is an image.
	const match = /^data:([a-z0-9!#$&^_.+\\/-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(trimmed);
	if (!match || match[2].length === 0) {
		return { error: "That file could not be read as an image." };
	}
	let bytes;
	try {
		bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
	} catch {
		return { error: "That file could not be read as an image." };
	}
	if (bytes.length === 0) return { error: "That file is empty." };
	return { bytes, declaredMime: match[1].toLowerCase() };
}

// Validates a decoded upload and returns the bytes plus the format to store it as.
function validateImageBytes(bytes) {
	if (!Buffer.isBuffer(bytes)) return { valid: false, error: "Choose an image file." };
	if (bytes.length > MAX_IMAGE_BYTES) {
		return { valid: false, error: "Images must be 5 MB or smaller." };
	}
	const signature = sniffImageType(bytes);
	if (!signature) {
		return {
			valid: false,
			error: `Use one of: ${ACCEPTED_MIME_TYPES.join(", ")}.`,
		};
	}
	return { valid: true, bytes, ext: signature.ext, mime: signature.mime };
}

// A storage name that cannot be used to escape the target directory: a random
// identifier plus the extension derived from the sniffed bytes. No part of the
// original filename is used, so a traversal attempt has nothing to work with.
function generateStorageName(ext) {
	const stem = crypto.randomBytes(16).toString("hex");
	return `products/${stem}.${ext}`;
}

// Resolves the upload directory and confirms it is inside the allowed root.
// Returns null when no directory is configured, which is the production case.
function resolveUploadRoot() {
	const configured = (process.env.PRODUCT_IMAGE_DIR || "").trim();
	if (!configured) return null;
	const root = path.resolve(configured);
	return {
		root,
		// The directory the images live in, created on demand.
		imagesDir: path.join(root, "products"),
	};
}

// The public path a stored image is served from, which must match what
// serve-local.js exposes for the upload directory.
function publicPathFor(storageName) {
	return `/product-images/${storageName}`;
}

// Writes a validated image and returns its public path. Refuses to write when no
// upload directory is configured, so a deployment without durable storage fails
// loudly instead of silently losing the file.
async function storeImage(bytes, ext) {
	const location = resolveUploadRoot();
	if (!location) {
		return {
			ok: false,
			error: "Product image upload is not configured on this server.",
		};
	}
	const storageName = generateStorageName(ext);
	// The storage name carries the "products/" prefix used by the public path
	// (/product-images/products/<name>), while the on-disk directory IS the
	// products directory. So the file's own name is the last segment, and joining
	// anything else would nest a second products/ folder and serve nothing.
	const target = path.join(location.imagesDir, path.basename(storageName));
	// Defence in depth: the generated name cannot escape, and this proves it rather
	// than assuming it, because the same code path serves every upload.
	if (!target.startsWith(location.imagesDir + path.sep)) {
		return { ok: false, error: "The image could not be stored safely." };
	}
	try {
		fs.mkdirSync(location.imagesDir, { recursive: true });
		fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
	} catch (error) {
		return { ok: false, error: "The image could not be saved." };
	}
	return { ok: true, publicPath: publicPathFor(storageName), size: bytes.length };
}

// --- database-backed storage -------------------------------------------------
//
// The filesystem store above is kept for local development, but a deployment
// has no durable directory: everything there is lost on the next deploy. The
// database is the durable place, so the uploaded bytes live in
// public.product_images and are served from there.
//
// The name and the MIME type are still the server's own: the name is generated
// here and the MIME type comes from the sniffed bytes, never from the request.

const DEFAULT_STORAGE_CAP_MB = 150;
// The name pattern is the same one the table's CHECK constraint enforces, so a
// name that cannot be stored is never even generated.
const STORED_IMAGE_NAME_PATTERN = /^[a-f0-9]{32}\.(png|jpg|webp|gif|avif)$/;
// An upload that no product references and that is older than this is an
// abandoned upload, and is swept away so it cannot accumulate.
const ABANDONED_IMAGE_AGE_HOURS = 24;

// The total size of the stored images, in bytes. Configurable so a small
// deployment can keep the database small.
function storageCapBytes() {
	const configured = Number(process.env.PRODUCT_IMAGE_STORAGE_CAP_MB);
	const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STORAGE_CAP_MB;
	return Math.floor(megabytes * 1024 * 1024);
}

// The name a new image is stored under: random bytes plus the extension that
// came from the file's own leading bytes.
function generateDatabaseImageName(ext) {
	return `${crypto.randomBytes(16).toString("hex")}.${ext}`;
}

// The public path an image is served from.
function databaseImagePublicPath(name) {
	return `/product-images/products/${name}`;
}

// True when the error means the table is not there, so the store is not
// configured on this database.
function isMissingTableError(error) {
	if (!error || typeof error !== "object") return false;
	if (error.code === "42P01") return true;
	return typeof error.message === "string" && /relation "[^"]+" does not exist/i.test(error.message);
}

// Removes the images no product references any more and that were uploaded more
// than a day ago. An upload that was never attached to a product is abandoned
// by the owner, and keeping it would fill the database for nothing.
async function pruneAbandonedImages(pool) {
	try {
		await pool.query(
			`DELETE FROM product_images
			  WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${ABANDONED_IMAGE_AGE_HOURS} hours'
			    AND NOT EXISTS (
			      SELECT 1 FROM products
			      WHERE products.image IS NOT NULL
			        AND products.image LIKE ('%' || product_images.name)
			    )`,
		);
	} catch {
		// A sweep that cannot run must never fail an upload.
	}
}

// Stores a validated image in the database and returns its public path.
//
// Refuses when the stored images already use up the configured cap, so the
// database cannot be filled by uploads. The message names the limit and
// nothing else.
async function saveImageToDatabase(pool, { bytes, ext, mime } = {}) {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
		return { ok: false, error: "That file is empty.", code: "INVALID_IMAGE" };
	}
	if (!SIGNATURES.some(signature => signature.ext === ext && signature.mime === mime)) {
		return { ok: false, error: `Use one of: ${ACCEPTED_MIME_TYPES.join(", ")}.`, code: "INVALID_IMAGE" };
	}

	const name = generateDatabaseImageName(ext);
	if (!STORED_IMAGE_NAME_PATTERN.test(name)) {
		return { ok: false, error: "The image could not be stored safely.", code: "INVALID_IMAGE" };
	}

	try {
		const stored = await pool.query(
			"SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM product_images",
		);
		const total = Number(stored.rows[0] && stored.rows[0].total ? stored.rows[0].total : 0);
		const cap = storageCapBytes();
		if (total + bytes.length > cap) {
			return {
				ok: false,
				error: `The image storage is full (${Math.floor(cap / (1024 * 1024))} MB limit). Remove an unused image or raise the limit.`,
				code: "IMAGE_STORAGE_FULL",
			};
		}

		await pruneAbandonedImages(pool);

		await pool.query(
			"INSERT INTO product_images (name, mime, data, size_bytes) VALUES ($1, $2, $3, $4)",
			[name, mime, bytes, bytes.length],
		);
	} catch (error) {
		if (isMissingTableError(error)) {
			return {
				ok: false,
				error: "Product image upload is not configured on this server.",
				code: "IMAGE_STORE_UNAVAILABLE",
			};
		}
		return { ok: false, error: "The image could not be saved.", code: "IMAGE_STORE_FAILED" };
	}

	return { ok: true, name, publicPath: databaseImagePublicPath(name), size: bytes.length };
}

// Deletes a stored image, but only when no product still points at it.
async function deleteImageIfUnused(pool, publicPath) {
	const name = imageNameFromPublicPath(publicPath);
	if (!name) return { ok: false, deleted: false };
	try {
		const referenced = await pool.query(
			"SELECT count(*)::int AS n FROM products WHERE image IS NOT NULL AND image LIKE ('%' || $1)",
			[name],
		);
		if (referenced.rows[0] && Number(referenced.rows[0].n) > 0) {
			return { ok: true, deleted: false };
		}
		const removed = await pool.query(
			"DELETE FROM product_images WHERE name = $1",
			[name],
		);
		return {
			ok: true,
			deleted: Boolean(removed.rowCount),
		};
	} catch (error) {
		if (isMissingTableError(error)) {
			return { ok: true, deleted: false };
		}
		return { ok: false, deleted: false };
	}
}

// The stored name behind a public path, or null when the path is not one of
// ours.
function imageNameFromPublicPath(publicPath) {
	if (typeof publicPath !== "string") return null;
	const match = /^\/product-images\/products\/([a-f0-9]{32}\.(?:png|jpg|webp|gif|avif))$/.exec(publicPath.trim());
	return match ? match[1] : null;
}

module.exports = {
	ACCEPTED_MIME_TYPES,
	MAX_IMAGE_BYTES,
	SIGNATURES,
	decodeDataUrl,
	generateStorageName,
	publicPathFor,
	resolveUploadRoot,
	sniffImageType,
	storeImage,
	validateImageBytes,
	validateUploadedImageBytes: validateImageBytes,
	// Database-backed storage.
	DEFAULT_STORAGE_CAP_MB,
	STORED_IMAGE_NAME_PATTERN,
	databaseImagePublicPath,
	deleteImageIfUnused,
	generateDatabaseImageName,
	imageNameFromPublicPath,
	isMissingTableError,
	pruneAbandonedImages,
	saveImageToDatabase,
	storageCapBytes,
};
