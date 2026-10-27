"use strict";
// Guards the rule that the deployed server must start with production
// dependencies only.
//
// THE BUG THESE GUARD AGAINST
//   local-sandbox-database.js required @electric-sql/pglite at module top level.
//   That package is a devDependency, and server.js requires the module
//   unconditionally at startup, so a host that installed production
//   dependencies only crashed with MODULE_NOT_FOUND before it could listen. The
//   sandbox is a local convenience; it must never be able to stop the server
//   from loading.
//
// WHAT IS CHECKED
//   1. Every package required while the server's module graph is being loaded is
//      listed under "dependencies" in package.json.
//   2. PGlite is not required at the top level of local-sandbox-database.js. It
//      is still required where the sandbox is actually created, so the sandbox
//      keeps working.
//
// The scan reads source text and follows relative requires. It deliberately does
// not execute anything: requiring server.js would start listening.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const serverEntry = path.join(root, "server.js");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Returns the require("...") specifiers that run while this module is being
// loaded, i.e. those outside every function body. Comments and string contents
// are skipped so text that merely looks like code cannot fool the brace count.
//
// The approximation is: a require nested inside braces belongs to a function (or
// a block) and therefore does not run at load time. A require inside a top-level
// "if" would also be skipped, which is the conservative direction for this check
// because such a require is still not needed to load the module.
function loadTimeRequires(source) {
	const found = [];
	let depth = 0;
	let index = 0;
	let quote = null;
	let lineComment = false;
	let blockComment = false;

	while (index < source.length) {
		const character = source[index];
		const next = source[index + 1];

		if (lineComment) {
			if (character === "\n") lineComment = false;
			index += 1;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index += 2;
				continue;
			}
			index += 1;
			continue;
		}
		if (quote !== null) {
			if (character === "\\") {
				index += 2;
				continue;
			}
			if (character === quote) quote = null;
			index += 1;
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			index += 2;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index += 2;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			index += 1;
			continue;
		}
		if (character === "{") {
			depth += 1;
			index += 1;
			continue;
		}
		if (character === "}") {
			depth = Math.max(0, depth - 1);
			index += 1;
			continue;
		}
		if (depth === 0 && source.startsWith("require", index)) {
			const match = /^require\(\s*(["'])([^"']+)\1\s*\)/.exec(source.slice(index));
			if (match) {
				found.push(match[2]);
				index += match[0].length;
				continue;
			}
		}
		index += 1;
	}

	return found;
}

function resolveRelative(fromFile, specifier) {
	const target = path.resolve(path.dirname(fromFile), specifier);
	if (path.extname(target) !== "") return target;
	return `${target}.js`;
}

function packageName(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Walks the load-time relative-require graph that starts at server.js and
// returns the bare package names it reaches, plus the files it visited.
function productionRequireGraph(entry) {
	const packages = new Set();
	const visited = new Set();
	const pending = [entry];

	while (pending.length > 0) {
		const file = pending.pop();
		if (visited.has(file)) continue;
		if (!fs.existsSync(file)) throw new Error(`required file does not exist: ${file}`);
		visited.add(file);

		for (const specifier of loadTimeRequires(fs.readFileSync(file, "utf8"))) {
			if (specifier.startsWith("node:")) continue;
			if (specifier.startsWith("./") || specifier.startsWith("../")) {
				pending.push(resolveRelative(file, specifier));
				continue;
			}
			packages.add(packageName(specifier));
		}
	}

	return { packages, visited };
}

// --- the scan itself ---------------------------------------------------------

test("the scanner tells a load-time require from one inside a function", () => {
	const sample = [
		'const a = require("alpha");',
		'// const commented = require("not-counted");',
		'function lazy() { return require("@scope/beta"); }',
		'const text = "require(\\"also-not-counted\\")";',
	].join("\n");
	assert.deepEqual(loadTimeRequires(sample), ["alpha"]);
});

// --- (a) every package needed to load the server is a production dependency --

test("every package the server needs to load is in dependencies", () => {
	const { packages, visited } = productionRequireGraph(serverEntry);
	const declared = Object.keys(packageJson.dependencies || {});
	const missing = [...packages].filter(name => !declared.includes(name)).sort();

	assert.deepEqual(
		missing,
		[],
		`these packages are loaded at startup but are not listed under "dependencies" in package.json: ${missing.join(", ")}`,
	);
	assert.ok(packages.size >= 4, `the scan should reach the real server graph, found: ${[...packages].join(", ")}`);
	assert.ok(visited.size >= 5, `the scan should follow server.js into its own modules, visited ${visited.size} files`);
});

// --- (b) PGlite is loaded only when the sandbox is used ----------------------

test("local-sandbox-database.js does not require PGlite at the top level", () => {
	const file = path.join(root, "local-sandbox-database.js");
	const source = fs.readFileSync(file, "utf8");
	const loadTime = loadTimeRequires(source).filter(specifier => specifier === "@electric-sql/pglite");

	assert.deepEqual(
		loadTime,
		[],
		"a top-level require of the devDependency makes server.js unloadable when only production dependencies are installed",
	);
	// It must still be loaded where the sandbox is created, or LOCAL_SANDBOX_DB
	// would silently stop working. This is the one place a comment cannot drift
	// away from the code.
	assert.match(
		source,
		/require\(\s*["']@electric-sql\/pglite["']\s*\)/,
		"the sandbox must still require PGlite when it is actually used",
	);
});
