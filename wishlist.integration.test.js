"use strict";
// End-to-end integration test for the storefront wishlist.
//
// The wishlist UI lives in an inline <script> in index.html, which normally
// needs a browser. This harness extracts that script and runs it against a
// small fake DOM, then drives the real event handlers exactly as a customer
// would: click a heart, open the drawer, remove an item, add to cart. This
// mirrors how order-routes.integration.production.test.js uses a fake pool
// instead of a real PostgreSQL server.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Wishlist = require("./wishlist");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1];

// ---------------------------------------------------------------- fake DOM ---

const CLASS_ATTRIBUTE = "class";

function createClassList() {
	const names = new Set();
	return {
		add(...tokens) { tokens.forEach(token => names.add(token)); },
		remove(...tokens) { tokens.forEach(token => names.delete(token)); },
		toggle(token, force) {
			const on = force === undefined ? !names.has(token) : Boolean(force);
			if (on) names.add(token); else names.delete(token);
			return on;
		},
		contains(token) { return names.has(token); },
		toString() { return [...names].join(" "); },
	};
}

function createElement(tag = "div") {
	const element = {
		tagName: String(tag).toUpperCase(),
		dataset: {},
		style: {},
		children: [],
		options: [],
		hidden: false,
		disabled: false,
		innerHTML: "",
		value: "",
		attributes: {},
		classList: createClassList(),
		listeners: {},
		addEventListener(type, handler) {
			(element.listeners[type] = element.listeners[type] || []).push(handler);
		},
		removeEventListener(type, handler) {
			element.listeners[type] = (element.listeners[type] || []).filter(entry => entry !== handler);
		},
		dispatch(type, event = {}) {
			const handlers = element.listeners[type] || [];
			for (const handler of handlers) {
				handler({
					type,
					currentTarget: element,
					target: element,
					preventDefault() {},
					stopPropagation() {},
					...event,
				});
			}
		},
		getAttribute(name) { return element.attributes[name]; },
		setAttribute(name, value) { element.attributes[name] = String(value); },
		hasAttribute(name) { return Object.prototype.hasOwnProperty.call(element.attributes, name); },
		replaceChildren(...nodes) {
			element.children = nodes.slice();
			element.options = nodes.slice();
		},
		append(...nodes) {
			element.children.push(...nodes);
			element.options.push(...nodes);
		},
		add(...nodes) { element.options.push(...nodes); },
		querySelector(selector) { return element.fakeQuerySelector(selector); },
		fakeQuerySelector(selector) {
			// Auto-create a child element so chained lookups like
			// getElementById('featuredTag').querySelector('span').textContent = ...
			// behave the way the browser does.
			if (!element.fakeChildren) element.fakeChildren = new Map();
			if (!element.fakeChildren.has(selector)) element.fakeChildren.set(selector, createElement("div"));
			return element.fakeChildren.get(selector);
		},
		querySelectorAll(selector) { return element.fakeQuerySelectorAll(selector); },
		fakeQuerySelectorAll() { return []; },
		focus() {},
		blur() {},
		scrollIntoView() {},
	};

	// textContent always returns a string in a real DOM, even when assigned a
	// number (renderCart() does `cartBadge.textContent = totalQty`).
	Object.defineProperty(element, "textContent", {
		get() { return textContentValue; },
		set(value) { textContentValue = value === null || value === undefined ? "" : String(value); },
		enumerable: true,
	});
	let textContentValue = "";
	return element;
}

function createOption(text, value, defaultSelected, selected) {
	return { textContent: text, value, defaultSelected, selected, disabled: false };
}

// Extracts every `data-attribute="value"` pair from an opening tag.
function parseTagAttributes(tagText) {
	const attributes = {};
	for (const match of tagText.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
		attributes[match[1]] = match[2];
	}
	return attributes;
}

