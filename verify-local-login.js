// Verifies the credential stored in the real local .env works through a real
// HTTP login, against an isolated in-memory PGlite database.
//
// The production database is never contacted and never mentioned: this builds
// the two owner tables in an in-process database and mounts the real router.
// Values are read from .env into memory and are never printed.
"use strict";

require("dotenv").config();
const readline = require("node:readline");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");
const { createOrderRouter } = require("./order-routes");
const { createApiErrorHandler } = require("./api-error-handler");
const { classifyPasswordHash, classifySessionSecret } = require("./owner-config-check");

// The password is read from a prompt, never from an argument: an argument would
// land in shell history and in the process list.
function promptForPassword() {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => {
		if (process.stdin.isTTY) {
			// Hidden entry on a real terminal, so nothing is echoed.
			let typed = "";
			process.stdout.write("Owner password: ");
			process.stdin.setRawMode(true);
			process.stdin.resume();
			const onData = chunk => {
				for (const char of chunk.toString("utf8")) {
					if (char === "\r" || char === "\n") {
						process.stdin.setRawMode(false);
						process.stdin.removeListener("data", onData);
						process.stdout.write("\n");
						rl.close();
						resolve(typed);
						return;
					}
					if (char === "\u0003") { process.stdout.write("\n"); process.exit(130); }
					if (char === "\u007F" || char === "\b") typed = typed.slice(0, -1);
					else typed += char;
				}
			};
			process.stdin.on("data", onData);
			return;
		}
		process.stdout.write("Owner password: ");
		rl.question("", answer => { rl.close(); resolve(answer); });
	});
}

const OWNER_TABLES = `
CREATE TABLE owner_sessions (
	session_hash CHAR(64) PRIMARY KEY,
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE owner_login_attempts (
	client_key_hash CHAR(64) PRIMARY KEY,
	window_started_at TIMESTAMPTZ NOT NULL,
	attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 1000000)
);
`;

(async () => {
	const hashState = classifyPasswordHash(process.env.OWNER_PASSWORD_HASH);
	const secretState = classifySessionSecret(process.env.OWNER_SESSION_SECRET);
	console.log(".env hash classification   :", hashState);
	console.log(".env secret classification :", secretState);
	if (hashState !== "valid" || secretState !== "valid") {
		console.error("local .env is not usable; run: npm run set-owner-password -- --write-env");
		process.exitCode = 1;
		return;
	}

	const db = await PGlite.create();
	await db.exec(OWNER_TABLES);
	const shim = { query: (sql, params) => db.query(sql, params || []) };
	const password = await promptForPassword();

	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.use("/api", createOrderRouter(shim, {
		allowedOrigins: ["http://localhost:4173"],
		secureCookies: false,
		ownerPasswordHash: process.env.OWNER_PASSWORD_HASH,
		sessionSecret: process.env.OWNER_SESSION_SECRET,
	}));
	app.use(createApiErrorHandler({ error() {} }));
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	const url = `http://127.0.0.1:${server.address().port}`;

	const attempt = password => fetch(`${url}/api/owner/csrf`, { headers: { Origin: "http://localhost:4173" } })
		.then(async csrf => {
			const body = await csrf.json();
			const token = body.csrf_token;
			const jar = csrf.headers.getSetCookie().map(c => c.split(";")[0]);
			const response = await fetch(`${url}/api/owner/login`, {
				method: "POST",
				headers: {
					Origin: "http://localhost:4173",
					"Content-Type": "application/json",
					Cookie: jar.join("; "),
					"X-CSRF-Token": token,
				},
				body: JSON.stringify({ password }),
			});
			return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
		});

	const good = await attempt(password);
	const bad = await attempt("a-password-that-is-not-the-one-in-env");
	console.log("login, correct password    :", good.status, good.body.authenticated === true ? "(authenticated)" : "");
	console.log("session cookie issued      :", good.cookies.length > 0 && good.status === 200);
	console.log("login, wrong password      :", bad.status, bad.body.code || "");

	server.close();
	await db.close();
	process.exitCode = (good.status === 200 && good.body.authenticated === true && bad.status === 401) ? 0 : 1;
})();
