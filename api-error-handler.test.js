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

test("captures the standard node-postgres 42703 message and keeps the 500 response generic", () => {
	const logs = [];
	const response = mockResponse();
	const handler = createApiErrorHandler({ error: (...args) => logs.push(args) });
	const error = Object.assign(new Error('column "idempotency_key" does not exist'), {
		code: "42703",
		schema: "public",
		table: "orders",
		column: "idempotency_key",
		detail: "customer data",
		hint: "sensitive hint",
		query: "query with parameter values",
	});

	handler(error, {
		method: "POST",
		body: { customer_name: "Private Customer", password: "secret-value" },
	}, response, () => {});

	assert.equal(response.statusCode, 500);
	assert.deepEqual(response.body, { error: "An internal server error occurred" });
	assert.deepEqual(logs, [[
		"API error:",
		{
			code: "42703",
			message: 'column "idempotency_key" does not exist',
			schema: "public",
			table: "orders",
			column: "idempotency_key",
		},
	]]);
	assert.doesNotMatch(JSON.stringify(logs), /customer data|sensitive hint|parameter values|private customer|secret-value/i);
});

test("does not log an unvalidated 42703 message or unsafe diagnostic identifiers", () => {
	const logs = [];
	const handler = createApiErrorHandler({ error: (...args) => logs.push(args) });
	const error = Object.assign(new Error("column missing; query: SELECT secret"), {
		code: "42703",
		schema: "public; DROP TABLE orders",
		table: "orders",
		column: "customer-name",
	});

	handler(error, { method: "POST" }, mockResponse(), () => {});

	assert.deepEqual(logs, [["API error:", { code: "42703" }]]);
});

test("replaces unusual error codes and names with a fixed safe label", () => {
	const logs = [];
	const handler = createApiErrorHandler({ error: (...args) => logs.push(args) });
	const error = Object.assign(new Error("database failure"), {
		code: "password=secret; customer=private",
		name: "SensitiveCustomerDetails",
	});

	handler(error, { method: "POST" }, mockResponse(), () => {});

	assert.deepEqual(logs, [["API error:", { code: "UnknownError" }]]);
	assert.doesNotMatch(JSON.stringify(logs), /password|secret|customer|private|SensitiveCustomerDetails/i);
});

test("preserves existing request-size and invalid-JSON responses", () => {
	const handler = createApiErrorHandler({ error() {} });
	const largeBodyResponse = mockResponse();
	handler(Object.assign(new Error("too large"), { type: "entity.too.large" }), {}, largeBodyResponse, () => {});
	assert.equal(largeBodyResponse.statusCode, 413);
	assert.deepEqual(largeBodyResponse.body, { error: "The request is too large." });

	const invalidJsonResponse = mockResponse();
	handler(Object.assign(new SyntaxError("invalid"), { status: 400, body: {} }), {}, invalidJsonResponse, () => {});
	assert.equal(invalidJsonResponse.statusCode, 400);
	assert.deepEqual(invalidJsonResponse.body, { error: "The request body is not valid JSON." });
});
