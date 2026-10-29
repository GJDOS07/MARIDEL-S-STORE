"use strict";

const API_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
	? "http://localhost:3000"
	: "https://maridel-s-store.onrender.com";

// An uploaded product photo is stored by the API and its image value is a path
// beginning "/product-images/products/". This page is served from a different
// origin, so it has to be resolved against the API before it is displayed.
// Only that one shape is rewritten; an absolute URL, a blob: preview or an
// empty string is returned unchanged. The value that is SAVED is never this
// resolved URL: the API stores and returns the relative path.
function resolveProductImageUrl(src) {
	if (typeof src !== "string" || !src.startsWith("/product-images/products/")) return src;
	return API_BASE_URL + src;
}

const ACTIVE_STATUSES = ["Pending", "Confirmed", "Preparing", "Ready for Pickup"];
const STATUS_DISPLAY_ORDER = ["Pending", "Confirmed", "Preparing", "Ready for Pickup", "Picked Up", "Completed", "Cancelled"];

// --- order board state -------------------------------------------------------
// The board keeps the full order list and the latest sales figures separately:
// the order request rebuilds the list, the sales request only feeds the strip
// above it and it hides just that strip when it fails.
let allOrders = [];
let salesData = null;
const ordersBoard = { tab: "needs", search: "" };

