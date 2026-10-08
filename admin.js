(() => {
	"use strict";

	const API_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
		? "http://localhost:3000"
		: "https://maridel-s-store.onrender.com";
	const LOGIN_URL = "admin.html";
	const ACTIVE_STATUSES = ["Pending", "Confirmed", "Preparing", "Ready for Pickup"];
	const WORKFLOW_STATUSES = ["Pending", "Confirmed", "Preparing", "Ready for Pickup", "Completed"];
	const STATUS_CLASSES = {
		"Pending": "pending",
		"Confirmed": "confirmed",
		"Preparing": "preparing",
		"Ready for Pickup": "ready",
		"Completed": "completed",
		"Cancelled": "cancelled",
	};
	const NEXT_STATUS = {
		"Confirmed": "Preparing",
		"Preparing": "Ready for Pickup",
		"Ready for Pickup": "Completed",
	};
	const STATUS_ORDER = [
		"Pending",
		"Confirmed",
		"Preparing",
		"Ready for Pickup",
		"Completed",
		"Cancelled",
	];
	const moneyFormatter = new Intl.NumberFormat("en-AU", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	const melbourneDateFormatter = new Intl.DateTimeFormat("en-AU", {
		timeZone: "Australia/Melbourne",
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	const createdAtFormatter = new Intl.DateTimeFormat("en-AU", {
		timeZone: "Australia/Melbourne",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});

	function escapeHtml(value) {
		return String(value ?? "").replace(/[&<>"']/g, character => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		})[character]);
	}

	function formatMoney(amount) {
		return `A$${moneyFormatter.format(Number(amount) || 0)}`;
	}

	function formatPickupDate(value) {
		if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Not confirmed";
		const [year, month, day] = value.split("-").map(Number);
		const date = new Date(Date.UTC(year, month - 1, day, 12));
		return melbourneDateFormatter.format(date);
	}

	function formatPickupTime(value) {
		if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return "Not confirmed";
		const [hour, minute] = value.split(":").map(Number);
		const suffix = hour >= 12 ? "PM" : "AM";
		return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
	}

	function formatCreatedAtFull(value) {
		const instant = new Date(value);
		return Number.isNaN(instant.getTime()) ? "Date unavailable" : createdAtFormatter.format(instant);
	}

	function melbourneToday() {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Australia/Melbourne",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(new Date());
		const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
		return `${values.year}-${values.month}-${values.day}`;
	}

	function statusClass(status) {
		return STATUS_CLASSES[status] || "pending";
	}

	async function readResponse(response) {
		try {
			return await response.json();
		} catch {
			return {};
		}
	}

	async function fetchCsrfToken() {
		const response = await fetch(`${API_BASE_URL}/api/admin/csrf`, {
			credentials: "include",
			cache: "no-store",
		});
		const result = await readResponse(response);
		if (!response.ok || typeof result.csrf_token !== "string") {
			throw new Error("A secure admin request token could not be obtained.");
		}
		return result.csrf_token;
	}

	function initLoginPage() {
		const form = document.getElementById("adminLoginForm");
		if (!form) return;

		const passwordInput = document.getElementById("adminPassword");
		const toggleButton = document.getElementById("togglePassword");
		const loginButton = document.getElementById("loginButton");
		const errorElement = document.getElementById("loginError");

		toggleButton.addEventListener("click", () => {
			const reveal = passwordInput.type === "password";
			passwordInput.type = reveal ? "text" : "password";
			toggleButton.textContent = reveal ? "Hide" : "Show";
			toggleButton.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
			toggleButton.setAttribute("aria-pressed", String(reveal));
		});

		form.addEventListener("submit", async event => {
			event.preventDefault();
			errorElement.hidden = true;
			loginButton.disabled = true;
			loginButton.classList.add("is-loading");
			try {
				const csrfToken = await fetchCsrfToken();
				const response = await fetch(`${API_BASE_URL}/api/admin/login`, {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
					body: JSON.stringify({ password: passwordInput.value }),
				});
				const result = await readResponse(response);
				if (!response.ok || result.authenticated !== true) {
					throw new Error("Invalid password.");
				}
				passwordInput.value = "";
				window.location.replace("admin-dashboard.html");
			} catch (error) {
				errorElement.textContent = error instanceof TypeError
					? "Unable to reach the local admin service. Restart the backend and try again."
					: "Invalid password.";
				errorElement.hidden = false;
			} finally {
				loginButton.disabled = false;
				loginButton.classList.remove("is-loading");
			}
		});
	}

	function initDashboardPage() {
		const dashboardApp = document.getElementById("dashboardApp");
		if (!dashboardApp) return;

		const gate = document.getElementById("dashboardGate");
		const ordersElement = document.getElementById("allOrders");
		const priorityElement = document.getElementById("priorityOrders");
		const summaryElement = document.getElementById("summaryCards");
		const filterElement = document.getElementById("statusFilter");
		const messageElement = document.getElementById("dashboardMessage");
		const refreshButton = document.getElementById("refreshButton");
		const logoutButton = document.getElementById("logoutButton");
		const dialog = document.getElementById("orderDialog");
		const dialogContent = document.getElementById("orderDialogContent");
		let orders = [];
		let notice = null;
		let selectedStatus = "All";
		let isReady = false;

		function showMessage(text, isError = false) {
			notice = { text, isError };
			renderMessage();
		}

		function renderMessage() {
			messageElement.textContent = notice?.text || "";
			messageElement.classList.toggle("error", Boolean(notice?.isError));
			messageElement.hidden = !notice;
		}

		async function fetchOrders() {
			const response = await fetch(`${API_BASE_URL}/api/admin/orders`, {
				credentials: "include",
				cache: "no-store",
			});
			if (response.status === 401) {
				window.location.replace(LOGIN_URL);
				return false;
			}
			const result = await readResponse(response);
			if (!response.ok) throw new Error(result.error || "Orders could not be loaded.");
			if (!Array.isArray(result)) throw new Error("The order response was not valid.");
			orders = result;
			isReady = true;
			gate.hidden = true;
			dashboardApp.hidden = false;
			renderDashboard();
			return true;
		}

		function renderSummary() {
			summaryElement.innerHTML = STATUS_ORDER.map(status => {
				const count = orders.filter(order => order.status === status).length;
				return `
					<button type="button" class="summary-card status-${statusClass(status)}${selectedStatus === status ? " is-selected" : ""}" data-summary-status="${escapeHtml(status)}" aria-pressed="${selectedStatus === status}">
						<span class="summary-label">${escapeHtml(status)}</span>
						<span class="summary-count">${count}</span>
					</button>
				`;
			}).join("");
			document.getElementById("orderCountLabel").textContent = `${orders.length} ${orders.length === 1 ? "order" : "orders"} total`;
		}

		function activeOrders() {
			return orders.filter(order => ACTIVE_STATUSES.includes(order.status));
		}

		function renderOrderCard(order, priority = false) {
			const statusLabel = `<span class="status-pill status-${statusClass(order.status)}">${escapeHtml(order.status)}</span>`;
			const requestedPickup = order.pickup_type === "ASAP"
				? '<span class="pickup-kind">ASAP</span>'
				: `<span class="pickup-kind">Scheduled</span> <span class="pickup-value">${escapeHtml(formatPickupDate(order.requested_pickup_date))} · ${escapeHtml(formatPickupTime(order.requested_pickup_time))}</span>`;
			const confirmedPickup = order.confirmed_pickup_date
				? `${escapeHtml(formatPickupDate(order.confirmed_pickup_date))} · ${escapeHtml(formatPickupTime(order.confirmed_pickup_time))}`
				: "Awaiting confirmation";
			const items = Array.isArray(order.items) ? order.items : [];
			const actionMarkup = renderActions(order);

			return `
				<article class="order-card${priority ? " priority-card" : ""}" data-order-card="${escapeHtml(order.order_id)}">
					<header class="order-card-head">
						<div>
							<button type="button" class="order-title-button" data-open-order="${escapeHtml(order.order_id)}">Order #${escapeHtml(order.order_id)}</button>
							<span class="order-date">${escapeHtml(formatCreatedAtFull(order.created_at))} · Melbourne</span>
						</div>
						${statusLabel}
					</header>
					<div class="order-card-body">
						<div class="order-customer">${escapeHtml(order.customer_name || "Customer")}</div>
						<span class="order-contact">${escapeHtml(order.customer_contact || "No contact provided")}</span>
						${order.customer_email ? `<span class="order-email">${escapeHtml(order.customer_email)}</span>` : ""}
						<div class="pickup-banner">
							<div><span class="pickup-label">Requested pickup</span><div>${requestedPickup}</div></div>
							<div><span class="pickup-label">Confirmed</span><span class="pickup-value">${confirmedPickup}</span></div>
						</div>
						<div class="items-preview">
							${items.length ? items.map(item => `
								<div class="item-line">
									<span>${escapeHtml(item.product_name_snapshot)} × ${Number(item.quantity) || 0}</span>
									<strong>${formatMoney(item.subtotal)}</strong>
								</div>
							`).join("") : '<span class="order-email">No items listed</span>'}
						</div>
						<div class="card-total"><span>Order total</span><strong>${formatMoney(order.total)}</strong></div>
						${actionMarkup}
					</div>
				</article>
			`;
		}

		function renderActions(order) {
			if (!ACTIVE_STATUSES.includes(order.status)) return "";
			const cancelButton = `<button type="button" class="button button-small button-cancel" data-action="cancel" data-order-id="${escapeHtml(order.order_id)}">Cancel order</button>`;
			if (order.status === "Pending") {
				const today = melbourneToday();
				const scheduledDate = order.pickup_type === "SCHEDULED" && order.requested_pickup_date >= today
					? order.requested_pickup_date
					: today;
				const scheduledTime = order.pickup_type === "SCHEDULED" ? order.requested_pickup_time || "" : "";
				return `
					<div class="order-actions">
						<form class="confirm-pickup-form" data-confirm-order="${escapeHtml(order.order_id)}">
							<label>Confirm pickup date
								<input type="date" name="confirmed_pickup_date" min="${today}" value="${escapeHtml(scheduledDate)}" required />
							</label>
							<label>Confirm pickup time
								<input type="time" name="confirmed_pickup_time" min="07:00" max="17:00" value="${escapeHtml(scheduledTime)}" required />
							</label>
							<button type="submit" class="button button-small button-next form-submit">Confirm Order</button>
						</form>
						${cancelButton}
					</div>
				`;
			}
			const nextStatus = NEXT_STATUS[order.status];
			return `
				<div class="order-actions">
					${nextStatus ? `<button type="button" class="button button-small button-next" data-action="advance" data-order-id="${escapeHtml(order.order_id)}" data-next-status="${escapeHtml(nextStatus)}">Mark ${escapeHtml(nextStatus)}</button>` : ""}
					${cancelButton}
				</div>
			`;
		}

		function renderDashboard() {
			renderSummary();
			const active = activeOrders();
			priorityElement.innerHTML = active.length
				? active.slice(0, 6).map(order => renderOrderCard(order, true)).join("")
				: '<div class="empty-state"><strong>All caught up</strong>No active orders need attention right now.</div>';

			const filtered = selectedStatus === "All"
				? orders
				: orders.filter(order => order.status === selectedStatus);
			ordersElement.innerHTML = filtered.length
				? filtered.map(order => renderOrderCard(order)).join("")
				: '<div class="empty-state"><strong>No orders found</strong>There are no orders in this status yet.</div>';
			filterElement.value = selectedStatus;
			renderMessage();
		}

		function renderTimeline(order) {
			if (order.status === "Cancelled") return '<p class="timeline-cancelled">This order was cancelled.</p>';
			const currentIndex = WORKFLOW_STATUSES.indexOf(order.status);
			return `<div class="timeline" aria-label="Order status timeline">${WORKFLOW_STATUSES.map((status, index) => `
				<div class="timeline-step${index < currentIndex ? " is-complete" : ""}${index === currentIndex ? " is-current" : ""}">
					${escapeHtml(status)}
				</div>
			`).join("")}</div>`;
		}

		function renderOrderDetails(order) {
			const items = Array.isArray(order.items) ? order.items : [];
			const pickup = order.pickup_type === "ASAP" ? "ASAP" : "Scheduled";
			dialogContent.innerHTML = `
				<header class="dialog-header">
					<div><p class="eyebrow">Order details</p><h2 id="dialogTitle">Order #${escapeHtml(order.order_id)}</h2></div>
					<button type="button" class="dialog-close" data-close-dialog aria-label="Close order details">×</button>
				</header>
				<div class="dialog-content">
					<div class="detail-grid">
						<div class="detail-block"><span>Customer</span><strong>${escapeHtml(order.customer_name || "Not provided")}</strong></div>
						<div class="detail-block"><span>Contact</span><strong>${escapeHtml(order.customer_contact || "Not provided")}</strong></div>
						<div class="detail-block"><span>Email</span><strong>${escapeHtml(order.customer_email || "Not provided")}</strong></div>
						<div class="detail-block"><span>Status</span><strong>${escapeHtml(order.status)}</strong></div>
						<div class="detail-block"><span>Order date · Melbourne</span><strong>${escapeHtml(formatCreatedAtFull(order.created_at))}</strong></div>
						<div class="detail-block"><span>Pickup type</span><strong>${pickup}</strong></div>
						<div class="detail-block"><span>Requested pickup · Melbourne</span><strong>${escapeHtml(order.pickup_type === "ASAP" ? "ASAP" : `${formatPickupDate(order.requested_pickup_date)} · ${formatPickupTime(order.requested_pickup_time)}`)}</strong></div>
						<div class="detail-block"><span>Confirmed pickup · Melbourne</span><strong>${escapeHtml(order.confirmed_pickup_date ? `${formatPickupDate(order.confirmed_pickup_date)} · ${formatPickupTime(order.confirmed_pickup_time)}` : "Not confirmed")}</strong></div>
					</div>
					<section class="detail-section">
						<h3>Order items</h3>
						${items.map(item => `
							<div class="detail-item">
								<strong>${escapeHtml(item.product_name_snapshot)}</strong>
								<span>Qty ${Number(item.quantity) || 0} × ${formatMoney(item.price)}</span>
								<strong>${formatMoney(item.subtotal)}</strong>
							</div>
						`).join("") || '<p class="order-email">No items listed.</p>'}
						<div class="detail-totals">
							<div class="detail-total-line"><span>Subtotal</span><strong>${formatMoney(order.subtotal)}</strong></div>
							<div class="detail-total-line"><span>Discount</span><strong>−${formatMoney(order.discount)}</strong></div>
							<div class="detail-total-line"><span>Shipping</span><strong>${formatMoney(order.shipping_fee)}</strong></div>
							<div class="detail-total-line grand"><span>Total</span><strong>${formatMoney(order.total)}</strong></div>
						</div>
					</section>
					<section class="detail-section"><h3>Status timeline</h3>${renderTimeline(order)}</section>
				</div>
			`;
			if (!dialog.open) dialog.showModal();
		}

		async function updateOrder(orderId, patch, successMessage) {
			const buttons = dashboardApp.querySelectorAll(`[data-order-id="${CSS.escape(orderId)}"]`);
			buttons.forEach(button => { button.disabled = true; });
			try {
				const csrfToken = await fetchCsrfToken();
				const response = await fetch(`${API_BASE_URL}/api/admin/orders/${encodeURIComponent(orderId)}`, {
					method: "PATCH",
					credentials: "include",
					headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
					body: JSON.stringify(patch),
				});
				const result = await readResponse(response);
				if (response.status === 401) {
					window.location.replace(LOGIN_URL);
					return;
				}
				if (!response.ok) throw new Error(result.error || "This order could not be updated.");
				showMessage(successMessage);
				await fetchOrders();
			} catch (error) {
				showMessage(error.message || "This order could not be updated.", true);
				buttons.forEach(button => { button.disabled = false; });
			}
		}

		async function handleOrderAction(event) {
			const actionButton = event.target.closest("[data-action]");
			if (!actionButton) return;
			const orderId = actionButton.dataset.orderId;
			if (actionButton.dataset.action === "advance") {
				const nextStatus = actionButton.dataset.nextStatus;
				await updateOrder(orderId, { status: nextStatus }, `Order #${orderId} updated.`);
			} else if (actionButton.dataset.action === "cancel") {
				if (!window.confirm(`Cancel order #${orderId}? This cannot be undone.`)) return;
				await updateOrder(orderId, { status: "Cancelled" }, `Order #${orderId} cancelled.`);
			}
		}

		async function handleConfirmation(event) {
			const form = event.target.closest("[data-confirm-order]");
			if (!form) return;
			event.preventDefault();
			const orderId = form.dataset.confirmOrder;
			const formData = new FormData(form);
			await updateOrder(orderId, {
				status: "Confirmed",
				confirmed_pickup_date: formData.get("confirmed_pickup_date"),
				confirmed_pickup_time: formData.get("confirmed_pickup_time"),
			}, `Order #${orderId} confirmed.`);
		}

		async function logout() {
			logoutButton.disabled = true;
			try {
				const csrfToken = await fetchCsrfToken();
				const response = await fetch(`${API_BASE_URL}/api/admin/logout`, {
					method: "POST",
					credentials: "include",
					headers: { "X-CSRF-Token": csrfToken },
				});
				if (response.ok || response.status === 401) {
					window.location.replace(LOGIN_URL);
					return;
				}
				const result = await readResponse(response);
				showMessage(result.error || "Logout failed. Please try again.", true);
			} catch {
				showMessage("Logout failed. Please check your connection and try again.", true);
			} finally {
				logoutButton.disabled = false;
			}
		}

		ordersElement.addEventListener("click", event => {
			const openButton = event.target.closest("[data-open-order]");
			if (openButton) {
				const order = orders.find(item => item.order_id === openButton.dataset.openOrder);
				if (order) renderOrderDetails(order);
				return;
			}
			void handleOrderAction(event);
		});
		priorityElement.addEventListener("click", event => {
			const openButton = event.target.closest("[data-open-order]");
			if (openButton) {
				const order = orders.find(item => item.order_id === openButton.dataset.openOrder);
				if (order) renderOrderDetails(order);
				return;
			}
			void handleOrderAction(event);
		});
		ordersElement.addEventListener("submit", event => { void handleConfirmation(event); });
		priorityElement.addEventListener("submit", event => { void handleConfirmation(event); });
		summaryElement.addEventListener("click", event => {
			const card = event.target.closest("[data-summary-status]");
			if (!card) return;
			selectedStatus = selectedStatus === card.dataset.summaryStatus ? "All" : card.dataset.summaryStatus;
			renderDashboard();
		});
		filterElement.addEventListener("change", () => {
			selectedStatus = filterElement.value;
			renderDashboard();
		});
		dialog.addEventListener("click", event => {
			if (event.target === dialog || event.target.closest("[data-close-dialog]")) dialog.close();
		});
		refreshButton.addEventListener("click", async () => {
			refreshButton.disabled = true;
			try {
				await fetchOrders();
				if (isReady) notice = null;
				renderMessage();
			} catch (error) {
				showMessage(error.message || "Orders could not be refreshed.", true);
			} finally {
				refreshButton.disabled = false;
			}
		});
		logoutButton.addEventListener("click", () => { void logout(); });

		fetchOrders().catch(error => {
			gate.innerHTML = `<span>${escapeHtml(error.message || "The dashboard could not be loaded.")} Check that the local backend is running, then <a href="${LOGIN_URL}">return to login</a>.</span>`;
		});
	}

	document.addEventListener("DOMContentLoaded", () => {
		if (document.body.dataset.adminPage === "login") initLoginPage();
		if (document.body.dataset.adminPage === "dashboard") initDashboardPage();
	});
})();
