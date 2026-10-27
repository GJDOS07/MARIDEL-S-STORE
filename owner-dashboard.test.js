"use strict";
// Contract tests for the owner dashboard password-show/hide toggle.
// The runtime for owner-dashboard.js is the browser and there is no DOM
// harness in this project, so these assert the markup/wiring contract that a
// future edit would most likely break: a missing control, a missing id, a
// toggle that stops flipping the input type, or dropped ARIA state.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "owner-dashboard.html"), "utf8");
const script = fs.readFileSync(path.join(root, "owner-dashboard.js"), "utf8");

test("the login form keeps a masked password input", () => {
	assert.match(html, /<input[^>]+id="ownerPassword"[^>]+type="password"/);
	assert.match(html, /<input[^>]+id="ownerPassword"[^>]+autocomplete="current-password"/);
	assert.match(html, /<input[^>]+id="ownerPassword"[^>]+maxlength="\d+"/);
});

test("the show/hide control is a real button inside the password field", () => {
	assert.match(html, /<div class="password-field">/);
	assert.match(html, /<button[^>]+type="button"[^>]+id="togglePassword"/);
	assert.match(html, /<button[^>]+id="togglePassword"[^>]+class="[^"]*toggle-password/);
	assert.match(html, /<button[^>]+id="togglePassword"[^>]+aria-pressed="false"/);
	assert.match(html, /aria-label="Show password"/);
	assert.match(html, /title="Show password"/);
});

