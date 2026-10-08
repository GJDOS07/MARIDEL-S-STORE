const test = require("node:test");
const assert = require("node:assert/strict");
const {
	melbourneNow,
	possibleInstantsForLocalTime,
	validatePickupChoice,
} = require("./pickup-time");

test("Melbourne local time follows daylight saving", () => {
	const parts = melbourneNow(new Date("2026-10-07T00:00:00.000Z"));
	assert.equal(parts.date, "2026-10-07");
	assert.equal(parts.hour, 11);
});

test("ASAP is accepted only during Melbourne opening hours", () => {
	const open = validatePickupChoice("ASAP", null, null, new Date("2026-10-07T00:00:00.000Z"));
	assert.equal(open.requestedPickupDate, "2026-10-07");
	assert.equal(open.requestedPickupTime, null);

	assert.throws(
		() => validatePickupChoice("ASAP", null, null, new Date("2026-10-07T06:00:00.000Z")),
		{ code: "PICKUP_CLOSED" },
	);
});

test("scheduled Melbourne pickup accepts an ordinary future slot", () => {
	const pickup = validatePickupChoice(
		"SCHEDULED",
		"2026-10-08",
		"09:30",
		new Date("2026-10-07T00:00:00.000Z"),
	);
	assert.equal(pickup.requestedPickupDate, "2026-10-08");
	assert.equal(pickup.requestedPickupTime, "09:30");
	assert.equal(pickup.requestedPickupAt.toISOString(), "2026-10-07T22:30:00.000Z");
});

test("scheduled pickup rejects closed hours and past times", () => {
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-10-08", "06:30", new Date("2026-10-07T00:00:00.000Z")),
		/7:00 AM and 5:00 PM Melbourne time/,
	);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-10-08", "17:30", new Date("2026-10-07T00:00:00.000Z")),
		/7:00 AM and 5:00 PM Melbourne time/,
	);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-10-07", "10:00", new Date("2026-10-07T00:00:00.000Z")),
		/valid future pickup time/,
	);
});

test("Melbourne DST gaps and repeated local times are rejected", () => {
	assert.equal(possibleInstantsForLocalTime("2026-10-04", "02:30").length, 0);
	assert.equal(possibleInstantsForLocalTime("2026-04-05", "02:30").length, 2);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-10-04", "02:30", new Date("2026-10-03T00:00:00.000Z")),
		{ code: "PICKUP_TIME_NONEXISTENT" },
	);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-04-05", "02:30", new Date("2026-04-04T00:00:00.000Z")),
		{ code: "PICKUP_TIME_AMBIGUOUS" },
	);
});
