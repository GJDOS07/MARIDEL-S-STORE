"use strict";

const { STORE_INFO, isWithinOperatingHours } = require("./store-info");

const BUSINESS_TIME_ZONE = STORE_INFO.timeZone;
const OPENING_MINUTES = STORE_INFO.openMinutes;
const CLOSING_MINUTES = STORE_INFO.closeMinutes;
const SLOT_INTERVAL_MINUTES = 1;

const melbournePartsFormatter = new Intl.DateTimeFormat("en-AU", {
	timeZone: BUSINESS_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});
const localDateFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: BUSINESS_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const localTimeFormatter = new Intl.DateTimeFormat("en-GB", {
	timeZone: BUSINESS_TIME_ZONE,
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

function formatParts(instant) {
	const parts = Object.fromEntries(
		melbournePartsFormatter.formatToParts(instant).map(({ type, value }) => [type, value]),
	);
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		weekday: parts.weekday,
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
	};
}

function melbourneNow(now = new Date()) {
	const parts = formatParts(now);
	return {
		...parts,
		date: formatLocalDate(parts),
		minutes: parts.hour * 60 + parts.minute,
	};
}

function formatLocalDate({ year, month, day }) {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseLocalDate(date) {
	if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error("Select a valid pickup date and Melbourne local time.");
	}
	const [year, month, day] = date.split("-").map(Number);
	const check = new Date(`${date}T00:00:00.000Z`);
	if (!Number.isFinite(check.getTime())
		|| check.getUTCFullYear() !== year
		|| check.getUTCMonth() + 1 !== month
		|| check.getUTCDate() !== day) {
		throw new Error("Select a valid pickup date and Melbourne local time.");
	}
	return { year, month, day };
}

function parseLocalTime(time) {
	if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
		throw new Error("Select a valid pickup date and Melbourne local time.");
	}
	const [hour, minute] = time.split(":").map(Number);
	return { hour, minute };
}

function sameLocalMinute(parts, date, time) {
	return formatLocalDate(parts) === date
		&& `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}` === time
		&& parts.second === 0;
}

function possibleInstantsForLocalTime(date, time) {
	const localDate = parseLocalDate(date);
	const localTime = parseLocalTime(time);
	const naiveUtc = Date.UTC(localDate.year, localDate.month - 1, localDate.day, localTime.hour, localTime.minute);
	const offsets = new Set();
	for (let hours = -36; hours <= 36; hours += 3) {
		const sample = new Date(naiveUtc + hours * 60 * 60 * 1000);
		const local = formatParts(sample);
		const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
		offsets.add(localAsUtc - sample.getTime());
	}
	const candidates = [...offsets]
		.map(offset => new Date(naiveUtc - offset))
		.filter(candidate => sameLocalMinute(formatParts(candidate), date, time));
	return [...new Map(candidates.map(candidate => [candidate.getTime(), candidate])).values()];
}

function melbourneDateAndTime(instant = new Date()) {
	const dateParts = Object.fromEntries(
		localDateFormatter.formatToParts(instant).map(({ type, value }) => [type, value]),
	);
	const timeParts = Object.fromEntries(
		localTimeFormatter.formatToParts(instant).map(({ type, value }) => [type, value]),
	);

	return {
		date: `${dateParts.year}-${dateParts.month}-${dateParts.day}`,
		time: `${timeParts.hour}:${timeParts.minute}`,
	};
}

function isValidDate(date) {
	if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const parsed = new Date(`${date}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function resolveScheduledPickup(pickupDate, pickupTime, now = new Date()) {
	const dateParts = parseLocalDate(pickupDate);
	const timeParts = parseLocalTime(pickupTime);
	const normalizedDate = formatLocalDate(dateParts);
	const normalizedTime = `${String(timeParts.hour).padStart(2, "0")}:${String(timeParts.minute).padStart(2, "0")}`;
	const candidates = possibleInstantsForLocalTime(normalizedDate, normalizedTime);
	if (candidates.length === 0) {
		const error = new Error("The selected Melbourne local time does not exist because of a daylight-saving change.");
		error.code = "PICKUP_TIME_NONEXISTENT";
		throw error;
	}
	if (candidates.length > 1) {
		const error = new Error("The selected Melbourne local time is ambiguous because of a daylight-saving change. Please choose another time.");
		error.code = "PICKUP_TIME_AMBIGUOUS";
		throw error;
	}
	if (!isWithinOperatingHours(normalizedTime)) {
		throw new Error(`Pickup is available from ${STORE_INFO.openLabel} to ${STORE_INFO.closeLabel} Melbourne time, 7 days a week.`);
	}
	const current = melbourneNow(now);
	if (normalizedDate < current.date) {
		throw new Error("Pickup date cannot be in the past.");
	}
	if (candidates[0].getTime() <= now.getTime()) {
		throw new Error("Select a pickup time that has not passed in Melbourne.");
	}
	return { pickupDate: normalizedDate, pickupTime: normalizedTime, pickupAt: candidates[0] };
}

function validatePickupChoice(pickupTypeOrDate, pickupDateOrTime, pickupTimeOrNow, nowArg) {
	let pickupType = "SCHEDULED";
	let pickupDate;
	let pickupTime;
	let now = new Date();
	const legacyCall = pickupTimeOrNow !== undefined
		|| pickupTypeOrDate === "ASAP"
		|| pickupTypeOrDate === "SCHEDULED";
	if (legacyCall) {
		pickupType = pickupTypeOrDate;
		pickupDate = pickupDateOrTime;
		pickupTime = pickupTimeOrNow;
		now = nowArg === undefined ? new Date() : nowArg;
	} else {
		pickupDate = pickupTypeOrDate;
		pickupTime = pickupDateOrTime;
		now = pickupTimeOrNow === undefined ? new Date() : pickupTimeOrNow;
	}
	const effectiveNow = now instanceof Date ? now : new Date(now);
	const current = melbourneNow(effectiveNow);
	if (pickupType === "ASAP") {
		if (current.minutes < OPENING_MINUTES || current.minutes > CLOSING_MINUTES) {
			const error = new Error("Pickup Now is currently unavailable because the store is closed.");
			error.code = "PICKUP_CLOSED";
			throw error;
		}
		return {
			pickupType,
			pickupDate: current.date,
			pickupTime: null,
			requestedPickupDate: current.date,
			requestedPickupTime: null,
			requestedPickupAt: effectiveNow,
		};
	}
	if (pickupType !== "SCHEDULED") {
		throw new Error("Select a valid pickup date and Melbourne local time.");
	}
	const resolved = resolveScheduledPickup(pickupDate, pickupTime, effectiveNow);
	return {
		pickupType,
		pickupDate: resolved.pickupDate,
		pickupTime: resolved.pickupTime,
		requestedPickupDate: resolved.pickupDate,
		requestedPickupTime: resolved.pickupTime,
		requestedPickupAt: resolved.pickupAt,
	};
}

module.exports = {
	BUSINESS_TIME_ZONE,
	OPENING_MINUTES,
	CLOSING_MINUTES,
	SLOT_INTERVAL_MINUTES,
	isValidDate,
	melbourneDateAndTime,
	melbourneNow,
	possibleInstantsForLocalTime,
	validatePickupChoice,
};
