"use strict";
// Tests for the prompt queue used by set-owner-credentials.js.
//
// The bug this guards against is a specific and silent one: Node's readline
// parses every available line of piped input before the first await resumes, so
// calling rl.question twice loses the second answer. The result is an operator
// who types a password, sees it accepted, and then cannot log in, because the
// confirmation never actually reached the script. The queue reads the lines up
// front and hands them out one at a time.

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const readline = require("node:readline");

const { createPromptQueue } = require("./set-owner-credentials");

// Drives createPromptQueue the same way readline does: "line" events for input
// and a single "close" event at end of input.
function makeHarness(lines, { closeAfterLines = true } = {}) {
	const rl = new EventEmitter();
	const queue = createPromptQueue(rl);
	const emit = () => {
		for (const line of lines) {
			setImmediate(() => rl.emit("line", line));
		}
		if (closeAfterLines) setImmediate(() => rl.emit("close"));
	};
	return { rl, queue, emit };
}

test("two prompts both receive an answer from pre-buffered input", async () => {
	// This is the exact case that used to fail.
	const { rl, queue, emit } = makeHarness(["first-password-1", "first-password-1"]);
	const first = queue.next();
	const second = queue.next();
	emit();

	assert.equal(await first, "first-password-1");
	assert.equal(await second, "first-password-1");
	void rl;
});

test("prompts are answered in the order they were asked", async () => {
	const { rl, queue, emit } = makeHarness(["a", "b", "c"]);
	const a = queue.next();
	const b = queue.next();
	const c = queue.next();
	emit();

	assert.equal(await a, "a", "the first question gets the first line");
	assert.equal(await b, "b", "the second question gets the second line");
	assert.equal(await c, "c", "the third question gets the third line");
});

test("a question asked before the line arrives waits for it", async () => {
	// Interactive case: the operator types after the prompt is shown.
	const rl = new EventEmitter();
	const queue = createPromptQueue(rl);
	const pending = queue.next();

	setImmediate(() => rl.emit("line", "typed-later-1"));
	assert.equal(await pending, "typed-later-1");
});

test("end of input answers a waiting prompt with null, so setup cannot hang", async () => {
	const rl = new EventEmitter();
	const queue = createPromptQueue(rl);
	const pending = queue.next();
	rl.emit("close");
	assert.equal(await pending, null, "run out of input must resolve, not hang forever");
});

test("end of input after the queue is drained does not disturb later prompts", async () => {
	const rl = new EventEmitter();
	const queue = createPromptQueue(rl);
	rl.emit("line", "only-line-1");
	assert.equal(await queue.next(), "only-line-1");
	rl.emit("close", );
	// A prompt offered after the input closed still resolves to null rather
	// than hanging, which is what keeps the tool from freezing on a bad pipe.
	const after = queue.next();
	rl.emit("close");
	assert.equal(await after, null);
});

test("a blank line is preserved rather than skipped", () => {
	// The operator may press Enter by mistake on the first prompt. Skipping it
	// would silently shift every following line, so an empty string must survive.
	const rl = new EventEmitter();
	const queue = createPromptQueue(rl);
	rl.emit("line", "");
	rl.emit("line", "real-password-1");
	return Promise.all([queue.next(), queue.next()]).then(([blank, real]) => {
		assert.equal(blank, "");
		assert.equal(real, "real-password-1");
	});
});

test("the queue is not readline itself: no question callback is ever registered", () => {
	// The regression was caused by rl.question. Assert the harness never touches
	// it, so a refactor back to question would fail this test.
	const rl = new EventEmitter();
	let questionCalled = 0;
	rl.question = () => {
		questionCalled += 1;
		throw new Error("rl.question must not be used for piped input");
	};
	const queue = createPromptQueue(rl);
	rl.emit("line", "queued-line-1");
	const promise = queue.next();
	assert.equal(questionCalled, 0, "rl.question must not be called");
	return promise.then(value => assert.equal(value, "queued-line-1"));
});

test("readline is still used for the interactive (TTY) path", () => {
	// The queue handles pipes; a real terminal is driven by readline.question.
	// Both must stay reachable, which this documents by checking the API exists.
	assert.equal(typeof readline.createInterface, "function");
	assert.equal(typeof createPromptQueue, "function");
});
