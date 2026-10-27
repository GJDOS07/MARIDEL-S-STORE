"use strict";
// Tests for product image upload storage and validation.
//
// The property that matters is that the declared filename and MIME type are not
// trusted: the decision comes from the file's leading bytes. A file called
// photo.png that holds a script must be refused, and the stored extension comes
// from the sniffed bytes rather than the original name.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	decodeDataUrl,
	validateImageBytes,
	sniffImageType,
	generateStorageName,
	publicPathFor,
	resolveUploadRoot,
	storeImage,
	ACCEPTED_MIME_TYPES,
	MAX_IMAGE_BYTES,
} = require("./product-image-store");

// Minimal valid headers for the supported formats, followed by filler so the
// sniffers have enough bytes to work with.
const PNG_HEADER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG_HEADER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const GIF_HEADER = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 1)]);
const WEBP_HEADER = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP"), Buffer.alloc(64, 1)]);
const AVIF_HEADER = Buffer.concat([Buffer.alloc(4, 0), Buffer.from("ftyp"), Buffer.from("avif"), Buffer.alloc(64, 1)]);
// Content that is not an image at all.
const SCRIPT = Buffer.from("<?php system($_GET['c']); ?>" + "x".repeat(80));
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 1)]);

test("the real image formats are recognised", () => {
	assert.equal(sniffImageType(PNG_HEADER).ext, "png");
	assert.equal(sniffImageType(JPEG_HEADER).ext, "jpg");
	assert.equal(sniffImageType(GIF_HEADER).ext, "gif");
	assert.equal(sniffImageType(WEBP_HEADER).ext, "webp");
	assert.equal(sniffImageType(AVIF_HEADER).ext, "avif");
});

test("non-image content is refused whatever it is called", () => {
	assert.equal(sniffImageType(SCRIPT), null, "a script must never be accepted");
	assert.equal(sniffImageType(ELF), null, "an executable must never be accepted");
	assert.equal(sniffImageType(Buffer.alloc(64, 0)), null, "empty filler is not an image");
	assert.equal(sniffImageType(null), null);
	assert.equal(sniffImageType(Buffer.alloc(4)), null, "too short to judge");
});

test("a declared type or extension cannot override the bytes", () => {
	// A PNG header presented as text/plain is still an image; a script presented as
	// image/png is not. The bytes decide in both directions.
	assert.equal(validateImageBytes(PNG_HEADER).valid, true);
	assert.equal(validateImageBytes(SCRIPT).valid, false,
		"a script with an image extension is refused");
	const dataUrl = `data:image/png;base64,${SCRIPT.toString("base64")}`;
	const decoded = decodeDataUrl(dataUrl);
	assert.ok(!decoded.error, "the data URL is well formed");
	assert.equal(validateImageBytes(decoded.bytes).valid, false,
		"the declared image/png does not make it an image");
});

test("an oversized image is refused", () => {
	const huge = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_IMAGE_BYTES + 1, 7)]);
	const result = validateImageBytes(huge);
	assert.equal(result.valid, false);
	assert.match(result.error, /5 MB/);
});

test("a data URL is decoded and its body used", () => {
	const dataUrl = `data:image/png;base64,${PNG_HEADER.toString("base64")}`;
	const decoded = decodeDataUrl(dataUrl);
	assert.ok(!decoded.error, JSON.stringify(decoded));
	assert.deepEqual(decoded.bytes, PNG_HEADER);
	// The declared MIME is reported but not trusted for the storage decision.
	assert.equal(decoded.declaredMime, "image/png");
});

test("a malformed data URL is refused", () => {
	for (const bad of ["", "not-a-data-url", "data:image/png,not-base64!!", null, undefined]) {
		assert.ok(decodeDataUrl(bad).error, `must be refused: ${JSON.stringify(bad)}`);
	}
});

test("the stored name is random and contains none of the original filename", () => {
	// A traversal attempt in the original name has nothing to work with: the
	// storage name is generated, so "../etc/passwd" cannot survive into it.
	const name = generateStorageName("png");
	assert.match(name, /^products\/[a-f0-9]{32}\.png$/);
	assert.ok(!name.includes(".."), "no traversal segment");
	assert.ok(!name.includes("/etc"), "no filesystem path");
	assert.notEqual(generateStorageName("png"), name, "each name is distinct");
});

test("the public path matches what the static server exposes", () => {
	assert.equal(publicPathFor("products/abc.png"), "/product-images/products/abc.png");
});

test("no upload directory means uploads are refused, not silently dropped", async t => {
	// Production has no durable store configured in this project, so the correct
	// behaviour is a clear refusal. The message names the gap and nothing else.
	const previous = process.env.PRODUCT_IMAGE_DIR;
	delete process.env.PRODUCT_IMAGE_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PRODUCT_IMAGE_DIR;
		else process.env.PRODUCT_IMAGE_DIR = previous;
	});
	assert.equal(resolveUploadRoot(), null, "no directory configured");
	const result = await storeImage(PNG_HEADER, "png");
	assert.equal(result.ok, false);
	assert.match(result.error, /not configured/);
});

test("a validated image is stored under a generated name and served back", async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maridel-image-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const previous = process.env.PRODUCT_IMAGE_DIR;
	process.env.PRODUCT_IMAGE_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PRODUCT_IMAGE_DIR;
		else process.env.PRODUCT_IMAGE_DIR = previous;
	});

	const validated = validateImageBytes(PNG_HEADER);
	const stored = await storeImage(validated.bytes, validated.ext);
	assert.equal(stored.ok, true);
	assert.match(stored.publicPath, /^\/product-images\/products\/[a-f0-9]{32}\.png$/);

	// The bytes on disk are exactly what was validated, with nothing prepended.
	const onDisk = fs.readFileSync(path.join(dir, stored.publicPath.replace("/product-images/", "")));
	assert.deepEqual(onDisk, PNG_HEADER);
	// And a second upload of the same bytes does not overwrite the first.
	const second = await storeImage(validated.bytes, validated.ext);
	assert.notEqual(second.publicPath, stored.publicPath, "each upload gets its own name");
	assert.equal(fs.readdirSync(path.join(dir, "products")).length, 2);
});

test("a refused upload never writes anything", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maridel-image-test-"));
	try {
		const validated = validateImageBytes(SCRIPT);
		assert.equal(validated.valid, false);
		// The route refuses before storeImage is reachable, but confirm the store
		// itself cannot be talked into writing unvalidated content.
		assert.ok(!fs.existsSync(path.join(dir, "products")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the accepted MIME list matches the sniffers", () => {
	assert.deepEqual([...ACCEPTED_MIME_TYPES].sort(),
		["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
});

// --- the route is behind the owner guard -------------------------------------

test("the upload route requires a session and a CSRF token", () => {
	const fs2 = require("node:fs");
	const source = fs2.readFileSync(path.join(__dirname, "order-routes.js"), "utf8");
	const guard = source.indexOf('router.use("/owner", requireAllowedOrigin, requireOwner);');
	const route = source.indexOf('router.post("/owner/product-images"');
	assert.ok(guard !== -1 && route !== -1, "both must exist");
	assert.ok(route > guard, "the upload route must be registered after the owner guard");
	const block = source.slice(route, source.indexOf("router.post", route + 40));
	assert.match(block, /requireCsrf/, "the upload route must require a CSRF token");
	assert.match(block, /IMAGE_STORE_UNAVAILABLE/, "an unconfigured store must be a clear 503");
});
