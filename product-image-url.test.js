"use strict";
// Regression tests for the image URL rule that lets an uploaded photo be saved.
//
// THE BUG THESE GUARD AGAINST
//   The upload endpoint stores the file and returns /product-images/..., but
//   validateImageUrl only accepted absolute http(s) URLs. Saving a product with an
//   uploaded photo therefore failed with "Use a full image URL starting with
//   https://" — the upload worked and the product could not use it. The two halves
//   did not connect.
//
//   The rule now accepts a same-origin upload path in the exact shape the upload
//   endpoint generates, and still refuses a relative path that is not one.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateImageUrl } = require("./product-admin");

const UPLOADED = "/product-images/products/663b99ee77dc18159001e867ef17e921.png";

test("an uploaded image path is accepted", () => {
	const result = validateImageUrl(UPLOADED);
	assert.equal(result.valid, true, JSON.stringify(result));
	assert.equal(result.value, UPLOADED);
});

test("every supported uploaded extension is accepted", () => {
	for (const ext of ["png", "jpg", "jpeg", "webp", "gif", "avif"]) {
		const value = `/product-images/products/${"a".repeat(32)}.${ext}`;
		assert.equal(validateImageUrl(value).valid, true, ext);
	}
});

test("a relative path that is not an uploaded image is refused", () => {
	// A plain relative path has no origin, so it cannot be trusted to resolve to
	// this host; only the upload prefix is accepted.
	for (const bad of [
		"/images/product.png",
		"/product-images/etc/passwd",
		"/product-images/products/",
		"/product-images/products/x.png",
		"/product-images/products/" + "a".repeat(200) + ".png",
		"/product-images/../owner-dashboard.html",
		"product-images/products/" + "a".repeat(32) + ".png",
		"/product-images/products/" + "a".repeat(32) + ".php",
	]) {
		assert.equal(validateImageUrl(bad).valid, false, `must be refused: ${bad}`);
	}
});

test("absolute image URLs keep working exactly as before", () => {
	assert.equal(validateImageUrl("https://example.com/a.png").valid, true);
	assert.equal(validateImageUrl("http://example.com/a.png").valid, true);
	// The existing refusals are unchanged.
	for (const bad of [
		"javascript:alert(1)",
		"data:image/png;base64,AAAA",
		"ftp://example.com/a.png",
		"//example.com/a.png",
		"https://nodot",
		"",
		null,
		undefined,
	]) {
		assert.equal(validateImageUrl(bad).valid === false || validateImageUrl(bad).value === null, true,
			`must not be accepted as an image URL: ${JSON.stringify(bad)}`);
	}
});

test("a product can be saved with an uploaded image", () => {
	// The end-to-end shape: upload returns a path, that path survives validation,
	// and the payload is normalised unchanged.
	const { normalizeProductPayload } = require("./product-admin");
	const result = normalizeProductPayload({
		name: "Uploaded Product", price: "9.99", stock: "3", image: UPLOADED,
	});
	assert.equal(result.valid, true, JSON.stringify(result));
	assert.equal(result.value.image, UPLOADED);
});

// --- the form-validity bug ----------------------------------------------------
//
// THE BUG THESE GUARD AGAINST
//   The image field was <input type="url">. A browser treats a relative value as
//   a type mismatch on that input, and constraint validation then blocks the whole
//   form's submit event — silently, with no error shown anywhere. Editing a
//   product whose image had been uploaded therefore did nothing at all: no
//   request, no message. The field must accept the app's own uploaded paths,
//   because the server validates the value anyway.

test("the product photo form has no URL input left to type into", () => {
	// The URL field was removed, so the only way to set a photo is the file
	// picker. Nothing in the form may reintroduce a text image field, which would
	// both bypass validation and reintroduce the type="url" submit block.
	const fs = require("node:fs");
	const path = require("node:path");
	const html = fs.readFileSync(path.join(__dirname, "owner-dashboard.html"), "utf8");
	assert.ok(!/id="productImage"/.test(html), "the URL input must be removed");
	assert.ok(!/Or paste an image URL/.test(html), "its label must be removed too");
	assert.match(html, /<input[^>]+type="file"[^>]+id="productImageFile"/, "the file picker must remain");
	assert.match(html, /id="productImagePreview"/, "the preview must remain");
});

test("no url-typed input can hold an uploaded path", () => {
	// A type="url" input holding a relative upload path blocks the form's submit
	// event silently, which is how editing broke. This guards the class.
	const fs = require("node:fs");
	const path = require("node:path");
	const html = fs.readFileSync(path.join(__dirname, "owner-dashboard.html"), "utf8");
	const urlInputs = [...html.matchAll(/<input[^>]+type="url"[^>]*>/g)].map(m => m[0]);
	for (const input of urlInputs) {
		const id = /id="([^"]+)"/.exec(input);
		assert.ok(!id || !/image/i.test(id[1]),
			`an image field must not be type=url: ${input.slice(0, 80)}`);
	}
});

test("the form is submitted by a real submit event, not a blocked one", () => {
	// The dashboard must not rely on the browser allowing submit: it listens for
	// the submit event, so any constraint that blocks it stops the request silently.
	const fs = require("node:fs");
	const path = require("node:path");
	const script = fs.readFileSync(path.join(__dirname, "owner-dashboard.js"), "utf8");
	assert.match(script, /productForm\.addEventListener\("submit"/, "the handler listens for submit");
	// The form must not opt out of validation wholesale either: required name and
	// price are what keep the server from seeing an empty product.
	const fs2 = require("node:fs");
	const html = fs2.readFileSync(path.join(__dirname, "owner-dashboard.html"), "utf8");
	assert.doesNotMatch(html, /<form[^>]+id="productForm"[^>]*novalidate/,
		"the form must keep native validation for name and price");
});

