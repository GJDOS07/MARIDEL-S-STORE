#!/usr/bin/env node
"use strict";
// Serves the storefront and the owner dashboard from this folder so you can open
// http://localhost:<port>/owner-dashboard.html in a normal browser.
//
// No dependencies and no uploads: it only reads files that already exist in this
// repository, so it can never expose anything that is not already in the repo.
// It refuses to serve anything above the project root and refuses dotfiles.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// SITE_PORT only. Deliberately NOT PORT.
//
// PORT in this project means "the backend service port": render.yaml maps it to
// the API service, and `npm start` uses it for server.js. serve-local.js also
// read it, so the documented pair of commands
//
//     LOCAL_SANDBOX_DB=1 PORT=3000 npm start
//     npm run serve
//
// made the static server compete for the SAME port as the backend. Whichever
// bound it first won, and the other either failed or served the wrong thing,
// which looks exactly like "the backend is broken".
//
// A dedicated variable removes the whole class of collision. 4173 is the default
// because it is the origin owner-dashboard.js already expects for local
// development. PORT is intentionally not honoured: honouring it is what caused
// the clash, and a static server silently adopting the API's port is never
// useful.
const DEFAULT_PORT = Number(process.env.SITE_PORT) || 4173;
const ROOT = __dirname;
// Uploaded product photos are served from here, and only from here. The directory
// is the same one the backend writes to, set with PRODUCT_IMAGE_DIR for local
// development. It is deliberately not inside the project folder, so an upload can
// never shadow a real page, and it is only exposed when explicitly configured.
const UPLOAD_DIR = (process.env.PRODUCT_IMAGE_DIR || "").trim()
	? path.resolve(process.env.PRODUCT_IMAGE_DIR.trim())
	: null;

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

// Serves an uploaded product photo. Deliberately narrow:
//   * only when PRODUCT_IMAGE_DIR is set, so this is opt-in local behaviour;
//   * only files inside that directory, so nothing else on the machine is reachable;
//   * only the image extensions the upload path validates, and the content type
//     comes from the extension, never from the request, so an uploaded file is
//     always served as the inert image type it was stored as.
function resolveUploadRequest(rawUrl) {
	if (!UPLOAD_DIR) return null;
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
	} catch {
		return null;
	}
	const prefix = "/product-images/";
	if (!pathname.startsWith(prefix)) return null;

	const relative = pathname.slice(prefix.length).replace(/^\/+/, "");
	if (relative.length === 0 || relative.includes("..") || relative.includes("\\")) return null;
	const segments = relative.split("/");
	if (segments.length !== 2 || segments[0] !== "products") return null;

	const resolved = path.resolve(UPLOAD_DIR, relative);
	if (resolved !== path.resolve(UPLOAD_DIR, relative)) return null;
	if (!resolved.startsWith(path.resolve(UPLOAD_DIR, "products") + path.sep)) return null;

	const extension = path.extname(resolved).toLowerCase();
	if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension)) return null;
	return { absolute: resolved, extension };
}

function resolveRequest(rawUrl) {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
	} catch {
		return null;
	}
	if (pathname.endsWith("/")) pathname += "index.html";

	// Examine the decoded path segment by segment. Two rules, applied before the
	// filesystem is ever touched:
	//
	//   1. No ".." segment. path.resolve collapses these on some inputs and not
	//      others depending on how the separator arrived, so relying on it by
	//      accident is not good enough. Reject it explicitly instead.
	//   2. No dotfile or dot-directory. The repository contains a .env holding
	//      the database connection string and a .git directory, and neither
	//      should ever be served, even by a local server.
	const segments = pathname.split("/").filter(segment => segment !== "");
	for (const segment of segments) {
		if (segment === ".." || segment === ".") return null;
		if (segment.startsWith(".")) return null;
	}

	// Collapse to a real path inside ROOT and reject anything that escapes it.
	const resolved = path.resolve(ROOT, `.${path.sep}${pathname.replace(/^[/\\]+/, "")}`);
	if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
	return resolved;
}

const server = http.createServer((req, res) => {
	const method = (req.method || "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
		res.end("Method not allowed\n");
		return;
	}

	// Uploaded product photos, served only from the configured upload directory.
	// Checked before the project tree so an upload can never shadow a real page.
	const upload = resolveUploadRequest(req.url || "/");
	if (upload) {
		let stat;
		try {
			stat = fs.statSync(upload.absolute);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found\n");
			return;
		}
		if (!stat.isFile()) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found\n");
			return;
		}
		res.writeHead(200, {
			"Content-Type": CONTENT_TYPES[upload.extension] || "application/octet-stream",
			"Content-Length": stat.size,
			"Cache-Control": "public, max-age=3600",
			// An uploaded image is always inert: it is never interpreted as a
			// document, so a file that slipped through cannot run in the browser.
			"X-Content-Type-Options": "nosniff",
		});
		if (method === "HEAD") { res.end(); return; }
		fs.createReadStream(upload.absolute).pipe(res);
		return;
	}

	const target = resolveRequest(req.url || "/");
	if (!target) {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Bad request\n");
		return;
	}

	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found\n");
		return;
	}
	if (!stat.isFile()) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found\n");
		return;
	}

	const extension = path.extname(target).toLowerCase();
	res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
		"Content-Length": stat.size,
		"Cache-Control": "no-store",
	});

	// HEAD must not send a body. Sending the stream anyway would desynchronise
	// the response and leave the browser waiting.
	if (method === "HEAD") {
		res.end();
		return;
	}
	fs.createReadStream(target).pipe(res);
});

function listen(port, attemptsLeft) {
	server.once("error", error => {
		if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
			// Another tool already holds this port; try the next one rather than
			// failing and leaving the operator to guess why.
			process.stdout.write(`Port ${port} is in use, trying ${port + 1}.\n`);
			listen(port + 1, attemptsLeft - 1);
			return;
		}
		process.stderr.write(`Could not start: ${error.message}\n`);
		process.exitCode = 1;
	});
	server.listen(port, "127.0.0.1", () => {
		const actual = server.address().port;
		process.stdout.write([
			"",
			"MARIDEL'S STORE local site is running.",
			"",
			`  Owner dashboard   http://localhost:${actual}/owner-dashboard.html`,
			`  Customer store    http://localhost:${actual}/index.html`,
			"",
			"  Log in with the password you set with: npm run set-owner-password",
			"  Press Ctrl+C to stop.",
			"",
		].join("\n"));
	});
}

module.exports = { resolveRequest, CONTENT_TYPES };

if (require.main === module) {
	listen(DEFAULT_PORT, 10);
}
