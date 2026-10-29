"use strict";
// Browser-level verification of the six owner password visibility toggles.
//
// These drive a REAL Chrome against the REAL served dashboard. Nothing is
// simulated: a Chromium instance loads the page, a human-equivalent click or tap
// lands on each eye button, and the resulting input `type` is read back from the
// live DOM.
//
// The tests run against the isolated sandbox with a synthetic credential. No
// production credential, database or environment variable is used, and no password
// is ever printed: values are compared in memory and only booleans are reported.
//
// The stack and the browser are shared across the suite: starting a server and a
// browser per test makes each test take tens of seconds, and a slow suite is one
// nobody runs, which is how regressions slip back in.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
// The scroll test books pickup slots through the same validator the checkout
// route runs, so every order it seeds is one the real API must accept.
const { validatePickupChoice, OPENING_MINUTES, CLOSING_MINUTES, SLOT_INTERVAL_MINUTES } = require("./pickup-time");

const { chromium } = require("playwright-core");

const SITE_PORT = 4292;
// The dashboard hardcodes localhost:3000 when opened from a loopback host, so the
// sandbox API is started there: that is the actual local deployment shape, and a
// different port would test a configuration nobody runs.
const API_PORT = 3000;
const ORIGIN = `http://localhost:${SITE_PORT}`;
// Synthetic credentials only. These never reach production and are not the
// operator's password.
const TEST_PASSWORD = "Synthetic-Toggle-Check-4471";
const { hashOwnerPassword } = require("./owner-credentials-tool");

