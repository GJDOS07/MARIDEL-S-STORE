"use strict";

const SAFE_DIAGNOSTIC_FIELDS = ["schema", "table", "column", "constraint"];

function safeLogValue(value, pattern) {
	return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function safePostgresMessage(error) {
	if (error.code !== "42703") return undefined;
	return safeLogValue(
		error.message,
		/^column "?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*"? does not exist$/,
	);
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

module.exports = { createApiErrorHandler };
