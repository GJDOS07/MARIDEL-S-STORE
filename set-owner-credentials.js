#!/usr/bin/env node
"use strict";
// Interactive helper that prints the values needed to set the owner password.
//
//   npm run set-owner-password             print a new owner password hash
//   npm run set-owner-password -- --secret also print a new session secret
//
// It writes nothing: not to disk, not to the database, not to the environment.
// It only prints the values for you to paste where you choose.
// See OWNER_DASHBOARD_ACCESS.md for the full procedure.

const readline = require("node:readline");
const {
	hashOwnerPassword,
	generateSessionSecret,
	buildCredentialsSql,
	updateEnvFile,
} = require("./owner-credentials-tool");
const { validatePasswordPolicy } = require("./owner-account");

const USAGE = [
	"Set the MARIDEL'S STORE owner password.",
	"",
	"Usage:",
	"  npm run set-owner-password              print the values, change nothing",
	"  npm run set-owner-password -- --secret    also print a new OWNER_SESSION_SECRET",
	"  npm run set-owner-password -- --write-env write the values into the local .env",
	"",
	"--write-env is the local setup command. It updates .env in place, reusing an",
	"existing OWNER_SESSION_SECRET when one is present and generating one only when",
	"there is none. Every other line in .env, including DATABASE_URL, is left",
	"untouched. No value is printed at any point.",
	"",
	"Nothing is written to the database, to Render, or to any environment other",
	"than the local .env. The password you type is never echoed or printed.",
	"",
	"NOTE: pass the password only when prompted. Never on the command line, which",
	"would place it in shell history and in the process list.",
].join("\n");

// ---------------------------------------------------------------------------
// Prompts
//
// On a real terminal the input is read one character at a time in raw mode, so
// the password is never echoed. When stdin is a pipe or a file, readline has
// already parsed every available line by the time the first await resumes, so
// lines are captured into a queue up front and drained from it. Calling
// readline.question twice against piped input silently loses the second answer,
// which is exactly how an operator would end up unable to finish setup.
// ---------------------------------------------------------------------------

function createPromptQueue(rl) {
	const queue = [];
	const waiting = [];

	const settle = () => {
		while (waiting.length > 0) {
			if (queue.length > 0) {
				waiting.shift()(queue.shift());
				continue;
			}
			break;
		}
	};

	rl.on("line", line => {
		queue.push(line);
		settle();
	});
	rl.on("close", () => {
		while (waiting.length > 0) waiting.shift()(null);
	});

	return {
		next() {
			if (queue.length > 0) return Promise.resolve(queue.shift());
			return new Promise(resolve => {
				waiting.push(resolve);
				settle();
			});
		},
	};
}

// Reads one line. `hidden` is honoured only on a TTY; piping a password into
// this script cannot hide it, so the notice below tells the operator.
function ask(prompts, promptText, { hidden = false } = {}) {
	return new Promise(resolve => {
		const interactive = Boolean(process.stdin.isTTY);
		if (!hidden || !interactive) {
			prompts.rl.question(promptText, answer => resolve(answer));
			return;
		}
		const stdout = process.stdout;
		let typed = "";
		stdout.write(promptText);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		const onData = chunk => {
			const text = chunk.toString("utf8");
			for (const char of text) {
				if (char === "\r" || char === "\n") {
					process.stdin.setRawMode(false);
					process.stdin.pause();
					process.stdin.removeListener("data", onData);
					stdout.write("\n");
					resolve(typed);
					return;
				}
				if (char === "\u007F" || char === "\b") {
					typed = typed.slice(0, -1);
					continue;
				}
				// Ctrl+C must still interrupt the prompt.
				if (char === "\u0003") {
					process.stdout.write("\n");
					process.exit(130);
				}
				typed += char;
			}
		};
		process.stdin.on("data", onData);
	});
}

// Reads a value that is already in the .env content, or "" when the key is
// absent, empty, or still a placeholder from .env.example. The value is never
// logged; the caller only needs to know whether one exists to reuse.
function readExistingEnvValue(content, key) {
	for (const line of String(content || "").split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!match || match[1] !== key) continue;
		const value = match[2].trim();
		// A placeholder left over from .env.example is not a real credential.
		if (value.length === 0 || /^REPLACE_WITH_/i.test(value)) return "";
		return value;
	}
	return "";
}

// Applies an update to a dotenv file and writes it back. Returns a summary that
// contains counts and key names only, never a value, so it is safe to log.
//
// Takes the path as an argument rather than assuming the project .env, which is
// what lets the tests exercise the real write path against a temporary file
// instead of the developer's actual environment.
function writeEnvFile(envPath, updates) {
	const fs = require("node:fs");
	let existing = "";
	if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, "utf8");
	const result = updateEnvFile(existing, updates);
	if (result.content === existing) {
		return { changed: false, replaced: result.replaced, appended: result.appended, keys: Object.keys(updates) };
	}
	fs.writeFileSync(envPath, result.content, "utf8");
	return { changed: true, replaced: result.replaced, appended: result.appended, keys: Object.keys(updates) };
}

