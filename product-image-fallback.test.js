"use strict";
// Regression tests for the storefront product-image fallback.
//
// THE BUG THESE GUARD AGAINST
//   index.html carried a hand-curated map of third-party image URLs keyed by
//   product name (philvending.com.ph, topgrocer.com, pinoywarehouse.com.au,
//   smmarkets.ph, kitchenangel.com.ph, cdn.shopify.com, static.wixstatic.com,
//   m.media-amazon.com, almerepinoystore.com, sukli.com, tse1.mm.bing.net).
//   Those hosts are outside this project's control: they can go down, change
//   their markup, or serve something the store cannot guarantee. A broken
//   third-party image also triggered a browser retry loop on every page load.
//
// The fix replaces the map with a self-contained inline SVG data URI and adds
// onerror handlers to every <img> so a broken upstream URL falls back to the
// same placeholder without looping.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("the storefront declares a self-contained image placeholder", () => {
	assert.match(html, /const PRODUCT_IMAGE_PLACEHOLDER =/);
	assert.match(html, /data:image\/svg\+xml;utf8,/);
	// The placeholder must be a data URI, never a remote URL.
	assert.doesNotMatch(html, /const PRODUCT_IMAGE_PLACEHOLDER\s*=\s*["']https?:/);
});

test("the placeholder is a valid inline SVG", () => {
	const match = /const PRODUCT_IMAGE_PLACEHOLDER\s*=\s*"([^"]+)"/.exec(html);
	assert.ok(match, "PRODUCT_IMAGE_PLACEHOLDER must be a quoted string literal");
	const uri = match[1];
	assert.ok(uri.startsWith("data:image/svg+xml;utf8,"), "must be a data URI");
	// The SVG body is built via encodeURIComponent() with string concatenation
	// across multiple template literals, so verify the parts that appear in the
	// source rather than decoding the whole value at once.
	const svgBlock = /encodeURIComponent\(\s*([\s\S]*?)\s*\)\s*;/.exec(html);
	assert.ok(svgBlock, "the SVG must be built inside an encodeURIComponent() call");
	const svg = svgBlock[1];
	assert.match(svg, /<svg[^>]*>/, "must contain an <svg> element");
	assert.match(svg, /<rect[^>]*>/, "must contain a <rect> element");
	assert.match(svg, /No image/, "must label the placeholder");
	// The placeholder must not depend on any remote host. The SVG namespace
	// (http://www.w3.org/2000/svg) is a fixed namespace URI, not a remote
	// image source, so it is excluded from the check.
	assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, "the SVG must not reference any remote host");
});

test("the fallback function returns the placeholder", () => {
	assert.match(html, /function fallbackProductImage\(\)\s*\{\s*return PRODUCT_IMAGE_PLACEHOLDER;\s*\}/);
});

test("every <img> in the storefront carries an onerror fallback", () => {
	const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
	assert.ok(imgs.length >= 5, `expected at least 5 <img> tags, found ${imgs.length}`);
	for (const img of imgs) {
		assert.match(img, /onerror="this\.onerror=null;this\.src=PRODUCT_IMAGE_PLACEHOLDER;"/,
			`<img> must fall back to the placeholder on error: ${img.slice(0, 80)}`);
	}
});

test("no third-party image host appears in the fallback map", () => {
	// The old map is gone; the only remaining https:// references must be the
	// Google Fonts preconnects, the render host, and the SVG namespace.
	const imageHosts = [
		"philvending.com.ph",
		"topgrocer.com",
		"pinoywarehouse.com.au",
		"smmarkets.ph",
		"kitchenangel.com.ph",
		"cdn.shopify.com",
		"static.wixstatic.com",
		"m.media-amazon.com",
		"almerepinoystore.com",
		"sukli.com",
		"tse1.mm.bing.net",
	];
	for (const host of imageHosts) {
		assert.doesNotMatch(html, new RegExp(host, "i"), `${host} must not appear in index.html`);
	}
});

test("the fallback map is removed entirely", () => {
	assert.doesNotMatch(html, /const productImageByName\s*=\s*\{/);
	assert.doesNotMatch(html, /normalizeProductName\(product\.name\)/);
});

test("mapApiProduct no longer passes a name to the fallback", () => {
	assert.match(html, /image:\s*apiImage\s*\|\|\s*fallbackProductImage\(\)/);
	assert.doesNotMatch(html, /fallbackProductImage\(\{\s*name:\s*title/);
});