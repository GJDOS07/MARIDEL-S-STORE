const test = require("node:test");
const assert = require("node:assert/strict");
const {
	moneyToCents,
	normalizeCheckout,
} = require("./order-routes");

function validOrder(overrides = {}) {
	return {
		customer_name: "Maridel Customer",
		customer_contact: "+61 400 123 456",
		customer_email: "customer@example.com",
		pickup_type: "SCHEDULED",
		pickup_date: "2026-10-08",
		pickup_time: "09:30",
		items: [{ product_id: 73, quantity: 2 }],
		...overrides,
	};
}

test("checkout normalization accepts valid customer and product data", () => {
	const checkout = normalizeCheckout(validOrder());
	assert.equal(checkout.customerName, "Maridel Customer");
	assert.equal(checkout.customerContact, "+61 400 123 456");
	assert.deepEqual(checkout.items, [{ productId: 73, quantity: 2 }]);
	assert.equal(checkout.pickupType, "SCHEDULED");
});

test("checkout normalization rejects invalid customer details and empty cart", () => {
	assert.throws(() => normalizeCheckout(validOrder({ customer_name: "  " })), { code: "INVALID_CUSTOMER_NAME" });
	assert.throws(() => normalizeCheckout(validOrder({ customer_contact: "x" })), { code: "INVALID_CUSTOMER_CONTACT" });
	assert.throws(() => normalizeCheckout(validOrder({ customer_email: "not-an-email" })), { code: "INVALID_CUSTOMER_EMAIL" });
	assert.throws(() => normalizeCheckout(validOrder({ items: [] })), { code: "INVALID_ORDER_ITEMS" });
});

test("checkout normalization rejects invalid products and quantities", () => {
	assert.throws(
		() => normalizeCheckout(validOrder({ items: [{ product_id: -1, quantity: 1 }] })),
		{ code: "INVALID_PRODUCT" },
	);
	assert.throws(
		() => normalizeCheckout(validOrder({ items: [{ product_id: 73, quantity: 0 }] })),
		{ code: "INVALID_QUANTITY" },
	);
	assert.throws(
		() => normalizeCheckout(validOrder({ items: [{ product_id: 73, quantity: 100 }] })),
		{ code: "INVALID_QUANTITY" },
	);
});

test("checkout normalization consolidates duplicate products within quantity caps", () => {
	const checkout = normalizeCheckout(validOrder({
		items: [
			{ product_id: 74, quantity: 2 },
			{ product_id: 73, quantity: 3 },
			{ product_id: 74, quantity: 1 },
		],
	}));
	assert.deepEqual(checkout.items, [
		{ productId: 73, quantity: 3 },
		{ productId: 74, quantity: 3 },
	]);
});

test("AUD product prices are converted to integer cents without floating-point totals", () => {
	assert.equal(moneyToCents("1.50"), 150);
	assert.equal(moneyToCents("2"), 200);
	assert.equal(moneyToCents("12.05"), 1205);
	assert.throws(() => moneyToCents("1.999"), /valid AUD amount/);
});