test("both eye icons ship and are swappable by ARIA state", () => {
	const toggleBlock = /<button[^>]+id="togglePassword"[\s\S]*?<\/button>/.exec(html);
	assert.ok(toggleBlock, "toggle button not found");
	assert.match(toggleBlock[0], /class="eye-open"/);
	assert.match(toggleBlock[0], /class="eye-closed"/);
	assert.match(html, /\.toggle-password \.eye-closed\s*\{\s*display:\s*none/);
	assert.match(html, /\.toggle-password\[aria-pressed="true"\] \.eye-open\s*\{\s*display:\s*none/);
	assert.match(html, /\.toggle-password\[aria-pressed="true"\] \.eye-closed\s*\{\s*display:\s*block/);
});

test("the script resolves the login elements before wiring the listener", () => {
	assert.match(script, /const togglePassword = document\.getElementById\("togglePassword"\);/);
	assert.match(script, /const ownerPasswordInput = document\.getElementById\("ownerPassword"\);/);
	// The login field is wired through the same helper as every other field, so
	// there is one toggle implementation rather than one per form.
	assert.match(script, /wirePasswordToggle\(ownerPasswordInput, togglePassword\)/);
	// Guarding on both keeps the dashboard working if the markup is ever reverted.
	assert.match(script, /if \(!input \|\| !button\) return;/);
});

test("clicking flips the input type to text and back", () => {
	// The behaviour moved into wirePasswordToggle when the toggle was extended to
	// every password field; assert it there, which is where it now lives.
	const block = /function wirePasswordToggle\(input, button\) \{([\s\S]*?)\n\}/.exec(script);
	assert.ok(block, "toggle helper not found");
	const body = block[1];
	assert.match(body, /input\.type === "password"/);
	assert.match(body, /input\.type = isHidden \? "text" : "password"/);
});

test("clicking keeps the control's accessible label and pressed state in sync", () => {
	const block = /function wirePasswordToggle\(input, button\) \{([\s\S]*?)\n\}/.exec(script);
	assert.ok(block, "toggle helper not found");
	const body = block[1];
	assert.match(body, /button\.setAttribute\("aria-pressed", isHidden \? "true" : "false"\)/);
	assert.match(body, /button\.setAttribute\("aria-label", isHidden \? "Hide password" : "Show password"\)/);
	assert.match(body, /button\.title = isHidden \? "Hide password" : "Show password"/);
});

// --- every password field gets its own toggle --------------------------------

// The fields that make up the account and recovery password flows. Each must be
// masked by default and independently toggleable.
const PASSWORD_FIELDS = [
	["ownerPassword", "togglePassword"],
	["currentPassword", "toggleCurrentPassword"],
	["newPassword", "toggleNewPassword"],
	["confirmPassword", "toggleConfirmPassword"],
	["resetNewPassword", "toggleResetNewPassword"],
	["resetConfirmPassword", "toggleResetConfirmPassword"],
];

test("every password field in the account and recovery flow has a toggle", () => {
	for (const [inputId, buttonId] of PASSWORD_FIELDS) {
		assert.match(html, new RegExp(`<input[^>]+id="${inputId}"[^>]+type="password"`),
			`${inputId} must be masked by default`);
		assert.match(html, new RegExp(`<button[^>]+type="button"[^>]+id="${buttonId}"`),
			`${buttonId} must exist and be type=button so it cannot submit the form`);
		assert.match(html, new RegExp(`<button[^>]+id="${buttonId}"[^>]+class="[^"]*toggle-password`),
			`${buttonId} must use the shared toggle styling`);
		assert.match(html, new RegExp(`<button[^>]+id="${buttonId}"[^>]+aria-pressed="false"`),
			`${buttonId} must start unpressed`);
	}
});

test("the script wires a toggle for every password field", () => {
	for (const [inputId, buttonId] of PASSWORD_FIELDS) {
		// The login field is wired from resolved consts, the rest inline; both
		// forms route through the same helper.
		const pattern = new RegExp(
			`wirePasswordToggle\\(\\s*(?:document\\.getElementById\\("${inputId}"\\)|${inputId === "ownerPassword" ? "ownerPasswordInput" : inputId})\\s*,\\s*` +
			`(?:document\\.getElementById\\("${buttonId}"\\)|${buttonId === "togglePassword" ? "togglePassword" : buttonId})\\s*\\)`,
		);
		assert.match(script, pattern, `${inputId} must be wired to ${buttonId}`);
	}
});

test("the toggle helper flips only the input it is given", () => {
	const block = /function wirePasswordToggle\(input, button\) \{([\s\S]*?)\n\}/.exec(script);
	assert.ok(block, "wirePasswordToggle not found");
	const body = block[1];
	// The type is derived from the field itself, never from a shared variable, so
	// one toggle cannot flip another field.
	assert.match(body, /input\.type === "password"/);
	assert.match(body, /input\.type = isHidden \? "text" : "password"/);
	assert.match(body, /button\.setAttribute\("aria-pressed"/);
	assert.match(body, /button\.setAttribute\("aria-label"/);
	assert.match(body, /button\.title =/);
	// Missing markup must not throw: the dashboard renders a subset of panels.
	assert.match(body, /if \(!input \|\| !button\) return;/);
});

test("toggling never touches the value or submits the form", () => {
	// The helper body must not read, clear, or assign .value, and the buttons are
	// type="button" so Enter inside the form still submits the form, not the eye.
	const block = /function wirePasswordToggle\(input, button\) \{([\s\S]*?)\n\}/.exec(script);
	const body = block[1];
	assert.ok(!/\.value/.test(body), "the toggle must not read or write the field value");
	for (const [, buttonId] of PASSWORD_FIELDS) {
		assert.match(html, new RegExp(`<button[^>]+type="button"[^>]+id="${buttonId}"`),
			`${buttonId} must be type=button`);
	}
});

test("the password confirmation hint reports agreement without exposing values", () => {
	assert.match(html, /id="passwordMatch"[^>]*role="status"/);
	const block = /function updatePasswordMatchHint\(\) \{([\s\S]*?)\n\}/.exec(script);
	assert.ok(block, "updatePasswordMatchHint not found");
	const body = block[1];
	// Both fields are read, but only their equality is reported.
	assert.match(body, /document\.getElementById\("newPassword"\)\.value/);
	assert.match(body, /document\.getElementById\("confirmPassword"\)\.value/);
	assert.match(body, /next === confirm/);
	// The message is a fixed sentence, not the typed value: the only thing
	// assigned to textContent is one of two literal strings.
	const assignments = [...body.matchAll(/passwordMatch\.textContent = ([^;]+);/g)].map(m => m[1].trim());
	assert.ok(assignments.length > 0, "the hint must set a message");
	for (const assignment of assignments) {
		assert.ok(
			/^(next === confirm|"" )?\s*\?/.test(assignment) || assignment === '""',
			`the hint must not echo a value, found: ${assignment.slice(0, 40)}`,
		);
		assert.ok(!/^\s*(next|confirm)\s*;?$/.test(assignment), "the hint must not assign a raw value");
	}
	// The hint is not the only gate: the submit path is unchanged.
	assert.match(script, /confirm_password: document\.getElementById\("confirmPassword"\)\.value/);
});

test("the confirmation hint is wired to both fields", () => {
	assert.match(script, /for \(const id of \["newPassword", "confirmPassword"\]\)/);
	assert.match(script, /addEventListener\("input", updatePasswordMatchHint\)/);
});

// --- password recovery reachability -------------------------------------------

test("the reset-password form is reachable without an email link", () => {
	// With no email provider configured, "Send reset link" delivers nothing, so
	// the only way to the password form is a manual entry point. Without this
	// button the recovery flow is a dead end for the owner.
	assert.match(html, /<button[^>]+type="button"[^>]+id="haveResetTokenLink"/);
	assert.match(script, /document\.getElementById\("haveResetTokenLink"\)\.addEventListener\("click"/);
	const block = /getElementById\("haveResetTokenLink"\)\.addEventListener\("click", \(\) => \{([\s\S]*?)\}\);/.exec(script);
	assert.ok(block, "the click handler must exist");
	const body = block[1];
	assert.match(body, /resetRequestPanel\.hidden = true/);
	assert.match(body, /resetPasswordPanel\.hidden = false/);
	// The token field takes focus, so the owner can paste straight into it.
	assert.match(body, /resetToken"\)\.focus\(\)/);
});

test("the recovery panels can always step back to the login screen", () => {
	// Both recovery panels must have a way back, otherwise the owner is stranded.
	for (const id of ["backToLoginFromRequest", "backToLoginFromReset"]) {
		assert.match(html, new RegExp(`<button[^>]+type="button"[^>]+id="${id}"`), `${id} must exist`);
	}
});