// --- Melbourne clock ---------------------------------------------------------
// Every "today", relative hint and pickup label is computed against the
// business time zone with Intl, never with the browser's own clock settings, so
// the page agrees with the server (Australia/Melbourne) wherever the owner is.
const OWNER_TIME_ZONE = "Australia/Melbourne";
const OWNER_DATE_QUERY = typeof Intl !== "undefined"
	? new Intl.DateTimeFormat("en-CA", {
		timeZone: OWNER_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
	: null;
const OWNER_TIME_QUERY = typeof Intl !== "undefined"
	? new Intl.DateTimeFormat("en-GB", {
		timeZone: OWNER_TIME_ZONE,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	})
	: null;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function melbourneDateKey(instant) {
	return OWNER_DATE_QUERY ? OWNER_DATE_QUERY.format(instant) : null;
}

function melbourneTimeKey(instant) {
	return OWNER_TIME_QUERY ? OWNER_TIME_QUERY.format(instant) : null;
}

// The UTC instant a Melbourne wall-clock reading means. Reads back what the
// zone reports and corrects by the difference each pass, converging from either
// side of a daylight-saving boundary.
function melbourneWallToInstant(dateKey, timeKey) {
	const naive = Date.parse(`${dateKey}T${timeKey}:00Z`);
	if (Number.isNaN(naive)) return null;
	let guess = naive;
	for (let pass = 0; pass < 4 && !Number.isNaN(guess); pass += 1) {
		const wall = new Date(guess);
		const wallDate = melbourneDateKey(wall);
		const wallTime = melbourneTimeKey(wall);
		if (!wallDate || !wallTime) return null;
		const wallAsUtc = Date.parse(`${wallDate}T${wallTime}:00Z`);
		if (Number.isNaN(wallAsUtc)) return null;
		// Each pass re-bases on the CURRENT guess, never on the naive reading,
		// so the correction accumulates towards the fixed point instead of
		// flipping between two candidates.
		const next = naive - (wallAsUtc - guess);
		if (next === guess) break;
		guess = next;
	}
	return guess;
}
const loginPanel = document.getElementById("loginPanel");
const ordersPanel = document.getElementById("ordersPanel");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const ordersError = document.getElementById("ordersError");
const ordersList = document.getElementById("ordersList");
const logoutButton = document.getElementById("logoutButton");
const togglePassword = document.getElementById("togglePassword");
const ownerPasswordInput = document.getElementById("ownerPassword");
const resetRequestPanel = document.getElementById("resetRequestPanel");
const resetPasswordPanel = document.getElementById("resetPasswordPanel");
let csrfToken = "";

// One eye toggle per password field, each bound to its own input.
//
// The toggle only changes `type`. It never reads, copies, or clears the value, so
// revealing a field cannot lose what was typed, and repeated clicks are safe.
// ARIA state and title are kept in step with the current mode, and the element is
// a `type="button"` so it can never submit the form it sits inside.
//
// Fields that are absent are skipped rather than throwing, so the dashboard still
// runs if the markup is reverted or a panel is removed.
function wirePasswordToggle(input, button) {
	if (!input || !button) return;
	button.addEventListener("click", () => {
		const isHidden = input.type === "password";
		input.type = isHidden ? "text" : "password";
		button.setAttribute("aria-pressed", isHidden ? "true" : "false");
		button.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
		button.title = isHidden ? "Hide password" : "Show password";
	});
}

// Login, account settings, and password recovery. Four fields, four independent
// toggles.
wirePasswordToggle(ownerPasswordInput, togglePassword);
wirePasswordToggle(document.getElementById("currentPassword"), document.getElementById("toggleCurrentPassword"));
wirePasswordToggle(document.getElementById("newPassword"), document.getElementById("toggleNewPassword"));
wirePasswordToggle(document.getElementById("confirmPassword"), document.getElementById("toggleConfirmPassword"));
wirePasswordToggle(document.getElementById("resetNewPassword"), document.getElementById("toggleResetNewPassword"));
wirePasswordToggle(document.getElementById("resetConfirmPassword"), document.getElementById("toggleResetConfirmPassword"));

// The CSRF token is derived from the current session, so it is only valid while
// that session exists. Any request that ends the session clears both cookies on
// the server, and the browser deliberately does not reveal Set-Cookie to script,
// so a cached token silently goes stale. The next protected request then sends a
// stale header against an empty cookie and requireCsrf refuses it with
// "A valid CSRF token is required." — which reads like a broken login form rather
// than a token that expired with the session.
//
// Three things keep the two in step, none of which weakens the check: the token
// is still required on every protected request and must still match the cookie.
//
//   1. Before a protected request, fetch a token if none is held. Without this
//      the header was skipped entirely when the token was empty.
//   2. After an action that ends the session, discard the cached token so the
//      next request bootstraps a fresh one.
//   3. If the server still refuses the token, fetch a fresh one and retry once.
//      This also covers a session that expires server-side while the page stays
//      open, which otherwise surfaces as a confusing CSRF error instead of a
//      prompt to log in again.

async function bootstrapCsrfToken() {
	// A GET, so it never recurses into the token logic.
	await apiRequest("/api/owner/csrf");
}

function invalidateCsrfToken() {
	csrfToken = "";
	// Re-arm in the background so a following login has a token ready.
	bootstrapCsrfToken().catch(() => {});
}

async function apiRequest(path, options = {}) {
	const send = async requestOptions => {
		const response = await fetch(`${API_BASE_URL}${requestOptions.path}`, {
			...requestOptions.options,
			credentials: "include",
			headers: {
				...(requestOptions.options.body ? { "Content-Type": "application/json" } : {}),
				...(requestOptions.needsToken ? { "X-CSRF-Token": csrfToken } : {}),
				...requestOptions.options.headers,
			},
		});
		const body = await response.json().catch(() => ({}));
		return { response, body };
	};

	const needsToken = Boolean(options.method && options.method !== "GET");

	// 1. Never send a protected request without a token.
	if (needsToken && !csrfToken) await bootstrapCsrfToken();

	const first = await send({ path, options, needsToken });

	// 3. A refused token is recoverable: get a fresh one and try the request once
	// more. A second refusal is a real rejection and is surfaced unchanged.
	if (first.response.status === 403 && first.body && first.body.code === "CSRF_INVALID" && csrfToken) {
		csrfToken = "";
		await bootstrapCsrfToken();
		if (csrfToken) {
			const retry = await send({ path, options, needsToken });
			if (retry.response.ok || !(retry.body && retry.body.code === "CSRF_INVALID")) {
				if (retry.body && retry.body.csrf_token) csrfToken = retry.body.csrf_token;
				if (!retry.response.ok) throw new Error(retry.body.error || "The request could not be completed.");
				return retry.body;
			}
		}
	}

	const { response, body } = first;
	if (!response.ok) throw new Error(body.error || "The request could not be completed.");
	if (body.csrf_token) csrfToken = body.csrf_token;
	return body;
}

async function loadOrders({ focusOrderId = null } = {}) {
	ordersError.hidden = true;
	setOrdersLoading(true);
	try {
		// Orders and sales figures travel together; a sales failure never
		// surfaces here, it only hides the sales cards.
		const [orders] = await Promise.all([fetchOwnerOrders(), loadSalesData()]);
		allOrders = mergeInFlightOrders(orders);
		// The old cards stay on screen until the fresh board exists, so the
		// page never collapses and never flings the owner to the top.
		swapOrderList({ includeSales: true, focusOrderId });
	} catch (error) {
		ordersError.textContent = error.message;
		ordersError.hidden = false;
		if (error.message === "Owner login is required.") showLogin();
	} finally {
		setOrdersLoading(false);
	}
}

// One query builder for the blocking load and the quiet refresh, so both always
// ask for the same slice and the status filter keeps working unchanged.
function fetchOwnerOrders() {
	const filter = document.getElementById("statusFilter");
	const status = filter ? filter.value : "";
	const query = new URLSearchParams({ limit: "100" });
	if (status) query.set("status", status);
	return apiRequest(`/api/owner/orders?${query.toString()}`);
}

async function loadSalesData() {
	try {
		const payload = await apiRequest("/api/owner/sales");
		salesData = payload && typeof payload === "object" ? payload : null;
	} catch (error) {
		// Only the sales card may fail: the order board keeps rendering. Session
		// expiry is surfaced by the order request itself.
		salesData = null;
	}
	return salesData;
}

function setOrdersLoading(loading) {
	ordersList.setAttribute("aria-busy", loading ? "true" : "false");
}

// Fresh list data must never overwrite an order whose status request is still
// on the wire: a poll or a late refresh would flip that card back to its older
// status until the request's own authoritative merge lands. Orders that are in
// flight keep whatever the board currently shows; every other order comes
// through untouched.
function mergeInFlightOrders(orders) {
	if (!Array.isArray(orders)) return [];
	if (ordersInFlight.size === 0) return orders;
	const localById = new Map();
	for (const order of allOrders) {
		if (order && order.id !== undefined && order.id !== null) localById.set(String(order.id), order);
	}
	return orders.map(order => {
		const id = order && order.id !== undefined && order.id !== null ? String(order.id) : null;
		return id !== null && ordersInFlight.has(id) && localById.has(id) ? localById.get(id) : order;
	});
}

// --- quiet order refresh -----------------------------------------------------
//
// loadOrders stays the blocking load used after a status change. A quiet refresh
// builds the finished board off-screen and swaps it in with one replaceChildren,
// so the list never shows an empty frame. It never writes to ordersError: a
// transient failure leaves the board exactly as it was.
//
// Only orders matching the current status filter are seen, so a new order in a
// different status does not raise the notice until that filter shows it.

const ORDERS_POLL_INTERVAL_MS = 60 * 1000;
const ORDERS_TRIGGER_MIN_INTERVAL_MS = 15 * 1000;
const ORDERS_IDLE_LIMIT_MS = 30 * 60 * 1000;
const seenOrderIds = new Set();
const pendingNewOrderIds = new Set();
// Orders with a status request on the wire, keyed by id string. While an order
// is in flight its card shows the optimistic status and its buttons stay
// disabled, so a second tap cannot queue a second request and a poll racing
// the request cannot pull the card back to its older status.
const ordersInFlight = new Set();
let ordersSeenInitialized = false;
let ordersQuietTimer = null;
let ordersQuietInFlight = false;
let lastOrdersQuietAt = 0;
let lastOwnerActivityAt = Date.now();
let lastOwnerMoveActivityAt = 0;
let ordersPollingPausedForIdle = false;
let ordersIdleNote = null;
let ordersNotice = null;
let ordersNoticeText = null;
let orderNoticeBaseTitle = null;

function recordSeenOrders(orders) {
	if (Array.isArray(orders)) {
		orders.forEach(order => {
			if (order && order.id !== undefined && order.id !== null) seenOrderIds.add(String(order.id));
		});
	}
	ordersSeenInitialized = true;
}

function ensureOrdersNoticeStyles() {
	if (typeof document === "undefined" || !document.head) return;
	if (document.getElementById("ordersNoticeStyles")) return;
	const style = document.createElement("style");
	style.id = "ordersNoticeStyles";
	style.textContent = ".orders-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0;padding:10px 14px;border:1px solid #f59e0b;border-radius:10px;background:#fffbeb;color:#78350f;font-weight:600;cursor:pointer}.orders-notice[hidden]{display:none}";
	document.head.appendChild(style);
}

function ensureOrdersNotice() {
	if (ordersNotice && ordersNotice.parentNode) return ordersNotice;
	if (!ordersList || !ordersList.parentNode) return null;
	ensureOrdersNoticeStyles();
	const notice = document.createElement("div");
	notice.id = "ordersNotice";
	notice.className = "orders-notice";
	notice.setAttribute("role", "status");
	const text = document.createElement("span");
	const dismiss = document.createElement("button");
	dismiss.type = "button";
	dismiss.className = "ghost";
	dismiss.textContent = "Dismiss";
	notice.append(text, dismiss);
	notice.addEventListener("click", dismissOrderNotice);
	ordersList.parentNode.insertBefore(notice, ordersList);
	ordersNotice = notice;
	ordersNoticeText = text;
	return notice;
}

function showOrderNotice(newIds) {
	for (const id of newIds) pendingNewOrderIds.add(id);
	const count = pendingNewOrderIds.size;
	if (count === 0) return;
	const notice = ensureOrdersNotice();
	if (!notice || !ordersNoticeText) return;
	ordersNoticeText.textContent = count === 1 ? "New order received" : `${count} new orders received`;
	notice.hidden = false;
	if (orderNoticeBaseTitle === null && typeof document.title === "string") {
		orderNoticeBaseTitle = document.title;
	}
	if (orderNoticeBaseTitle !== null && typeof document.title === "string") {
		document.title = `(${count}) ${orderNoticeBaseTitle}`;
	}
}

function dismissOrderNotice() {
	pendingNewOrderIds.clear();
	if (ordersNotice && ordersNotice.parentNode) ordersNotice.parentNode.removeChild(ordersNotice);
	ordersNotice = null;
	ordersNoticeText = null;
	if (orderNoticeBaseTitle !== null) {
		if (typeof document.title === "string") document.title = orderNoticeBaseTitle;
		orderNoticeBaseTitle = null;
	}
}

function ordersPollingAllowed() {
	if (typeof document === "undefined" || document.visibilityState !== "visible") return false;
	if (typeof document.getElementById !== "function") return false;
	const tabs = document.getElementById("dashboardTabs");
	if (!tabs || tabs.hidden) return false;
	return Boolean(ordersPanel && !ordersPanel.hidden);
}

function ordersIdleExpired() {
	return Date.now() - lastOwnerActivityAt >= ORDERS_IDLE_LIMIT_MS;
}

function showOrdersIdleNote() {
	if (!ordersList || !ordersList.parentNode) return;
	if (ordersIdleNote && ordersIdleNote.parentNode) return;
	const note = document.createElement("p");
	note.id = "ordersIdleNote";
	note.className = "muted";
	note.setAttribute("role", "status");
	note.textContent = "Live updates paused because the page was idle. Move the mouse or tap to resume.";
	ordersList.parentNode.insertBefore(note, ordersList);
	ordersIdleNote = note;
}

function clearOrdersIdleNote() {
	if (ordersIdleNote && ordersIdleNote.parentNode) ordersIdleNote.parentNode.removeChild(ordersIdleNote);
	ordersIdleNote = null;
}

function pauseOrdersForIdle() {
	ordersPollingPausedForIdle = true;
	stopOrdersQuietPoll();
	showOrdersIdleNote();
}

function resumeOrdersAfterIdle() {
	if (!ordersPollingAllowed()) return;
	lastOwnerActivityAt = Date.now();
	ordersPollingPausedForIdle = false;
	clearOrdersIdleNote();
	scheduleOrdersQuietPoll();
	maybeRefreshOrdersQuietly();
}

function markOwnerActivity() {
	lastOwnerActivityAt = Date.now();
	if (ordersPollingPausedForIdle && ordersPollingAllowed()) resumeOrdersAfterIdle();
}

function markOwnerMouseMove() {
	const now = Date.now();
	if (now - lastOwnerMoveActivityAt < 1000) return;
	lastOwnerMoveActivityAt = now;
	markOwnerActivity();
}

function stopOrdersQuietPoll() {
	if (ordersQuietTimer !== null && typeof clearTimeout === "function") clearTimeout(ordersQuietTimer);
	ordersQuietTimer = null;
}

function scheduleOrdersQuietPoll() {
	stopOrdersQuietPoll();
	if (ordersPollingPausedForIdle) return;
	if (typeof setTimeout !== "function" || !ordersPollingAllowed()) return;
	ordersQuietTimer = setTimeout(async () => {
		ordersQuietTimer = null;
		try {
			if (ordersIdleExpired()) {
				pauseOrdersForIdle();
				return;
			}
			await refreshOrdersQuietly();
		} finally {
			if (!ordersPollingPausedForIdle && ordersQuietTimer === null) scheduleOrdersQuietPoll();
		}
	}, ORDERS_POLL_INTERVAL_MS);
}

async function refreshOrdersQuietly() {
	if (!ordersList || ordersQuietInFlight || !ordersPollingAllowed()) return;
	if (ordersIdleExpired()) {
		pauseOrdersForIdle();
		return;
	}
	ordersQuietInFlight = true;
	lastOrdersQuietAt = Date.now();
	try {
		const [orders] = await Promise.all([fetchOwnerOrders(), loadSalesData()]);
		if (!Array.isArray(orders)) return;
		allOrders = mergeInFlightOrders(orders);
		const firstLoad = !ordersSeenInitialized;
		const newIds = [];
		for (const order of orders) {
			if (!order || order.id === undefined || order.id === null) continue;
			const id = String(order.id);
			if (!seenOrderIds.has(id)) newIds.push(id);
		}
		let fragment;
		if (typeof DocumentFragment === "function") fragment = new DocumentFragment();
		else if (typeof document.createDocumentFragment === "function") fragment = document.createDocumentFragment();
		else return;
		const scrollY = typeof window !== "undefined" && typeof window.scrollY === "number" ? window.scrollY : null;
		// The owner may be parked with the keyboard on a card's action button
		// while the quiet refresh swaps the list underneath it; that focus
		// must survive the swap, or the follow-up press stops working.
		const focusedCardId = findFocusedOrderCardId();
		// One swap: the finished board replaces the list, so the frame never
		// goes blank. The sales strip renders alongside in its own container.
		renderOrdersInto(fragment);
		ordersList.replaceChildren(fragment);
		if (focusedCardId) restoreOrderCardFocus(focusedCardId);
		if (scrollY !== null && typeof window.scrollTo === "function" && window.scrollY !== scrollY) {
			try {
				window.scrollTo(0, scrollY);
			} catch {
				// Restoring scroll is best effort; never let it break the refresh.
			}
		}
		if (!firstLoad && newIds.length > 0) showOrderNotice(newIds);
	} catch (error) {
		if (error && error.message === "Owner login is required.") {
			showLogin();
		} else if (typeof console !== "undefined" && typeof console.warn === "function") {
			console.warn("Quiet order refresh failed:", error);
		}
	} finally {
		ordersQuietInFlight = false;
	}
}

function maybeRefreshOrdersQuietly() {
	if (!ordersPollingAllowed() || ordersQuietInFlight || ordersPollingPausedForIdle) return;
	if (ordersIdleExpired()) {
		pauseOrdersForIdle();
		return;
	}
	if (Date.now() - lastOrdersQuietAt < ORDERS_TRIGGER_MIN_INTERVAL_MS) return;
	refreshOrdersQuietly();
}

function resumeOrdersQuietRefreshing() {
	lastOwnerActivityAt = Date.now();
	if (!ordersPollingAllowed()) {
		stopOrdersQuietPoll();
		return;
	}
	if (ordersPollingPausedForIdle) {
		resumeOrdersAfterIdle();
		return;
	}
	scheduleOrdersQuietPoll();
	maybeRefreshOrdersQuietly();
}

function displayStatus(status) {
	if (status === "Completed") return "Picked Up";
	return status;
}

// A colour per stage so the order board reads at a glance instead of every card
// looking the same. The stage name stays as the visible text; this is styling.
function statusClass(status) {
	switch (status) {
	case "Pending":
		return "status status-waiting";
	case "Confirmed":
	case "Preparing":
		return "status status-active";
	case "Ready for Pickup":
		return "status status-ready";
	case "Picked Up":
		return "status status-done";
	case "Cancelled":
		return "status status-stopped";
	default:
		return "status";
	}
}

// A short plain-language note on what a stage means, so the dashboard is usable
// without the operator memorising the pipeline.
const STATUS_HINTS = {
	Pending: "New order, not yet confirmed.",
	Confirmed: "Confirmed with the customer.",
	Preparing: "Being packed for pickup.",
	"Ready for Pickup": "Ready to hand over.",
	"Picked Up": "Collected by the customer.",
	Completed: "Closed out.",
	Cancelled: "Cancelled.",
};

function orderPriority(order) {
	if (order.status === "Pending") return 0;
	if (order.status === "Confirmed") return 1;
	if (["Preparing", "Ready for Pickup"].includes(order.status)) return 2;
	if (["Picked Up", "Completed", "Cancelled"].includes(order.status)) return 3;
	return 4;
}

function pickupSortKey(order) {
	return `${order.pickup_date || ""} ${order.pickup_time || ""}`;
}

function sortByPickupUrgency(orders) {
	return [...orders].sort((a, b) => orderPriority(a) - orderPriority(b)
		|| pickupSortKey(a).localeCompare(pickupSortKey(b))
		|| String(a.id || "").localeCompare(String(b.id || "")));
}

// --- board tabs, search and the sales strip ----------------------------------
//
// The list is laid out in three buckets: what needs an owner action, what is
// waiting to be picked up, and what is finished. Sorting, search and chip
// colours are presentation only; no status transitions happen here.

const BOARD_TABS = {
	needs: {
		statuses: ["Pending", "Confirmed", "Preparing"],
		empty: "No orders need attention right now.",
		hint: "New pickup orders appear here on their own.",
	},
	upcoming: {
		statuses: ["Ready for Pickup"],
		empty: "Nothing is ready for pickup yet.",
		hint: "Confirmed and preparing orders land here once they are marked ready.",
	},
	done: {
		statuses: ["Picked Up", "Cancelled"],
		empty: "No completed or cancelled orders yet.",
		hint: "",
	},
};

function classifyOrders(orders) {
	const buckets = { needs: [], upcoming: [], done: [] };
	(orders || []).forEach(order => {
		const status = displayStatus(order && order.status);
		const bucket = Object.keys(BOARD_TABS).find(key => BOARD_TABS[key].statuses.includes(status));
		if (bucket) buckets[bucket].push(order);
		else buckets.needs.push(order); // unknown stages stay visible, never vanish
	});
	return buckets;
}

// Needs action and Upcoming run oldest pickup first; Done runs newest first.
function boardSort(orders, tab) {
	const direction = tab === "done" ? -1 : 1;
	return [...(orders || [])].sort((a, b) =>
		pickupSortKey(a).localeCompare(pickupSortKey(b)) * direction
		|| String(a.id || "").localeCompare(String(b.id || "")) * direction);
}

// Search matches the customer name, the order number and the phone number with
// every non-digit ignored, so "0412", "(04) 12" and a name all find the order.
function ordersMatchSearch(order, needle) {
	const query = needle.trim().toLowerCase();
	if (!query) return true;
	const contact = String(order.customer_contact || "");
	const haystack = [
		order.customer_name || "",
		order.order_number || "",
		`MS-${order.id}`,
		contact,
		contact.replace(/\D/g, ""),
	].join(" ").toLowerCase();
	return query.split(/\s+/).filter(Boolean).every(part => haystack.includes(part));
}

function boardEmptyNode(tab, hasSearch) {
	const wrap = document.createElement("div");
	wrap.className = "board-empty";
	const title = document.createElement("p");
	title.textContent = hasSearch ? "No orders match your search." : BOARD_TABS[tab].empty;
	wrap.append(title);
	if (!hasSearch && BOARD_TABS[tab].hint) {
		const hint = document.createElement("span");
		hint.className = "hint";
		hint.textContent = BOARD_TABS[tab].hint;
		wrap.append(hint);
	}
	return wrap;
}

function money(value) {
	const amount = Number(value);
	return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

// --- sales strip -------------------------------------------------------------
// One large "Sales today" card, the week/month/all-time figures, the Collected
// figure, and the 14-day mini bar chart, all straight from GET /owner/sales.
function buildSalesCards(data) {
	const content = document.createElement("div");
	content.className = "sales-summary";

	const big = document.createElement("div");
	big.className = "sales-card-big";
	const bigLabel = document.createElement("span");
	bigLabel.className = "sales-label";
	bigLabel.textContent = "Sales today";
	const bigValue = document.createElement("strong");
	bigValue.className = "sales-value";
	bigValue.textContent = `A$${money(data.today && data.today.sales)}`;
	const bigMeta = document.createElement("p");
	bigMeta.className = "sales-meta";
	const todayOrders = (data.today && data.today.orders) || 0;
	bigMeta.textContent = `${todayOrders} order${todayOrders === 1 ? "" : "s"} today`;
	big.append(bigLabel, bigValue, bigMeta);

	const figures = document.createElement("div");
	figures.className = "sales-figures";
	for (const [label, period] of [
		["This week", data.this_week],
		["This month", data.this_month],
		["All time", data.all_time],
	]) {
		const cell = document.createElement("div");
		cell.className = "sales-figure";
		const name = document.createElement("span");
		name.className = "sales-label";
		name.textContent = label;
		const value = document.createElement("strong");
		value.textContent = `A$${money(period && period.sales)}`;
		const count = document.createElement("small");
		count.className = "sales-count";
		const periodOrders = (period && period.orders) || 0;
		count.textContent = `${periodOrders} order${periodOrders === 1 ? "" : "s"}`;
		cell.append(name, value, count);
		figures.append(cell);
	}

	const collected = document.createElement("div");
	collected.className = "sales-collected";
	const collectedLabel = document.createElement("span");
	collectedLabel.className = "sales-label";
	collectedLabel.textContent = "Collected";
	const collectedValue = document.createElement("strong");
	collectedValue.textContent = `A$${money(data.today && data.today.collected)}`;
	const collectedMeta = document.createElement("small");
	collectedMeta.className = "sales-count";
	collectedMeta.textContent = "Picked Up payments today";
	collected.append(collectedLabel, collectedValue, collectedMeta);

	const chart = document.createElement("div");
	chart.className = "sales-chart";
	chart.setAttribute("role", "img");
	chart.setAttribute("aria-label", "Daily sales for the last 14 days");
	const daily = Array.isArray(data.daily) ? data.daily.slice(-14) : [];
	const peak = daily.reduce((max, day) => Math.max(max, Number(day && day.sales) || 0), 0);
	for (const day of daily) {
		const bar = document.createElement("div");
		const sales = Number(day && day.sales) || 0;
		bar.className = sales > 0 ? "chart-bar" : "chart-bar chart-bar-none";
		bar.style.height = sales > 0 && peak > 0 ? `${Math.max(8, Math.round((sales / peak) * 100))}%` : "4px";
		const label = `${(day && day.date) || "??"}: A$${money(sales)}`;
		bar.setAttribute("aria-label", label);
		bar.title = label;
		chart.append(bar);
	}

	const note = document.createElement("p");
	note.className = "sales-note";
	note.textContent = "Excludes cancelled orders.";

	content.append(big, figures, collected, chart, note);
	return content;
}

// --- monthly sales -----------------------------------------------------------
// A Monthly sales card under the main sales card: one bar per Melbourne
// calendar month (up to 12, from the first order's month), the current month
// highlighted, and one fair comparison line. The comparison is against the
// same days of last month (day 1 to today's day-of-month, clamped to last
// month's length), so a month half over is never compared with a full one.
// Every string is placed with textContent.
function buildMonthlySalesPanel(data) {
	const panel = document.createElement("div");
	panel.className = "sales-summary monthly-panel";

	const title = document.createElement("span");
	title.className = "sales-label";
	title.textContent = "Monthly sales";
	panel.append(title);

	const monthly = data && data.monthly;
	const months = monthly && Array.isArray(monthly.months) ? monthly.months : [];

	// No charted orders at all: say so plainly and show neither chart nor a
	// comparison, so no percentage, infinity or NaN can ever appear.
	if (!months.some(row => Number(row && row.orders) > 0)) {
		const empty = document.createElement("p");
		empty.className = "sales-note";
		empty.textContent = "No sales yet. Your first orders will chart here month by month.";
		panel.append(empty);
		return panel;
	}

	const grid = document.createElement("div");
	grid.className = "monthly-grid";
	grid.setAttribute("role", "img");
	grid.setAttribute("aria-label", "Monthly sales, newest month last");

	const peak = months.reduce((max, row) => Math.max(max, Number(row && row.sales) || 0), 0);
	const currentMonthKey = String(months[months.length - 1].month || "");
	for (const row of months) {
		const sales = Number(row.sales) || 0;
		const monthKey = String(row.month || "????-??");
		const monthIndex = Number(monthKey.slice(5, 7));

		const cell = document.createElement("div");
		cell.className = "monthly-cell";
		if (monthKey === currentMonthKey) cell.classList.add("is-current");

		const track = document.createElement("div");
		track.className = "monthly-bar-track";
		const bar = document.createElement("div");
		bar.className = sales > 0 ? "monthly-bar" : "monthly-bar monthly-bar-none";
		bar.style.height = sales > 0 && peak > 0 ? `${Math.max(8, Math.round((sales / peak) * 100))}%` : "4px";
		track.append(bar);

		const label = document.createElement("span");
		label.className = "monthly-label";
		label.textContent = `${MONTH_SHORT[monthIndex >= 1 && monthIndex <= 12 ? monthIndex - 1 : 0]} ${monthKey.slice(0, 4)}`;

		const value = document.createElement("span");
		value.className = "monthly-value";
		value.textContent = `A$${money(sales)}`;

		cell.append(track, label, value);
		grid.append(cell);
	}
	panel.append(grid);

	// The comparison line. The displayed "last month" figure is last month in
	// full; the percentage is fair because it compares like with like: this
	// month so far against the same days of last month. When last month has no
	// sales there is nothing to compare, so no percentage is ever shown.
	const soFar = Number(monthly && monthly.this_month_so_far && monthly.this_month_so_far.sales) || 0;
	const lastFull = Number(monthly && monthly.last_month && monthly.last_month.sales) || 0;
	const lastSameDays = Number(monthly && monthly.last_month_same_days && monthly.last_month_same_days.sales) || 0;
	const compare = document.createElement("p");
	compare.className = "monthly-compare";
	if (lastFull === 0) {
		compare.textContent = "No sales last month to compare.";
	} else if (lastSameDays === 0) {
		compare.textContent = `This month so far A$${money(soFar)}, last month A$${money(lastFull)}. The first days of last month had no sales to compare yet.`;
	} else {
		const change = Math.round(((soFar - lastSameDays) / lastSameDays) * 100);
		const prefix = `This month so far A$${money(soFar)}, last month A$${money(lastFull)}, `;
		if (change > 0) {
			compare.classList.add("is-up");
			compare.textContent = `${prefix}up ${change}% vs the same days last month.`;
		} else if (change < 0) {
			compare.classList.add("is-down");
			compare.textContent = `${prefix}down ${-change}% vs the same days last month.`;
		} else {
			compare.textContent = `${prefix}level with the same days last month.`;
		}
	}
	panel.append(compare);
	return panel;
}

// The strip is rebuilt on every refresh. When the sales request fails, only the
// sales card hides (as an empty placeholder); the stat tiles beside it and the
// order list always stay.
function renderSalesStrip() {
	const host = document.getElementById("salesStrip");
	if (!host) return;
	const strip = document.createElement("section");
	strip.className = "sales-strip";
	if (salesData) strip.append(buildSalesCards(salesData), buildMonthlySalesPanel(salesData));
	else {
		const placeholder = document.createElement("div");
		placeholder.className = "sales-summary";
		placeholder.hidden = true;
		strip.append(placeholder);
	}
	strip.append(renderSummary(allOrders));
	host.replaceChildren(strip);
}

function renderSummary(orders) {
	recordSeenOrders(orders);
	// Melbourne's date comes from the server response when it is available, and
	// from the business time zone otherwise — never from the browser's clock.
	const todayKey = (salesData && salesData.melbourne_today) || melbourneDateKey(new Date());
	const statList = orders || [];
	const cards = [
		{
			label: "Need attention",
			value: statList.filter(order => ["Pending", "Confirmed"].includes(displayStatus(order.status))).length,
			tone: "attention",
		},
		{
			label: "Today's pickups",
			value: statList.filter(order => displayStatus(order.status) !== "Cancelled" && order.pickup_date === todayKey).length,
			tone: "",
		},
		{
			label: "Ready for pickup",
			value: statList.filter(order => displayStatus(order.status) === "Ready for Pickup").length,
			tone: "done",
		},
	];
	const board = document.createElement("div");
	board.className = "mini-stats";
	board.id = "ordersSummary";
	for (const card of cards) {
		const tile = document.createElement("div");
		tile.className = `summary-card${card.tone ? ` is-${card.tone}` : ""}`;
		const value = document.createElement("strong");
		value.textContent = String(card.value);
		const label = document.createElement("span");
		label.textContent = card.label;
		tile.append(value, label);
		board.append(tile);
	}
	return board;
}

function updateOrderBoardTabCounts(buckets) {
	const tabsEl = document.getElementById("orderBoardTabs");
	if (!tabsEl || typeof tabsEl.querySelectorAll !== "function") return;
	for (const tab of Object.keys(BOARD_TABS)) {
		const button = tabsEl.querySelector(`[data-board-tab="${tab}"]`);
		const count = button && button.querySelector ? button.querySelector(".order-tab-count") : null;
		if (count) count.textContent = String((buckets[tab] || []).length);
	}
}

function renderOrderListInto(target) {
	// Drop menu entries whose cards left the DOM: replaced lists otherwise pile up.
	for (let index = ORDER_MENUS.length - 1; index >= 0; index -= 1) {
		const entry = ORDER_MENUS[index];
		if (typeof entry.wrap.isConnected === "boolean" && !entry.wrap.isConnected) ORDER_MENUS.splice(index, 1);
	}
	const buckets = classifyOrders(allOrders);
	updateOrderBoardTabCounts(buckets);
	const searchNeedle = ordersBoard.search;
	const searchActive = Boolean(searchNeedle && searchNeedle.trim());
	const bucket = buckets[ordersBoard.tab] || [];
	const visible = searchActive ? bucket.filter(order => ordersMatchSearch(order, searchNeedle)) : bucket;
	boardSort(visible, ordersBoard.tab).forEach(order => target.append(renderOrder(order)));
	if (visible.length === 0) target.append(boardEmptyNode(ordersBoard.tab, searchActive));
}

function buildFragment() {
	if (typeof DocumentFragment === "function") return new DocumentFragment();
	if (typeof document !== "undefined" && typeof document.createDocumentFragment === "function") {
		return document.createDocumentFragment();
	}
	return null;
}

function renderOrdersInto(target) {
	renderSalesStrip();
	renderOrderListInto(target);
}

// Swaps a finished list in with one replaceChildren while holding the page in
// place: the window scroll position and the list's own scroll are captured
// before the swap and put back after it, so a refresh cannot fling the owner
// to the top of the board. When focusOrderId names an order that is still on
// the board after the swap, the keyboard lands on that card's next primary
// action button; preventScroll stops the transfer from moving the page. An
// order that has moved to another tab is simply not found there, so nothing
// is focused and the scroll restoration alone decides where the page sits.
function swapOrderList({ includeSales = false, focusOrderId = null } = {}) {
	if (!ordersList) return;
	const fragment = buildFragment();
	if (!fragment) return;
	const windowScrollY = typeof window !== "undefined" && typeof window.scrollY === "number" ? window.scrollY : null;
	const listScrollTop = typeof ordersList.scrollTop === "number" ? ordersList.scrollTop : null;
	if (includeSales) renderSalesStrip();
	renderOrderListInto(fragment);
	ordersList.replaceChildren(fragment);
	if (listScrollTop !== null && ordersList.scrollTop !== listScrollTop) {
		try {
			ordersList.scrollTop = listScrollTop;
		} catch {
			// Some containers are never scroll targets; restoring is best effort.
		}
	}
	if (windowScrollY !== null && typeof window.scrollTo === "function" && window.scrollY !== windowScrollY) {
		try {
			window.scrollTo(0, windowScrollY);
		} catch {
			// Restoring scroll is best effort; never let it break the refresh.
		}
	}
	if (focusOrderId === null || focusOrderId === undefined) return;
	if (typeof ordersList.querySelector !== "function") return;
	const safeId = String(focusOrderId).replace(/[^0-9a-zA-Z_-]/g, "");
	// Focus is best effort and ALSO asynchronous-proof: a browser clears the
	// focus of a button that was just removed from the DOM around the end of
	// the click event, so the synchronous focus below can be undone a moment
	// later. The follow-up re-assert runs after that settles, and only when
	// focus actually fell back to the body or a detached node — if the owner
	// has focused anything else in the meantime, that choice wins.
	const refocus = () => {
		if (!ordersList || typeof ordersList.querySelector !== "function") return null;
		let current = null;
		try {
			current = document.activeElement;
		} catch {
			current = null;
		}
		let loose = current === null || current === undefined || current === document.body;
		if (!loose && current && typeof current.isConnected === "boolean") loose = !current.isConnected;
		if (!loose) return null;
		let card = null;
		try {
			card = ordersList.querySelector(`.order-card[data-id="${safeId}"]`);
		} catch {
			return null;
		}
		if (!card) return null;
		const button = card.querySelector("button.primary-action");
		if (!button || typeof button.focus !== "function") return null;
		try {
			button.focus({ preventScroll: true });
		} catch {
			button.focus();
		}
		return button;
	};
	refocus();
	if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
		window.requestAnimationFrame(refocus);
	} else if (typeof setTimeout === "function") {
		setTimeout(refocus, 0);
	}
}

// A refresh must not clear the owner's working position: whichever order card
// currently holds focus is remembered by id so the fresh list can put the
// keyboard back after the swap.
function findFocusedOrderCardId() {
	if (typeof document === "undefined" || !document.activeElement) return null;
	try {
		const element = document.activeElement;
		if (typeof element.closest !== "function") return null;
		const card = element.closest(".order-card");
		if (!card || !card.dataset || card.dataset.id === undefined || card.dataset.id === null) return null;
		return String(card.dataset.id);
	} catch {
		return null;
	}
}

function restoreOrderCardFocus(cardId) {
	if (!ordersList || typeof ordersList.querySelector !== "function") return;
	const safeId = String(cardId).replace(/[^0-9a-zA-Z_-]/g, "");
	if (!safeId) return;
	let card = null;
	try {
		card = ordersList.querySelector(`.order-card[data-id="${safeId}"]`);
	} catch {
		return;
	}
	if (!card) return;
	const button = card.querySelector("button.primary-action");
	if (!button || typeof button.focus !== "function") return;
	try {
		button.focus({ preventScroll: true });
	} catch {
		button.focus();
	}
}

// The blocking path: build the finished board off-screen and swap it in.
function renderOrdersBoard() {
	swapOrderList({ includeSales: true });
}

// Tab and search changes only redraw the list, still in one replaceChildren.
function renderOrderListOnly() {
	swapOrderList();
}

function selectOrderBoardTab(tab) {
	if (!BOARD_TABS[tab]) tab = "needs";
	ordersBoard.tab = tab;
	const tabsEl = document.getElementById("orderBoardTabs");
	if (tabsEl && typeof tabsEl.querySelectorAll === "function") {
		tabsEl.querySelectorAll(".order-board-tab").forEach(button => {
			const active = button.dataset && button.dataset.boardTab === tab;
			button.classList.toggle("is-active", active);
			button.setAttribute("aria-selected", active ? "true" : "false");
		});
	}
	renderOrderListOnly();
}

// --- pickup labels -----------------------------------------------------------
// Dates render from the stored Melbourne date, so a day never shifts.
function pickupDateLabel(order) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(order.pickup_date || ""));
	if (!match) return "Date not set";
	const weekday = WEEKDAY_SHORT[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
	return `${weekday} ${match[3]} ${MONTH_SHORT[Number(match[2]) - 1]}`;
}

function fallbackFormatTime(value) {
	const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
	if (!match) return "";
	const hour = Number(match[1]) % 12 || 12;
	return `${hour}:${match[2]} ${Number(match[1]) < 12 ? "AM" : "PM"}`;
}

function pickupTimeLabel(order) {
	if (typeof PickupTimeDisplay === "object" && PickupTimeDisplay && typeof PickupTimeDisplay.formatPickupTime === "function") {
		return PickupTimeDisplay.formatPickupTime(order.pickup_time) || fallbackFormatTime(order.pickup_time);
	}
	return fallbackFormatTime(order.pickup_time);
}

// Relative hints are Melbourne-only: Overdue once the pickup time has passed
// for anything not yet handed over or cancelled; otherwise Today / Tomorrow
// plus a near-time estimate while it is close.
function pickupHint(order) {
	const instant = melbourneWallToInstant(order.pickup_date, order.pickup_time);
	if (instant === null) return "";
	const now = Date.now();
	const minutes = (instant - now) / 60000;
	const settledOrder = ["Picked Up", "Completed", "Cancelled"].includes(order.status);
	if (minutes < 0) return settledOrder ? "" : "Overdue";
	if (!OWNER_DATE_QUERY) return "";
	const day = melbourneDateKey(new Date(instant));
	const today = melbourneDateKey(new Date(now));
	const tomorrow = melbourneDateKey(new Date(now + 24 * 60 * 60 * 1000));
	const near = minutes < 60 ? `in ${Math.max(1, Math.round(minutes))} min` : minutes < 6 * 60 ? `in ${Math.round(minutes / 60)} hrs` : "";
	if (day === today) return near ? `Today · ${near}` : "Today";
	if (day === tomorrow) return near ? `Tomorrow · ${near}` : "Tomorrow";
	return near;
}

// --- the overflow menu -------------------------------------------------------
const STATUS_CHIP_CLASS = {
	Pending: "chip-pending",
	Confirmed: "chip-confirmed",
	Preparing: "chip-confirmed",
	"Ready for Pickup": "chip-ready",
	"Picked Up": "chip-done",
	Cancelled: "chip-cancelled",
};

const STATUS_BAR_TONE = {
	Pending: "pending",
	Confirmed: "confirmed",
	Preparing: "confirmed",
	"Ready for Pickup": "ready",
	"Picked Up": "done",
	Cancelled: "cancelled",
};

// Exactly one primary action per stage; everything else lives in the overflow
// menu so a card never offers two competing buttons.
const PRIMARY_ACTIONS = {
	Pending: { label: "Confirm order", next: "Confirmed" },
	Confirmed: { label: "Mark ready", next: "Ready for Pickup" },
	Preparing: { label: "Mark ready", next: "Ready for Pickup" },
	"Ready for Pickup": { label: "Mark picked up", next: "Picked Up" },
};

const PICKUP_CONFIRMABLE_STATUSES = ["Pending", "Confirmed", "Preparing", "Ready for Pickup"];

const ORDER_MENUS = [];
let openOrderMenu = null;

function closeOrderMenus(refocus) {
	if (!openOrderMenu) return;
	const entry = openOrderMenu;
	openOrderMenu = null;
	entry.menu.hidden = true;
	entry.toggle.setAttribute("aria-expanded", "false");
	if (refocus && entry.toggle.isConnected && typeof entry.toggle.focus === "function") entry.toggle.focus();
}

function orderMenuOutsideClick(event) {
	if (!openOrderMenu) return;
	const wrap = openOrderMenu.wrap;
	if (wrap && typeof wrap.contains === "function" && wrap.contains(event.target)) return;
	closeOrderMenus();
}

function orderMenuKeydown(event) {
	if (!openOrderMenu) return;
	if (event && event.key === "Escape") {
		event.preventDefault();
		closeOrderMenus(true);
	}
}

function buildOrderActionsMenu(order) {
	const wrap = document.createElement("div");
	wrap.className = "order-menu";
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "order-menu-btn";
	toggle.setAttribute("aria-haspopup", "menu");
	toggle.setAttribute("aria-expanded", "false");
	toggle.setAttribute("aria-label", `More actions for ${order.order_number || `MS-${order.id}`}`);
	toggle.textContent = "⋯";
	const menu = document.createElement("div");
	menu.className = "order-menu-list";
	menu.setAttribute("role", "menu");
	menu.hidden = true;

	const changePickup = document.createElement("button");
	changePickup.type = "button";
	changePickup.className = "order-menu-item";
	changePickup.setAttribute("role", "menuitem");
	changePickup.textContent = "Change pickup time";
	changePickup.addEventListener("click", () => {
		closeOrderMenus();
		// The existing confirmation flow, unchanged: two prompts, then the
		// status endpoint re-validates both in the business time zone.
		const date = window.prompt("Confirmed pickup date (YYYY-MM-DD):", order.pickup_date || "");
		if (date === null) return;
		const time = window.prompt("Confirmed pickup time (HH:MM, 10:00-20:00 Melbourne):", order.pickup_time || "");
		if (time === null) return;
		updateOrderStatus(order.id, order.status, "", date.trim(), time.trim());
	});
	const cancelOrder = document.createElement("button");
	cancelOrder.type = "button";
	cancelOrder.className = "order-menu-item danger-outline";
	cancelOrder.setAttribute("role", "menuitem");
	cancelOrder.textContent = "Cancel order";
	cancelOrder.addEventListener("click", () => {
		closeOrderMenus();
		// A cancellation reason stays required, exactly as before.
		const reason = window.prompt("Enter a reason for cancelling this order.");
		if (reason !== null) updateOrderStatus(order.id, "Cancelled", reason.trim());
	});
	menu.append(changePickup, cancelOrder);

	const entry = { wrap, toggle, menu };
	toggle.addEventListener("click", () => {
		const opening = menu.hidden;
		closeOrderMenus();
		if (opening) {
			menu.hidden = false;
			toggle.setAttribute("aria-expanded", "true");
			openOrderMenu = entry;
			const first = menu.querySelector("button");
			if (first && typeof first.focus === "function") first.focus();
		}
	});
	ORDER_MENUS.push(entry);
	wrap.append(toggle, menu);
	return wrap;
}

function renderOrder(order) {
	const card = document.createElement("article");
	const status = displayStatus(order.status);
	card.className = `order-card${STATUS_BAR_TONE[status] ? ` bar-${STATUS_BAR_TONE[status]}` : " bar-pending"}`;
	if (order && order.id !== undefined && order.id !== null) card.dataset.id = String(order.id);

	const head = document.createElement("div");
	head.className = "order-head";
	const number = document.createElement("h3");
	number.className = "order-number";
	number.textContent = order.order_number || `Order ${order.id}`;
	const chip = document.createElement("span");
	chip.className = `chip ${STATUS_CHIP_CLASS[status] || "chip-pending"}`;
	chip.textContent = status;
	head.append(number, chip);

	const pickup = document.createElement("p");
	pickup.className = "order-pickup";
	const when = document.createElement("span");
	const time = pickupTimeLabel(order);
	when.textContent = time ? `${pickupDateLabel(order)} · ${time}` : pickupDateLabel(order);
	pickup.append(when);
	const hint = pickupHint(order);
	if (hint) {
		const badge = document.createElement("span");
		badge.className = `pickup-hint${hint === "Overdue" ? " is-overdue" : ""}`;
		badge.textContent = hint;
		pickup.append(badge);
	}

	// Customer details straight from this order record. A missing name falls
	// back to an honest label rather than a fabricated one, and the phone
	// number becomes a tappable call link.
	const nameLine = document.createElement("p");
	nameLine.className = "order-name";
	nameLine.textContent = order.customer_name || "Customer name not provided";
	const phone = document.createElement(order.customer_contact ? "a" : "span");
	phone.className = "order-phone";
	if (order.customer_contact) {
		phone.href = `tel:${String(order.customer_contact).replace(/[^\d+]/g, "")}`;
		phone.textContent = order.customer_contact;
	} else {
		phone.textContent = "No contact number";
	}

	let cancellation = null;
	if (order.status === "Cancelled" && order.cancellation_reason) {
		cancellation = document.createElement("p");
		cancellation.className = "order-cancel-reason";
		cancellation.textContent = `Cancellation reason: ${order.cancellation_reason}`;
	}

	// Items compress to the first two, so a card stays compact on any screen.
	const items = Array.isArray(order.items) ? order.items : [];
	const itemsLine = document.createElement("p");
	if (items.length > 0) {
		const parts = items.slice(0, 2).map(item => `${item.product_name || "Product"} × ${item.quantity}`);
		if (items.length > 2) parts.push(`+${items.length - 2} more`);
		itemsLine.textContent = parts.join(", ");
	} else {
		itemsLine.textContent = "No item details recorded.";
	}

	const total = document.createElement("p");
	total.className = "order-total";
	total.textContent = `A$${Number(order.total || 0).toFixed(2)}`;

	const actionArea = document.createElement("div");
	actionArea.className = "order-actions";
	const primary = PRIMARY_ACTIONS[order.status];
	if (primary) {
		const advance = document.createElement("button");
		advance.type = "button";
		advance.className = "primary-action";
		advance.textContent = primary.label;
		advance.addEventListener("click", () => updateOrderStatus(order.id, primary.next, "", null, null));
		actionArea.append(advance);
	}
	if (PICKUP_CONFIRMABLE_STATUSES.includes(order.status)) {
		actionArea.append(buildOrderActionsMenu(order));
	}
	// A change in flight disarms this card's controls: a double tap cannot
	// queue a second request while the first one is still on the wire. The
	// buttons come back in the swap that lands with the result.
	if (order.id !== undefined && order.id !== null && ordersInFlight.has(String(order.id))) {
		for (const button of actionArea.querySelectorAll("button")) button.disabled = true;
	}

	card.append(head, pickup, nameLine, phone,
		...(cancellation ? [cancellation] : []),
		itemsLine, total, actionArea);
	return card;
}

const OWNER_STATUS_TIMEOUT_MS = 20 * 1000;

// Raw browser network errors read like internals; say what they mean for the
// owner, covering the free server's cold starts.
function friendlyStatusError(error) {
	const raw = error && error.message ? String(error.message) : "";
	if (error && (error.name === "AbortError" || /aborted|timeout/i.test(raw))) {
		return "The store server took too long to answer. It may still be waking up.";
	}
	if (/failed to fetch|networkerror|load failed/i.test(raw)) {
		return "The store server could not be reached. It may still be waking up.";
	}
	return raw || "The change could not be applied.";
}

async function updateOrderStatus(orderId, status, cancellationReason, confirmedDate = null, confirmedTime = null) {
	ordersError.hidden = true;
	const idKey = String(orderId);
	// One request per order at a time: the card's disabled buttons plus this
	// guard keep a double tap from queueing a second, identical request.
	if (ordersInFlight.has(idKey)) return;
	const localIndex = allOrders.findIndex(order => order && order.id !== undefined && order.id !== null
		&& String(order.id) === idKey);
	if (localIndex === -1) {
		// The order is not on the board (for example behind a status filter),
		// so there is no local card to update optimistically. The original
		// blocking path stays correct, and the banner wording stays clear.
		try {
			await apiRequest(`/api/owner/orders/${encodeURIComponent(orderId)}/status`, {
				method: "POST",
				body: JSON.stringify({
					status,
					...(status === "Cancelled" ? { cancellation_reason: cancellationReason } : {}),
					...(confirmedDate !== null || confirmedTime !== null
						? { confirmed_pickup_date: confirmedDate, confirmed_pickup_time: confirmedTime }
						: {}),
				}),
			});
			await loadOrders({ focusOrderId: orderId });
		} catch (error) {
			ordersError.textContent = friendlyStatusError(error);
			ordersError.hidden = false;
		}
		return;
	}
	// Optimistic: the card adopts the new status right away through the same
	// in-place swap a refresh uses, so the press paints in one frame instead
	// of after three slow round trips. A cancellation reaches this point only
	// after the reason prompt has been answered, and stock is restored by the
	// server alone — the local copy changes the status label, nothing else.
	const snapshot = allOrders[localIndex];
	const optimisticOrder = { ...snapshot, status };
	if (status === "Cancelled" && cancellationReason) {
		optimisticOrder.cancellation_reason = cancellationReason;
	}
	allOrders[localIndex] = optimisticOrder;
	ordersInFlight.add(idKey);
	swapOrderList({ includeSales: false, focusOrderId: orderId });

	const controller = typeof AbortController === "function" ? new AbortController() : null;
	const timeoutId = controller ? setTimeout(() => controller.abort(), OWNER_STATUS_TIMEOUT_MS) : null;
	try {
		const updated = await apiRequest(`/api/owner/orders/${encodeURIComponent(orderId)}/status`, {
			method: "POST",
			body: JSON.stringify({
				status,
				...(status === "Cancelled" ? { cancellation_reason: cancellationReason } : {}),
				...(confirmedDate !== null || confirmedTime !== null
					? { confirmed_pickup_date: confirmedDate, confirmed_pickup_time: confirmedTime }
					: {}),
			}),
			...(controller ? { signal: controller.signal } : {}),
		});
		if (timeoutId !== null) clearTimeout(timeoutId);
		// The status route answers with the whole updated order, so the board
		// does not need a full reload: merge it wherever the card sits now.
		// If nothing usable came back, one quiet refresh repairs the board in
		// the background (it never blanks and never writes the banner).
		const merged = updated && typeof updated === "object" && updated.id !== undefined && updated.id !== null
			? updated
			: null;
		if (merged) {
			const currentIndex = allOrders.findIndex(order => order && order.id !== undefined && order.id !== null
				&& String(order.id) === idKey);
			if (currentIndex >= 0) allOrders[currentIndex] = merged;
			else allOrders.push(merged);
			ordersInFlight.delete(idKey);
			swapOrderList({ includeSales: false, focusOrderId: orderId });
		} else {
			ordersInFlight.delete(idKey);
			await refreshOrdersQuietly();
		}
		// The sales numbers follow in the background. The board never waits
		// for the sales strip: when the figures land, only the strip
		// container is rebuilt, so the list, its scroll and its focus stay
		// exactly where the owner left them.
		await loadSalesData();
		renderSalesStrip();
	} catch (error) {
		if (timeoutId !== null) clearTimeout(timeoutId);
		// Put the card back exactly as it was, silently: no refresh, no board
		// blanking, only this card changes.
		const currentIndex = allOrders.findIndex(order => order && order.id !== undefined && order.id !== null
			&& String(order.id) === idKey);
		if (currentIndex >= 0) allOrders[currentIndex] = snapshot;
		ordersInFlight.delete(idKey);
		swapOrderList({ includeSales: false, focusOrderId: orderId });
		ordersError.textContent = `${friendlyStatusError(error)} The card is back to its previous status. Try again in a moment.`;
		ordersError.hidden = false;
	}
}

function showOwnerDashboard() {
	loginPanel.hidden = true;
	resetRequestPanel.hidden = true;
	resetPasswordPanel.hidden = true;
	ordersPanel.hidden = false;
	productsPanel.hidden = true;
	accountPanel.hidden = true;
	dashboardTabs.hidden = false;
	logoutButton.hidden = false;
	ordersPollingPausedForIdle = false;
	lastOwnerActivityAt = Date.now();
	clearOrdersIdleNote();
	loadOrders();
	scheduleOrdersQuietPoll();
}

function showLogin() {
	loginPanel.hidden = false;
	resetRequestPanel.hidden = true;
	resetPasswordPanel.hidden = true;
	ordersPanel.hidden = true;
	productsPanel.hidden = true;
	accountPanel.hidden = true;
	dashboardTabs.hidden = true;
	logoutButton.hidden = true;
	stopOrdersQuietPoll();
	dismissOrderNotice();
	ordersPollingPausedForIdle = false;
	clearOrdersIdleNote();
}

// --- password recovery -------------------------------------------------------
//
// Three states: logging in, asking for a link, and setting a new password with
// the token. Only one panel is visible at a time. Every message is generic on
// purpose, and nothing here implies that an owner account exists.

function showResetRequest(prefillToken = "") {
	loginPanel.hidden = true;
	ordersPanel.hidden = true;
	resetRequestPanel.hidden = true;
	resetPasswordPanel.hidden = false;
	if (prefillToken) document.getElementById("resetToken").value = prefillToken;
	document.getElementById("resetToken").focus();
}

function hideRecoveryMessages() {
	for (const id of ["resetRequestError", "resetRequestSuccess", "resetPasswordError", "resetPasswordSuccess"]) {
		const element = document.getElementById(id);
		if (element) {
			element.hidden = true;
			element.textContent = "";
		}
	}
}

// The link in the email carries ?reset_token=..., so opening it lands directly
// on the new-password form with the token already filled in.
const tokenFromLink = new URLSearchParams(window.location.search).get("reset_token");
const manualRecoveryPanel = document.getElementById("manualRecoveryPanel");

// Switches the recovery panel between the email flow (a link is sent) and the
// manual-token flow (a token was issued some other way). The manual path is only
// offered when email is not configured: once delivery works it is not needed, and
// removing it keeps the flow simple.
function applyRecoveryMode(emailConfigured) {
	document.getElementById("haveResetTokenLink").hidden = emailConfigured;
	manualRecoveryPanel.hidden = emailConfigured;
	document.getElementById("requestSubmit").textContent = emailConfigured
		? "Send reset link"
		: "Request a reset link";
}

document.getElementById("forgotPasswordLink").addEventListener("click", () => {
	hideRecoveryMessages();
	loginPanel.hidden = true;
	resetPasswordPanel.hidden = true;
	resetRequestPanel.hidden = false;
	document.querySelector("#resetRequestForm button[type=submit]").focus();
	// Ask the server which mode applies before the owner commits to either path.
	// The answer is a boolean about provider configuration and reveals nothing
	// about the account.
	apiRequest("/api/owner/password/reset-request", { method: "POST", body: "{}" })
		.then(result => applyRecoveryMode(result.delivery_configured === true))
		.catch(() => applyRecoveryMode(false));
});

document.getElementById("haveResetTokenLink").addEventListener("click", () => {
	hideRecoveryMessages();
	loginPanel.hidden = true;
	resetRequestPanel.hidden = true;
	resetPasswordPanel.hidden = false;
	document.getElementById("resetToken").focus();
});

document.getElementById("backToLoginFromRequest").addEventListener("click", () => {
	hideRecoveryMessages();
	showLogin();
});

document.getElementById("backToLoginFromReset").addEventListener("click", () => {
	hideRecoveryMessages();
	showLogin();
});

document.getElementById("resetRequestForm").addEventListener("submit", async event => {
	event.preventDefault();
	hideRecoveryMessages();
	const status = document.getElementById("resetRequestSuccess");
	const failure = document.getElementById("resetRequestError");
	try {
		// The form sends no address. The route resolves the recipient from
		// server-side configuration alone, so this form cannot be used to test an
		// address or to redirect a link to one.
		const result = await apiRequest("/api/owner/password/reset-request", {
			method: "POST",
			body: JSON.stringify({}),
		});
		applyRecoveryMode(result.delivery_configured === true);
		if (result.delivery_configured === false) {
			status.textContent = "Email delivery is not set up for this store, so no link can be sent. Use the manual reset token option below if a token has been issued.";
			status.hidden = false;
			return;
		}
		// Same wording whether or not the send succeeded: the response must not
		// become a way to discover anything about the account.
		status.textContent = result.message
			|| "If a reset link is enabled for this store, it is on its way to the owner address.";
		status.hidden = false;
	} catch (error) {
		failure.textContent = error.message;
		failure.hidden = false;
	}
});

document.getElementById("resetPasswordForm").addEventListener("submit", async event => {
	event.preventDefault();
	hideRecoveryMessages();
	const token = document.getElementById("resetToken").value.trim();
	const newPassword = document.getElementById("resetNewPassword").value;
	const confirmPassword = document.getElementById("resetConfirmPassword").value;
	const failure = document.getElementById("resetPasswordError");
	const success = document.getElementById("resetPasswordSuccess");
	if (newPassword !== confirmPassword) {
		failure.textContent = "The new password and its confirmation do not match.";
		failure.hidden = false;
		return;
	}
	try {
		const result = await apiRequest("/api/owner/password/reset", {
			method: "POST",
			body: JSON.stringify({
				token,
				new_password: newPassword,
				confirm_password: confirmPassword,
			}),
		});
		success.textContent = result.message || "Your password has been reset. Please log in again.";
		success.hidden = false;
		document.getElementById("resetPasswordForm").reset();
		// Every owner session was revoked server side, so the cached token is
		// stale: re-arm it before the login form is shown.
		invalidateCsrfToken();
		// Clean login.
		setTimeout(() => {
			hideRecoveryMessages();
			showLogin();
		}, 2500);
	} catch (error) {
		failure.textContent = error.message;
		failure.hidden = false;
	}
});

// --- dashboard tabs ---------------------------------------------------------

const dashboardTabs = document.getElementById("dashboardTabs");
const tabButtons = dashboardTabs.querySelectorAll(".tab");

dashboardTabs.addEventListener("click", event => {
	const button = event.target.closest(".tab");
	if (!button) return;
	tabButtons.forEach(tab => {
		const active = tab === button;
		tab.classList.toggle("is-active", active);
		if (active) tab.setAttribute("aria-current", "true");
		else tab.removeAttribute("aria-current");
	});
	const tab = button.dataset.tab;
	ordersPanel.hidden = tab !== "orders";
	productsPanel.hidden = tab !== "products";
	accountPanel.hidden = tab !== "account";
	if (tab === "products") loadProducts();
	if (tab === "orders") scheduleOrdersQuietPoll();
	else stopOrdersQuietPoll();
});

// --- product photo upload ----------------------------------------------------
//
// The file is read in the browser so the owner sees a preview before saving, but
// the browser's word for the type is never trusted: the server re-reads the bytes
// and stores the image only if the magic numbers match a supported format. A
// blob: or data: URL is never written to the database as the product image; the
// value saved is the path the server returns for the stored file, or the https
// URL the owner typed.

const imageFileInput = document.getElementById("productImageFile");
const imagePreview = document.getElementById("productImagePreview");
const imagePreviewImg = document.getElementById("productImagePreviewImg");
const imageError = document.getElementById("productImageError");
const imageReplaceButton = document.getElementById("productImageReplace");
const imageClearButton = document.getElementById("productImageClear");
// The URL of the file that has been uploaded and stored for this form session,
// and the image the product already had. The payload prefers a fresh upload, then
// the existing image, so editing without choosing a file preserves the current
// photo — and there is no text field left to type into.
let uploadedImageUrl = "";
let existingImage = "";

const MAX_CLIENT_IMAGE_BYTES = 5 * 1024 * 1024;

function showImageError(message) {
	if (!imageError) return;
	imageError.textContent = message;
	imageError.hidden = false;
}

function clearImageError() {
	if (!imageError) return;
	imageError.textContent = "";
	imageError.hidden = true;
}

function showImagePreview(src) {
	if (!imagePreview || !imagePreviewImg) return;
	imagePreviewImg.src = src;
	imagePreview.hidden = false;
}

function hideImagePreview() {
	if (!imagePreview || !imagePreviewImg) return;
	imagePreviewImg.removeAttribute("src");
	imagePreview.hidden = true;
}

// Downscales and recompresses an image in the browser before it is uploaded.
//
// A phone photo is routinely 3-8 MB, and base64 makes it a third larger again, so
// an untouched upload blows the request limit ("The request is too large") and
// wastes the owner's data allowance. Downscaling to 1400px on the longest side at
// high JPEG quality keeps product photos crisp in the admin and on the storefront
// while landing around 150-400 KB.
//
// This is a size decision, not a security one. The server re-reads the bytes and
// decides for itself, so a downscaled image is still validated in full.
const MAX_IMAGE_DIMENSION = 1400;
const IMAGE_QUALITY = 0.85;

async function downscaleImage(file) {
	// Only formats the browser can decode are downscaled; anything else is sent
	// as-is and validated on the server.
	if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
		// Already within bounds and small: keep the original bytes rather than
		// paying for a recompression that cannot help.
		if (scale === 1 && file.size <= 400 * 1024) return file;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) return file;
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close?.();
		const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", IMAGE_QUALITY));
		if (!blob) return file;
		// Never return something larger than the original: the compression was
		// the point, and a bigger payload is a regression.
		if (blob.size >= file.size) return file;
		return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
	} catch {
		// A decode failure means the file is not what it claims. The server
		// refuses it, so fall through rather than inventing a substitute.
		return file;
	}
}

