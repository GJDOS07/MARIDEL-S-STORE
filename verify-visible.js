"use strict";
// Opens the real served pages in Chrome and verifies the changes are actually
// visible: the storefront's product list, and the dashboard's password toggles.
// Prints no secret.
const { chromium } = require("playwright-core");

const SITE = "http://localhost:4173";
const ORIGIN = SITE;
const TEST_PASSWORD = process.env.E2E_PASSWORD || "";

const results = [];
const check = (label, ok, detail = "") => {
	results.push({ label, ok, detail });
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
};

(async () => {
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		// --- 1. The customer storefront -------------------------------------
		const siteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await siteContext.newPage();
		const storeErrors = [];
		const apiHits = [];
		page.on("console", m => { if (m.type() === "error") storeErrors.push(m.text()); });
		page.on("pageerror", e => storeErrors.push("PAGEERROR: " + e.message));
		page.on("request", r => { if (r.url().includes("/api/products")) apiHits.push(r.url()); });

		const response = await page.goto(`${SITE}/index.html`, { waitUntil: "networkidle" });
		const status = response ? response.status() : 0;
		check("storefront loads", status === 200, `status ${status}`);

		// Which API did it actually call?
		const usedLocal = apiHits.some(u => u.startsWith("http://localhost:3000"));
		const usedProd = apiHits.some(u => u.includes("maridel-s-store.onrender.com"));
		check("storefront calls the LOCAL backend", usedLocal && !usedProd,
			`local=${usedLocal} production=${usedProd}`);

		// The error sentence also exists in the page's inline script, so match on
		// a RENDERED error rather than on the raw HTML.
		const renderedError = await page.evaluate(() => {
			const alert = document.querySelector('[role="alert"]');
			return alert ? alert.textContent.trim() : "";
		});
		check("storefront does NOT show a rendered load error",
			!/Products could not be loaded/.test(renderedError),
			JSON.stringify(renderedError.slice(0, 60)));

		const productCards = await page.locator("[data-product-id], .product-card, .product").count();
		check("storefront rendered product content", productCards > 0, `cards=${productCards}`);
		await page.screenshot({ path: "verify-storefront.png", fullPage: false });
		check("storefront screenshot captured", true, "verify-storefront.png");
		await siteContext.close();

		// --- 2. The owner dashboard -----------------------------------------
		if (TEST_PASSWORD) {
			const dashContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const dpage = await dashContext.newPage();
			const dashErrors = [];
			dpage.on("console", m => { if (m.type() === "error") dashErrors.push(m.text()); });
			dpage.on("pageerror", e => dashErrors.push("PAGEERROR: " + e.message));
			const dres = await dpage.goto(`${SITE}/owner-dashboard.html`, { waitUntil: "networkidle" });
			check("dashboard loads", dres && dres.status === 200);

			const loginVisible = await dpage.locator("#loginPanel").isVisible();
			check("login panel is visible", loginVisible);
			check("eye toggle exists on login field", await dpage.locator("#togglePassword").count() === 1);

			if (loginVisible) {
				await dpage.fill("#ownerPassword", TEST_PASSWORD);
				await dpage.click("#loginForm button[type=submit]");
				await dpage.waitForSelector("#ordersPanel:not([hidden])", { timeout: 20000 });
				check("login succeeds with the local credential", true);

				// Account panel with its three toggles.
				await dpage.click('#dashboardTabs .tab[data-tab="account"]');
				await dpage.waitForSelector("#accountPanel:not([hidden])", { timeout: 15000 });
				check("account settings panel opens", true);
				for (const id of ["toggleCurrentPassword", "toggleNewPassword", "toggleConfirmPassword"]) {
					check(`${id} present`, await dpage.locator(`#${id}`).count() === 1);
				}
				// The password-match hint.
				await dpage.fill("#newPassword", "Alpha-One-123");
				await dpage.fill("#confirmPassword", "Beta-Two-456");
				await dpage.waitForTimeout(150);
				const hint = await dpage.locator("#passwordMatch").textContent();
				check("password-match hint appears", /do not match/i.test(hint), JSON.stringify(hint.slice(0, 40)));
				await dpage.fill("#confirmPassword", "Alpha-One-123");
				await dpage.waitForTimeout(150);
				const hint2 = await dpage.locator("#passwordMatch").textContent();
				check("password-match hint updates", /match/i.test(hint2) && !/do not match/i.test(hint2));

				// The recovery path.
				await dpage.click("#logoutButton");
				await dpage.waitForSelector("#loginPanel:not([hidden])", { timeout: 15000 });
				await dpage.click("#forgotPasswordLink");
				await dpage.waitForSelector("#resetRequestPanel:not([hidden])", { timeout: 15000 });
				await dpage.click("#haveResetTokenLink");
				await dpage.waitForSelector("#resetPasswordPanel:not([hidden])", { timeout: 15000 });
				check("'I already have a reset token' path works", true);
				for (const id of ["toggleResetNewPassword", "toggleResetConfirmPassword"]) {
					check(`${id} present on reset form`, await dpage.locator(`#${id}`).count() === 1);
				}
				await dpage.screenshot({ path: "verify-dashboard.png" });
				check("dashboard screenshot captured", true, "verify-dashboard.png");
			}
			const dashReal = dashErrors.filter(e => !/404|Failed to load resource/.test(e));
			check("no relevant dashboard console errors", dashReal.length === 0, dashReal.slice(0, 2).join(" | "));
			await dashContext.close();
		} else {
			console.log("  SKIP  dashboard checks (no E2E_PASSWORD supplied; run with the password on stdin)");
		}

		const storeReal = storeErrors.filter(e => !/404|Failed to load resource/.test(e));
		check("no relevant storefront console errors", storeReal.length === 0, storeReal.slice(0, 2).join(" | "));
	} catch (error) {
		check("harness completed", false, error.message);
	} finally {
		await browser.close();
	}

	const failed = results.filter(r => !r.ok).length;
	console.log(`\n=== ${results.length - failed} passed, ${failed} failed ===`);
	process.exitCode = failed === 0 ? 0 : 1;
})();
