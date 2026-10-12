"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiErrorHandler } = require("./api-error-handler");

function mockResponse() {
	return {
		statusCode: null,
		body: null,
		status(statusCode) {
			this.statusCode = statusCode;
			return this;
		},
		json(body) {
			this.body = body;
			return this;
		},
	};
}

test("logs safe undefined-column diagnostics without exposing database details to customers", () => {
	const entries = [];
	const response = mockResponse();
	const handler = createApiErrorHandler({
		error: (...entry) => entries.push(entry),
	});
	const failure = Object.assign(new Error('column "idempotency_key" does not exist'), {
		code: "42703",
		schema: "public",
		table: "orders",
		column: "idempotency_key",
		detail: "Sensitive customer data",
		hint: "Do not expose this hint",
		query: "SELECT using a private value",
	});

	handler(failure, {
		method: "POST",
		body: { customer_name: "Private Customer", password: "private-password" },
	}, response, () => {});

	assert.equal(response.statusCode, 500);
	assert.deepEqual(response.body, {
		error: "An internal server error occurred",
		code: "INTERNAL_ERROR",
	});
	assert.deepEqual(entries, [[
		"API error:",
		{
			method: "POST",
			code: "42703",
			message: 'column "idempotency_key" does not exist',
			schema: "public",
			table: "orders",
			column: "idempotency_key",
		},
	]]);
	assert.doesNotMatch(
		JSON.stringify(entries),
		/private customer|private-password|sensitive customer data|private value|do not expose/i,
	);
});

test("omits unexpected PostgreSQL messages and all error detail fields", () => {
	const entries = [];
	const handler = createApiErrorHandler({
		error: (...entry) => entries.push(entry),
	});

	handler(
		Object.assign(new Error("database error included private customer data"), {
			code: "42703",
			detail: "private customer data",
			hint: "private hint",
			query: "query containing private values",
		}),
		{ method: "POST" },
		mockResponse(),
		() => {},
	);

	assert.deepEqual(entries, [[
		"API error:",
		{ method: "POST", code: "42703" },
	]]);
});

test("preserves safe client validation responses", () => {
	const response = mockResponse();
	const handler = createApiErrorHandler({ error() {} });

	handler(
		Object.assign(new Error("Enter a valid pickup time."), { status: 400, code: "INVALID_PICKUP" }),
		{ method: "POST" },
		response,
		() => {},
	);

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.body, {
		error: "Enter a valid pickup time.",
		code: "INVALID_PICKUP",
	});
});
