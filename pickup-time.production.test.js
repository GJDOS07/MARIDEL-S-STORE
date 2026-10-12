"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STORE_INFO, buildPickupSlotTimes } = require("./store-info");
const {
	melbourneDateAndTime,
	melbourneNow,
	possibleInstantsForLocalTime,
	validatePickupChoice,
} = require("./pickup-time");

const FUTURE_DATE = "2099-06-15";

test("single source of truth matches the official Maridel's Store hours", () => {
	assert.equal(STORE_INFO.address, "1 Victoria Place, Stawell, Victoria 3380, Australia");
	assert.equal(STORE_INFO.phone, "0473 953 049");
	assert.equal(STORE_INFO.timeZone, "Australia/Melbourne");
	assert.equal(STORE_INFO.openMinutes, 10 * 60);
	assert.equal(STORE_INFO.closeMinutes, 20 * 60);
	assert.equal(STORE_INFO.slotIntervalMinutes, 1);
});

test("accepts flexible minute-level pickup times at the open boundaries", () => {
	for (const time of ["10:00", "10:01", "12:00", "13:47", "19:59", "20:00"]) {
		const result = validatePickupChoice(FUTURE_DATE, time);
		assert.equal(result.pickupDate, FUTURE_DATE);
		assert.equal(result.pickupTime, time);
	}
});

test("rejects times outside 10:00 AM to 8:00 PM", () => {
	for (const time of ["09:59", "06:59", "07:00", "08:30", "20:01", "23:00", "00:00"]) {
		assert.throws(() => validatePickupChoice(FUTURE_DATE, time), /Pickup is available from 10:00 AM to 8:00 PM/);
	}
});

test("rejects invalid calendar dates and dates in the past", () => {
	assert.throws(() => validatePickupChoice("2099-02-29", "10:00"), /valid pickup date/);
	assert.throws(() => validatePickupChoice("2000-01-01", "10:00"), /cannot be in the past/);
});

test("uses Melbourne local date and rejects a same-day time that has passed", () => {
	const now = new Date("2026-10-10T00:00:00.000Z");
	const local = melbourneDateAndTime(now);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", local.date, local.time, now),
		/not passed in Melbourne/,
	);
});

test("generates a complete one-minute schedule from 10:00 through 20:00", () => {
	const slots = buildPickupSlotTimes();
	assert.equal(slots.length, 601);
	assert.equal(slots[0], "10:00");
	assert.equal(slots[slots.length - 1], "20:00");
	assert.equal(new Set(slots).size, slots.length);
	for (let index = 1; index < slots.length; index += 1) {
		const previous = Number(slots[index - 1].slice(0, 2)) * 60 + Number(slots[index - 1].slice(3, 5));
		const current = Number(slots[index].slice(0, 2)) * 60 + Number(slots[index].slice(3, 5));
		assert.equal(current - previous, 1);
	}
});

test("rejects the current minute with second-level precision", () => {
	const now = new Date("2026-10-09T23:59:30.000Z");
	const local = melbourneDateAndTime(now);
	assert.equal(local.date, "2026-10-10");
	assert.equal(local.time, "10:59");
	assert.throws(() => validatePickupChoice("SCHEDULED", local.date, local.time, now), /not passed in Melbourne/);
});

test("rejects daylight-saving gaps and ambiguous times", () => {
	assert.equal(possibleInstantsForLocalTime("2026-10-04", "02:30").length, 0);
	assert.equal(possibleInstantsForLocalTime("2026-04-05", "02:30").length, 2);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-10-04", "02:30", new Date("2026-10-03T00:00:00.000Z")),
		/daylight-saving change/,
	);
	assert.throws(
		() => validatePickupChoice("2026-04-05", "02:30", new Date("2026-04-04T00:00:00.000Z")),
		/valid pickup date/,
	);
	assert.throws(
		() => validatePickupChoice("SCHEDULED", "2026-04-05", "02:30", new Date("2026-04-04T00:00:00.000Z")),
		/daylight-saving change/,
	);
	const melbourne = melbourneNow(new Date("2026-10-07T00:00:00.000Z"));
	assert.equal(melbourne.date, "2026-10-07");
	assert.equal(melbourne.hour, 11);
});

test("supports ASAP during open hours and rejects it when closed", () => {
	const open = validatePickupChoice("ASAP", null, null, new Date("2026-10-07T00:00:00.000Z"));
	assert.equal(open.requestedPickupDate, "2026-10-07");
	assert.equal(open.requestedPickupTime, null);
	assert.throws(
		() => validatePickupChoice("ASAP", null, null, new Date("2026-10-07T10:30:00.000Z")),
		/PICKUP_CLOSED|currently unavailable/,
	);
});