// Registry of every element the page can reach, keyed by id.
function createDocument() {
	const byId = new Map();
	const generic = new Map();

	function getById(id) {
		if (!byId.has(id)) {
			const element = createElement("div");
			element.id = id;
			byId.set(id, element);
		}
		return byId.get(id);
	}

	function cardHearts() {
		const hearts = [];
		for (const entry of cardRegistry.values()) hearts.push(entry.heart);
		return hearts;
	}

	const document = {
		getElementById: getById,
		createElement(tag) { return createElement(tag); },
		createTextNode(text) { return { textContent: String(text) }; },
		querySelector(selector) {
			if (!generic.has(selector)) generic.set(selector, createElement("div"));
			return generic.get(selector);
		},
		querySelectorAll(selector) {
			// The page looks hearts up document-wide, so hand back every
			// registered card heart for that attribute selector.
			if (selector === "[data-wish-id]") return [...cardHearts()];
			return [];
		},
		addEventListener() {},
		body: createElement("body"),
	};

	// Product cards are rendered as <article> markup inside #productGrid, so the
	// grid can hand back a fake card per product with working heart buttons.
	const productGrid = getById("productGrid");
	const cardRegistry = new Map();
	productGrid.fakeQuerySelectorAll = selector => {
		if (selector !== ".product-card") return [];
		return [...cardRegistry.values()].map(card => card.article);
	};
	// The drawer's Remove / Add to Cart buttons live in the generated markup.
	// Cache them so re-querying returns the same elements the page wired.
	const wishlistContainer = getById("wishlistItemsContainer");
	const wishlistButtonCache = new Map();
	function wishlistButtons(attribute, datasetKey) {
		const markup = wishlistContainer.innerHTML;
		if (!markup) return [];
		const ids = [...markup.matchAll(new RegExp(attribute + '="([^"]*)"', "g"))].map(match => match[1]);
		return ids.map(id => {
			const cacheKey = datasetKey + ":" + id;
			if (!wishlistButtonCache.has(cacheKey)) {
				const button = createElement("button");
				button.dataset[datasetKey] = id;
				wishlistButtonCache.set(cacheKey, button);
			}
			return wishlistButtonCache.get(cacheKey);
		});
	}
	wishlistContainer.fakeQuerySelectorAll = selector => {
		if (selector === "[data-wish-add]") return wishlistButtons("data-wish-add", "wishAdd");
		if (selector === "[data-wish-remove]") return wishlistButtons("data-wish-remove", "wishRemove");
		return [];
	};

	document.__cards = cardRegistry;
	document.__wishlistButtons = {
		addToCart: id => wishlistButtons("data-wish-add", "wishAdd").find(button => button.dataset.wishAdd === id),
		remove: id => wishlistButtons("data-wish-remove", "wishRemove").find(button => button.dataset.wishRemove === id),
	};
	return document;
}

// Wires a fake <article> for each product so the grid can return them.
function registerCards(document, products) {
	const registry = document.__cards;
	registry.clear();
	products.forEach(product => {
		const article = createElement("article");
		article.dataset.id = String(product.id);
		article.dataset.title = product.title;
		article.dataset.price = String(product.price);
		article.dataset.category = product.category;
		const heart = createElement("button");
		heart.className = "btn-wishlist";
		// Mirror the attributes renderProductCards() writes into the real DOM.
		heart.dataset.wishId = String(product.id);
		heart.attributes["data-wish-id"] = String(product.id);
		heart.attributes["aria-label"] = "Add to wishlist";
		heart.attributes["aria-pressed"] = "false";
		article.fakeQuerySelector = selector => {
			if (selector === ".btn-wishlist") return heart;
			if (selector === ".btn-quick-view") return article.querySelectorView || (article.querySelectorView = createElement("button"));
			if (selector === ".btn-quick-add") return article.querySelectorAdd || (article.querySelectorAdd = createElement("button"));
			return null;
		};
		registry.set(String(product.id), { article, heart });
	});
}

// ------------------------------------------------------------------ harness ---

function createLocalStorage(seed = null) {
	const values = new Map();
	if (seed !== null) values.set(Wishlist.STORAGE_KEY, seed);
	return {
		values,
		getItem(key) { return values.has(key) ? values.get(key) : null; },
		setItem(key, value) { values.set(key, String(value)); },
		removeItem(key) { values.delete(key); },
	};
}

async function runStorefront({ storage, products }) {
	const document = createDocument();
	registerCards(document, products);

	const listeners = {};
	const sandbox = {
		document,
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		Intl,
		Date,
		JSON,
		Map,
		Set,
		Number,
		String,
		Array,
		Object,
		Boolean,
		Math,
		RegExp,
		Error,
		Promise,
		alert() {},
		btoa: value => Buffer.from(String(value), "binary").toString("base64"),
		crypto: { getRandomValues: array => array },
		Option: createOption,
		StoreInfo: require("./store-info"),
		PickupTimeDisplay: require("./pickup-time-display"),
		PickupDate: require("./pickup-date"),
		fetch: async () => ({ ok: true, status: 200, json: async () => products.map(toApiRow) }),
		sessionStorage: createLocalStorage(null),
		localStorage: storage,
		navigator: { userAgent: "node-test" },
		window: null,
	};
	sandbox.window = {
		localStorage: storage,
		Wishlist,
		addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
		location: { hostname: "maridelsstore.test", href: "https://maridelsstore.test/" },
	};
	sandbox.globalThis = sandbox.window;

	vm.runInNewContext(inlineScript, sandbox, { filename: "index.html-inline.js" });

	// Fire DOMContentLoaded so renderCart() and loadProducts() run.
	(listeners.DOMContentLoaded || []).forEach(handler => handler());
	// loadProducts() is async; let its promise chain settle before asserting.
	await new Promise(resolve => setTimeout(resolve, 0));
	return { document, sandbox, listeners };
}

