"use strict";
// Regression tests for the upload request-size handling.
//
// THE BUG THESE GUARD AGAINST
//   server.js applied a single global express.json({ limit: "32kb" }). A product
//   photo arrives as base64, which is ~33% larger than the file, so even a modest
//   image blew the limit and the browser saw "The request is too large" before the
//   route ran. Uploads were impossible at any size.
//
//   The fix gives that one path its own larger body limit and leaves the general
//   limit tight everywhere else. The route still enforces the real 5MB decoded
//   size, so a bigger body limit is not an unbounded acceptance.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;

test("the upload path has its own body limit, and others keep the tight one", () => {
	const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const general = /app\.use\(express\.json\(\{ limit: "32kb" \}\)\)/.exec(server);
	assert.ok(general, "the general body limit must remain tight");

	const specific = /app\.use\("\/api\/owner\/product-images", express\.json\(\{ limit: imageBodyLimit \}\)\)/.exec(server);
	assert.ok(specific, "the upload path must have its own parser");

	// The specific parser must be registered FIRST. Express runs middleware in
	// order, so a general parser registered first would reject the body before
	// the specific one ever saw it.
	assert.ok(specific.index < general.index,
		"the upload body limit must be registered before the general one");
});

test("the general limit is still small, so the fix is not an unbounded increase", () => {
	const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const specific = /app\.use\("\/api\/owner\/product-images", express\.json\(\{ limit: (\w+) \}\)\)/.exec(server);
	assert.ok(specific, "the upload parser must exist");
	// 8mb covers a 5MB image as base64 (about 6.7MB) with headroom, and nothing
	// more. It is not "unlimited", and the decoded size is still checked.
	assert.match(server, /PRODUCT_IMAGE_BODY_LIMIT \|\| "8mb"/,
		"the limit is configurable and defaults to 8mb");
	assert.equal(specific[1], "imageBodyLimit", "the limit comes from one named variable");
});

test("the decoded image size is still enforced at 5MB", () => {
	// A larger body limit must not become a larger accepted image: the route
	// decides on the real bytes.
	const routes = fs.readFileSync(path.join(root, "order-routes.js"), "utf8");
	assert.match(routes, /MAX_PRODUCT_IMAGE_BYTES/, "the route must enforce the decoded size limit");
	const store = fs.readFileSync(path.join(root, "product-image-store.js"), "utf8");
	assert.match(store, /MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/, "5MB is the real limit");
});

test("the client downscales before uploading", () => {
	// A phone photo is 3-8 MB, so the upload must be resized in the browser or the
	// request is still too large no matter what the limit says.
	const script = fs.readFileSync(path.join(root, "owner-dashboard.js"), "utf8");
	assert.match(script, /function downscaleImage\(file\)/, "the client must downscale");
	assert.match(script, /MAX_IMAGE_DIMENSION = 1400/, "to a bounded dimension");
	assert.match(script, /IMAGE_QUALITY = 0\.85/, "at a high quality");
	assert.match(script, /canvas\.toBlob/, "using the platform encoder");
	// Never send a bigger result than the original: the point is a smaller payload.
	assert.match(script, /if \(blob\.size >= file\.size\) return file;/, "compression must never grow the file");
});

test("the removed URL field is gone from the product form", () => {
	// The task asked for the URL input to be removed entirely, and every reference
	// to follow, so creating and editing keep working without it.
	const html = fs.readFileSync(path.join(root, "owner-dashboard.html"), "utf8");
	assert.ok(!/id="productImage"/.test(html), "the URL input must be removed");
	assert.ok(!/Or paste an image URL/.test(html), "its label must be removed too");

	const script = fs.readFileSync(path.join(root, "owner-dashboard.js"), "utf8");
	assert.ok(!/getElementById\("productImage"\)/.test(script), "no script may reference it");
	// The image value now comes from either an upload or the existing photo.
	assert.match(script, /image: uploaded \|\| existingImage \|\| null/, "the payload must still carry an image");
});

test("editing without choosing a file preserves the existing image", () => {
	const script = fs.readFileSync(path.join(root, "owner-dashboard.js"), "utf8");
	assert.match(script, /existingImage = product\.image \|\| ""/, "fillProductForm records the current image");
	assert.match(script, /existingImage = ""/, "resetProductForm clears it");
});