async function previewSelectedImage(file) {
	clearImageError();
	if (!file) return false;
	if (!file.type.startsWith("image/")) {
		showImageError("Choose an image file (PNG, JPEG, WebP, GIF or AVIF).");
		return false;
	}
	if (file.size > MAX_CLIENT_IMAGE_BYTES) {
		showImageError("That image is larger than 5 MB. Choose a smaller file.");
		return false;
	}
	// A quick client-side check on the real bytes, so an obviously wrong file is
	// caught before the round trip. The server performs the same check, and its
	// answer is the one that decides.
	const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
	const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
	const isAvif = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
	if (!isPng && !isJpeg && !isGif && !isWebp && !isAvif) {
		showImageError("That file is not a supported image.");
		return false;
	}
	showImagePreview(URL.createObjectURL(file));
	return true;
}

if (imageFileInput) {
	imageFileInput.addEventListener("change", async () => {
		const raw = imageFileInput.files && imageFileInput.files[0];
		// Validate the original file, then preview and upload the downscaled
		// version: the owner sees exactly what will be stored.
		const file = await downscaleImage(raw);
		if (file !== raw && imageFileInput.files.length > 0) {
			// Keep the picker's selection in step with what was validated.
			const swap = new DataTransfer();
			swap.items.add(file);
			imageFileInput.files = swap.files;
		}
		if (await previewSelectedImage(file)) {
			clearImageError();
		}
	});
}

