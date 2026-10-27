"use strict";
// Unit tests for the wishlist store. All tests use an injected storage object
// or the built-in memory storage; none touch a real browser or a database.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	STORAGE_KEY,
	MAX_WISHLIST_ITEMS,
	createWishlistStore,
	createMemoryStorage,
	normalizeProductId,
	parseStoredIds,
} = require("./wishlist");

function makeFakeStorage(initial = null) {
	const values = new Map();
	if (initial !== null) values.set(STORAGE_KEY, initial);
	return {
		values,
		getItem(key) {
			return values.has(key) ? values.get(key) : null;
		},
		setItem(key, value) {
			values.set(key, String(value));
		},
		removeItem(key) {
			values.delete(key);
		},
	};
}

test("adds a product id once and reports it active", () => {
	const store = createWishlistStore({ storage: makeFakeStorage() });
	assert.equal(store.size(), 0);

	const first = store.add("73");
	assert.deepEqual(first, { active: true, added: true });
	assert.equal(store.size(), 1);
	assert.equal(store.has("73"), true);
});

test("never stores duplicate wishlist entries", () => {
	const store = createWishlistStore({ storage: makeFakeStorage() });
	store.add("73");
	store.add("73");
	store.add("73");

	assert.equal(store.size(), 1);
	assert.deepEqual(store.read(), ["73"]);
});

test("toggle adds then removes the same product", () => {
	const store = createWishlistStore({ storage: makeFakeStorage() });

	assert.deepEqual(store.toggle("73"), { active: true, changed: true });
	assert.equal(store.has("73"), true);
	assert.deepEqual(store.toggle("73"), { active: false, changed: true });
	assert.equal(store.has("73"), false);
	assert.equal(store.size(), 0);
});

test("toggle is a no-op for an unusable identifier", () => {
	const store = createWishlistStore({ storage: makeFakeStorage() });
	for (const value of [null, undefined, "", "   ", {}, [], true, Number.NaN]) {
		assert.deepEqual(store.toggle(value), { active: false, changed: false }, `toggled ${String(value)}`);
	}
	assert.equal(store.size(), 0);
});

test("numeric and string identifiers for the same product are treated as one", () => {
	const store = createWishlistStore({ storage: makeFakeStorage() });
	store.add(73);
	store.add("73");
	assert.equal(store.size(), 1);
	assert.deepEqual(store.read(), ["73"]);
});

test("persists the wishlist so it survives a reload in the same browser", () => {
	const storage = makeFakeStorage();
	const first = createWishlistStore({ storage });
	first.add("73");
	first.add("74");

	// A new store over the same storage simulates a page reload.
	const reloaded = createWishlistStore({ storage });
	assert.deepEqual(reloaded.read(), ["73", "74"]);
	assert.equal(reloaded.has("74"), true);
});

test("round-trips through JSON under the documented storage key", () => {
	const storage = makeFakeStorage();
	const store = createWishlistStore({ storage });
	store.add("73");
	store.add("90");

	const stored = storage.getItem(STORAGE_KEY);
	assert.equal(STORAGE_KEY, "maridelWishlist");
	assert.deepEqual(JSON.parse(stored), ["73", "90"]);
	assert.ok(Array.isArray(JSON.parse(stored)), "payload must be a JSON array");
});

test("stores only product identifiers and nothing sensitive", () => {
	const storage = makeFakeStorage();
	const store = createWishlistStore({ storage });
	store.add("73");
	store.add(74);

	const payload = JSON.parse(storage.getItem(STORAGE_KEY));
	assert.ok(payload.every(entry => typeof entry === "string"), "only string ids are persisted");
	assert.ok(payload.every(entry => entry.length > 0 && entry.length <= 64), "ids must be non-empty and bounded");
	for (const forbidden of ["password", "session", "token", "secret", "email", "DATABASE_URL"]) {
		assert.ok(
			!storage.getItem(STORAGE_KEY).toLowerCase().includes(forbidden.toLowerCase()),
			`storage must never contain ${forbidden}`,
		);
	}
});

test("survives corrupt or unexpected stored data without throwing", () => {
	for (const raw of ["not json", "{", "null", '"73"', "{}", "[1,2", "[]"]) {
		const store = createWishlistStore({ storage: makeFakeStorage(raw) });
		assert.equal(store.size(), 0, `payload ${raw} should load as empty`);
		assert.deepEqual(store.read(), []);
	}
});

test("drops duplicates and junk from previously stored data", () => {
	const raw = JSON.stringify(["73", "73", "", "   ", 74, 75, {}, null, true, "x".repeat(200), "76"]);
	const store = createWishlistStore({ storage: makeFakeStorage(raw) });
	assert.deepEqual(store.read(), ["73", "74", "75", "76"]);
	assert.equal(store.size(), 4);
});

