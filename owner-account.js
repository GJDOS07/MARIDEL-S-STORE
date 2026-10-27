"use strict";
// Owner account logic for the Maridel's Store owner dashboard.
//
// Pure functions only, in the same dual-export style as store-info.js and
// wishlist.js, so both the server and the Node test runner can use them.
//
// Covers:
//   * password policy validation (no hashing here; hashing stays in
//     order-routes.js where the existing scrypt stack lives)
//   * reset-token generation, hashing and expiry, so a token is only ever
//     persisted as a SHA-256 digest
//
// SECURITY: this module never stores, logs or returns a plaintext password or
// a plaintext reset token.

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
// 256 bits of entropy, base64url encoded, matches the idempotency-key shape the
// checkout already uses.
const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MINUTES = 30;

function validatePasswordPolicy(password) {
	if (typeof password !== "string" || password.length === 0) {
		return { valid: false, reason: "Enter your new password." };
	}
	if (password.length < MIN_PASSWORD_LENGTH) {
		return { valid: false, reason: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		return { valid: false, reason: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
	}
	// Reject leading/trailing whitespace, which is invisible to the operator and
	// a common cause of a password that cannot be retyped.
	if (password !== password.trim()) {
		return { valid: false, reason: "Remove any spaces at the start or end of the password." };
	}
	if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
		return { valid: false, reason: "Include at least one letter and one number." };
	}
	return { valid: true, reason: "" };
}

function validatePasswordChange(current, next, confirmation) {
	if (typeof current !== "string" || current.length === 0) {
		return { valid: false, code: "CURRENT_PASSWORD_REQUIRED", error: "Enter your current password." };
	}
	if (typeof next !== "string" || next.length === 0) {
		return { valid: false, code: "NEW_PASSWORD_REQUIRED", error: "Enter your new password." };
	}
	if (typeof confirmation !== "string" || confirmation.length === 0) {
		return { valid: false, code: "CONFIRMATION_REQUIRED", error: "Confirm your new password." };
	}
	if (next !== confirmation) {
		return { valid: false, code: "PASSWORD_MISMATCH", error: "The new password and its confirmation do not match." };
	}
	const policy = validatePasswordPolicy(next);
	if (!policy.valid) {
		return { valid: false, code: "WEAK_PASSWORD", error: policy.reason };
	}
	// Refuse a no-op change: it is almost always a paste mistake and would
	// silently invalidate every other session.
	if (current === next) {
		return { valid: false, code: "PASSWORD_UNCHANGED", error: "The new password must be different from the current one." };
	}
	return { valid: true, code: null, error: "" };
}

// Reset tokens are opaque, high-entropy, single-use and short-lived. Only the
// SHA-256 digest is ever stored, so a database read cannot recover a usable
// token.
function generateResetToken(randomBytes = 32) {
	const crypto = require("node:crypto");
	const bytes = crypto.randomBytes(RESET_TOKEN_BYTES);
	return bytes.toString("base64url");
}

function hashResetToken(token) {
	const crypto = require("node:crypto");
	if (typeof token !== "string" || token.length === 0) return null;
	return crypto.createHash("sha256").update(token).digest("hex");
}

function resetTokenIsWellFormed(token) {
	return typeof token === "string"
		&& /^[A-Za-z0-9_-]{43}$/.test(token)
		&& Buffer.from(token, "base64url").length === RESET_TOKEN_BYTES;
}

function resetTokenExpiry(from = new Date(), ttlMinutes = RESET_TOKEN_TTL_MINUTES) {
	const base = from instanceof Date ? from : new Date(from);
	const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : RESET_TOKEN_TTL_MINUTES;
	return new Date(base.getTime() + ttl * 60 * 1000);
}

// A generic message used for every reset request outcome, so an observer cannot
// tell whether an account exists or whether delivery succeeded.
const GENERIC_RESET_REQUEST_MESSAGE =
	"If an owner account exists, a password reset link is on its way. Check your inbox and spam folder.";

const api = {
	MIN_PASSWORD_LENGTH,
	MAX_PASSWORD_LENGTH,
	RESET_TOKEN_BYTES,
	RESET_TOKEN_TTL_MINUTES,
	GENERIC_RESET_REQUEST_MESSAGE,
	validatePasswordPolicy,
	validatePasswordChange,
	generateResetToken,
	hashResetToken,
	resetTokenIsWellFormed,
	resetTokenExpiry,
};

if (typeof module === "object" && module.exports) {
	module.exports = api;
} else if (typeof globalThis !== "undefined") {
	globalThis.OwnerAccount = api;
}