if (imageReplaceButton && imageFileInput) {
	// Opens the picker again without clearing what was already chosen.
	imageReplaceButton.addEventListener("click", () => imageFileInput.click());
}

if (imageClearButton) {
	imageClearButton.addEventListener("click", () => {
		if (imageFileInput) imageFileInput.value = "";
		uploadedImageUrl = "";
		existingImage = "";
		hideImagePreview();
		clearImageError();
	});
}

// Uploads the chosen file and returns the stored image path, or "" when nothing
// was chosen. Failures surface a clear message; nothing is invented.
async function uploadSelectedProductImage() {
	if (!imageFileInput || !imageFileInput.files || imageFileInput.files.length === 0) {
		return uploadedImageUrl || "";
	}
	// Upload the same bytes that were previewed, so what the owner saw is what is
	// stored. The picker already holds the downscaled file.
	const file = imageFileInput.files[0];
	if (!(await previewSelectedImage(file))) return null;
	const dataUrl = await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("That file could not be read."));
		reader.readAsDataURL(file);
	});
	const result = await apiRequest("/api/owner/product-images", {
		method: "POST",
		body: JSON.stringify({ image: dataUrl }),
	});
	uploadedImageUrl = result.image;
	return result.image;
}

// --- products ---------------------------------------------------------------

