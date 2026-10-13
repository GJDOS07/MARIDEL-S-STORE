"use strict";

const SAFE_DIAGNOSTIC_FIELDS = ["schema", "table", "column", "constraint"];

// PostgreSQL names a missing object inside its message text. node-postgres does
// not populate error.table / error.column for a simple (non-prepared) query, so
// without this the only trace of the cause is a bare SQLSTATE. Observed against
// the live database:
//   42703  column "tracking_token_hash" does not exist
//   42P01  relation "owner_sessions" does not exist
// Only these two codes are recognised, and the identifier is re-validated by
// the pattern itself, so a message carrying literal values, SQL text or
// customer data can never reach the log.
const MISSING_OBJECT_PATTERNS = new Map([
	[
		"42703",
		/^column "?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)"? does not exist$/,
	],
	[
		"42P01",
		/^relation "?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)"? does not exist$/,
	],
]);

function safeLogValue(value, pattern) {
	return typeof value === "string" && pattern.test(value) ? value : undefined;
}

// Returns the name of the missing object, or null when the error is not a
// missing-object error or its message does not match the strict shape.
function safeMissingObjectName(error) {
	if (!error || typeof error.message !== "string") return null;
	const pattern = MISSING_OBJECT_PATTERNS.get(error.code);
	if (!pattern) return null;
	const match = pattern.exec(error.message);
	return match ? match[1] : null;
}

function safePostgresMessage(error) {
	// Same strict validation as the missing-object extraction, so the message
	// is logged for both a missing column (42703) and a missing relation (42P01).
	const pattern = error && MISSING_OBJECT_PATTERNS.get(error.code);
	if (!pattern) return undefined;
	return safeLogValue(error.message, pattern);
}

function createApiErrorHandler(logger = console) {
	return function apiErrorHandler(error, req, res, next) {
		const details = {
			method: safeLogValue(req.method, /^[A-Z]{1,10}$/) || "UNKNOWN",
			code: safeLogValue(error.code, /^[A-Za-z0-9_.-]{1,64}$/)
				|| safeLogValue(error.name, /^[A-Za-z][A-Za-z0-9]*$/)
				|| "UnknownError",
		};
		const message = safePostgresMessage(error);
		if (message) details.message = message;
		for (const field of SAFE_DIAGNOSTIC_FIELDS) {
			const value = safeLogValue(error[field], /^[A-Za-z0-9_$.-]{1,128}$/);
			if (value) details[field] = value;
		}

		// Record the missing object by name when pg did not already report it
		// through error.table / error.column, and point the operator at the
		// reviewed migration. This stays in the server log only; the client
		// response below is unchanged.
		const missingObject = safeMissingObjectName(error);
		if (missingObject && missingObject !== details.column && missingObject !== details.table) {
			details.missing_object = missingObject;
			details.remediation = "a required database object is absent; apply the reviewed production-order-system.sql migration";
		}

		logger.error("API error:", details);

		const status = Number.isInteger(error.status) ? error.status : 500;
		if (error.type === "entity.too.large") {
			return res.status(413).json({ error: "The request is too large." });
		}
		if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
			return res.status(400).json({ error: "The request body is not valid JSON." });
		}
		return res.status(status).json({
			error: status === 500 ? "An internal server error occurred" : error.message,
			code: status === 500 ? "INTERNAL_ERROR" : error.code,
		});
	};
}

module.exports = { createApiErrorHandler, safeMissingObjectName };
