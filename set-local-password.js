#!/usr/bin/env node
"use strict";

const { hashOwnerPassword, updateEnvFile } = require("./owner-credentials-tool");
const fs = require("fs");
const path = require("path");

const password = process.argv[2];
if (!password || typeof password !== "string") {
	console.error("Usage: node set-local-password.js <password>");
	process.exit(1);
}

const encodedHash = hashOwnerPassword(password);
const envPath = path.join(__dirname, ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const result = updateEnvFile(existing, { OWNER_PASSWORD_HASH: encodedHash });
fs.writeFileSync(envPath, result.content, "utf8");

console.log("OWNER_PASSWORD_HASH written to local .env");
