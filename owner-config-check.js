"use strict";
// Startup and local checks for owner authentication configuration.
//
// WHY THIS EXISTS
//   The service starts and logs "backend is running" whether or not owner
//   authentication is usable. A successful deploy therefore says nothing about
//   it, and the first sign of trouble is a dashboard that answers
//   OWNER_AUTH_NOT_CONFIGURED, which looks like a code failure rather than a
//   missing environment variable. These helpers turn that silent failure into
//   an actionable line in the log, and into a command you can run locally
//   before pasting anything into Render.
//
// SAFETY
//   Nothing here prints a password, hash, secret, or any part of one. Values are
//   classified only, never echoed. The classifier calls the very same
//   parsePasswordHash the login route uses, so it cannot drift from the check
//   that matters.

const { parsePasswordHash } = require("./order-routes");

const MIN_SESSION_SECRET_LENGTH = 32;

// Classifies OWNER_PASSWORD_HASH. The order matters: a value with surrounding
// whitespace is reported as such, because that is the single most common way a
// correctly generated hash gets rejected, and the remedy (strip it) is different
// from the remedy for a genuinely wrong format.
function classifyPasswordHash(value) {
	if (typeof value !== "string" || value.length === 0) return "missing";
	if (value !== value.trim()) return "has-whitespace";
	if (parsePasswordHash(value) === null) return "malformed";
	return "valid";
}

// Classifies OWNER_SESSION_SECRET. The login route requires at least 32
// characters; anything shorter fails closed with the same 503.
function classifySessionSecret(value) {
	if (typeof value !== "string" || value.length === 0) return "missing";
	if (value.length < MIN_SESSION_SECRET_LENGTH) return "too-short";
	return "valid";
}

const PASSWORD_HASH_ADVICE = {
	missing: "Set OWNER_PASSWORD_HASH in the environment. Generate one with: npm run set-owner-password",
	"has-whitespace": "OWNER_PASSWORD_HASH has leading or trailing whitespace. Re-copy the value with no surrounding spaces or newline.",
	malformed: "OWNER_PASSWORD_HASH is not in scrypt$<32+ hex salt>$<128 hex key> format. Generate one with: npm run set-owner-password",
	valid: "OWNER_PASSWORD_HASH is present and parses.",
};

const SESSION_SECRET_ADVICE = {
	missing: "Set OWNER_SESSION_SECRET to at least 32 random characters. Generate one with: npm run set-owner-password -- --secret",
	"too-short": `OWNER_SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters. Login will fail closed until it is longer.`,
	valid: "OWNER_SESSION_SECRET is present and long enough.",
};

function describeOwnerAuthConfig({ passwordHash, sessionSecret } = {}) {
	const passwordState = classifyPasswordHash(passwordHash);
	const secretState = classifySessionSecret(sessionSecret);
	const problems = [];
	if (passwordState !== "valid") problems.push(PASSWORD_HASH_ADVICE[passwordState]);
	if (secretState !== "valid") problems.push(SESSION_SECRET_ADVICE[secretState]);
	return { passwordHash: passwordState, sessionSecret: secretState, problems };
}

// True only when both are usable. This is the same condition the login route
// checks, so a false here means login will answer 503 before doing any work.
function isOwnerAuthConfigured({ passwordHash, sessionSecret } = {}) {
	return classifyPasswordHash(passwordHash) === "valid" && classifySessionSecret(sessionSecret) === "valid";
}

// Lines safe to write to a log: classifications and advice only.
function startupNoticeLines({ passwordHash, sessionSecret } = {}) {
	const passwordState = classifyPasswordHash(passwordHash);
	const secretState = classifySessionSecret(sessionSecret);
	const lines = [
		`Owner authentication: password hash ${passwordState}, session secret ${secretState}.`,
	];
	if (passwordState !== "valid") lines.push(`  Owner login disabled: ${PASSWORD_HASH_ADVICE[passwordState]}`);
	if (secretState !== "valid") lines.push(`  Owner login disabled: ${SESSION_SECRET_ADVICE[secretState]}`);
	if (passwordState === "valid" && secretState === "valid") {
		lines.push("  Owner login is available.");
	}
	return lines;
}

module.exports = {
	classifyPasswordHash,
	classifySessionSecret,
	describeOwnerAuthConfig,
	isOwnerAuthConfigured,
	startupNoticeLines,
	MIN_SESSION_SECRET_LENGTH,
	PASSWORD_HASH_ADVICE,
	SESSION_SECRET_ADVICE,
};

// ---------------------------------------------------------------------------
// CLI: npm run check-owner-config
//
// Reads the environment exactly as the server does, with dotenv loaded, and
// reports how OWNER_PASSWORD_HASH and OWNER_SESSION_SECRET were classified.
// Nothing is written and no value is printed. Run this before pasting a value
// into Render, and again after, to confirm the format is what the login route
// accepts.
// ---------------------------------------------------------------------------

if (require.main === module) {
	require("dotenv").config();
	const passwordHash = process.env.OWNER_PASSWORD_HASH;
	const sessionSecret = process.env.OWNER_SESSION_SECRET;
	const described = describeOwnerAuthConfig({ passwordHash, sessionSecret });
	const lines = [
		"MARIDEL'S STORE owner authentication configuration",
		"=".repeat(56),
		`OWNER_PASSWORD_HASH : ${described.passwordHash}`,
		`OWNER_SESSION_SECRET: ${described.sessionSecret}`,
		"",
	];
	if (described.problems.length === 0) {
		lines.push("Both values are usable. Owner login should work.");
	} else {
		lines.push("Owner login will answer OWNER_AUTH_NOT_CONFIGURED until this is fixed:");
		for (const problem of described.problems) lines.push(`  - ${problem}`);
	}
	lines.push("");
	lines.push("Note: values are read from this process environment and .env.");
	lines.push("A value that is correct here is not necessarily set in Render.");
	console.log(lines.join("\n"));
	process.exitCode = described.problems.length === 0 ? 0 : 1;
}