const productsPanel = document.getElementById("productsPanel");
const productsList = document.getElementById("productsList");
const productsError = document.getElementById("productsError");
const productsStatus = document.getElementById("productsStatus");
const productsEmpty = document.getElementById("productsEmpty");
const productForm = document.getElementById("productForm");
const productSearch = document.getElementById("productSearch");
const productCategoryFilter = document.getElementById("productCategoryFilter");
const productIncludeUnpublished = document.getElementById("productIncludeUnpublished");
const stockWarning = document.getElementById("stockWarning");
// The products behind the cards that are on screen right now. Kept so the
// low-stock warning can be recomputed the moment a stock correction lands,
// without reloading the list.
let renderedProducts = [];

// The threshold the database column defaults to. Products carry their own once
// the stock migration is applied; until then this keeps badge colours correct.
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

function productLowStockThreshold(product) {
	const value = Number(product && product.low_stock_threshold);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LOW_STOCK_THRESHOLD;
}

// Badge state, with the exact pairing the AA palette allows: green above the
// threshold, soft red with a real number for low stock, and solid dark red for
// sold out. The badge always shows a number except when there is nothing left.
function stockBadgeState(product) {
	const stock = Number(product.stock ?? 0);
	if (!Number.isSafeInteger(stock) || stock <= 0) {
		return { cls: "stock-out", text: "Sold out" };
	}
	if (stock <= productLowStockThreshold(product)) {
		return { cls: "stock-low", text: `Low stock · ${stock} left` };
	}
	return { cls: "stock-ok", text: `Stock ${stock}` };
}

