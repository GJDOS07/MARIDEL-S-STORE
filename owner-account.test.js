"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("./owner-account");

test("MIN_PASSWORD_LENGTH is 12", () => {
	assert.equal(MIN_PASSWORD_LENGTH, 12);
});

test("MAX_PASSWORD_LENGTH is 1024", () => {
	assert.equal(MAX_PASSWORD_LENGTH, 1024);
});

test("RESET_TOKEN_BYTES is 32", () => {
	assert.equal(RESET_TOKEN_BYTES, 32);
});

test("RESET_TOKEN_TTL_MINUTES is 30", () => {
	assert.equal(RESET_TOKEN_TTL_MINUTES, 30);
});

test("GENERIC_RESET_REQUEST_MESSAGE is a non-empty string", () => {
	assert.ok(typeof GENERIC_RESET_REQUEST_MESSAGE === "string" && GENERIC_RESET_REQUEST_MESSAGE.length > 0);
});

test("validatePasswordPolicy rejects empty password", () => {
	const result = validatePasswordPolicy("");
	assert.equal(result.valid, false);
	assert.match(result.reason, /Enter your new password/);
});

test("validatePasswordPolicy rejects password shorter than minimum", () => {
	const result = validatePasswordPolicy("short1");
	assert.equal(result.valid, false);
	assert.match(result.reason, /at least 12 characters/);
});

test("validatePasswordPolicy rejects password longer than maximum", () => {
	const result = validatePasswordPolicy("a".repeat(1025));
	assert.equal(result.valid, false);
	assert.match(result.reason, /at most 1024 characters/);
});

test("validatePasswordPolicy rejects leading/trailing whitespace", () => {
	const result = validatePasswordPolicy(" validpassword123 ");
	assert.equal(result.valid, false);
	assert.match(result.reason, /spaces at the start or end/);
});

test("validatePasswordPolicy rejects password without letter", () => {
	const result = validatePasswordPolicy("123456789012");
	assert.equal(result.valid, false);
	assert.match(result.reason, /letter and one number/);
});

test("validatePasswordPolicy rejects password without number", () => {
	const result = validatePasswordPolicy("passwordonly");
	assert.equal(result.valid, false);
	assert.match(result.reason, /letter and one number/);
});

test("validatePasswordPolicy accepts valid password", () => {
	const result = validatePasswordPolicy("validpassword123");
	assert.equal(result.valid, true);
});

test("validatePasswordPolicy accepts password at exactly minimum length", () => {
	const result = validatePasswordPolicy("a1" + "b".repeat(10));
	assert.equal(result.valid, true);
});

test("validatePasswordPolicy accepts password at exactly maximum length", () => {
	const result = validatePasswordPolicy("a1" + "b".repeat(1022));
	assert.equal(result.valid, true);
});

test("validatePasswordChange rejects missing current password", () => {
	const result = validatePasswordChange("", "newpassword123", "newpassword123");
	assert.equal(result.valid, false);
	assert.equal(result.code, "CURRENT_PASSWORD_REQUIRED");
});

test("validatePasswordChange rejects missing new password", () => {
	const result = validatePasswordChange("current123", "", "newpassword123");
	assert.equal(result.valid, false);
	assert.equal(result.code, "NEW_PASSWORD_REQUIRED");
});

test("validatePasswordChange rejects missing confirmation", () => {
	const result = validatePasswordChange("current123", "newpassword123", "");
	assert.equal(result.valid, false);
	assert.equal(result.code, "CONFIRMATION_REQUIRED");
});

test("validatePasswordChange rejects mismatched confirmation", () => {
	const result = validatePasswordChange("current123", "newpassword123", "different456");
	assert.equal(result.valid, false);
	assert.equal(result.code, "PASSWORD_MISMATCH");
});

test("validatePasswordChange rejects new password that fails policy", () => {
	const result = validatePasswordChange("current123", "short1", "short1");
	assert.equal(result.valid, false);
	assert.equal(result.code, "WEAK_PASSWORD");
});

test("validatePasswordChange rejects unchanged password", () => {
	const result = validatePasswordChange("samepassword123", "samepassword123", "samepassword123");
	assert.equal(result.valid, false);
	assert.equal(result.code, "PASSWORD_UNCHANGED");
});

test("validatePasswordChange accepts valid change", () => {
	const result = validatePasswordChange("current123", "newpassword456", "newpassword456");
	assert.equal(result.valid, true);
	assert.equal(result.code, null);
});

test("generateResetToken returns base64url string of correct length", () => {
	const token = generateResetToken();
	assert.ok(typeof token === "string");
	assert.match(token, /^[A-Za-z0-9_-]+$/);
	// 32 bytes = 43 base64url chars (no padding)
	assert.equal(token.length, 43);
});

test("generateResetToken produces unique tokens", () => {
	const tokens = new Set();
	for (let i = 0; i < 100; i++) {
		tokens.add(generateResetToken());
	}
	assert.equal(tokens.size, 100);
});

test("hashResetToken returns 64-char hex string", () => {
	const token = generateResetToken();
	const hash = hashResetToken(token);
	assert.equal(typeof hash, "string");
	assert.match(hash, /^[a-f0-9]{64}$/);
});

test("hashResetToken is deterministic", () => {
	const token = generateResetToken();
	assert.equal(hashResetToken(token), hashResetToken(token));
});

test("hashResetToken returns null for empty/invalid input", () => {
	assert.equal(hashResetToken(""), null);
	assert.equal(hashResetToken(null), null);
	assert.equal(hashResetToken(undefined), null);
});

test("resetTokenIsWellFormed accepts valid base64url token", () => {
	const token = generateResetToken();
	assert.equal(resetTokenIsWellFormed(token), true);
});

test("resetTokenIsWellFormed rejects wrong length", () => {
	assert.equal(resetTokenIsWellFormed("short"), false);
	assert.equal(resetTokenIsWellFormed("a".repeat(44)), false);
});

test("resetTokenIsWellFormed rejects invalid characters", () => {
	assert.equal(resetTokenIsWellFormed("a".repeat(42) + "!"), false);
	assert.equal(resetTokenIsWellFormed("a".repeat(42) + "/"), false);
	assert.equal(resetTokenIsWellFormed("a".repeat(42) + "+"), false);
});

test("resetTokenIsWellFormed rejects non-string", () => {
	assert.equal(resetTokenIsWellFormed(123), false);
	assert.equal(resetTokenIsWellFormed(null), false);
	assert.equal(resetTokenIsWellFormed(undefined), false);
});

test("resetTokenExpiry returns Date 30 minutes in future by default", () => {
	const before = new Date();
	const expiry = resetTokenExpiry();
	const after = new Date();
	const diffMs = expiry.getTime() - before.getTime();
	assert.ok(diffMs >= 29 * 60 * 1000 && diffMs <= 31 * 60 * 1000);
});

test("resetTokenExpiry accepts custom base time", () => {
	const base = new Date("2026-01-01T12:00:00Z");
	const expiry = resetTokenExpiry(base);
	assert.equal(expiry.getTime(), base.getTime() + 30 * 60 * 1000);
});

test("resetTokenExpiry accepts custom TTL", () => {
	const base = new Date("2026-01-01T12:00:00Z");
	const expiry = resetTokenExpiry(base, 60);
	assert.equal(expiry.getTime(), base.getTime() + 60 * 60 * 1000);
});

test("resetTokenExpiry handles Date-like input", () => {
	const base = "2026-01-01T12:00:00Z";
	const expiry = resetTokenExpiry(base);
	const expected = new Date(base).getTime() + 30 * 60 * 1000;
	assert.equal(expiry.getTime(), expected);
});