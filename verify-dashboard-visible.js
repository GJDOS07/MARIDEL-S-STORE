"use strict";
// Verifies the dashboard changes in Chrome using a SYNTHETIC credential against
// the isolated sandbox. This proves the UI without needing or revealing the
// operator's own password. No secret is printed.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createSandboxDatabase } = require("./local-sandbox-database");
const { hashOwnerPassword } = require("./owner-credentials-tool");

const SITE_PORT = 4173;
const API_PORT = 3000;
const SITE = `http://localhost:${SITE_PORT}`;
const TEST_PASSWORD = "Synthetic-Visibility-Check-8827";
const SECRET = "synthetic-visibility-check-secret-0123456789abcdef";

let api, site;

const results = [];
const check = (label, ok, detail = "") => {
	results.push(ok);
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
};

(async () => {
	// Start the real servers, the backend with a synthetic credential so the
	// operator's own password is neither needed nor revealed.
	api = spawn(process.execPath, [path.join(__dirname, "server.js")], {
		env: {
			...process.env, LOCAL_SANDBOX_DB: "1", PORT: String(API_PORT), NODE_ENV: "development",
			OWNER_PASSWORD_HASH: hashOwnerPassword(TEST_PASSWORD),
			OWNER_SESSION_SECRET: SECRET,
			DOTENV_CONFIG_PATH: path.join(__dirname, "does-not-exist.env"),
		}, stdio: ["ignore", "pipe", "pipe"],
	});
	site = spawn(process.execPath, [path.join(__dirname, "serve-local.js")], {
		env: { ...process.env, SITE_PORT: String(SITE_PORT), DOTENV_CONFIG_PATH: path.join(__dirname, "does-not-exist.env") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const wait = async url => {
		for (let i = 0; i < 60; i += 1) {
			try { if ((await fetch(url)).status === 200) return true; } catch {}
			await sleep(200);
		}
		return false;
	};
	if (!(await wait(`http://127.0.0.1:${API_PORT}/`)) || !(await wait(`${SITE}/owner-dashboard.html`))) {
		console.log("  servers did not start");
		process.exit(1);
	}

	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		const errors = [];
		page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
		page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));

		// 1. Login page.
		const res = await page.goto(`${SITE}/owner-dashboard.html`, { waitUntil: "networkidle" });
		check("dashboard loads", res.status() === 200);
		check("login panel visible", await page.locator("#loginPanel").isVisible());
		check("login eye toggle present", await page.locator("#togglePassword").count() === 1);

		// 2. Login with the synthetic credential.
		await page.fill("#ownerPassword", TEST_PASSWORD);
		await page.click("#loginForm button[type=submit]");
		await page.waitForSelector("#ordersPanel:not([hidden])", { timeout: 20000 });
		check("login succeeds", true);
		await page.screenshot({ path: "verify-dashboard-orders.png" });

		// 3. Orders panel content.
		const summaryCount = await page.locator("#ordersSummary").count();
		check("orders summary card present", summaryCount === 1);
		const orderCards = await page.locator(".order-card").count();
		check("order cards rendered", orderCards > 0, `cards=${orderCards}`);

		// 4. Products panel.
		await page.click('#dashboardTabs .tab[data-tab="products"]');
		await page.waitForSelector("#productsPanel:not([hidden])", { timeout: 15000 });
		await page.waitForTimeout(600);
		const productCards = await page.locator(".product-card").count();
		check("products panel lists products", productCards === 18, `cards=${productCards}`);
		// The toolbar with all its controls.
		for (const id of ["productSearch", "productCategoryFilter", "productIncludeUnpublished", "refreshProducts", "addProductToggle"]) {
			check(`products toolbar has #${id}`, await page.locator(`#${id}`).count() === 1);
		}
		// Live search: type and confirm the list narrows without a page reload.
		const before = await page.locator(".product-card").count();
		await page.fill("#productSearch", "pocari");
		await page.waitForTimeout(800);
		const after = await page.locator(".product-card").count();
		check("search filters the list live", after < before && after >= 1, `before=${before} after=${after}`);
		await page.fill("#productSearch", "");
		await page.waitForTimeout(800);
		check("clearing search restores the list", await page.locator(".product-card").count() === before);
		await page.screenshot({ path: "verify-dashboard-products.png" });

		// 5. Account panel: three eye toggles and the match hint.
		await page.click('#dashboardTabs .tab[data-tab="account"]');
		await page.waitForSelector("#accountPanel:not([hidden])", { timeout: 15000 });
		for (const [input, button] of [
			["currentPassword", "toggleCurrentPassword"],
			["newPassword", "toggleNewPassword"],
			["confirmPassword", "toggleConfirmPassword"],
		]) {
			check(`#${input} masked with #${button}`,
				await page.locator(`#${input}`).getAttribute("type") === "password"
				&& await page.locator(`#${button}`).count() === 1);
		}
		await page.fill("#newPassword", "Alpha-One-123");
		await page.fill("#confirmPassword", "Beta-Two-456");
		await page.waitForTimeout(150);
		check("match hint reports a mismatch", /do not match/i.test(await page.locator("#passwordMatch").textContent()));
		await page.fill("#confirmPassword", "Alpha-One-123");
		await page.waitForTimeout(150);
		const hint = await page.locator("#passwordMatch").textContent();
		check("match hint reports a match", /match/i.test(hint) && !/do not match/i.test(hint));
		await page.screenshot({ path: "verify-dashboard-account.png" });

		// 6. Independent toggling.
		await page.click("#toggleNewPassword");
		check("new password revealed", await page.locator("#newPassword").getAttribute("type") === "text");
		check("confirm password still masked", await page.locator("#confirmPassword").getAttribute("type") === "password");
		check("current password still masked", await page.locator("#currentPassword").getAttribute("type") === "password");

		// 7. Recovery path.
		await page.click("#logoutButton");
		await page.waitForSelector("#loginPanel:not([hidden])", { timeout: 15000 });
		await page.click("#forgotPasswordLink");
		await page.waitForSelector("#resetRequestPanel:not([hidden])", { timeout: 15000 });
		check("forgot-password opens the request step", true);
		await page.click("#haveResetTokenLink");
		await page.waitForSelector("#resetPasswordPanel:not([hidden])", { timeout: 15000 });
		check("'I already have a reset token' opens the password form", true);
		for (const id of ["toggleResetNewPassword", "toggleResetConfirmPassword"]) {
			check(`reset form has #${id}`, await page.locator(`#${id}`).count() === 1);
		}
		await page.screenshot({ path: "verify-dashboard-reset.png" });

		const real = errors.filter(e => !/404|Failed to load resource/.test(e));
		check("no relevant console errors", real.length === 0, real.slice(0, 2).join(" | "));
		await context.close();
	} catch (error) {
		check("harness", false, error.message);
	} finally {
		await browser.close();
		api.kill("SIGTERM"); site.kill("SIGTERM");
		await sleep(400);
	}

	const failed = results.filter(r => !r).length;
	console.log(`\n=== ${results.length - failed} passed, ${failed} failed ===`);
	process.exitCode = failed === 0 ? 0 : 1;
})();
