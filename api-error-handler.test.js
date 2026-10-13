"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiErrorHandler, safeMissingObjectName } = require("./api-error-handler");

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

// --- Regression tests for the production internal server error ---------------
//
// Root cause: the deployed application queries five schema objects that the
// live database does not have. Every one of those paths currently returns
//   {"error":"An internal server error occurred","code":"INTERNAL_ERROR"}
// and, until the handler named them, left only a bare SQLSTATE in the log.

const CONFIRMED_MISSING_OBJECTS = [
	{ code: "42703", object: "tracking_token_hash", message: 'column "tracking_token_hash" does not exist', workflow: "customer order tracking" },
	{ code: "42703", object: "idempotency_fingerprint", message: 'column "idempotency_fingerprint" does not exist', workflow: "customer checkout and order creation" },
	{ code: "42703", object: "cancellation_reason", message: 'column "cancellation_reason" does not exist', workflow: "owner order list, order detail and status update" },
	{ code: "42P01", object: "owner_sessions", message: 'relation "owner_sessions" does not exist', workflow: "owner authentication" },
	{ code: "42P01", object: "owner_login_attempts", message: 'relation "owner_login_attempts" does not exist', workflow: "owner login rate limiting" },
];

test("names the missing object in the log for every confirmed failing workflow", async t => {
	for (const { code, object, message, workflow } of CONFIRMED_MISSING_OBJECTS) {
		await t.test(`${code} ${object} (${workflow})`, () => {
			const entries = [];
			const response = mockResponse();
			const handler = createApiErrorHandler({ error: (...entry) => entries.push(entry) });

			// node-postgres leaves error.table / error.column unset for a simple
			// query, exactly as observed against the live database.
			handler(Object.assign(new Error(message), { code }), { method: "POST" }, response, () => {});

			assert.equal(response.statusCode, 500);
			assert.deepEqual(response.body, {
				error: "An internal server error occurred",
				code: "INTERNAL_ERROR",
			}, "the client response must stay generic");

			const logged = entries[0][1];
			assert.equal(logged.missing_object, object, "the missing object must be named in the log");
			assert.equal(logged.message, message, "the validated message is retained");
			assert.match(logged.remediation, /production-order-system\.sql/);
		});
	}
});

test("the log never names a missing object for an unrecognised PostgreSQL error", () => {
	const entries = [];
	const handler = createApiErrorHandler({ error: (...entry) => entries.push(entry) });

	// 23505 is a unique violation, which carries no missing-object shape.
	handler(
		Object.assign(new Error('duplicate key value violates unique constraint "orders_idempotency_key_uidx"'), { code: "23505" }),
		{ method: "POST" },
		mockResponse(),
		() => {},
	);

	assert.deepEqual(entries[0][1], { method: "POST", code: "23505" });
});

test("a message that only looks like a missing object is rejected", () => {
	const entries = [];
	const handler = createApiErrorHandler({ error: (...entry) => entries.push(entry) });

	// A message carrying literal values or extra text must not be logged.
	handler(
		Object.assign(new Error('column "orders" does not exist; customer_name = "Jane Doe"'), { code: "42703" }),
		{ method: "POST" },
		mockResponse(),
		() => {},
	);

	assert.deepEqual(entries[0][1], { method: "POST", code: "42703" });
});

test("does not duplicate a missing object already reported by error.column", () => {
	const entries = [];
	const handler = createApiErrorHandler({ error: (...entry) => entries.push(entry) });

	handler(
		Object.assign(new Error('column "tracking_token_hash" does not exist'), {
			code: "42703",
			table: "orders",
			column: "tracking_token_hash",
		}),
		{ method: "POST" },
		mockResponse(),
		() => {},
	);

	const logged = entries[0][1];
	assert.equal(logged.column, "tracking_token_hash");
	assert.equal(logged.missing_object, undefined, "not repeated when already named");
	assert.equal(logged.remediation, undefined);
});

test("safeMissingObjectName rejects non-error inputs", () => {
	assert.equal(safeMissingObjectName(null), null);
	assert.equal(safeMissingObjectName({}), null);
	assert.equal(safeMissingObjectName({ code: "42703" }), null);
	assert.equal(safeMissingObjectName({ code: "42P01", message: 42 }), null);
	assert.equal(safeMissingObjectName({ code: "99999", message: 'relation "x" does not exist' }), null);
	assert.equal(safeMissingObjectName({ code: "42703", message: 'column "" does not exist' }), null);
	assert.equal(safeMissingObjectName({ code: "42703", message: 'column "a b" does not exist' }), null);
});
