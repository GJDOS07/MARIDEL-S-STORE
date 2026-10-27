"use strict";
// Local-only tool for initialising the owner account: it turns a password the
// operator types into the exact scrypt hash the login route verifies, and a new
// OWNER_SESSION_SECRET when one is needed.
//
// WHY THIS EXISTS
//   The owner password hash lives in the OWNER_PASSWORD_HASH environment
//   variable, and, once owner-account-and-products.sql has been applied, in the
//   owner_credentials table (which wins). There is no email provider in this
//   project, so the self-service reset flow cannot deliver a link, and an
//   operator who does not know the current password has no other way in. This
//   module is the safe way in: it produces the value to set, and the SQL to
//   store it, without the operator needing to know the old password.
//
// SAFETY (hard rules, not defaults)
//   * It never opens a database connection and never touches .env, Render, or
//     Neon. It computes and returns values; the caller decides where to put them.
//   * The plaintext password is never returned, written to a file, or logged.
//   * The password must satisfy the same validatePasswordPolicy the API uses,
//     so any password accepted here is accepted at login.

const crypto = require("node:crypto");

const SALT_BYTES = 16;   // 32 hex chars: satisfies parsePasswordHash and the DB CHECK
const KEY_BYTES = 64;    // 128 hex chars: matches parsePasswordHash and the DB CHECK
const SESSION_SECRET_BYTES = 32;

// Produces "scrypt$<hex salt>$<hex key>", byte-for-byte the shape
// parsePasswordHash() accepts and the owner_credentials CHECK constraint allows.
// The login route verifies with crypto.scrypt(password, salt, 64) using Node's
// default cost parameters, so this deliberately passes no custom N/r/p.
function hashOwnerPassword(password, salt = crypto.randomBytes(SALT_BYTES)) {
	if (typeof password !== "string") throw new TypeError("password must be a string");
	if (password.length === 0) throw new TypeError("password must not be empty");
	if (!Buffer.isBuffer(salt)) throw new TypeError("salt must be a Buffer");
	const derived = crypto.scryptSync(password, salt, KEY_BYTES);
	return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

// 256 bits of entropy, base64url. The login route requires at least 32
// characters, so anything shorter makes login fail closed with a 503.
function generateSessionSecret() {
	return crypto.randomBytes(SESSION_SECRET_BYTES).toString("base64url");
}

// The SQL that stores the hash. ON CONFLICT keeps it an upsert so it can be run
// again after a later password change without an error. Singleton is always
// true: there is exactly one owner row.
function buildCredentialsSql(encodedHash) {
	if (typeof encodedHash !== "string" || encodedHash.length === 0) {
		throw new TypeError("encodedHash must be a non-empty string");
	}
	return [
		"-- Sets the owner password used by /api/owner/login.",
		"-- owner_credentials wins over the OWNER_PASSWORD_HASH environment variable.",
		"INSERT INTO public.owner_credentials (singleton, password_hash, updated_at)",
		"VALUES (true, '" + encodedHash + "', CURRENT_TIMESTAMP)",
		"ON CONFLICT (singleton) DO UPDATE",
		"SET password_hash = EXCLUDED.password_hash,",
		"    updated_at = CURRENT_TIMESTAMP;",
	].join("\n");
}

// Rewrites a dotenv file so the given keys hold new values, leaving every other
// line untouched.
//
// This exists because the credential tools previously only printed values, so
// configuring a local environment still meant hand-editing .env, which is how a
// trailing newline ends up inside a hash and login keeps failing for no visible
// reason.
//
// Guarantees that matter here:
//   * Every key not named in `updates` survives byte-for-byte, including
//     DATABASE_URL, comments, blank lines and their order.
//   * Existing lines for a replaced key are removed, so no duplicate key remains
//     for dotenv to resolve ambiguously.
//   * The dominant line ending and whether the file ends with a newline are both
//     preserved, so an edited file still diffs cleanly.
//   * Nothing is returned to the caller except counts: the values stay internal.
function updateEnvFile(content, updates) {
	if (typeof content !== "string") throw new TypeError("content must be a string");
	if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
		throw new TypeError("updates must be an object");
	}
	for (const [key, value] of Object.entries(updates)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`invalid key name: ${key}`);
		if (typeof value !== "string" || value.length === 0) {
			throw new TypeError(`value for ${key} must be a non-empty string`);
		}
		// A value containing a newline would silently truncate the entry, which
		// is the exact class of bug this whole function exists to prevent.
		if (/[\r\n]/.test(value)) throw new TypeError(`value for ${key} must not contain a newline`);
	}

	const usesCrlf = content.includes("\r\n");
	const newline = usesCrlf ? "\r\n" : "\n";
	const endsWithNewline = content.length === 0 || /\r?\n$/.test(content);

	const desired = Object.keys(updates);
	const kept = [];
	let replaced = 0;

	for (const line of content.split(/\r?\n/)) {
		// A trailing newline yields one empty final element, which is meaningful
		// only for reconstructing the file's ending, so track it separately.
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		if (match && desired.includes(match[1])) {
			replaced += 1;
			continue;
		}
		kept.push(line);
	}

	// Drop the single trailing empty element produced by the final newline, then
	// rebuild with the newline style the file already used.
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();

	for (const key of desired) kept.push(`${key}=${updates[key]}`);

	let result = kept.join(newline);
	if (result.length > 0 && endsWithNewline) result += newline;
	return { content: result, replaced, appended: desired.length - replaced };
}

module.exports = {
	hashOwnerPassword,
	generateSessionSecret,
	buildCredentialsSql,
	updateEnvFile,
	SALT_BYTES,
	KEY_BYTES,
	SESSION_SECRET_BYTES,
};