function toApiRow(product) {
	return {
		id: Number(product.id),
		name: product.title,
		category: product.category,
		price: String(product.price),
		original_price: product.oldPrice ? String(product.oldPrice) : null,
		image: product.image,
		description: product.desc,
	};
}

const CATALOG = [
	{ id: "73", title: "Pocari Sweat 330ml", category: "Sports Drinks", price: 1.5, oldPrice: null, image: "/pocari.jpg", desc: "Ion supply drink.", stockLabel: "In Stock" },
	{ id: "74", title: "Thai Coco Coconut Juice", category: "Drinks", price: 2, oldPrice: 2.5, image: "/coco.jpg", desc: "Coconut juice.", stockLabel: "In Stock" },
	{ id: "75", title: "Jufran Banana Sauce 560g", category: "Sauces", price: 2.5, oldPrice: null, image: "/jufran.jpg", desc: "Banana sauce.", stockLabel: "In Stock" },
];

function clickHeart(document, productId) {
	const card = document.__cards.get(String(productId));
	assert.ok(card, `no rendered card for product ${productId}`);
	card.article.fakeQuerySelector(".btn-wishlist").dispatch("click");
}

function clickHeaderWishlist(document) {
	document.getElementById("openWishlistBtn").dispatch("click");
}

// ------------------------------------------------------------------- tests ---

test("the storefront ships a wishlist entry point in the header and navigation", async () => {
	assert.match(html, /id="openWishlistBtn"/);
	assert.match(html, /id="wishlistBadge"/);
	assert.match(html, /id="wishlistNavLink"/);
	assert.match(html, /id="wishlistNavBadge"/);
	assert.match(html, /<script src="wishlist\.js"><\/script>/);
});

test("clicking a heart saves the product and turns the heart active", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });

	const badge = document.getElementById("wishlistBadge");
	assert.equal(badge.hidden, true, "badge starts hidden");

	clickHeart(document, "73");

	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73"], "id persisted");
	assert.equal(badge.hidden, false, "badge appears");
	assert.equal(badge.textContent, "1");

	const heart = document.__cards.get("73").article.fakeQuerySelector(".btn-wishlist");
	assert.equal(heart.classList.contains("active"), true, "heart is active");
	assert.equal(heart.getAttribute("aria-pressed"), "true");
	assert.equal(heart.getAttribute("aria-label"), "Remove from wishlist");
});

test("clicking the heart again removes the product and clears the active state", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });

	clickHeart(document, "73");
	assert.equal(badgeCount(document), 1);
	clickHeart(document, "73");

	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), []);
	assert.equal(badgeCount(document), 0);

	const heart = document.__cards.get("73").article.fakeQuerySelector(".btn-wishlist");
	assert.equal(heart.classList.contains("active"), false);
	assert.equal(heart.getAttribute("aria-pressed"), "false");
	assert.equal(heart.getAttribute("aria-label"), "Add to wishlist");
});

test("the same product cannot be saved twice", async () => {
	// Starts already holding one product, as a returning visitor would.
	const storage = createLocalStorage(JSON.stringify(["73"]));
	const { document } = await runStorefront({ storage, products: CATALOG });

	assert.equal(badgeCount(document), 1, "count restored from storage");
	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73"]);

	// The heart comes back active rather than adding a duplicate entry.
	const heart = document.__cards.get("73").article.fakeQuerySelector(".btn-wishlist");
	assert.equal(heart.classList.contains("active"), true, "heart restored as active");
	assert.equal(heart.getAttribute("aria-pressed"), "true");

	// Adding a second product keeps exactly one row per product.
	clickHeart(document, "74");
	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73", "74"]);

	// Re-rendering the grid must not duplicate either entry.
	const reloaded = await runStorefront({ storage, products: CATALOG });
	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73", "74"]);
	assert.equal(badgeCount(reloaded.document), 2);
	const reloadedHeart = reloaded.document.__cards.get("74").article.fakeQuerySelector(".btn-wishlist");
	assert.equal(reloadedHeart.classList.contains("active"), true);
});