// The six fields, from the login panel through to password recovery.
const FIELDS = [
	{ input: "ownerPassword", button: "togglePassword", label: "owner login password" },
	{ input: "currentPassword", button: "toggleCurrentPassword", label: "current password" },
	{ input: "newPassword", button: "toggleNewPassword", label: "new password" },
	{ input: "confirmPassword", button: "toggleConfirmPassword", label: "confirm new password" },
	{ input: "resetNewPassword", button: "toggleResetNewPassword", label: "reset new password" },
	{ input: "resetConfirmPassword", button: "toggleResetConfirmPassword", label: "reset confirmation password" },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser = null;
let api = null;
let site = null;

// Guards against a port left bound by an earlier crashed run, which is the usual
// reason a browser test fails on a second invocation.
async function portIsFree(port) {
	try {
		const probe = await fetch(`http://127.0.0.1:${port}/`);
		return !probe.ok;
	} catch {
		return true;
	}
}

test.before(async () => {
	// Reuse the Chrome already installed on this machine, so no browser download
	// is needed and the test runs against a real, mainstream engine.
	for (const port of [SITE_PORT, API_PORT]) {
		if (!(await portIsFree(port))) {
			throw new Error(`port ${port} is already in use; stop the other process and re-run`);
		}
	}

	api = spawn(process.execPath, [path.join(__dirname, "server.js")], {
		env: {
			...process.env,
			LOCAL_SANDBOX_DB: "1",
			PORT: String(API_PORT),
			NODE_ENV: "development",
			// Synthetic credential, supplied in-memory only.
			OWNER_PASSWORD_HASH: hashOwnerPassword(TEST_PASSWORD),
			OWNER_SESSION_SECRET: "browser-toggle-check-secret-0123456789",
			DOTENV_CONFIG_PATH: path.join(__dirname, "does-not-exist.env"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	site = spawn(process.execPath, [path.join(__dirname, "serve-local.js")], {
		env: { ...process.env, SITE_PORT: String(SITE_PORT), DOTENV_CONFIG_PATH: path.join(__dirname, "does-not-exist.env") },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const waitFor = async (url, ms = 40000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			try { if ((await fetch(url)).status === 200) return true; } catch {}
			await sleep(200);
		}
		return false;
	};
	const apiUp = await waitFor(`http://127.0.0.1:${API_PORT}/`);
	const siteUp = await waitFor(`${ORIGIN}/owner-dashboard.html`);
	if (!apiUp || !siteUp) throw new Error(`stack did not start (api=${apiUp} site=${siteUp})`);

	browser = await chromium.launch({ channel: "chrome", headless: true });
});

test.after(async () => {
	if (browser) await browser.close();
	for (const child of [api, site]) {
		if (!child) continue;
		child.kill("SIGTERM");
	}
	await sleep(500);
});

// A fresh context and page per test, so no session cookie leaks between tests.
// The page is navigated to the dashboard here, because every test needs the real
// document: a page that was never navigated is at about:blank and has no controls.
async function newPage({ viewport, hasTouch } = {}) {
	const context = await browser.newContext({ viewport, hasTouch });
	const page = await context.newPage();
	await page.goto(`${ORIGIN}/owner-dashboard.html`, { waitUntil: "networkidle" });
	// initializeDashboard runs on load and reveals one panel; wait until it settles.
	await page.waitForSelector("#loginPanel:not([hidden]), #ordersPanel:not([hidden])", { timeout: 20000 });
	return { context, page };
}

// Logs the browser in so the account and reset panels become reachable.
//
// Waits for the dashboard script to finish initialising, which reveals whichever
// panel the current session state calls for. A leftover session cookie would
// otherwise land straight in the dashboard with no login form, so the login form
// is waited for explicitly and a stale session is logged out first.
async function loginAndOpenPanels(page) {
	await page.goto(`${ORIGIN}/owner-dashboard.html`, { waitUntil: "networkidle" });
	// initializeDashboard runs on load and shows one panel; wait until it settles.
	await page.waitForSelector("#loginPanel:not([hidden]), #ordersPanel:not([hidden])", { timeout: 20000 });

	// A stale session from an earlier run would skip the login form entirely.
	const alreadyLoggedIn = await page.locator("#ordersPanel").isVisible();
	if (alreadyLoggedIn) {
		await page.click("#logoutButton");
		await page.waitForSelector("#loginPanel:not([hidden])", { timeout: 15000 });
	}

	await page.fill("#ownerPassword", TEST_PASSWORD);
	await page.click("#loginForm button[type=submit]");
	await page.waitForSelector("#ordersPanel:not([hidden])", { timeout: 20000 });
	// Account panel.
	await page.click('#dashboardTabs .tab[data-tab="account"]');
	await page.waitForSelector("#accountPanel:not([hidden])", { timeout: 15000 });
}

// Opens the panel that owns a given field. The three password areas live on
// different panels, and only one panel is visible at a time, so each must be
// opened before its fields can be touched.
//
// "Is a session open?" is not "is the orders panel visible": after switching to
// the Account or Products tab, ordersPanel is hidden while the session is still
// live. Checking only the orders panel is why the reset step used to hang: the
// logout was skipped, the login panel stayed hidden, and #forgotPasswordLink
// could never be clicked. The login panel being hidden is the reliable signal.
async function openPanelFor(page, field) {
	const loginPanelVisible = async () => page.locator("#loginPanel").isVisible();

	// Ends any live session or open recovery panel and returns to the login
	// panel. "Is the login panel visible?" is the one reliable signal: it is
	// hidden while a session is open AND while either recovery panel is open, so
	// checking it alone covers every intermediate state.
	async function returnToLogin() {
		if (await loginPanelVisible()) return;

		// A recovery panel is open: step back through it rather than trying to
		// log out, because the logout button is hidden on those panels.
		const requestOpen = await page.locator("#resetRequestPanel").isVisible();
		const passwordOpen = await page.locator("#resetPasswordPanel").isVisible();
		if (requestOpen || passwordOpen) {
			const back = page.locator(requestOpen ? "#backToLoginFromRequest" : "#backToLoginFromReset");
			await back.click();
			await page.waitForSelector("#loginPanel:not([hidden])", { timeout: 20000 });
			if (await loginPanelVisible()) return;
		}

		await page.waitForSelector("#logoutButton:visible", { timeout: 20000 });
		await page.click("#logoutButton");
		await page.waitForSelector("#loginPanel:not([hidden])", { timeout: 20000 });
	}

	// Logs in if no session is live, then opens the account panel.
	//
	// This must NOT log out first: a reload keeps the session cookie, so the one
	// reliable way through the login panel state is to log in and let the
	// dashboard settle, not to tear the session down.
	async function openAccount() {
		const accountVisible = await page.locator("#accountPanel").isVisible();
		if (accountVisible) return;

		// A recovery panel blocks everything; step out of it without logging out.
		const requestOpen = await page.locator("#resetRequestPanel").isVisible();
		const passwordOpen = await page.locator("#resetPasswordPanel").isVisible();
		if (requestOpen || passwordOpen) {
			const back = page.locator(requestOpen ? "#backToLoginFromRequest" : "#backToLoginFromReset");
			await back.click();
			await page.waitForSelector("#loginPanel:not([hidden])", { timeout: 20000 });
		}

		// Reload: a live session then opens the dashboard with orders active.
		await page.goto(`${ORIGIN}/owner-dashboard.html`, { waitUntil: "networkidle" });
		await page.waitForSelector("#ordersPanel:not([hidden]), #loginPanel:not([hidden])", { timeout: 25000 });
		if (await page.locator("#loginPanel").isVisible()) {
			await page.fill("#ownerPassword", TEST_PASSWORD);
			await page.click("#loginForm button[type=submit]");
			await page.waitForSelector("#ordersPanel:not([hidden])", { timeout: 25000 });
		}
		await page.click('#dashboardTabs .tab[data-tab="account"]');
		await page.waitForSelector("#accountPanel:not([hidden])", { timeout: 20000 });
	}

	if (field.input === "ownerPassword") {
		// The login panel is the default state, so only a live session needs undoing.
		await returnToLogin();
		return;
	}

	if (field.input.startsWith("reset")) {
		await returnToLogin();
		// "Forgot password?" opens the request step. Without an email provider
		// that step is a dead end, so the "I already have a reset token" link is
		// the only way to reach the password form.
		await page.click("#forgotPasswordLink");
		await page.waitForSelector("#resetRequestPanel:not([hidden])", { timeout: 20000 });
		await page.click("#haveResetTokenLink");
		await page.waitForSelector("#resetPasswordPanel:not([hidden])", { timeout: 20000 });
		return;
	}

	await openAccount();
}

test("all six password toggles behave correctly in a real browser", async t => {
	const { context, page } = await newPage();
	t.after(() => context.close());

	const results = [];
	for (const field of FIELDS) {
		await openPanelFor(page, field);
		const input = page.locator(`#${field.input}`);
		const button = page.locator(`#${field.button}`);

		// 1. Masked initially.
		await page.waitForSelector(`#${field.input}`, { state: "attached", timeout: 15000 });
		const initialType = await input.getAttribute("type", { timeout: 15000 });
		const initialPressed = await button.getAttribute("aria-pressed");
		const initialLabel = await button.getAttribute("aria-label");

		// 2. Type a value, then reveal.
		await input.fill(TEST_PASSWORD);
		const valueBefore = await input.inputValue();
		await button.click();
		const revealedType = await input.getAttribute("type");
		const revealedPressed = await button.getAttribute("aria-pressed");
		const revealedLabel = await button.getAttribute("aria-label");
		const revealedTitle = await button.getAttribute("title");
		const valueAfterReveal = await input.inputValue();

		// 3. Mask again.
		await button.click();
		const maskedAgainType = await input.getAttribute("type");
		const maskedAgainPressed = await button.getAttribute("aria-pressed");

		// 4. The value survived every toggle.
		const valueAfterMask = await input.inputValue();
		const valuePreserved = valueBefore === valueAfterReveal && valueBefore === valueAfterMask;

		results.push({
			field: field.label,
			initialType, revealedType, maskedAgainType, valuePreserved,
		});

		assert.equal(initialType, "password", `${field.label} must start masked`);
		assert.equal(initialPressed, "false", `${field.label} button must start unpressed`);
		assert.equal(initialLabel, "Show password", `${field.label} label must start "Show password"`);
		assert.equal(revealedType, "text", `${field.label} must be revealed after one click`);
		assert.equal(revealedPressed, "true", `${field.label} must report pressed`);
		assert.equal(revealedLabel, "Hide password", `${field.label} label must become "Hide password"`);
		assert.equal(revealedTitle, "Hide password", `${field.label} title must become "Hide password"`);
		assert.equal(maskedAgainType, "password", `${field.label} must mask again`);
		assert.equal(maskedAgainPressed, "false", `${field.label} must report unpressed`);
		assert.ok(valuePreserved, `${field.label} value must survive every toggle`);
	}

	// The whole matrix, without any value in it.
	console.log("\n  TOGGLE MATRIX (no values printed)");
	console.log("  " + "field".padEnd(28) + "initial".padEnd(10) + "revealed".padEnd(10) + "re-masked".padEnd(11) + "value kept");
	for (const row of results) {
		console.log("  " + row.field.padEnd(28) + row.initialType.padEnd(10) + row.revealedType.padEnd(10)
			+ row.maskedAgainType.padEnd(11) + (row.valuePreserved ? "yes" : "NO"));
	}
});

test("revealing one field does not affect any other field", async t => {
	const { context, page } = await newPage();
	t.after(() => context.close());

	// Fill all six across their panels. Each openPanelFor call moves to the panel
	// that owns the field, so the fills happen where the field is actually
	// visible. After a panel switch an earlier panel's fields are hidden but
	// still hold their values, which is what this test relies on.
	for (const field of FIELDS) {
		await openPanelFor(page, field);
		await page.fill(`#${field.input}`, TEST_PASSWORD);
	}

	// Return to the account panel and reveal only the new password.
	await openPanelFor(page, FIELDS[2]);
	await page.click("#toggleNewPassword");

	assert.equal(await page.locator("#newPassword").getAttribute("type"), "text",
		"the targeted field must be revealed");
	for (const field of FIELDS.filter(f => f.input !== "newPassword")) {
		await openPanelFor(page, field);
		const type = await page.locator(`#${field.input}`).getAttribute("type");
		assert.equal(type, "password", `${field.label} must stay masked`);
	}
});

test("the eye button never submits the form or changes a password", async t => {
	const { context, page } = await newPage();
	t.after(() => context.close());
	await loginAndOpenPanels(page);
	await page.fill("#currentPassword", TEST_PASSWORD);
	await page.fill("#newPassword", "Another-Synthetic-Pass-991");
	await page.fill("#confirmPassword", "Another-Synthetic-Pass-991");

	// A click on the eye must not fire submit: the dashboard leaves the account
	// panel on a successful password change, which is the observable signal.
	await page.click("#toggleNewPassword");
	await sleep(400);
	assert.equal(await page.locator("#accountPanel").isVisible(), true,
		"clicking the eye must not leave the account panel");

	// The typed values are untouched, so nothing was submitted and reset.
	assert.equal(await page.inputValue("#newPassword"), "Another-Synthetic-Pass-991");
	assert.equal(await page.inputValue("#confirmPassword"), "Another-Synthetic-Pass-991");

	// The button is type=button, so it cannot submit natively.
	assert.equal(await page.locator("#toggleNewPassword").getAttribute("type"), "button");
});

test("keyboard activation reveals and masks the field", async t => {
	const { context, page } = await newPage();
	t.after(() => context.close());
	await loginAndOpenPanels(page);
	await page.fill("#newPassword", TEST_PASSWORD);

	// Focus the toggle and activate it with the keyboard, as an assistive-tech
	// user would. Enter on a focused button fires click.
	await page.focus("#toggleNewPassword");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(150);
	assert.equal(await page.locator("#newPassword").getAttribute("type"), "text",
		"Enter must reveal the field");

	await page.keyboard.press("Enter");
	await page.waitForTimeout(150);
	assert.equal(await page.locator("#newPassword").getAttribute("type"), "password",
		"Enter must mask it again");
});

test("the password-match hint updates correctly and never echoes a password", async t => {
	const { context, page } = await newPage();
	t.after(() => context.close());
	await loginAndOpenPanels(page);

	// Empty: hidden.
	assert.equal(await page.locator("#passwordMatch").isHidden(), true, "no hint when both are empty");

	// Differing: hint visible, says they do not match, and echoes neither value.
	await page.fill("#newPassword", "First-Synthetic-Pass-1");
	await page.fill("#confirmPassword", "Different-Synthetic-Pass-2");
	await page.waitForTimeout(150);
	const differing = await page.locator("#passwordMatch").textContent();
	assert.match(differing, /do not match/i);
	assert.ok(!differing.includes("First-Synthetic-Pass-1"), "the hint must not echo a password");
	assert.ok(!differing.includes("Different-Synthetic-Pass-2"), "the hint must not echo a password");

	// Matching: hint updates.
	await page.fill("#confirmPassword", "First-Synthetic-Pass-1");
	await page.waitForTimeout(150);
	const matching = await page.locator("#passwordMatch").textContent();
	assert.match(matching, /match/i);
	assert.ok(!matching.includes("First-Synthetic-Pass-1"), "the hint must not echo a password");

	// Clearing both hides it again.
	await page.fill("#newPassword", "");
	await page.fill("#confirmPassword", "");
	await page.waitForTimeout(150);
	assert.equal(await page.locator("#passwordMatch").isHidden(), true);
});

test("the toggle matrix holds on a mobile viewport", async t => {
	const { context, page } = await newPage({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
	});
	t.after(() => context.close());

	for (const field of FIELDS) {
		await openPanelFor(page, field);
		const button = page.locator(`#${field.button}`);
		// On a narrow viewport a control below the fold has no box, so bring it
		// into view before measuring: that is what a thumb would do.
		await button.scrollIntoViewIfNeeded();
		const box = await button.boundingBox();
		assert.ok(box, `${field.label} toggle must be visible on mobile`);
		assert.ok(box.width >= 24 && box.height >= 24,
			`${field.label} touch target must be at least 24px, got ${box.width}x${box.height}`);
		// Tap rather than click, so the touch path is what is exercised.
		await button.tap();
		await page.waitForTimeout(80);
		assert.equal(await page.locator(`#${field.input}`).getAttribute("type"), "text",
			`${field.label} must reveal on tap`);
		await button.tap();
		await page.waitForTimeout(80);
		assert.equal(await page.locator(`#${field.input}`).getAttribute("type"), "password",
			`${field.label} must mask on second tap`);
	}
});

test("the toggle matrix holds on a desktop viewport", async t => {
	const { context, page } = await newPage({ viewport: { width: 1280, height: 800 } });
	t.after(() => context.close());

	// All six buttons must sit inside their field, and the inputs must keep a
	// usable width rather than shrinking behind the icon.
	for (const field of FIELDS) {
		await openPanelFor(page, field);
		const inputBox = await page.locator(`#${field.input}`).boundingBox();
		const buttonBox = await page.locator(`#${field.button}`).boundingBox();
		assert.ok(inputBox && buttonBox, `${field.label} must be laid out`);
		assert.ok(
			buttonBox.x + buttonBox.width <= inputBox.x + inputBox.width + 1,
			`${field.label} toggle must sit inside the field`,
		);
		assert.ok(inputBox.width > 120, `${field.label} must keep a usable width`);
	}
});

// --- the SameSite root cause -------------------------------------------------
// The dashboard is on one origin and the API on another, so every owner request is
// cross-origin. A SameSite=Lax cookie is NOT sent on a cross-origin POST, which is
// why the CSRF cookie never reached the login route: the owner was locked out of
// the dashboard while every same-origin test passed, and the failure was invisible
// outside a real browser.

test("the owner cookies are set so a cross-origin browser POST will carry them", async t => {
	const { serializeCookie, sameSiteFor } = require("./order-routes");
	assert.equal(sameSiteFor(true), "None", "a secure deployment must allow cross-origin cookies");
	assert.equal(sameSiteFor(false), "Lax", "without Secure the browser would reject None anyway");

	const header = serializeCookie("maridel_owner_session", "synthetic", {
		maxAge: 28800, httpOnly: true, secure: true,
	});
	assert.match(header, /SameSite=None/);
	assert.match(header, /Secure/);
	assert.match(header, /HttpOnly/);
});

test("a sandbox deployment marks its cookies Secure, because 127.0.0.1 is a secure context", async t => {
	const { createOrderRouter } = require("./order-routes");
	const { createSandboxDatabase } = require("./local-sandbox-database");
	const { createPoolAdapter } = require("./pglite-pool");
	const express = require("express");

	const previous = process.env.LOCAL_SANDBOX_DB;
	process.env.LOCAL_SANDBOX_DB = "1";
	process.env.OWNER_SESSION_SECRET = "x".repeat(43);
	try {
		const sandbox = await createSandboxDatabase();
		t.after(() => sandbox.close());
		const app = express();
		app.use(express.json());
		app.use("/api", createOrderRouter(createPoolAdapter(sandbox.db), {
			allowedOrigins: ["http://localhost:4173"],
			isOriginAllowed: origin => origin === "http://localhost:4173",
		}));
		const server = app.listen(0, "127.0.0.1");
		t.after(() => new Promise(resolve => server.close(resolve)));
		await new Promise(resolve => server.once("listening", resolve));

		const csrf = await fetch(`http://127.0.0.1:${server.address().port}/api/owner/csrf`, {
			headers: { Origin: "http://localhost:4173" },
		});
		const cookie = csrf.headers.getSetCookie().find(c => c.startsWith("maridel_owner_csrf="));
		assert.ok(cookie, "the CSRF cookie must be set");
		assert.match(cookie, /SameSite=None/, "the cookie must travel cross-origin");
		assert.match(cookie, /Secure/, "and be marked Secure, which None requires");
	} finally {
		if (previous === undefined) delete process.env.LOCAL_SANDBOX_DB;
		else process.env.LOCAL_SANDBOX_DB = previous;
	}
});

// --- the orders board keeps the page where the owner is ----------------------
//
// The trigger is a real Android complaint: pressing a card's primary action
// (Confirm order, then Mark ready, then Mark picked up) used to fling the page
// to the top, because the reload emptied the whole board before the fresh data
// arrived. The fix builds the new board off-screen, swaps it in once, restores
// the scroll, and parks focus on the same order's next step.
//
// Scroll assertions keep their exact meaning:
//   * presses 1 and 2 must leave window.scrollY byte-identical,
//   * the tab switch and press 3 must never land on or near the top,
//   * a leaving card can cost at most about one card height (170px),
//   * focus must land on the next action button without scrolling.

// An order action re-renders in place; a pixel or two of noise is tolerated
// where the spec allows proximity (press 3 and later), not on presses 1 and 2.
const SCROLL_TOLERANCE_PX = 170;

// Books one pickup slot a day or more ahead, in open hours, using the exact
// validator the checkout route runs. Day 0 is skipped so the slot cannot expire
// between the probe and the checkout.
function findFuturePickupSlot() {
	const base = new Date();
	for (let dayOffset = 1; dayOffset <= 21; dayOffset += 1) {
		const day = new Date(base.getTime() + dayOffset * 24 * 60 * 60 * 1000);
		const date = day.toISOString().slice(0, 10);
		for (let minutes = OPENING_MINUTES; minutes <= CLOSING_MINUTES; minutes += SLOT_INTERVAL_MINUTES) {
			const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
			try {
				validatePickupChoice(date, time);
				return { date, time };
			} catch {
				// Closed weekday or unopen slot: probe the next one.
			}
		}
	}
	throw new Error("no future pickup slot accepted by the store's own rules");
}

async function createScrollPatrolOrder(pickup, index) {
	// 32 bytes as base64url: the exact idempotency-key shape checkout requires.
	const idempotencyKey = crypto.randomBytes(32).toString("base64url");
	const response = await fetch(`http://127.0.0.1:${API_PORT}/api/orders`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify({
			customer_name: `Scroll Patrol ${index}`,
			customer_contact: "0412345678",
			pickup_date: pickup.date,
			pickup_time: pickup.time,
			items: [{ product_id: 74, quantity: 1 }],
		}),
	});
	if (response.status !== 201) {
		throw new Error(`checkout seeding failed with ${response.status}`);
	}
	const body = await response.json();
	return String(body.id);
}

test("stepping an order through the board keeps the page where the owner is", async t => {
	// Seven seeded orders plus the sandbox's legacy first order: enough depth to
	// need scrolling at 375px. The three browser tests that check out keep the
	// file inside the checkout rate limit of ten per ten minutes.
	const pickup = findFuturePickupSlot();
	const createdIds = [];
	for (let index = 1; index <= 7; index += 1) {
		createdIds.push(await createScrollPatrolOrder(pickup, index));
	}

	const { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
	t.after(() => context.close());

	await page.fill("#ownerPassword", TEST_PASSWORD);
	await page.click("#loginForm button[type=submit]");
	await page.waitForSelector("#ordersPanel:not([hidden])", { timeout: 20000 });
	await page.waitForSelector("article.order-card", { timeout: 20000 });
	await page.waitForFunction(() => {
		const list = document.getElementById("ordersList");
		return list && list.querySelectorAll("article.order-card").length > 1 && list.getAttribute("aria-busy") !== "true";
	}, undefined, { timeout: 20000, polling: 100 });

	// The seeded legacy order sorts first (oldest pickup), so an early member of
	// the fresh batch sits deeper in the list; park the third one on screen like
	// an owner scrolling to their work.
	const targetId = createdIds[2];
	const cardSelector = `.order-card[data-id="${targetId}"]`;
	await page.waitForSelector(cardSelector, { timeout: 20000 });
	await page.evaluate(selector => {
		document.querySelector(selector).scrollIntoView({ block: "center" });
	}, cardSelector);
	const startScrollY = await page.evaluate(() => window.scrollY);
	assert.ok(startScrollY > 100, `the target card must require scrolling (scrollY=${startScrollY})`);

	// --- press 1: Confirm order (Pending -> Confirmed, same tab) ------------
	const before1 = await page.evaluate(() => window.scrollY);
	await page.locator(`${cardSelector} button.primary-action`).click();
	await page.waitForFunction(
		(args) => {
			const card = document.querySelector(`.order-card[data-id="${args.orderId}"]`);
			const button = card && card.querySelector("button.primary-action");
			return Boolean(button && button.textContent === args.nextLabel);
		},
		{ orderId: targetId, nextLabel: "Mark ready" },
		{ timeout: 15000, polling: 100 },
	);
	const after1 = await page.evaluate(() => window.scrollY);
	// The browser clears the focus of a removed button around the end of the
	// click event, so the focus can land a frame after the card repaints; wait
	// for it to reach the same order's next action instead of reading once.
	await page.waitForFunction(
		selector => {
			const card = document.querySelector(selector);
			const button = card && card.querySelector("button.primary-action");
			return Boolean(button && document.activeElement === button);
		},
		cardSelector,
		{ timeout: 5000, polling: 50 },
	);
	const focus1 = await page.evaluate(selector => {
		const card = document.querySelector(selector);
		const button = card && card.querySelector("button.primary-action");
		return button && document.activeElement === button ? button.textContent : null;
	}, cardSelector);

	// --- press 2: Mark ready (Confirmed -> Ready for Pickup, moves tab) ------
	const before2 = await page.evaluate(() => window.scrollY);
	await page.locator(`${cardSelector} button.primary-action`).click();
	await page.waitForFunction(
		(args) => !document.querySelector(`.order-card[data-id="${args.orderId}"]`),
		{ orderId: targetId },
		{ timeout: 15000, polling: 100 },
	);
	const after2 = await page.evaluate(() => window.scrollY);
	const stillListed2 = await page.evaluate(selector => Boolean(document.querySelector(selector)), cardSelector);

	// --- reach the moved card through its new tab ----------------------------
	await page.locator('[data-board-tab="upcoming"]').click();
	await page.waitForSelector(cardSelector, { timeout: 20000 });
	const afterTab = await page.evaluate(() => window.scrollY);

	// --- press 3: Mark picked up (Ready for Pickup -> done tab) --------------
	const before3 = await page.evaluate(() => window.scrollY);
	await page.locator(`${cardSelector} button.primary-action`).click();
	await page.waitForFunction(
		(args) => !document.querySelector(`.order-card[data-id="${args.orderId}"]`),
		{ orderId: targetId },
		{ timeout: 15000, polling: 100 },
	);
	const after3 = await page.evaluate(() => window.scrollY);
	const stillListed3 = await page.evaluate(selector => Boolean(document.querySelector(selector)), cardSelector);

	// Reporting first, assertions second: the owner needs the scrollY numbers.
	console.log("\n  ORDER BOARD SCROLL REPORT (375px viewport)");
	console.log("  press 1          : " + before1 + " -> " + after1 + " (focus after swap: " + focus1 + ")");
	console.log("  press 2          : " + before2 + " -> " + after2 + " (card still in tab: " + stillListed2 + ")");
	console.log("  after tab switch : " + afterTab);
	console.log("  press 3          : " + before3 + " -> " + after3 + " (card still in tab: " + stillListed3 + ")");

	assert.equal(after1, before1, "press 1 must not move the page");
	assert.equal(focus1, "Mark ready", "press 1 must park focus on the same order's next action");
	assert.equal(after2, before2, "press 2 must not move the page even though the card left the tab");
	assert.equal(stillListed2, false, "press 2 moves the card to the upcoming tab");
	assert.ok(afterTab > 0, "choosing the new tab must not scroll to the top");
	// The card leaving to the Done tab shortens the tab's list, so the page can
	// lose at most about one card of scroll: "as close as possible", never the
	// top of the board.
	assert.ok(Math.abs(after3 - before3) <= SCROLL_TOLERANCE_PX,
		`press 3 must keep the page near its position (moved ${before3 - after3}px)`);
	assert.ok(after3 > 0, "press 3 must never scroll to the top");
	assert.equal(stillListed3, false, "press 3 moves the card to the done tab");
});

// --- an order action must paint immediately, not after three round trips -----
//
// The very slow free server turns one press into status + orders + sales round
// trips that the old code awaited before repainting (1-2s on a phone). The
// optimistic path repaints the same card in one frame, keeps the change live
// while the request crawls, merges the server's answer, and rolls the card
// back with the error banner when the request fails.
test("an order action paints immediately on a slow server and rolls back on failure", async t => {
	const { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
	t.after(() => context.close());

	// One checkout order on the shared stack (the file stays inside the
	// checkout rate limit of ten per ten minutes).
	const pickup = findFuturePickupSlot();
	const orderId = await createScrollPatrolOrder(pickup, 1);
	const cardSelector = `.order-card[data-id="${orderId}"]`;

	await page.fill("#ownerPassword", TEST_PASSWORD);
	await page.click("#loginForm button[type=submit]");
	await page.waitForSelector("#ordersPanel:not([hidden])", { timeout: 20000 });
	await page.waitForSelector(cardSelector, { timeout: 20000 });
	// Park the card on screen like a thumb would: the scroll number must be
	// read AFTER the card is where it will be pressed, not before Playwright's
	// click helper scrolls it into reach.
	await page.evaluate(selector => {
		document.querySelector(selector).scrollIntoView({ block: "center" });
	}, cardSelector);
	await new Promise(resolve => setTimeout(resolve, 150));

	// Latency forcing: the status request crawls (800ms, like a waking free
	// server) and the two follow-up fetches crawl too (300ms each). The first
	// status call lands on the real server; the second is killed to test the
	// rollback.
	let statusCalls = 0;
	await context.route("**/api/owner/orders/*/status", async route => {
		statusCalls += 1;
		if (statusCalls === 1) {
			await new Promise(resolve => setTimeout(resolve, 800));
			await route.continue();
		} else {
			await route.abort("connectionreset");
		}
	});
	await context.route("**/api/owner/orders?*", async route => {
		await new Promise(resolve => setTimeout(resolve, 300));
		await route.continue();
	});
	await context.route("**/api/owner/sales*", async route => {
		await new Promise(resolve => setTimeout(resolve, 300));
		await route.continue();
	});

	// --- press 1 with a slow server: the card must change before it answers --
	const scrollBefore = await page.evaluate(() => window.scrollY);
	const pressStartedAt = Date.now();
	await page.locator(`${cardSelector} button.primary-action`).click();
	await page.waitForFunction(
		args => {
			const card = document.querySelector(`.order-card[data-id="${args.orderId}"]`);
			const button = card && card.querySelector("button.primary-action");
			return Boolean(button && button.textContent === "Mark ready");
		},
		{ orderId },
		{ timeout: 15000, polling: 100 },
	);
	const pressMilliseconds = Date.now() - pressStartedAt;
	const scrollAfterPress = await page.evaluate(() => window.scrollY);

	// --- a poll racing the crawling request must not flip the card back ------
	// The status POST has not reached the server yet (it is still inside its
	// 800ms delay), so a refresh right now returns the older Pending list.
	const pollRan = await page.evaluate(() => {
		if (typeof refreshOrdersQuietly !== "function") return "unreachable";
		return refreshOrdersQuietly().then(() => true);
	});
	await new Promise(resolve => setTimeout(resolve, 400));
	const pollGuardCard = await page.evaluate(selector => {
		const card = document.querySelector(selector);
		const button = card && card.querySelector("button.primary-action");
		return button ? button.textContent : null;
	}, cardSelector);

	// --- the slow request lands: the merge keeps the same new status ---------
	// 800ms on the wire plus the server's own work, then the follow-up sales
	// fetch; 1300ms puts the merge safely behind both.
	await new Promise(resolve => setTimeout(resolve, 1300));
	const mergeCard = await page.locator(`${cardSelector} button.primary-action`).textContent();
	const mergeMilliseconds = Date.now() - pressStartedAt;

	// --- reporting first, so the numbers survive any later assertion ---------
	console.log("\n  ORDER ACTION SPEED REPORT (375px, status+800ms, list/sales+300ms)");
	console.log(`  press -> card changed : ${pressMilliseconds}ms (scrollY ${scrollBefore} -> ${scrollAfterPress})`);
	console.log(`  slow request merged by: ${mergeMilliseconds}ms (card after merge: ${mergeCard})`);
	console.log(`  poll raced the request: ran=${pollRan} card stayed at: ${pollGuardCard}`);

	// --- press 2 fails: the card returns to its earlier Confirmed state ------
	// In flight the button showed "Mark picked up"; the rollback restores the
	// exact pre-press card: Confirmed, with "Mark ready" enabled again.
	await page.locator(`${cardSelector} button.primary-action`).click();
	await page.waitForFunction(
		args => {
			const card = document.querySelector(`.order-card[data-id="${args.orderId}"]`);
			const button = card && card.querySelector("button.primary-action");
			return Boolean(button && button.textContent === args.label && !button.disabled);
		},
		{ orderId, label: "Mark ready" },
		{ timeout: 10000, polling: 100 },
	);
	const bannerAfterFailure = await page.evaluate(() => {
		const banner = document.getElementById("ordersError");
		return banner && !banner.hidden ? banner.textContent : null;
	});
	console.log(`  failure banner: ${bannerAfterFailure ? "shown" : "MISSING"}`);

	assert.ok(pressMilliseconds < 1000,
		`the card must repaint from the optimistic swap, not the round trip (took ${pressMilliseconds}ms)`);
	assert.equal(scrollAfterPress, scrollBefore, "the press must not move the page");
	assert.equal(mergeCard, "Mark ready", "the merged server order keeps the new status");
	assert.equal(pollRan, true, "the racing refresh must have run");
	assert.equal(pollGuardCard, "Mark ready", "a poll racing the request must not revert the card");
	assert.ok(bannerAfterFailure && /waking|reached|previous status/i.test(bannerAfterFailure),
		"the failure must surface the banner: " + String(bannerAfterFailure));
});

// --- a broken CSRF cookie must heal itself -------------------------------------
//
// When the jar's CSRF cookie stops matching the live session (an old cookie
// expiring, or another tab winning the shared jar), a press used to fail with
// "A valid CSRF token is required." until the page was reloaded, because the
// dashboard's single retry re-fetched a random token that can never satisfy a
// logged-in request. The session-aware bootstrap now re-issues the
// session-paired token, so the same retry heals the press, the status change
// lands, and logout keeps working.
test("a press with a poisoned CSRF cookie heals on the retry and logout still works", async t => {
	const { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
	t.after(() => context.close());

	// One checkout order on the shared stack, seeded BEFORE the login so the
	// first board load already shows it (the file stays inside the checkout
	// rate limit of ten per ten minutes).
	const pickup = findFuturePickupSlot();
	const orderId = await createScrollPatrolOrder(pickup, 1);
	const cardSelector = `.order-card[data-id="${orderId}"]`;

	await page.fill("#ownerPassword", TEST_PASSWORD);
	await page.click("#loginForm button[type=submit]");
	await page.waitForSelector("#ordersPanel:not([hidden])", { timeout: 20000 });
	await page.waitForSelector(cardSelector, { timeout: 20000 });

	// Break the pair exactly the way a second tab or an expiry would: the
	// session cookie is untouched, the CSRF cookie is garbage.
	await page.evaluate(() => {
		document.cookie = "maridel_owner_csrf=poison-9999999999; Path=/; SameSite=None; Secure";
	});

	const button = page.locator(`${cardSelector} button.primary-action`);
	const pressLabel = (await button.textContent()).trim();
	console.log(`  poisoned-cookie heal: pressing "${pressLabel}" -> expect one refused press, then the retry lands it`);
	await button.click();

	// The heal path: first press 403, one bootstrap, retried press 200 with the
	// session-paired token. The card must end Confirmed with the banner hidden.
	await page.waitForFunction(
		args => {
			const card = document.querySelector(`.order-card[data-id="${args.orderId}"]`);
			const element = card && card.querySelector("button.primary-action");
			return Boolean(element && element.textContent === "Mark ready" && !element.disabled);
		},
		{ orderId },
		{ timeout: 15000, polling: 100 },
	);
	const bannerAfterHeal = await page.evaluate(() => {
		const banner = document.getElementById("ordersError");
		return banner && !banner.hidden ? banner.textContent : null;
	});
	assert.equal(bannerAfterHeal, null,
		"the healed press must leave no error banner: " + String(bannerAfterHeal));

	// Logout was also CSRF-gated; with the healed pair it goes straight through.
	await page.click("#logoutButton");
	await page.waitForSelector("#loginPanel:not([hidden])", { timeout: 15000 });
});