// The red line at the top of the products section. It counts everything that
// is low or sold out, and hides itself when there is nothing to warn about.
function updateStockWarning() {
	if (!stockWarning) return;
	const lowCount = renderedProducts
		.filter(product => Number(product.stock ?? 0) <= productLowStockThreshold(product))
		.length;
	if (lowCount === 0) {
		stockWarning.hidden = true;
		stockWarning.textContent = "";
		return;
	}
	stockWarning.textContent = lowCount === 1 ? "1 item low on stock." : `${lowCount} items low on stock.`;
	stockWarning.hidden = false;
}

let productsVisibilitySupported = true;

function clearProductStatus() {
	productsError.hidden = true;
	productsStatus.hidden = true;
}

function showProductsError(message) {
	productsError.textContent = message;
	productsError.hidden = false;
	productsStatus.hidden = true;
}

function showProductsStatus(message) {
	productsStatus.textContent = message;
	productsStatus.hidden = false;
	productsError.hidden = true;
}

function formatPrice(value) {
	const amount = Number(value);
	if (!Number.isFinite(amount)) return "—";
	return `A$${amount.toFixed(2)}`;
}

function renderProduct(product) {
	const card = document.createElement("article");
	card.className = "product-card";
	card.dataset.id = product.id;

	const thumb = document.createElement("div");
	thumb.className = "product-thumb";
	if (product.image) {
		const img = document.createElement("img");
		// Displayed against the API origin; the stored value is untouched.
		img.src = resolveProductImageUrl(product.image);
		img.alt = product.name;
		img.loading = "lazy";
		thumb.append(img);
	} else {
		const placeholder = document.createElement("span");
		placeholder.className = "thumb-placeholder";
		placeholder.textContent = "No image";
		thumb.append(placeholder);
	}

	const body = document.createElement("div");
	body.className = "product-body";
	const name = document.createElement("h3");
	name.textContent = product.name;
	const meta = document.createElement("p");
	meta.className = "muted";
	meta.textContent = product.category || "Uncategorised";

	// Stock, shown for every product: a colour-coded badge for the state and a
	// one-tap correction row. The controls speak to PATCH /owner/products/:id/
	// stock and update this card in place, so a quick fix never reloads the
	// whole list.
	const stockRow = document.createElement("div");
	stockRow.className = "stock-row";
	const badge = document.createElement("span");
	const initialState = stockBadgeState(product);
	badge.className = `stock-badge ${initialState.cls}`;
	badge.textContent = initialState.text;
	const controls = document.createElement("div");
	controls.className = "stock-controls";
	const minus = document.createElement("button");
	minus.type = "button";
	minus.className = "ghost stock-step";
	minus.textContent = "−";
	minus.setAttribute("aria-label", `Reduce stock of ${product.name} by 1`);
	minus.title = "Reduce stock by 1";
	const stockInput = document.createElement("input");
	stockInput.type = "number";
	stockInput.min = "0";
	stockInput.step = "1";
	stockInput.inputMode = "numeric";
	stockInput.className = "stock-input";
	stockInput.value = String(Number(product.stock ?? 0));
	stockInput.setAttribute("aria-label", `Stock value for ${product.name}`);
	const plus = document.createElement("button");
	plus.type = "button";
	plus.className = "ghost stock-step";
	plus.textContent = "+";
	plus.setAttribute("aria-label", `Increase stock of ${product.name} by 1`);
	plus.title = "Increase stock by 1";
	const applyStock = document.createElement("button");
	applyStock.type = "button";
	applyStock.className = "ghost stock-set";
	applyStock.textContent = "Set";
	applyStock.setAttribute("aria-label", `Set stock of ${product.name} to the entered value`);
	controls.append(minus, stockInput, plus, applyStock);
	stockRow.append(badge, controls);

	const price = document.createElement("p");
	price.className = "price";
	price.textContent = formatPrice(product.price);
	if (product.original_price && Number(product.original_price) > Number(product.price)) {
		const was = document.createElement("s");
		was.className = "was";
		was.textContent = formatPrice(product.original_price);
		price.append(" ", was);
	}
	if (product.is_published === false) {
		const hiddenTag = document.createElement("span");
		hiddenTag.className = "tag hidden-tag";
		hiddenTag.textContent = "Hidden";
		body.append(hiddenTag);
	}
	body.append(name, meta, stockRow, price);

	const actions = document.createElement("div");
	actions.className = "product-actions";
	const editButton = document.createElement("button");
	editButton.type = "button";
	editButton.textContent = "Edit";
	editButton.addEventListener("click", () => fillProductForm(product));
	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.className = "danger";
	deleteButton.textContent = "Delete";
	deleteButton.addEventListener("click", () => deleteProduct(product));
	actions.append(editButton, deleteButton);

	// One small PATCH per tap. Every control re-reads the server's answer, so
	// the card always shows the stored value, including the floor at zero that
	// the SQL applies for a −1 on an empty shelf.
	async function runStockChange(body, busyLock) {
		const buttons = busyLock.slice();
		for (const button of buttons) button.disabled = true;
		try {
			const result = await apiRequest(
				`/api/owner/products/${encodeURIComponent(product.id)}/stock`,
				{ method: "PATCH", body: JSON.stringify(body) },
			);
			const updated = result && result.product ? result.product : null;
			if (updated) {
				product.stock = Number(updated.stock ?? 0);
				if (updated.low_stock_threshold !== undefined) product.low_stock_threshold = updated.low_stock_threshold;
				const state = stockBadgeState(product);
				badge.className = `stock-badge ${state.cls}`;
				badge.textContent = state.text;
				stockInput.value = String(product.stock);
			}
			updateStockWarning();
		} catch (error) {
			showProductsError(error.message);
		} finally {
			for (const button of buttons) button.disabled = false;
		}
	}
	minus.addEventListener("click", () => runStockChange({ delta: -1 }, [minus, plus, applyStock]));
	plus.addEventListener("click", () => runStockChange({ delta: 1 }, [minus, plus, applyStock]));
	applyStock.addEventListener("click", () => {
		const value = Number(String(stockInput.value).trim());
		if (!Number.isSafeInteger(value) || value < 0) {
			showProductsError("Enter a whole number of 0 or more before setting stock.");
			return;
		}
		runStockChange({ set: value }, [minus, plus, applyStock]);
	});

	card.append(thumb, body, actions);
	return card;
}

