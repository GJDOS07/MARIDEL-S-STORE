"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	ALLOWED_STATUSES,
	STATUS_TRANSITIONS,
	amountToCents,
	centsToAmount,
	normalizeOrderRequest,
	parsePasswordHash,
} = require("./order-routes");

test("normalizes valid order input without accepting browser-supplied prices", () => {
	const order = normalizeOrderRequest({
		customer_name: " Customer ",
		customer_contact: "+61 400 000 000",
		pickup_date: "2099-06-15",
		pickup_time: "13:45",
		total: 0.01,
		items: [{ product_id: "9", quantity: 2 }],
	});
	assert.deepEqual(order, {
		customerName: "Customer",
		customerContact: "+61 400 000 000",
		pickupDate: "2099-06-15",
		pickupTime: "13:45",
		items: [{ productId: 9, quantity: 2 }],
	});
});

test("rejects invalid quantities and duplicate product IDs", () => {
	const base = {
		customer_name: "Customer",
		customer_contact: "0400000000",
		pickup_date: "2099-06-15",
		pickup_time: "13:00",
	};
	assert.throws(() => normalizeOrderRequest({ ...base, items: [{ product_id: 1, quantity: 0 }] }), /quantity/);
	assert.throws(() => normalizeOrderRequest({
		...base,
		items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 2 }],
	}), /only once/);
	assert.throws(() => normalizeOrderRequest({
		...base,
		items: Array.from({ length: 3 }, (_, index) => ({ product_id: index + 1, quantity: 99 })),
	}), /cannot exceed 200/);
});

test("calculates exact cents from trusted database numeric values", () => {
	assert.equal(amountToCents("12.30"), 1230);
	assert.equal(centsToAmount(1230), "12.30");
	assert.throws(() => amountToCents("12.345"), /not a valid AUD amount/);
});

test("allows only the requested owner order statuses and forward transitions", () => {
	assert.deepEqual([...ALLOWED_STATUSES], ["Pending", "Confirmed", "Preparing", "Ready for Pickup", "Completed", "Picked Up", "Cancelled"]);
	assert.equal(STATUS_TRANSITIONS.Pending.has("Confirmed"), true);
	assert.equal(STATUS_TRANSITIONS.Confirmed.has("Preparing"), true);
	assert.equal(STATUS_TRANSITIONS.Preparing.has("Ready for Pickup"), true);
	assert.equal(STATUS_TRANSITIONS["Ready for Pickup"].has("Picked Up"), true);
	assert.equal(STATUS_TRANSITIONS["Ready for Pickup"].has("Completed"), true);
	assert.equal(STATUS_TRANSITIONS["Picked Up"].size, 0);
	assert.equal(STATUS_TRANSITIONS.Completed.size, 0);
	assert.equal(STATUS_TRANSITIONS.Cancelled.size, 0);
});

test("accepts only a well-formed scrypt password hash", () => {
	assert.ok(parsePasswordHash(`scrypt$${"a".repeat(32)}$${"b".repeat(128)}`));
	assert.equal(parsePasswordHash("plaintext-password"), null);
});
