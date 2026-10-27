"use strict";
// Owner password-reset email delivery.
//
// FREE PROVIDER: Resend. Its free tier allows 3,000 emails per month and 100 per
// day, which is orders of magnitude more than a single-owner store needs, and it
// authenticates with a plain API key over HTTPS — no paid tier, no subscription,
// no SMTP relay to run.
//
// WHAT THIS MODULE GUARANTEES
//   * The reset link is built from OWNER_RESET_BASE_URL, never from the request
//     Host header. An attacker-supplied Host would let the link point anywhere,
//     leaking the token to a site they control.
//   * The token is never logged, never included in an error, and never returned
//     in a response body.
//   * A provider failure is reported without the API key or the response body,
//     because both can contain secrets.
//   * With no usable configuration it refuses to build, so the caller falls back
//     to the generic response and no token is wasted.
//
// THE RECIPIENT IS NOT USER INPUT. It comes from OWNER_CONTACT_EMAIL (or the
// owner_contact row), which only the operator can set. A request body is never
// consulted for it, so a caller cannot redirect a reset link to an address of
// their choosing.

const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_RESET_TTL_MINUTES = 30;
// The production storefront, used when OWNER_RESET_BASE_URL is not set. It must be
// https in production: a reset link over plaintext would expose the token.
const DEFAULT_RESET_BASE_URL = "https://gjdos07.github.io/MARIDEL-S-STORE";

function resetTtlMinutes() {
	const raw = Number.parseInt(process.env.OWNER_RESET_TTL_MINUTES || "", 10);
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RESET_TTL_MINUTES;
	// A longer TTL is a wider theft window, so cap it.
	return Math.min(raw, 24 * 60);
}

// Classifies the email configuration. `missing` means the feature is simply not
// set up, which is a supported state: the reset request route then answers
// generically and issues no token.
function describeEmailConfig({ apiKey, fromEmail, toEmail, baseUrl } = {}) {
	const trimmed = value => (typeof value === "string" ? value.trim() : "");
	const api = trimmed(apiKey);
	const from = trimmed(fromEmail);
	const to = trimmed(toEmail);
	const base = trimmed(baseUrl);
	if (!api || !from || !to) return "missing";
	if (!/^https:\/\//i.test(base || DEFAULT_RESET_BASE_URL)) return "invalid-base-url";
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return "invalid-sender";
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return "invalid-recipient";
	return "valid";
}

// Trims trailing slashes and returns the base unchanged, so the link builder can
// append a path without producing a double slash.
function normaliseBaseUrl(baseUrl) {
	return String(baseUrl || DEFAULT_RESET_BASE_URL).trim().replace(/\/+$/, "");
}

// Builds the reset link. The only inputs are the configured base URL and the
// token; nothing from the request is involved.
function buildResetLink(baseUrl, token) {
	const base = normaliseBaseUrl(baseUrl);
	if (typeof token !== "string" || token.length === 0) {
		throw new TypeError("a non-empty token is required to build a reset link");
	}
	return `${base}/owner-dashboard.html?reset_token=${encodeURIComponent(token)}`;
}

// Minimal HTTPS POST with no dependencies. Node's global fetch is used when
// available; the raw client is the fallback, so the module works on any Node the
// project supports.
function postJson(endpoint, headers, payload, { fetchImpl } = {}) {
	const resolvedFetch = typeof fetchImpl === "function"
		? fetchImpl
		: (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
	if (resolvedFetch) {
		return resolvedFetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(payload),
		}).then(response => ({
			status: typeof response.status === "number" ? response.status : 0,
			text: () => response.text(),
		}));
	}
	const body = JSON.stringify(payload);
	const url = new URL(endpoint);
	const options = {
		method: "POST",
		hostname: url.hostname,
		port: url.port || 443,
		path: `${url.pathname}${url.search}`,
		headers: {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(body),
			...headers,
		},
	};
	const client = url.protocol === "http:" ? http : https;
	return new Promise((resolve, reject) => {
		const request = client.request(options, response => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", chunk => { text += chunk; });
			response.on("end", () => resolve({ status: response.statusCode || 0, text: () => Promise.resolve(text) }));
		});
		request.on("error", reject);
		request.write(body);
		request.end();
	});
}

// Returns a delivery callback, or null when the configuration is not usable.
//
// The returned function takes only the token: the recipient and sender come from
// configuration, so no caller can aim the email at another address.
function createResendDelivery({ apiKey, fromEmail, toEmail, baseUrl, fetchImpl } = {}) {
	const state = describeEmailConfig({ apiKey, fromEmail, toEmail, baseUrl });
	if (state !== "valid") return null;

	const recipient = String(toEmail).trim();
	const sender = String(fromEmail).trim();
	const base = normaliseBaseUrl(baseUrl);
	const ttlMinutes = resetTtlMinutes();

	return async function deliver({ token } = {}) {
		if (typeof token !== "string" || token.length === 0) {
			throw new TypeError("a non-empty reset token is required");
		}
		const resetLink = buildResetLink(base, token);
		const subject = "Reset your MARIDEL'S STORE owner password";
		const text = [
			"A password reset was requested for the MARIDEL'S STORE owner account.",
			"",
			`Open this link to choose a new password: ${resetLink}`,
			"",
			`The link works once and expires in ${ttlMinutes} minutes. Choosing a new`,
			"password signs out every existing owner session.",
			"",
			"If you did not request this you can ignore this message.",
		].join("\n");

		let response;
		try {
			response = await postJson(
				RESEND_ENDPOINT,
				{
					// The key is sent in a header and nowhere else. It is never
					// included in an error message.
					Authorization: `Bearer ${String(apiKey).trim()}`,
				},
				{ from: sender, to: [recipient], subject, text },
				{ fetchImpl },
			);
		} catch (cause) {
			// Network failure. The cause may embed the request URL, which is fine,
			// but it must not carry the key: state only that the transport failed.
			throw new Error("The reset email could not be sent.");
		}

		if (!response || typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
			const status = response && typeof response.status === "number" ? response.status : "unknown";
			// Deliberately no body: a provider error body can echo the request,
			// and the subject line plus status are enough for an operator log.
			throw new Error(`The reset email was rejected by the provider (status ${status}).`);
		}

		return { delivered: true, recipient, subject, ttlMinutes };
	};
}

module.exports = {
	RESEND_ENDPOINT,
	DEFAULT_RESET_BASE_URL,
	DEFAULT_RESET_TTL_MINUTES,
	createResendDelivery,
	describeEmailConfig,
	buildResetLink,
	normaliseBaseUrl,
	resetTtlMinutes,
	postJson,
};
