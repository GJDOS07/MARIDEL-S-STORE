const test = require("node:test");
const assert = require("node:assert/strict");
const {
	amountToCents,
	normalizeOrderRequest,
} = require("./order-routes");

function validOrder(overrides = {}) {
	return {
		customer_name: "Maridel Customer",
		customer_contact: "+61 400 123 456",
		pickup_date: "2099-06-15",
		pickup_time: "13:30",
		items: [{ product_id: 73, quantity: 2 }],
		...overrides,
	};
}

test("checkout normalization accepts valid customer and product data", () => {
	const checkout = normalizeOrderRequest(validOrder());
	assert.equal(checkout.customerName, "Maridel Customer");
	assert.equal(checkout.customerContact, "+61 400 123 456");
	assert.deepEqual(checkout.items, [{ productId: 73, quantity: 2 }]);
	assert.equal(checkout.pickupDate, "2099-06-15");
	assert.equal(checkout.pickupTime, "13:30");
});

test("checkout normalization rejects invalid customer details and empty cart", () => {
	assert.throws(() => normalizeOrderRequest(validOrder({ customer_name: "  " })), { code: "INVALID_CUSTOMER_NAME" });
	assert.throws(() => normalizeOrderRequest(validOrder({ customer_contact: "x" })), { code: "INVALID_CUSTOMER_CONTACT" });
	assert.throws(() => normalizeOrderRequest(validOrder({ items: [] })), { code: "INVALID_ITEMS" });
});

test("checkout normalization rejects invalid products and quantities", () => {
	assert.throws(
		() => normalizeOrderRequest(validOrder({ items: [{ product_id: -1, quantity: 1 }] })),
		{ code: "INVALID_PRODUCT" },
	);
	assert.throws(
		() => normalizeOrderRequest(validOrder({ items: [{ product_id: 73, quantity: 0 }] })),
		{ code: "INVALID_QUANTITY" },
	);
	assert.throws(
		() => normalizeOrderRequest(validOrder({ items: [{ product_id: 73, quantity: 100 }] })),
		{ code: "INVALID_QUANTITY" },
	);
});

test("checkout normalization rejects duplicate products", () => {
	assert.throws(
		() => normalizeOrderRequest(validOrder({
			items: [
				{ product_id: 74, quantity: 2 },
				{ product_id: 73, quantity: 3 },
				{ product_id: 74, quantity: 1 },
			],
		})),
		{ code: "DUPLICATE_PRODUCT" },
	);
});

test("AUD product prices are converted to integer cents without floating-point totals", () => {
	assert.equal(amountToCents("1.50"), 150);
	assert.equal(amountToCents("2"), 200);
	assert.equal(amountToCents("12.05"), 1205);
	assert.throws(() => amountToCents("1.999"), /not a valid AUD amount/);
});