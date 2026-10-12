"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clampDay, daysInMonth, isBefore } = require("./pickup-date");

test("returns the correct number of days for leap years and short months", () => {
	assert.equal(daysInMonth(2028, 1), 29);
	assert.equal(daysInMonth(2027, 1), 28);
	assert.equal(daysInMonth(2026, 3), 30);
	assert.equal(daysInMonth(2026, 0), 31);
});

test("clamps an end-of-month day when the selected month or year is shorter", () => {
	assert.equal(clampDay(31, 2026, 3), 30);
	assert.equal(clampDay(31, 2027, 1), 28);
	assert.equal(clampDay(31, 2028, 1), 29);
	assert.equal(clampDay(28, 2028, 1), 28);
});

test("compares pickup dates as local calendar fields without timezone conversion", () => {
	const minimum = { year: 2026, month: 9, day: 11 };
	assert.equal(isBefore({ year: 2026, month: 9, day: 10 }, minimum), true);
	assert.equal(isBefore({ year: 2026, month: 9, day: 11 }, minimum), false);
	assert.equal(isBefore({ year: 2026, month: 10, day: 1 }, minimum), false);
	assert.equal(isBefore({ year: 2027, month: 0, day: 1 }, minimum), false);
});
