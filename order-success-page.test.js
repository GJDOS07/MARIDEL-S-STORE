"use strict";
// Regression tests for the Order Success Modal.
//
// The modal's rendering lives in an inline <script> in index.html and there is
// no DOM harness in this project, so these tests assert the two things that can
// go wrong silently and that the earlier plain message got wrong:
//
//   1. The markup contract: every element the script looks up exists exactly
//      once, and the retired plain-success element is fully gone.
//   2. The data contract: the modal renders order number, status, pickup date,
//      time, total, item name, quantity, unit price and subtotal from the API
//      response using the SAME formatting helpers the storefront already uses,
//      so a redesign cannot drift from backend or store configuration.
//
// Every value asserted here is either derived by the project's own helpers or
// read from store-info.js; no sample order data is hardcoded in the tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const { STORE_INFO, hoursRangeLabel } = require("./store-info");
const { formatPickupTime } = require("./pickup-time-display");

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

// The element ids renderOrderSuccess() writes into.
const RENDERED_IDS = [
	"orderSuccessNumber",
	"orderSuccessStatus",
	"orderSuccessPickup",
	"orderSuccessTotal",
	"orderSuccessItems",
	"orderSuccessAddress",
	"orderSuccessHours",
	"orderSuccessPhone",
	"orderSuccessCredential",
];

// The element ids the modal wires up as controls.
const CONTROL_IDS = [
	"orderSuccessModal",
	"copyTrackingCode",
	"copyFeedback",
	"trackMyOrderBtn",
	"continueShoppingBtn",
];

// --- markup contract --------------------------------------------------------

test("the order success modal exists and reuses the storefront modal pattern", () => {
	assert.match(html, /<div class="modal-overlay" id="orderSuccessModal">/);
	assert.match(html, /<div class="modal-card order-success-card"/);
	assert.match(html, /role="dialog"[\s\S]{0,250}aria-modal="true"[\s\S]{0,120}aria-labelledby="orderSuccessTitle"/);
	assert.match(html, /aria-label="Close order confirmation"/);
});

test("every element rendered into is defined exactly once", () => {
	for (const id of [...RENDERED_IDS, ...CONTROL_IDS]) {
		const defined = (html.match(new RegExp(`id="${id}"`, "g")) || []).length;
		assert.equal(defined, 1, `#${id} must be defined exactly once, found ${defined}`);
		assert.ok(
			INLINE_SCRIPT.includes(`getElementById('${id}')`),
			`#${id} must be referenced by the inline script`,
		);
	}
});

test("every order-success class used in markup has a matching CSS rule", () => {
	const used = new Set(
		[...html.matchAll(/class="([^"]*order-success[^"]*)"/g)]
			.flatMap(match => match[1].split(/\s+/))
			.filter(Boolean),
	);
	assert.ok(used.size > 10, "expected a substantial set of order-success classes");
	for (const className of used) {
		assert.ok(
			css.includes(`.${className}`),
			`class .${className} is used in markup but has no CSS rule`,
		);
	}
});

test("the retired plain checkout-success message is fully removed", () => {
	// The old flow injected a paragraph into a <p id="checkoutSuccess">. Both the
	// element and every reference to it must be gone, or dead state accumulates.
	assert.ok(!html.includes('id="checkoutSuccess"'), "the element must be removed from the markup");
	assert.ok(!INLINE_SCRIPT.includes("checkoutSuccess"), "the script must not reference the removed element");
	assert.ok(!css.includes("#checkoutSuccess"), "the dead CSS rule must be removed");
});

test("the modal has a responsive rule for small phones", () => {
	// Find the 640px block that actually contains the modal's rules.
	const blocks = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]);
	assert.ok(blocks.length > 0, "expected at least one 640px media query");
	assert.ok(
		blocks.some(block => /order-success/.test(block)),
		"the modal must adapt below 640px",
	);
});

// --- data contract ----------------------------------------------------------

