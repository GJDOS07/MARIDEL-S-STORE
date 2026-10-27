"use strict";
// Tests for the local static server's request handling.
//
// This server is only ever run on a developer machine, but it is still a web
// server: a traversal bug would let anyone who can reach the port read files
// outside the project, including ones the operator assumes are private. So the
// path handling is tested rather than assumed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// require.main is not set here, so the listen() call is skipped and no port is
// opened by loading the module.
const { resolveRequest, CONTENT_TYPES } = require("./serve-local");

const ROOT = __dirname;

test("a normal file resolves inside the project", () => {
	assert.equal(resolveRequest("/owner-dashboard.html"), path.join(ROOT, "owner-dashboard.html"));
	assert.equal(resolveRequest("/style.css"), path.join(ROOT, "style.css"));
	assert.equal(resolveRequest("/index.html"), path.join(ROOT, "index.html"));
});

test("a directory path becomes index.html", () => {
	assert.equal(resolveRequest("/"), path.join(ROOT, "index.html"));
	assert.equal(resolveRequest("/sub/"), path.join(ROOT, "sub", "index.html"));
});

test("the asset names the owner dashboard actually uses resolve", () => {
	// These are the exact files owner-dashboard.html loads, plus the shared
	// helpers the API routes need. If one of these fails to resolve, the
	// dashboard would silently break in the browser.
	const fs = require("node:fs");
	for (const asset of [
		"owner-dashboard.html",
		"owner-dashboard.js",
		"pickup-time-display.js",
		"style.css",
	]) {
		const resolved = resolveRequest(`/${asset}`);
		assert.ok(resolved, `${asset} must resolve`);
		assert.ok(fs.existsSync(resolved), `${asset} must actually exist in the repository`);
	}
});

// The security property is "never resolves to a path outside the project":
// either the request is refused (null) or the path stays inside the project.
// Asserting that directly is both stronger and more honest than guessing which
// input a given layer happens to reject: the URL parser normalises some ".."
// forms away and the segment check catches the rest, and it is the final path
// that matters, not which layer refused it.
const staysInsideProject = resolved =>
	resolved === null || resolved === ROOT || resolved.startsWith(ROOT + path.sep);

test("no input can resolve to a path outside the project", () => {
	const attempts = [
		"/../package.json",
		"/../../etc/passwd",
		"/..%2f..%2fetc%2fpasswd",
		"/%2e%2e/%2e%2e/etc/passwd",
		"/static/../../secret.txt",
		"/a/../../../package.json",
		"/..%5c..%5cpackage.json",
		"\\..\\..\\package.json",
		"/..\\..\\package.json",
		"/%252e%252e/%252e%252e/etc/passwd",
		"/....//....//etc/passwd",
		"/..;/../package.json",
		"/../.env",
		"/..%2f.env",
		"//etc/passwd",
		"/%2e%2e%2f%2e%2e%2f.env",
		"/" + "..".repeat(40) + "/etc/passwd",
	];
	for (const attempt of attempts) {
		const resolved = resolveRequest(attempt);
		assert.ok(
			staysInsideProject(resolved),
			`${attempt} must not resolve outside the project (got ${resolved})`,
		);
	}
});

test("dotfiles and dot-directories are never served", () => {
	// The repository holds a .env with the database connection string and a .git
	// directory. Serving either from a local web server would leak them to any
	// process that can reach the port.
	for (const forbidden of [
		"/.env",
		"/../.env",
		"/..%2f.env",
		"/.git/config",
		"/.git/HEAD",
		"/.gitignore",
		"/.npmrc",
		"/%2eenv",
		"/sub/.env",
		"/%2e%2e%2f.env",
	]) {
		assert.equal(resolveRequest(forbidden), null, `${forbidden} must never be served`);
	}
});

test("an absolute path in the URL is not honoured as a filesystem path", () => {
	// Without this, resolve(ROOT, "./" + "/etc/passwd") would escape on Windows.
	for (const attempt of ["/etc/passwd", "/C:/Windows/win.ini", "///etc/passwd"]) {
		const resolved = resolveRequest(attempt);
		if (resolved !== null) {
			assert.ok(
				resolved === ROOT || resolved.startsWith(ROOT + path.sep),
				`${attempt} must not escape the project`,
			);
		}
	}
});

test("a malformed percent-escape is refused rather than throwing", () => {
	// decodeURIComponent throws on an incomplete escape. The handler must turn
	// that into a 400, not an unhandled exception that takes the process down.
	assert.equal(resolveRequest("/%zz"), null);
	assert.equal(resolveRequest("/%"), null);
});

test("the static server never adopts the API's PORT", () => {
	// PORT is the backend service port: render.yaml maps it to the API, and
	// `npm start` uses it for server.js. When serve-local.js also read it, the
	// documented pair of commands made the static server compete with the backend
	// for the same port, and whichever process bound it first won. The dashboard
	// then failed to load and it looked exactly like the backend was broken.
	const source = fs.readFileSync(path.join(__dirname, "serve-local.js"), "utf8");
	const portLine = /const DEFAULT_PORT = ([^;]+);/.exec(source);
	assert.ok(portLine, "serve-local.js must declare DEFAULT_PORT");
	assert.ok(
		!portLine[1].includes("process.env.PORT"),
		"the static server must not read PORT, which belongs to the backend",
	);
	assert.ok(portLine[1].includes("process.env.SITE_PORT"), "it must use its own SITE_PORT");
	// 4173 is the origin owner-dashboard.js already expects locally.
	assert.match(portLine[1], /4173/);
});

test("the content types cover every asset the frontend loads", () => {
	for (const [extension, type] of Object.entries({
		".html": "text/html",
		".css": "text/css",
		".js": "text/javascript",
		".json": "application/json",
		".svg": "image/svg+xml",
	})) {
		assert.ok(CONTENT_TYPES[extension], `${extension} must have a content type`);
		assert.ok(CONTENT_TYPES[extension].includes(type), `${extension} must map to ${type}`);
	}
	// A script served as text/plain would be refused by the browser, which would
	// silently break the dashboard with no obvious cause.
	assert.equal(CONTENT_TYPES[".html"], "text/html; charset=utf-8");
	assert.ok(CONTENT_TYPES[".js"].includes("javascript"), "scripts must not be served as plain text");
});