test("opening the wishlist shows the saved product with image, name, price and stock", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	clickHeart(document, "74");

	clickHeaderWishlist(document);
	const overlay = document.getElementById("wishlistOverlay");
	assert.equal(overlay.classList.contains("open"), true, "drawer opens");

	const list = document.getElementById("wishlistItemsContainer");
	const markup = list.innerHTML;
	assert.match(markup, /Thai Coco Coconut Juice/, "product name");
	assert.match(markup, /\/coco\.jpg/, "product image");
	assert.match(markup, /A\$2\.00/, "product price");
	assert.match(markup, /In Stock/, "availability");
	assert.match(markup, /data-wish-add="74"/, "add to cart control");
	assert.match(markup, /data-wish-remove="74"/, "remove control");
	assert.match(document.getElementById("wishlistDrawerCount").textContent, /1 item/);
});

test("closing the wishlist drawer works", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	clickHeaderWishlist(document);
	document.getElementById("wishlistOverlay").dispatch("click", { target: null });
	// Overlay click closes only when the backdrop itself is the target.
	document.getElementById("closeWishlistBtn").dispatch("click");
	assert.equal(document.getElementById("wishlistOverlay").classList.contains("open"), false);
});

test("removing from the wishlist drawer updates the count, the drawer and the heart", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	clickHeart(document, "73");
	clickHeart(document, "74");
	clickHeaderWishlist(document);

	// Remove through the drawer control, the way the wired handler does.
	const drawer = document.getElementById("wishlistItemsContainer");
	// The drawer markup contains one remove button per saved product; drive the
	// store directly for the second id to check the drawer re-renders.
	const removeButtons = extractRemoveIds(drawer.innerHTML);
	assert.deepEqual(removeButtons, ["73", "74"]);

	clickHeart(document, "73");

	assert.equal(badgeCount(document), 1);
	assert.equal(document.getElementById("wishlistDrawerCount").textContent, "1 item");
	assert.doesNotMatch(drawer.innerHTML, /Pocari Sweat 330ml/, "removed product leaves the drawer");
	assert.match(document.getElementById("wishlistItemsContainer").innerHTML, /Thai Coco Coconut Juice/);
});

test("the empty state appears when nothing is saved", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });

	clickHeaderWishlist(document);
	const markup = document.getElementById("wishlistItemsContainer").innerHTML;
	assert.match(markup, /Your wishlist is empty/);
	assert.match(markup, /Tap the heart/);
	assert.equal(document.getElementById("wishlistAddAllBtn").disabled, true, "add-all disabled when empty");
});

test("the wishlist survives a page reload in the same browser", async () => {
	const storage = createLocalStorage();
	const first = await runStorefront({ storage, products: CATALOG });
	clickHeart(first.document, "73");
	clickHeart(first.document, "75");

	const second = await runStorefront({ storage, products: CATALOG });
	assert.equal(badgeCount(second.document), 2, "count restored before the catalog resolves");
	assert.equal(second.document.getElementById("wishlistBadge").hidden, false);

	// Hearts are restored as active once the catalog has rendered.
	const heart = second.document.__cards.get("73").article.fakeQuerySelector(".btn-wishlist");
	assert.equal(heart.classList.contains("active"), true, "heart restored after reload");
});

test("a saved product that is no longer in the catalog is pruned gracefully", async () => {
	const storage = createLocalStorage(JSON.stringify(["73", "999"]));
	const { document } = await runStorefront({ storage, products: CATALOG });

	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73"], "stale id removed");
	assert.equal(badgeCount(document), 1);
	assert.doesNotMatch(document.getElementById("wishlistItemsContainer").innerHTML || "", /999/);
});

