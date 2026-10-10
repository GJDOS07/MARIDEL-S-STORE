"use strict";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const SAFE_POSTGRES_COLUMN_MESSAGE = /^column "?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*"? does not exist$/;

function safeIdentifier(value) {
	return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function createApiErrorHandler(logger = console) {
	return function apiErrorHandler(error, req, res, next) {
		const details = {
			code: typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
				? error.code
				: "UnknownError",
		};

		if (error.code === "42703" && typeof error.message === "string" && SAFE_POSTGRES_COLUMN_MESSAGE.test(error.message)) {
			details.message = error.message;
			for (const field of ["schema", "table", "column"]) {
				const value = safeIdentifier(error[field]);
				if (value) details[field] = value;
			}
		}

		logger.error("API error:", details);
		if (error.type === "entity.too.large") {
			return res.status(413).json({ error: "The request is too large." });
		}
		if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
			return res.status(400).json({ error: "The request body is not valid JSON." });
		}
		return res.status(500).json({ error: "An internal server error occurred" });
	};
}

module.exports = { createApiErrorHandler };
