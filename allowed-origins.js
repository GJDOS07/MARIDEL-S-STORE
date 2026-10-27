"use strict";
// Decides whether a browser origin may talk to the API.
//
// Kept out of server.js because it is a security decision: whether a public
// origin is accepted is the difference between the storefront working and an
// unrelated site being able to drive the owner API. It deserves its own tests.

const PRODUCTION_FRONTEND_ORIGIN = "https://gjdos07.github.io";
// Origins served by a local web server, used so the owner dashboard can be
// opened from whatever static server the operator already has.
const DEVELOPMENT_DEFAULT_ORIGINS = [
	PRODUCTION_FRONTEND_ORIGIN,
	"http://localhost:5500",
	"http://127.0.0.1:5500",
];

// http://localhost, http://127.0.0.1, optionally with any port. Only loopback:
// an attacker-controlled hostname is not affected by this at all.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function isLoopbackOrigin(origin) {
	return typeof origin === "string" && LOOPBACK_ORIGIN.test(origin);
}

// Builds the allow-list checker used by the CORS middleware.
//
// In production only the explicit origins are accepted: the value of
// FRONTEND_ORIGINS when set, otherwise the single GitHub Pages origin. Loopback
// is NOT accepted in production, because a request could still reach the service
// from another container on the same network.
//
// Outside production, loopback is accepted on any port so the dashboard opens
// from any local web server. That is safe because a loopback origin cannot be
// presented by a site on the public internet.
function createOriginChecker({ allowedOrigins = [], isProduction = false } = {}) {
	const allowed = new Set(allowedOrigins);
	return function isOriginAllowed(origin) {
		// No Origin header: a same-origin or non-browser request. The API is
		// public for reads and CSRF-protected for writes, so this is unchanged.
		if (!origin) return false;
		if (allowed.has(origin)) return true;
		if (!isProduction && isLoopbackOrigin(origin)) return true;
		return false;
	};
}

// The origin list server.js uses when FRONTEND_ORIGINS is not configured.
function defaultOriginsFor({ isProduction = false } = {}) {
	return isProduction
		? [PRODUCTION_FRONTEND_ORIGIN]
		: [...DEVELOPMENT_DEFAULT_ORIGINS];
}

module.exports = {
	createOriginChecker,
	defaultOriginsFor,
	isLoopbackOrigin,
	PRODUCTION_FRONTEND_ORIGIN,
};
