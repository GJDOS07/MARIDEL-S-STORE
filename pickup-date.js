"use strict";

(function exposePickupDateHelpers(root) {
	function daysInMonth(year, month) {
		return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	}

	function clampDay(day, year, month) {
		return Math.min(day, daysInMonth(year, month));
	}

	function isBefore(date, minimum) {
		return date.year < minimum.year
			|| (date.year === minimum.year && date.month < minimum.month)
			|| (date.year === minimum.year && date.month === minimum.month && date.day < minimum.day);
	}

	const helpers = Object.freeze({ daysInMonth, clampDay, isBefore });
	if (typeof module === "object" && module.exports) {
		module.exports = helpers;
	} else {
		root.PickupDate = helpers;
	}
})(globalThis);