function readProductFilters() {
	return {
		search: productSearch.value,
		category: productCategoryFilter.value.trim(),
		includeUnpublished: productIncludeUnpublished.checked,
	};
}

async function loadProducts() {
	clearProductStatus();
	productsList.setAttribute("aria-busy", "true");
	try {
		const { search, category, includeUnpublished } = readProductFilters();
		const params = new URLSearchParams({ limit: "200" });
		if (search) params.set("search", search);
		if (category) params.set("category", category);
		if (!includeUnpublished) params.set("include_unpublished", "false");
		const data = await apiRequest(`/api/owner/products?${params.toString()}`);
		productsVisibilitySupported = data.visibility_supported !== false;
		document.getElementById("productPublished").disabled = !productsVisibilitySupported;
		productsEmpty.hidden = data.products.length > 0;
		productsList.replaceChildren();
		// Kept for the low-stock warning: it is recomputed from the same objects
		// the cards render, so a stock change above is already reflected here.
		renderedProducts = data.products;
		data.products.forEach(product => productsList.append(renderProduct(product)));
		updateStockWarning();
	} catch (error) {
		showProductsError(error.message);
		return false;
	} finally {
		productsList.setAttribute("aria-busy", "false");
	}
	return true;
}

function fillProductForm(product) {
	clearProductStatus();
	document.getElementById("productId").value = product.id;
	document.getElementById("productName").value = product.name || "";
	document.getElementById("productCategory").value = product.category || "";
	document.getElementById("productPrice").value = product.price || "";
	document.getElementById("productOriginalPrice").value = product.original_price || "";
	document.getElementById("productStock").value = product.stock ?? 0;
	document.getElementById("productDescription").value = product.description || "";
	document.getElementById("productPublished").checked = product.is_published !== false;
	document.getElementById("productSubmit").textContent = "Save changes";
	// Editing shows the photo the product already has, so the owner can see what
	// they are changing. That image is sent back unchanged unless a replacement
	// is chosen, which is what "preserve the existing image" means.
	existingImage = product.image || "";
	if (imageFileInput) imageFileInput.value = "";
	uploadedImageUrl = "";
	clearImageError();
	// Only the preview is resolved; existingImage above keeps the stored path.
	if (product.image) showImagePreview(resolveProductImageUrl(product.image));
	else hideImagePreview();
	productForm.hidden = false;
	if (typeof productForm.scrollIntoView === "function") productForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetProductForm() {
	productForm.reset();
	// The checkbox has a checked default in the markup, but reset() is not
	// reliable across browsers, so set it explicitly: a new product is visible.
	document.getElementById("productPublished").checked = true;
	document.getElementById("productId").value = "";
	document.getElementById("productSubmit").textContent = "Save product";
	productForm.hidden = true;
	clearProductStatus();
	// Reset the photo picker too, so a previously chosen image cannot follow the
	// owner into the next product.
	if (imageFileInput) imageFileInput.value = "";
	uploadedImageUrl = "";
	existingImage = "";
	hideImagePreview();
	clearImageError();
}

productForm.addEventListener("submit", async event => {
	event.preventDefault();
	clearProductStatus();
	clearImageError();
	const id = document.getElementById("productId").value;
	const submitButton = document.getElementById("productSubmit");
	submitButton.disabled = true;
	try {
		// A chosen file is uploaded first and the SAVED path is what goes to the
		// database, never the browser's blob: URL. With no file, the image the
		// product already had is preserved.
		const uploaded = await uploadSelectedProductImage();
		if (uploaded === null) {
			showProductsError("The product photo could not be uploaded. Check the file and try again.");
			return;
		}
		const payload = {
			name: document.getElementById("productName").value,
			category: document.getElementById("productCategory").value,
			price: document.getElementById("productPrice").value,
			original_price: document.getElementById("productOriginalPrice").value || null,
			stock: document.getElementById("productStock").value,
			image: uploaded || existingImage || null,
			description: document.getElementById("productDescription").value,
		};
		if (productsVisibilitySupported) {
			payload.is_published = document.getElementById("productPublished").checked;
		}
		if (id) {
			await apiRequest(`/api/owner/products/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: JSON.stringify(payload),
			});
		} else {
			await apiRequest("/api/owner/products", {
				method: "POST",
				body: JSON.stringify(payload),
			});
		}
		resetProductForm();
		if (await loadProducts()) showProductsStatus(id ? "Product updated." : "Product added.");
	} catch (error) {
		showProductsError(error.message);
	} finally {
		submitButton.disabled = false;
	}
});

async function deleteProduct(product) {
	const confirmed = window.confirm(
		`Delete "${product.name}" permanently? This cannot be undone. To keep it but take it off the store, use Hide instead. Products that already appear in an order cannot be deleted.`,
	);
	if (!confirmed) return;
	try {
		await apiRequest(`/api/owner/products/${encodeURIComponent(product.id)}`, {
			method: "DELETE",
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		if (await loadProducts()) showProductsStatus("Product removed.");
	} catch (error) {
		showProductsError(error.message);
	}
}

document.getElementById("addProductToggle").addEventListener("click", () => {
	resetProductForm();
	productForm.hidden = false;
	document.getElementById("productName").focus();
});
document.getElementById("productCancel").addEventListener("click", resetProductForm);
document.getElementById("refreshProducts").addEventListener("click", loadProducts);
let searchDebounce;
productSearch.addEventListener("input", () => {
	clearTimeout(searchDebounce);
	searchDebounce = setTimeout(loadProducts, 250);
});
productCategoryFilter.addEventListener("input", () => {
	clearTimeout(searchDebounce);
	searchDebounce = setTimeout(loadProducts, 250);
});
productIncludeUnpublished.addEventListener("change", loadProducts);

// --- account settings -------------------------------------------------------

const passwordForm = document.getElementById("passwordForm");
const passwordError = document.getElementById("passwordError");
const passwordStatus = document.getElementById("passwordStatus");
const passwordMatch = document.getElementById("passwordMatch");

// Live confirmation check. Reports only whether the two fields agree, never any
// part of either value, so the hint is safe to leave on screen. It is a hint, not
// a gate: the server re-validates on submit, and a password is never changed by
// typing alone.
function updatePasswordMatchHint() {
	if (!passwordMatch) return;
	const next = document.getElementById("newPassword").value;
	const confirm = document.getElementById("confirmPassword").value;
	if (next.length === 0 && confirm.length === 0) {
		passwordMatch.hidden = true;
		passwordMatch.textContent = "";
		return;
	}
	passwordMatch.hidden = false;
	passwordMatch.textContent = next === confirm
		? "The new password and its confirmation match."
		: "The new password and its confirmation do not match yet.";
}

for (const id of ["newPassword", "confirmPassword"]) {
	document.getElementById(id).addEventListener("input", updatePasswordMatchHint);
}

passwordForm.addEventListener("submit", async event => {
	event.preventDefault();
	passwordError.hidden = true;
	passwordStatus.hidden = true;
	const submitButton = document.getElementById("passwordSubmit");
	submitButton.disabled = true;
	try {
		const result = await apiRequest("/api/owner/password", {
			method: "POST",
			body: JSON.stringify({
				current_password: document.getElementById("currentPassword").value,
				new_password: document.getElementById("newPassword").value,
				confirm_password: document.getElementById("confirmPassword").value,
			}),
		});
		passwordForm.reset();
		passwordStatus.textContent = result.message || "Your password has been changed.";
		passwordStatus.hidden = false;
		// The change revoked every session, so the token must be re-fetched.
		invalidateCsrfToken();
		showLogin();
	} catch (error) {
		passwordError.textContent = error.message;
		passwordError.hidden = false;
	} finally {
		submitButton.disabled = false;
	}
});

loginForm.addEventListener("submit", async event => {
	event.preventDefault();
	loginError.hidden = true;
	try {
		await apiRequest("/api/owner/login", {
			method: "POST",
			body: JSON.stringify({ password: document.getElementById("ownerPassword").value }),
		});
		loginForm.reset();
		showOwnerDashboard();
	} catch (error) {
		loginError.textContent = error.message;
		loginError.hidden = false;
	}
});

logoutButton.addEventListener("click", async () => {
	try {
		await apiRequest("/api/owner/logout", { method: "POST", body: "{}" });
		// The session is gone, so the cached token is dead with it.
		invalidateCsrfToken();
		showLogin();
	} catch (error) {
		ordersError.textContent = error.message;
		ordersError.hidden = false;
	}
});

async function initializeDashboard() {
	try {
		await apiRequest("/api/owner/csrf");
		await apiRequest("/api/owner/session");
		showOwnerDashboard();
	} catch {
		showLogin();
		// Opening a reset link (?reset_token=...) goes straight to the new
		// password form, with the token already filled in. A token from a URL is
		// still single use, so an intercepted link buys one attempt at most.
		if (tokenFromLink) {
			showResetRequest(tokenFromLink);
			// Drop the token from the address bar so it is not left in history or
			// copied from the bar later.
			window.history.replaceState({}, "", window.location.pathname);
		}
	}
}

if (typeof document.addEventListener === "function") {
	["pointerdown", "keydown", "touchstart", "wheel"].forEach(type => {
		document.addEventListener(type, markOwnerActivity, { passive: true });
	});
	document.addEventListener("mousemove", markOwnerMouseMove, { passive: true });
	document.addEventListener("visibilitychange", () => {
		if (typeof document.visibilityState !== "string") return;
		if (document.visibilityState === "visible") resumeOrdersQuietRefreshing();
		else stopOrdersQuietPoll();
	});
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("focus", () => {
		resumeOrdersQuietRefreshing();
	});
}

// --- order board wiring ------------------------------------------------------
// Filters, board tabs and search are wired once, at boot. Everything is guarded:
// environments that load this script without a full DOM must still boot.
const orderBoardTabsEl = typeof document !== "undefined" ? document.getElementById("orderBoardTabs") : null;
const orderSearchInput = typeof document !== "undefined" ? document.getElementById("orderSearch") : null;
const statusFilterSelect = typeof document !== "undefined" ? document.getElementById("statusFilter") : null;

if (orderBoardTabsEl && typeof orderBoardTabsEl.addEventListener === "function") {
	orderBoardTabsEl.addEventListener("click", event => {
		const button = event.target && typeof event.target.closest === "function"
			? event.target.closest(".order-board-tab")
			: null;
		if (button) selectOrderBoardTab(button.dataset ? button.dataset.boardTab || "needs" : "needs");
	});
}

if (orderSearchInput && typeof orderSearchInput.addEventListener === "function") {
	orderSearchInput.addEventListener("input", () => {
		ordersBoard.search = orderSearchInput.value;
		renderOrderListOnly();
	});
}

if (statusFilterSelect && typeof statusFilterSelect.addEventListener === "function") {
	statusFilterSelect.addEventListener("change", loadOrders);
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
	document.addEventListener("click", orderMenuOutsideClick);
	document.addEventListener("keydown", orderMenuKeydown);
}

initializeDashboard();
