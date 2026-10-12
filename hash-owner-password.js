"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

async function main() {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Run this script in a terminal so the password can be entered without echo.");
	}

	const password = await readHiddenPassword("New owner password (12+ characters): ");
	if (password.length < 12 || password.length > 1024) {
		throw new Error("The owner password must contain 12 to 1024 characters.");
	}
	const confirmation = await readHiddenPassword("Confirm owner password: ");
	if (password !== confirmation) {
		throw new Error("The passwords do not match.");
	}

	const salt = crypto.randomBytes(16);
	const hash = await scrypt(password, salt, 64);
	process.stdout.write(`OWNER_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${hash.toString("hex")}\n`);
}

function readHiddenPassword(prompt) {
	return new Promise((resolve, reject) => {
		const input = process.stdin;
		let value = "";
		const wasRaw = input.isRaw;
		process.stdout.write(prompt);
		input.setRawMode(true);
		input.resume();

		function cleanup() {
			input.removeListener("data", onData);
			input.setRawMode(wasRaw);
			input.pause();
			process.stdout.write("\n");
		}

		function onData(buffer) {
			for (const character of buffer.toString("utf8")) {
				if (character === "\u0003") {
					cleanup();
					reject(new Error("Password entry cancelled."));
					return;
				}
				if (character === "\r" || character === "\n") {
					cleanup();
					resolve(value);
					return;
				}
				if (character === "\u007f" || character === "\b") {
					value = value.slice(0, -1);
				} else if (character >= " ") {
					value += character;
				}
			}
		}

		input.on("data", onData);
	});
}

main().catch(error => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