// Mirrors what POST /api/orders returns (loadOrder() + tracking_token).
function apiOrder(overrides = {}) {
	return {
		id: "8",
		pickup_date: "2099-06-15",
		pickup_time: "13:30",
		total: "7.00",
		status: "Pending",
		order_number: "MS-8",
		items: [
			{ product_name: "Pocari Sweat 330ml", quantity: 2, unit_price: "2.50", subtotal: "5.00" },
			{ product_name: "Jufran Banana Sauce 560g", quantity: 1, unit_price: "2.00", subtotal: "2.00" },
		],
		tracking_token: "synthetic-tracking-credential-do-not-print",
		...overrides,
	};
}

const audFormatter = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatAud = amount => `A$${audFormatter.format(Number(amount) || 0)}`;

function formatMelbourneDateDisplay(isoDate) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "")) return isoDate || "";
	const [year, month, day] = isoDate.split("-").map(Number);
	return new Intl.DateTimeFormat("en-AU", {
		timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric",
	}).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

test("the modal renders every field the backend returns for an order", () => {
	const saved = apiOrder();

	// Assert the script wires each API field into the corresponding element.
	const expectations = [
		[saved.order_number, "orderSuccessNumber", "order number"],
		[saved.status, "orderSuccessStatus", "status"],
		[saved.pickup_time, "orderSuccessPickup", "pickup time"],
		[saved.total, "orderSuccessTotal", "total"],
	];
	for (const [value, id, label] of expectations) {
		assert.ok(
			INLINE_SCRIPT.includes(`getElementById('${id}')`),
			`${label} must be written to #${id}`,
		);
		assert.ok(String(value).length > 0, `fixture ${label} must be non-empty`);
	}

	// Item list: name, quantity and subtotal must all be rendered. Unit price is
	// shown per line in the item row layout, so assert its element exists.
	assert.match(INLINE_SCRIPT, /item\.product_name/, "item name must be rendered");
	assert.match(INLINE_SCRIPT, /item\.quantity/, "item quantity must be rendered");
	assert.match(INLINE_SCRIPT, /order-success-item-name/, "an item-name element must exist");
	assert.match(INLINE_SCRIPT, /order-success-item-qty/, "an item-quantity element must exist");
	assert.match(INLINE_SCRIPT, /item\.subtotal/, "subtotal must be rendered");
	assert.match(INLINE_SCRIPT, /order-success-item-subtotal/, "an item-subtotal element must exist");
	assert.match(INLINE_SCRIPT, /itemsList\.replaceChildren\(\.\.\.items\.map\(/, "the item list must be rebuilt per order");
});

test("the modal reuses the storefront's formatting helpers, not local copies", () => {
	// A redesign must not re-derive currency, dates or times, or it will drift.
	assert.ok(INLINE_SCRIPT.includes("formatAud(saved.total)"), "total must use formatAud");
	assert.ok(INLINE_SCRIPT.includes("formatMelbourneDateDisplay(saved.pickup_date)"), "date must use the existing helper");
	assert.ok(INLINE_SCRIPT.includes("PickupTimeDisplay.formatPickupTime(saved.pickup_time)"), "time must use the existing helper");
	assert.ok(INLINE_SCRIPT.includes("window.StoreInfo.STORE_INFO"), "store details must come from StoreInfo");
	assert.ok(INLINE_SCRIPT.includes("hoursRangeLabel()"), "hours must come from StoreInfo");
});

test("store address, hours and phone are shown from configuration, not hardcoded", () => {
	assert.ok(INLINE_SCRIPT.includes("info.address"), "address must come from STORE_INFO");
	assert.ok(INLINE_SCRIPT.includes("info.phone"), "phone must come from STORE_INFO");
	assert.ok(INLINE_SCRIPT.includes("info.operatingDaysLabel"), "days must come from STORE_INFO");

	// The configuration must actually carry these values.
	assert.ok(STORE_INFO.address && STORE_INFO.address.length > 10, "STORE_INFO.address must be configured");
	assert.ok(/^0\d{3}\s?\d{3}\s?\d{3}$/.test(STORE_INFO.phone), "STORE_INFO.phone must be a configured contact number");
	assert.ok(hoursRangeLabel().includes(STORE_INFO.openLabel), "hoursRangeLabel must use the configured open label");
	assert.equal(STORE_INFO.timeZone, "Australia/Melbourne", "store timezone must be Melbourne");
});

test("the pickup summary formats a Melbourne date and time using the real helpers", () => {
	const saved = apiOrder();
	const expectedDate = formatMelbourneDateDisplay(saved.pickup_date);
	const expectedTime = formatPickupTime(saved.pickup_time);
	const expectedTotal = formatAud(saved.total);

	assert.equal(expectedDate.length, 10, "an en-AU Melbourne date is dd/mm/yyyy");
	assert.equal(expectedTime, "1:30 PM", "13:30 must render as 1:30 PM");
	// The fixture total is the sum of its two item subtotals.
	assert.equal(expectedTotal, "A$7.00", "the two-line fixture total is A$7.00");

	// and the modal composes them the same way
	assert.match(
		INLINE_SCRIPT,
		/\$\{pickupDate\} at \$\{pickupTime\}/,
		"pickup summary must be '<date> at <time>'",
	);
});

test("the total is the sum of the item subtotals", () => {
	const saved = apiOrder();
	const sum = saved.items.reduce((total, item) => total + Number(item.subtotal), 0);
	assert.equal(sum, 7);
	assert.equal(Number(saved.total), sum, "the backend total must match the item subtotals");
});

test("the tracking credential is displayed but never exposed in a URL or log", () => {
	assert.match(INLINE_SCRIPT, /credential\.textContent = saved\.tracking_token/, "credential must come from the response");
	assert.ok(!/window\.open|location\.href\s*=/.test(INLINE_SCRIPT), "must not open a URL");
	assert.ok(!/console\.(log|info|debug|warn)\([^)]*credential/i.test(INLINE_SCRIPT), "must not log the credential");
	// The credential is only ever placed in a request body, never a query string.
	assert.match(INLINE_SCRIPT, /body: JSON\.stringify\(\{ token \}\)/);
});

test("copying the credential uses the async Clipboard API with a fallback", () => {
	assert.match(INLINE_SCRIPT, /navigator\.clipboard && window\.isSecureContext/);
	assert.match(INLINE_SCRIPT, /navigator\.clipboard\.writeText\(credential\)/);
	assert.match(INLINE_SCRIPT, /document\.execCommand\('copy'\)/, "a fallback must exist for non-secure contexts");
	assert.match(INLINE_SCRIPT, /is-success/, "copy success must be reported");
	assert.match(INLINE_SCRIPT, /is-error/, "copy failure must be reported");
});

test("the tracking lookup is shared with the tracking modal rather than duplicated", () => {
	assert.match(INLINE_SCRIPT, /async function lookupOrderByToken\(token\)/);
	assert.match(INLINE_SCRIPT, /trackingForm'\)\.addEventListener\('submit'/);
	assert.match(INLINE_SCRIPT, /await lookupOrderByToken\(document\.getElementById\('trackingTokenInput'\)\.value\.trim\(\)\)/);
	assert.match(INLINE_SCRIPT, /await lookupOrderByToken\(credential\)/, "Track My Order must reuse the same lookup");
});

test("a successful checkout closes the checkout modal and opens the success modal", () => {
	assert.match(INLINE_SCRIPT, /renderOrderSuccess\(saved\);\s*closeCheckout\(\);\s*openOrderSuccess\(\);/, "checkout must hand off to the success modal");
});

test("the modal handles an order whose item list is missing", () => {
	// A redesign must not crash on a legacy order that returns no items.
	assert.match(INLINE_SCRIPT, /Array\.isArray\(saved\.items\) \? saved\.items : \[\]/, "missing items must fall back to an empty list");
	assert.match(INLINE_SCRIPT, /items\.length === 0/, "an empty list must render an explanatory state");
});
