"use strict";

(function exposeStoreInfo(root) {
	const STORE_INFO = Object.freeze({
		name: "Maridel's Store",
		address: "1 Victoria Place, Stawell, Victoria 3380, Australia",
		phone: "0473 953 049",
		timeZone: "Australia/Melbourne",
		operatingDaysLabel: "Open 7 days a week (Monday to Sunday)",
		openMinutes: 10 * 60,
		closeMinutes: 20 * 60,
		openLabel: "10:00 AM",
		closeLabel: "8:00 PM",
		slotIntervalMinutes: 1,
	});

	function minutesToLabel(minutes) {
		const hour24 = Math.floor(minutes / 60) % 24;
		const minute = minutes % 60;
		const period = hour24 < 12 ? "AM" : "PM";
		const displayHour = hour24 % 12 || 12;
		return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
	}

	function hoursRangeLabel() {
		return `${STORE_INFO.openLabel} \u2013 ${STORE_INFO.closeLabel}`;
	}

	function isWithinOperatingHours(pickupTime) {
		if (typeof pickupTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) return false;
		const minutes = Number(pickupTime.slice(0, 2)) * 60 + Number(pickupTime.slice(3, 5));
		return minutes >= STORE_INFO.openMinutes && minutes <= STORE_INFO.closeMinutes;
	}

	function buildPickupSlotTimes() {
		const times = [];
		for (let minutes = STORE_INFO.openMinutes; minutes <= STORE_INFO.closeMinutes; minutes += STORE_INFO.slotIntervalMinutes) {
			const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
			const minute = String(minutes % 60).padStart(2, "0");
			times.push(`${hour}:${minute}`);
		}
		return times;
	}

	const api = Object.freeze({
		STORE_INFO,
		minutesToLabel,
		hoursRangeLabel,
		isWithinOperatingHours,
		buildPickupSlotTimes,
	});

	if (typeof module === "object" && module.exports) {
		module.exports = api;
	} else {
		root.StoreInfo = api;
	}
})(globalThis);
