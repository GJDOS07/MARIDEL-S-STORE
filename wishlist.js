"use strict";

// Wishlist state for the Maridel's Store storefront.
//
// Guests are supported: no customer accounts and no server-side wishlist table
// exist in this project, so the wishlist is browser-local. Only stable product
// IDs are ever persisted. No credentials, tokens, names, contact details, or
// order data are written to storage.
//
// Written in the same dual-export style as store-info.js / pickup-time-display.js
// so the same file runs in the browser and in the Node test runner.

(function exposeWishlist(root) {
	const STORAGE_KEY = "maridelWishlist";
	const MAX_WISHLIST_ITEMS = 200;
	const MAX_ID_LENGTH = 64;

	// Product identifiers are whatever the catalog uses. The storefront maps
	// mapApiProduct() to String(id), so both numbers and strings are accepted.
	function normalizeProductId(value) {
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return null;
			const truncated = Math.trunc(value);
			return truncated > 0 ? String(truncated) : null;
		}
		if (typeof value !== "string") return null;
		const trimmed = value.trim();
		if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
		return trimmed;
	}

	// Tolerant reader: corrupt JSON, a non-array payload, non-string entries,
	// over-long identifiers and duplicates are all dropped instead of throwing.
	function parseStoredIds(raw) {
		if (typeof raw !== "string" || raw.length === 0) return [];
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return [];
		}
		if (!Array.isArray(parsed)) return [];

		const seen = new Set();
		const ids = [];
		for (const entry of parsed) {
			const id = normalizeProductId(entry);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
			if (ids.length >= MAX_WISHLIST_ITEMS) break;
		}
		return ids;
	}

	function createMemoryStorage() {
		const values = new Map();
		return {
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

	// Accepts only something that behaves like Storage. Safari private mode and
	// disabled-storage browsers throw on write, so a real probe is required
	// rather than a feature check.
	function resolveStorage(candidate) {
		if (!candidate || typeof candidate.getItem !== "function" || typeof candidate.setItem !== "function") {
			return null;
		}
		try {
			const probeKey = `${STORAGE_KEY}:probe`;
			candidate.setItem(probeKey, "1");
			candidate.removeItem(probeKey);
			return candidate;
		} catch {
			return null;
		}
	}

	function createWishlistStore(options = {}) {
		const provided = Object.prototype.hasOwnProperty.call(options, "storage")
			? options.storage
			: (root && typeof root.localStorage !== "undefined" ? root.localStorage : null);
		const storage = provided === null ? null : resolveStorage(provided);
		let ids = parseStoredIds(storage ? storage.getItem(STORAGE_KEY) : null);

		function persist() {
			if (!storage) return;
			try {
				storage.setItem(STORAGE_KEY, JSON.stringify(ids));
			} catch {
				// Storage full or blocked: keep the in-memory list authoritative
				// so the current session still behaves correctly.
			}
		}

		function read() {
			return ids.slice();
		}

		function has(id) {
			const normalized = normalizeProductId(id);
			return normalized ? ids.indexOf(normalized) !== -1 : false;
		}

		function size() {
			return ids.length;
		}

		function add(id) {
			const normalized = normalizeProductId(id);
			if (!normalized) return { active: false, added: false };
			if (ids.indexOf(normalized) !== -1) return { active: true, added: false };
			ids.push(normalized);
			if (ids.length > MAX_WISHLIST_ITEMS) ids = ids.slice(ids.length - MAX_WISHLIST_ITEMS);
			persist();
			return { active: true, added: true };
		}

		function remove(id) {
			const normalized = normalizeProductId(id);
			if (!normalized) return { active: false, removed: false };
			const index = ids.indexOf(normalized);
			if (index === -1) return { active: false, removed: false };
			ids.splice(index, 1);
			persist();
			return { active: false, removed: true };
		}

		function toggle(id) {
			const normalized = normalizeProductId(id);
			if (!normalized) return { active: false, changed: false };
			if (ids.indexOf(normalized) !== -1) {
				return { active: false, changed: remove(normalized).removed };
			}
			return { active: true, changed: add(normalized).added };
		}

		// Drops identifiers that are no longer offered by the catalog. Pass null
		// while the catalog is still loading so a failed or empty fetch can
		// never wipe a customer's saved list.
		function prune(knownIds) {
			if (!Array.isArray(knownIds)) return [];
			const known = new Set(knownIds.map(normalizeProductId).filter(Boolean));
			const removed = ids.filter(id => !known.has(id));
			if (removed.length === 0) return removed;
			ids = ids.filter(id => known.has(id));
			persist();
			return removed;
		}

		return Object.freeze({
			read,
			has,
			size,
			add,
			remove,
			toggle,
			prune,
			storageKey: STORAGE_KEY,
		});
	}

	const api = Object.freeze({
		STORAGE_KEY,
		MAX_WISHLIST_ITEMS,
		createWishlistStore,
		createMemoryStorage,
		normalizeProductId,
		parseStoredIds,
	});

	if (typeof module === "object" && module.exports) {
		module.exports = api;
	} else {
		root.Wishlist = api;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
