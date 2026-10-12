"use strict";

(function exposePickupTimeDisplay(root) {
	function formatPickupTime(value) {
		if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;

		const [hour, minute] = value.split(":").map(Number);
		const period = hour < 12 ? "AM" : "PM";
		const displayHour = hour % 12 || 12;
		return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
	}

	const helpers = Object.freeze({ formatPickupTime });
	if (typeof module === "object" && module.exports) {
		module.exports = helpers;
	} else {
		root.PickupTimeDisplay = helpers;
	}
})(globalThis);