test("caps the number of saved products defensively", () => {
	const raw = JSON.stringify(Array.from({ length: 500 }, (_, index) => String(index + 1)));
	const store = createWishlistStore({ storage: makeFakeStorage(raw) });
	assert.equal(store.size(), MAX_WISHLIST_ITEMS);
	assert.equal(MAX_WISHLIST_ITEMS, 200);
});

test("falls back to memory when browser storage is unavailable", () => {
	const store = createWishlistStore({ storage: null });
	assert.equal(store.size(), 0);
	assert.deepEqual(store.add("73"), { active: true, added: true });
	assert.equal(store.has("73"), true);
	assert.deepEqual(store.remove("73"), { active: false, removed: true });
	assert.equal(store.size(), 0);
});

test("rejects a storage-like object that cannot be written", () => {
	const blocked = {
		getItem() { return null; },
		setItem() { throw new Error("QuotaExceededError"); },
		removeItem() {},
	};
	const store = createWishlistStore({ storage: blocked });
	assert.deepEqual(store.add("73"), { active: true, added: true });
	assert.equal(store.has("73"), true);
	assert.equal(store.size(), 1);
});

test("keeps working when a later write fails after a successful one", () => {
	let failWrites = false;
	const flaky = {
		values: new Map(),
		getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
		setItem(key, value) {
			if (failWrites) throw new Error("QuotaExceededError");
			this.values.set(key, String(value));
		},
		removeItem(key) { this.values.delete(key); },
	};
	const store = createWishlistStore({ storage: flaky });
	store.add("73");
	failWrites = true;

	// In-memory state stays authoritative even though persistence is lost.
	assert.deepEqual(store.add("74"), { active: true, added: true });
	assert.equal(store.size(), 2);
	assert.equal(store.has("74"), true);
});

test("memory storage behaves like a real Storage object", () => {
	const storage = createMemoryStorage();
	assert.equal(storage.getItem(STORAGE_KEY), null);
	storage.setItem(STORAGE_KEY, '["73"]');
	assert.equal(storage.getItem(STORAGE_KEY), '["73"]');
	storage.removeItem(STORAGE_KEY);
	assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("prunes products that are no longer in the catalog", () => {
	const storage = makeFakeStorage();
	const store = createWishlistStore({ storage });
	store.add("73");
	store.add("74");
	store.add("999");

	const removed = store.prune(["73", "74"]);
	assert.deepEqual(removed, ["999"]);
	assert.deepEqual(store.read(), ["73", "74"]);

	// Pruning again is a no-op and does not re-persist needlessly.
	assert.deepEqual(store.prune(["73", "74"]), []);
	assert.deepEqual(store.read(), ["73", "74"]);
});

test("prune never wipes the list while the catalog is still loading", () => {
	const storage = makeFakeStorage();
	const store = createWishlistStore({ storage });
	store.add("73");
	store.add("74");

	for (const notLoaded of [null, undefined, "73,74", 42, {}]) {
		assert.deepEqual(store.prune(notLoaded), [], `prune(${String(notLoaded)}) must not remove anything`);
	}
	assert.deepEqual(store.read(), ["73", "74"]);
});

test("prune removes every entry when the catalog is genuinely empty", () => {
	const storage = makeFakeStorage();
	const store = createWishlistStore({ storage });
	store.add("73");

	assert.deepEqual(store.prune([]), ["73"]);
	assert.equal(store.size(), 0);
	assert.deepEqual(store.read(), []);
});

test("normalizeProductId accepts catalog identifiers and rejects noise", () => {
	assert.equal(normalizeProductId("73"), "73");
	assert.equal(normalizeProductId(73), "73");
	assert.equal(normalizeProductId(" 73 "), "73");
	assert.equal(normalizeProductId(73.9), "73");
	assert.equal(normalizeProductId("abc-123"), "abc-123");

	for (const bad of [null, undefined, "", "   ", "x".repeat(65), 0, -1, Number.NaN, {}, [], true]) {
		assert.equal(normalizeProductId(bad), null, `rejected ${JSON.stringify(bad)}`);
	}
});

test("parseStoredIds tolerates every malformed payload", () => {
	assert.deepEqual(parseStoredIds(""), []);
	assert.deepEqual(parseStoredIds("nope"), []);
	assert.deepEqual(parseStoredIds("null"), []);
	assert.deepEqual(parseStoredIds('"73"'), []);
	assert.deepEqual(parseStoredIds("{}"), []);
	assert.deepEqual(parseStoredIds(JSON.stringify(["1", "1", "2"])), ["1", "2"]);
});

test("read returns a copy so callers cannot mutate internal state", () => {
	const store = createWishlistStore({ storage: makeFakeStorage() });
	store.add("73");
	const snapshot = store.read();
	snapshot.push("99");
	assert.deepEqual(store.read(), ["73"]);
	assert.equal(store.has("99"), false);
});

test("the storage key is namespaced to this store", () => {
	assert.equal(STORAGE_KEY, "maridelWishlist");
	const store = createWishlistStore({ storage: makeFakeStorage() });
	assert.equal(store.storageKey, "maridelWishlist");
});