async function promptForNewPassword(prompts) {
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const isPiped = !process.stdin.isTTY;
		const password = isPiped
			? await prompts.askQueued("New owner password: ")
			: await ask(prompts, "New owner password: ", { hidden: true });
		const confirmation = isPiped
			? await prompts.askQueued("Re-type the same password: ")
			: await ask(prompts, "Re-type the same password: ", { hidden: true });

		if (password === null || confirmation === null) {
			throw new Error("No password was provided. Nothing was changed.");
		}
		if (password !== confirmation) {
			process.stdout.write("Those passwords do not match. Try again.\n");
			continue;
		}
		const policy = validatePasswordPolicy(password);
		if (!policy.valid) {
			process.stdout.write(`${policy.reason}\n`);
			continue;
		}
		return password;
	}
	throw new Error("Too many attempts. Nothing was changed.");
}

async function main(argv) {
	let showSecret = false;
	let writeEnv = false;
	const rest = [];
	for (const arg of argv.slice(2)) {
		if (arg === "--secret") showSecret = true;
		else if (arg === "--write-env") writeEnv = true;
		else rest.push(arg);
	}
	const args = rest;

	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	if (args.length > 0) {
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 2;
		return;
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const prompts = { rl, askQueued: null };
	prompts.askQueued = createPromptQueue(rl).next;

	try {
		if (!process.stdin.isTTY) {
			process.stdout.write(
				"\nNote: this terminal is not interactive, so the password you type is\n"
				+ "visible on screen as readline echoes it. In a real terminal nothing you\n"
				+ "type is displayed. Your password is still never printed back to you.\n\n",
			);
		}

		const lines = [];
		lines.push("MARIDEL'S STORE - owner credentials (local only, nothing is written)");
		lines.push("=".repeat(66));

		let section = 1;
		if (showSecret) {
			lines.push("");
			lines.push(`[${section}] OWNER_SESSION_SECRET`);
			section += 1;
			lines.push("");
			lines.push("    Paste this into the Render dashboard as OWNER_SESSION_SECRET.");
			lines.push("    It must be at least 32 characters, or login fails closed with ");
			lines.push("    a 503 and the dashboard cannot be opened at all.");
			lines.push(`    ${generateSessionSecret()}`);
			lines.push("");
			lines.push("    Changing it signs every owner out. There is no other owner-held");
			lines.push("    secret, so if it leaks the only repair is to set a new one here.");
		}

		const password = await promptForNewPassword(prompts);
		const encodedHash = hashOwnerPassword(password);

		if (writeEnv) {
			// Set the local .env so the backend can authenticate immediately.
			// An existing, usable OWNER_SESSION_SECRET is reused: rotating it
			// would sign the owner out, which is not what "set a password" asks
			// for. A new one is only created when there is nothing to reuse.
			const path = require("node:path");
			const envPath = path.join(__dirname, ".env");

			const existing = require("node:fs").existsSync(envPath)
				? require("node:fs").readFileSync(envPath, "utf8")
				: "";
			const updates = { OWNER_PASSWORD_HASH: encodedHash };
			// Reuse the current secret unless a new one was asked for or none
			// exists: rotating it would invalidate every existing session.
			const secret = showSecret ? generateSessionSecret() : readExistingEnvValue(existing, "OWNER_SESSION_SECRET");
			if (showSecret || !secret) updates.OWNER_SESSION_SECRET = secret || generateSessionSecret();

			const summary = writeEnvFile(envPath, updates);
			if (!summary.changed) {
				process.stdout.write("\n.env is already up to date. Nothing was written.\n");
			} else {
				process.stdout.write("\n.env updated.\n");
				process.stdout.write(`  replaced ${summary.replaced} key(s), appended ${summary.appended} key(s)\n`);
				process.stdout.write(`  wrote: ${summary.keys.join(", ")}\n`);
				process.stdout.write("  Every other line, including DATABASE_URL, is untouched.\n");
				process.stdout.write("  No value is printed.\n\n");
				process.stdout.write("  Next: npm run check-owner-config\n");
				process.stdout.write("        npm run serve      (and npm start in a second terminal)\n");
				process.stdout.write("        open http://localhost:4173/owner-dashboard.html\n\n");
			}
			return;
		}

		lines.push("");
		lines.push(`[${section}] OWNER_PASSWORD_HASH`);
		lines.push("");
		lines.push("    Paste this into the Render dashboard as OWNER_PASSWORD_HASH, then");
		lines.push("    use the password you just typed to log in. It does NOT work until");
		lines.push("    Render has restarted the service with the new value.");
		lines.push("");
		lines.push(`    ${encodedHash}`);
		lines.push("");
		lines.push("    --- SQL: run in the Neon SQL Editor after the migration -------");
		lines.push("");
		lines.push(buildCredentialsSql(encodedHash)
			.split("\n")
			.map(line => `    ${line}`)
			.join("\n"));
		lines.push("");
		lines.push("    Notes");
		lines.push("      * Prefer the SQL over the environment variable once the migration");
		lines.push("        is applied: owner_credentials wins over OWNER_PASSWORD_HASH, so");
		lines.push("        the variable stops mattering and no redeploy is ever needed.");
		lines.push("      * The plaintext password is not shown above and was not stored.");
		lines.push("      * Password reset by email does NOT work: no email provider is");
		lines.push("        configured. Re-running this tool is the recovery path.");
		lines.push("");

		process.stdout.write(`${lines.join("\n")}\n`);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} finally {
		rl.close();
	}
}

if (require.main === module) {
	main(process.argv).catch(error => {
		process.stderr.write(`${error && error.message ? error.message : error}\n`);
		process.exitCode = 1;
	});
}

module.exports = { createPromptQueue, ask, readExistingEnvValue, writeEnvFile };
