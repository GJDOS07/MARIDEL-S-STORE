"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPickupTime } = require("./pickup-time-display");
const { validatePickupChoice } = require("./pickup-time");

const FUTURE_DATE = "2099-06-15";

test("formats valid 24-hour API times for customer-facing display", () => {
	assert.equal(formatPickupTime("07:00"), "7:00 AM");
	assert.equal(formatPickupTime("08:30"), "8:30 AM");
	assert.equal(formatPickupTime("11:59"), "11:59 AM");
	assert.equal(formatPickupTime("12:00"), "12:00 PM");
	assert.equal(formatPickupTime("13:15"), "1:15 PM");
	assert.equal(formatPickupTime("17:00"), "5:00 PM");
	assert.equal(formatPickupTime("00:00"), "12:00 AM");
});

test("does not format malformed times or change the backend HH:MM contract", () => {
	for (const value of ["7:00", "24:00", "13:60", "1:15 PM", "", null]) {
		assert.equal(formatPickupTime(value), null);
	}

	for (const time of ["13:15", "12:00", "20:00"]) {
		const result = validatePickupChoice(FUTURE_DATE, time);
		assert.equal(result.pickupDate, FUTURE_DATE);
		assert.equal(result.pickupTime, time);
	}
	assert.throws(() => validatePickupChoice(FUTURE_DATE, "00:00"), /Pickup is available from 10:00 AM to 8:00 PM/);
	assert.throws(() => validatePickupChoice(FUTURE_DATE, "09:59"), /Pickup is available from 10:00 AM to 8:00 PM/);
	assert.throws(() => validatePickupChoice(FUTURE_DATE, "20:01"), /Pickup is available from 10:00 AM to 8:00 PM/);
});
