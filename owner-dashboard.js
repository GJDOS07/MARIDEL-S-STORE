"use strict";

const API_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
	? "http://localhost:3000"
	: "https://maridel-s-store.onrender.com";
const ACTIVE_STATUSES = ["Pending", "Confirmed", "Preparing", "Ready for Pickup"];
const STATUS_DISPLAY_ORDER = ["Pending", "Confirmed", "Preparing", "Ready for Pickup", "Picked Up", "Completed", "Cancelled"];
const loginPanel = document.getElementById("loginPanel");
const ordersPanel = document.getElementById("ordersPanel");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const ordersError = document.getElementById("ordersError");
const ordersList = document.getElementById("ordersList");
const logoutButton = document.getElementById("logoutButton");
let csrfToken = "";

async function apiRequest(path, options = {}) {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		...options,
		credentials: "include",
		headers: {
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...(options.method && options.method !== "GET" && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
			...options.headers,
		},
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || "The request could not be completed.");
	if (body.csrf_token) csrfToken = body.csrf_token;
	return body;
}

async function loadOrders() {
	ordersError.hidden = true;
	ordersList.replaceChildren();
	setOrdersLoading(true);
	try {
		const status = document.getElementById("statusFilter").value;
		const query = new URLSearchParams({ limit: "100" });
		if (status) query.set("status", status);
		const orders = await apiRequest(`/api/owner/orders?${query.toString()}`);
		renderSummary(orders);
		const sorted = sortByPickupUrgency(orders);
		sorted.forEach(order => ordersList.append(renderOrder(order)));
		if (orders.length === 0) {
			const empty = document.createElement("p");
			empty.className = "panel muted";
			empty.textContent = "No orders found.";
			ordersList.append(empty);
		}
	} catch (error) {
		ordersError.textContent = error.message;
		ordersError.hidden = false;
		if (error.message === "Owner login is required.") showLogin();
	} finally {
		setOrdersLoading(false);
	}
}

function setOrdersLoading(loading) {
	ordersList.setAttribute("aria-busy", loading ? "true" : "false");
}

function displayStatus(status) {
	if (status === "Completed") return "Picked Up";
	return status;
}

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

function renderSummary(orders) {
	const existing = document.getElementById("ordersSummary");
	if (existing) existing.remove();
	const summary = document.createElement("div");
	summary.className = "panel";
	summary.id = "ordersSummary";
	const counts = new Map(STATUS_DISPLAY_ORDER.map(status => [status, 0]));
	orders.forEach(order => {
		const key = displayStatus(order.status) || "Pending";
		counts.set(key, (counts.get(key) || 0) + 1);
	});
	const urgent = orders.filter(order => ACTIVE_STATUSES.includes(order.status)).length;
	summary.textContent = `Showing ${orders.length} orders · ${urgent} need attention · `
		+ [...counts.entries()].filter(([, count]) => count > 0).map(([status, count]) => `${status}: ${count}`).join(" · ");
	ordersList.before(summary);
}

function renderOrder(order) {
	const card = document.createElement("article");
	card.className = "order-card";
	const title = document.createElement("h3");
	title.textContent = order.order_number || `Order ${order.id}`;
	const status = document.createElement("p");
	status.className = "status";
	status.textContent = displayStatus(order.status);
	let cancellation = null;
	if (order.status === "Cancelled" && order.cancellation_reason) {
		cancellation = document.createElement("p");
		cancellation.textContent = `Cancellation reason: ${order.cancellation_reason}`;
	}
	const customer = document.createElement("p");
	customer.textContent = `${order.customer_name || "Customer"} · ${order.customer_contact || "No contact"}`;
	const pickup = document.createElement("p");
	pickup.textContent = `Pickup: ${order.pickup_date || "Not set"} at ${PickupTimeDisplay.formatPickupTime(order.pickup_time) || "Time unavailable"} Melbourne time`;
	const total = document.createElement("p");
	total.textContent = `Total: A$${Number(order.total || 0).toFixed(2)}`;
	const items = document.createElement("ul");
	items.className = "order-items";
	(order.items || []).forEach(item => {
		const entry = document.createElement("li");
		entry.textContent = `${item.product_name} × ${item.quantity} — A$${Number(item.subtotal || 0).toFixed(2)}`;
		items.append(entry);
	});

	const actionArea = document.createElement("div");
	actionArea.className = "order-actions";
	const nextStatus = {
		Pending: "Confirmed",
		Confirmed: "Preparing",
		Preparing: "Ready for Pickup",
		"Ready for Pickup": "Picked Up",
	};
	const activeForActions = ["Pending", "Confirmed", "Preparing", "Ready for Pickup"];
	if (nextStatus[order.status]) {
		const advance = document.createElement("button");
		advance.type = "button";
		advance.textContent = `Mark ${nextStatus[order.status]}`;
		advance.addEventListener("click", () => updateOrderStatus(order.id, nextStatus[order.status], "", null, null));
		actionArea.append(advance);
	}
	if (activeForActions.includes(order.status)) {
		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.textContent = "Confirm pickup time";
		confirm.addEventListener("click", () => {
			const date = window.prompt("Confirmed pickup date (YYYY-MM-DD):", order.pickup_date || "");
			if (date === null) return;
			const time = window.prompt("Confirmed pickup time (HH:MM, 10:00-20:00 Melbourne):", order.pickup_time || "");
			if (time === null) return;
			updateOrderStatus(order.id, order.status, "", date.trim(), time.trim());
		});
		actionArea.append(confirm);
	}
	if (activeForActions.includes(order.status)) {
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.textContent = "Cancel order";
		cancel.addEventListener("click", () => {
			const reason = window.prompt("Enter a reason for cancelling this order.");
			if (reason !== null) updateOrderStatus(order.id, "Cancelled", reason.trim());
		});
		actionArea.append(cancel);
	}

	card.append(title, status, ...(cancellation ? [cancellation] : []), customer, pickup, total, items, actionArea);
	return card;
}

async function updateOrderStatus(orderId, status, cancellationReason, confirmedDate = null, confirmedTime = null) {
	ordersError.hidden = true;
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
		await loadOrders();
	} catch (error) {
		ordersError.textContent = error.message;
		ordersError.hidden = false;
	}
}

function showOwnerDashboard() {
	loginPanel.hidden = true;
	ordersPanel.hidden = false;
	logoutButton.hidden = false;
	loadOrders();
}

function showLogin() {
	loginPanel.hidden = false;
	ordersPanel.hidden = true;
	logoutButton.hidden = true;
}

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
		showLogin();
	} catch (error) {
		ordersError.textContent = error.message;
		ordersError.hidden = false;
	}
});

document.getElementById("statusFilter").addEventListener("change", loadOrders);

async function initializeDashboard() {
	try {
		await apiRequest("/api/owner/csrf");
		await apiRequest("/api/owner/session");
		showOwnerDashboard();
	} catch {
		showLogin();
	}
}

initializeDashboard();