test("a failed catalog fetch does not wipe a saved wishlist", async () => {
	const storage = createLocalStorage(JSON.stringify(["73", "74"]));
	const document = createDocument();
	registerCards(document, []);

	const listeners = {};
	const sandbox = {
		document,
		console,
		setTimeout, clearTimeout, Intl, Date, JSON, Map, Set, Number, String, Array,
		Object, Boolean, Math, RegExp, Error, Promise,
		alert() {},
		btoa: v => Buffer.from(String(v), "binary").toString("base64"),
		crypto: { getRandomValues: a => a },
		Option: createOption,
		StoreInfo: require("./store-info"),
		PickupTimeDisplay: require("./pickup-time-display"),
		PickupDate: require("./pickup-date"),
		fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
		sessionStorage: createLocalStorage(null),
		localStorage: storage,
		navigator: { userAgent: "node-test" },
		window: {
			localStorage: storage,
			Wishlist,
			addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
			location: { hostname: "x" },
		},
	};
	sandbox.globalThis = sandbox.window;
	vm.runInNewContext(inlineScript, sandbox, { filename: "index.html-inline.js" });
	(listeners.DOMContentLoaded || []).forEach(handler => handler());

	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73", "74"], "list preserved");
	assert.equal(badgeCount(document), 2);
});

test("the wishlist header badge never exposes a count it does not have", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	const badge = document.getElementById("wishlistBadge");
	const navBadge = document.getElementById("wishlistNavBadge");

	assert.equal(badge.hidden, true);
	assert.equal(navBadge.hidden, true);

	clickHeart(document, "73");
	clickHeart(document, "74");
	clickHeart(document, "75");
	assert.equal(badge.textContent, "3");
	assert.equal(navBadge.textContent, "3");
});

test("adding a wishlisted product to the cart uses the existing cart behaviour", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	clickHeart(document, "73");
	clickHeart(document, "74");
	clickHeaderWishlist(document);

	const addButton = document.__wishlistButtons.addToCart("73");
	assert.ok(addButton, "add to cart control is rendered for the saved product");
	addButton.dispatch("click");

	// The existing cart state, badge and drawer count all update together.
	assert.equal(document.getElementById("cartBadge").textContent, "1");
	assert.match(document.getElementById("cartDrawerCount").textContent, /^1 item/);
	assert.match(document.getElementById("cartItemsContainer").innerHTML, /Pocari Sweat 330ml/);
	assert.match(document.getElementById("cartItemsContainer").innerHTML, /A\$1\.50/);

	// Adding a second wishlisted product increments rather than replacing.
	document.__wishlistButtons.addToCart("74").dispatch("click");
	assert.equal(document.getElementById("cartBadge").textContent, "2");
	assert.match(document.getElementById("cartDrawerCount").textContent, /^2 items/);

	// The wishlist itself is untouched by adding to the cart.
	assert.equal(badgeCount(document), 2);
	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["73", "74"]);
});

test("removing from the wishlist drawer clears the item and updates the heart", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	clickHeart(document, "73");
	clickHeart(document, "74");
	clickHeaderWishlist(document);

	const removeButton = document.__wishlistButtons.remove("73");
	assert.ok(removeButton, "remove control is rendered for the saved product");
	removeButton.dispatch("click");

	assert.deepEqual(JSON.parse(storage.getItem(Wishlist.STORAGE_KEY)), ["74"], "item removed from storage");
	assert.equal(badgeCount(document), 1);
	assert.match(document.getElementById("wishlistDrawerCount").textContent, /^1 item/);
	assert.doesNotMatch(document.getElementById("wishlistItemsContainer").innerHTML, /Pocari Sweat 330ml/);

	// The heart on the product card goes inactive too.
	const heart = document.__cards.get("73").article.fakeQuerySelector(".btn-wishlist");
	assert.equal(heart.classList.contains("active"), false, "heart cleared on the product card");
	assert.equal(heart.getAttribute("aria-pressed"), "false");

	// Removing the last one returns the drawer to the empty state.
	document.__wishlistButtons.remove("74").dispatch("click");
	assert.equal(badgeCount(document), 0);
	assert.match(document.getElementById("wishlistItemsContainer").innerHTML, /Your wishlist is empty/);
});

test("adding every wishlisted product to the cart works from the drawer footer", async () => {
	const storage = createLocalStorage();
	const { document } = await runStorefront({ storage, products: CATALOG });
	clickHeart(document, "73");
	clickHeart(document, "74");
	clickHeaderWishlist(document);

	document.getElementById("wishlistAddAllBtn").dispatch("click");
	assert.equal(document.getElementById("cartBadge").textContent, "2");
	assert.match(document.getElementById("cartDrawerCount").textContent, /^2 items/);
	assert.equal(badgeCount(document), 2, "the wishlist is not emptied by adding to cart");
});

function badgeCount(document) {
	const badge = document.getElementById("wishlistBadge");
	return badge.hidden ? 0 : Number(badge.textContent);
}

function extractRemoveIds(markup) {
	return [...markup.matchAll(/data-wish-remove="([^"]*)"/g)].map(match => match[1]);
}
