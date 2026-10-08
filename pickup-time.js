const BUSINESS_TIME_ZONE = "Australia/Melbourne";
const OPENING_MINUTES = 7 * 60;
const CLOSING_MINUTES = 17 * 60;

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

function formatLocalDate({ year, month, day }) {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseLocalDate(date) {
	if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error("Please select a valid future pickup time.");
	}

	const [year, month, day] = date.split("-").map(Number);
	const check = new Date(`${date}T00:00:00.000Z`);
	if (
		!Number.isFinite(check.getTime())
		|| check.getUTCFullYear() !== year
		|| check.getUTCMonth() + 1 !== month
		|| check.getUTCDate() !== day
	) {
		throw new Error("Please select a valid future pickup time.");
	}

	return { year, month, day };
}

function parseLocalTime(time) {
	if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
		throw new Error("Please select a pickup time between 7:00 AM and 5:00 PM Melbourne time.");
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
	const naiveUtc = Date.UTC(
		localDate.year,
		localDate.month - 1,
		localDate.day,
		localTime.hour,
		localTime.minute,
	);
	const offsets = new Set();

	for (let hours = -36; hours <= 36; hours += 3) {
		const sample = new Date(naiveUtc + hours * 60 * 60 * 1000);
		const local = formatParts(sample);
		const localAsUtc = Date.UTC(
			local.year,
			local.month - 1,
			local.day,
			local.hour,
			local.minute,
			local.second,
		);
		offsets.add(localAsUtc - sample.getTime());
	}

	const candidates = [...offsets]
		.map(offset => new Date(naiveUtc - offset))
		.filter(candidate => sameLocalMinute(formatParts(candidate), date, time));

	return [...new Map(candidates.map(candidate => [candidate.getTime(), candidate])).values()];
}

function melbourneNow(now = new Date()) {
	const parts = formatParts(now);
	return {
		...parts,
		date: formatLocalDate(parts),
		minutes: parts.hour * 60 + parts.minute,
	};
}

function validatePickupChoice(pickupType, pickupDate, pickupTime, now = new Date()) {
	const current = melbourneNow(now);

	if (pickupType === "ASAP") {
		if (current.minutes < OPENING_MINUTES || current.minutes >= CLOSING_MINUTES) {
			const error = new Error("Pickup Now is currently unavailable because the store is closed.");
			error.code = "PICKUP_CLOSED";
			throw error;
		}

		return {
			pickupType,
			requestedPickupDate: current.date,
			requestedPickupTime: null,
			requestedPickupAt: now,
		};
	}

	if (pickupType !== "SCHEDULED") {
		throw new Error("Please select a valid pickup option.");
	}

	const dateParts = parseLocalDate(pickupDate);
	const timeParts = parseLocalTime(pickupTime);
	const normalizedDate = formatLocalDate(dateParts);
	const normalizedTime = `${String(timeParts.hour).padStart(2, "0")}:${String(timeParts.minute).padStart(2, "0")}`;
	const minutes = timeParts.hour * 60 + timeParts.minute;

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
	if (minutes < OPENING_MINUTES || minutes > CLOSING_MINUTES) {
		throw new Error("Please select a pickup time between 7:00 AM and 5:00 PM Melbourne time.");
	}
	if (normalizedDate < current.date) {
		throw new Error("Please select a valid future pickup time.");
	}

	if (candidates[0].getTime() <= now.getTime()) {
		throw new Error("Please select a valid future pickup time.");
	}

	return {
		pickupType,
		requestedPickupDate: normalizedDate,
		requestedPickupTime: normalizedTime,
		requestedPickupAt: candidates[0],
	};
}

module.exports = {
	BUSINESS_TIME_ZONE,
	melbourneNow,
	possibleInstantsForLocalTime,
	validatePickupChoice,
};
