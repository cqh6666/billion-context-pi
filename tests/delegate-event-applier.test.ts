import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEventApplier, type EventApplier } from "../src/delegate-tool.js";

class MockWriter {
	chunks: string[] = [];
	write(c: string): void {
		this.chunks.push(c);
	}
	get text(): string {
		return this.chunks.join("");
	}
}

interface Harness {
	applier: EventApplier;
	reply: MockWriter;
	activity: MockWriter;
}

function makeHarness(showThinking = false): Harness {
	const reply = new MockWriter();
	const activity = new MockWriter();
	const applier = makeEventApplier({ showThinking }, { reply, activity });
	return { applier, reply, activity };
}

function delta(text: string, contentIndex = 0): string {
	return `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":${contentIndex},"delta":${JSON.stringify(text)}}}`;
}

function end(text: string, contentIndex = 0): string {
	return `{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":${contentIndex},"content":${JSON.stringify(text)}}}`;
}

function thinkingDelta(text: string): string {
	return `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":${JSON.stringify(text)}}}`;
}

function thinkingEnd(): string {
	return '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0}}';
}

test("normal streaming: deltas cover the full content, text_end adds nothing", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(delta("ab"));
	applier.handleEventLine(delta("cd"));
	applier.handleEventLine(end("abcd"));
	assert.equal(reply.text, "abcd");
	assert.equal(applier.getReplyText(), "abcd");
});

test("bug repro: final content arrives via text_end with no deltas — never lost", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(end("final answer"));
	assert.equal(reply.text, "final answer");
	assert.equal(applier.getReplyText(), "final answer");
});

test("truncated stream: text_end fills the missing tail", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(delta("ab"));
	applier.handleEventLine(end("abcdef"));
	assert.equal(reply.text, "abcdef");
	assert.equal(applier.getReplyText(), "abcdef");
});

test("multiple messages: file keeps all turns, replyText is the last content", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(delta("first "));
	applier.handleEventLine(end("first turn"));
	applier.handleEventLine(delta("second "));
	applier.handleEventLine(end("second turn"));
	assert.equal(reply.text, "first turnsecond turn");
	assert.equal(applier.getReplyText(), "second turn");
});

test("multiple content blocks: each block's deltas and tails append in order", () => {
	const { applier, reply } = makeHarness();
	// block 0: streamed fully
	applier.handleEventLine(delta("block0", 0));
	applier.handleEventLine(end("block0", 0));
	// block 1: truncated stream, tail filled
	applier.handleEventLine(delta("b1-", 1));
	applier.handleEventLine(end("b1-full", 1));
	assert.equal(reply.text, "block0b1-full");
});

test("empty delta and empty content: no writes", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(delta(""));
	applier.handleEventLine(end(""));
	assert.equal(reply.text, "");
	assert.equal(applier.getReplyText(), "");
});

test("delta without text_end (killed process): file keeps the streamed delta", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(delta("partial "));
	applier.handleEventLine(delta("text"));
	assert.equal(reply.text, "partial text");
	assert.equal(applier.getReplyText(), "partial text");
});

test("thinking deltas never pollute the reply file, activity gated by showThinking", () => {
	const hidden = makeHarness(false);
	hidden.applier.handleEventLine(thinkingDelta(" wan"));
	hidden.applier.handleEventLine(thinkingEnd());
	hidden.applier.handleEventLine(delta("answer"));
	hidden.applier.handleEventLine(end("answer"));
	assert.equal(hidden.reply.text, "answer");
	assert.equal(
		hidden.activity.text,
		"",
		"thinking hidden when showThinking=false",
	);

	const shown = makeHarness(true);
	shown.applier.handleEventLine(thinkingDelta(" wan"));
	shown.applier.handleEventLine(thinkingEnd());
	assert.equal(shown.activity.text, "[thinking] wan\n");
	assert.equal(shown.reply.text, "", "thinking never written to reply file");
});

test("text_end content shorter than written deltas: no duplicate write", () => {
	const { applier, reply } = makeHarness();
	applier.handleEventLine(delta("longer"));
	applier.handleEventLine(end("short"));
	assert.equal(reply.text, "longer", "delta content kept, nothing appended");
	assert.equal(applier.getReplyText(), "short");
});

test("appendRaw (omp fallback) writes straight through", () => {
	const { applier, reply } = makeHarness();
	applier.appendRaw("plain reply");
	assert.equal(reply.text, "plain reply");
	assert.equal(applier.getReplyText(), "plain reply");
});

test("tool activity goes to activity file, not reply", () => {
	const { applier, reply, activity } = makeHarness();
	applier.handleEventLine(
		'{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"echo hi"}}',
	);
	applier.handleEventLine(delta("answer"));
	applier.handleEventLine(end("answer"));
	assert.equal(reply.text, "answer");
	assert.match(activity.text, /\[tool\] bash echo hi/);
});

function toolStart(name = "bash"): string {
	return `{"type":"tool_execution_start","toolCallId":"c1","toolName":${JSON.stringify(name)},"args":{"path":"f"}}`;
}

function toolEnd(): string {
	return '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","isError":false}';
}

// ─── #506: activity stats feed the silent-no-op verdict ─────────────────────

test("getStats: pristine applier reports no substantive activity", () => {
	const { applier } = makeHarness();
	assert.deepEqual(applier.getStats(), { toolStarts: 0, thinkingChars: 0, lastSubstantive: null });
});

test("getStats: thinking-only stream ends on thinking with char count", () => {
	const { applier } = makeHarness();
	applier.handleEventLine(thinkingDelta("abc"));
	applier.handleEventLine(thinkingDelta("defgh"));
	applier.handleEventLine(thinkingEnd());
	assert.deepEqual(applier.getStats(), { toolStarts: 0, thinkingChars: 8, lastSubstantive: "thinking" });
});

test("getStats: reply after tools ends on reply and counts tool starts", () => {
	const { applier } = makeHarness();
	applier.handleEventLine(toolStart());
	applier.handleEventLine(toolEnd());
	applier.handleEventLine(delta("answer"));
	applier.handleEventLine(end("answer"));
	assert.deepEqual(applier.getStats(), { toolStarts: 1, thinkingChars: 0, lastSubstantive: "reply" });
});

test("getStats: run ending right after a tool execution ends on tool", () => {
	const { applier } = makeHarness();
	applier.handleEventLine(toolStart());
	applier.handleEventLine(toolEnd());
	assert.deepEqual(applier.getStats(), { toolStarts: 1, thinkingChars: 0, lastSubstantive: "tool" });
});

test("getStats: thinking after a tool execution overrides the tool class (stall signature)", () => {
	const { applier } = makeHarness();
	applier.handleEventLine(toolStart("read"));
	applier.handleEventLine(toolEnd());
	applier.handleEventLine(thinkingDelta("stalling…"));
	applier.handleEventLine(thinkingEnd());
	assert.deepEqual(applier.getStats(), { toolStarts: 1, thinkingChars: 9, lastSubstantive: "thinking" });
});

test("getStats: appendRaw (omp fallback) counts as reply", () => {
	const { applier } = makeHarness();
	applier.appendRaw("plain reply");
	assert.equal(applier.getStats().lastSubstantive, "reply");
});

test("getStats: control-flow events (retry, usage, settled) never change the class", () => {
	const { applier } = makeHarness();
	applier.handleEventLine(thinkingDelta("x"));
	applier.handleEventLine(thinkingEnd());
	applier.handleEventLine('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":100,"errorMessage":"boom"}');
	applier.handleEventLine('{"type":"auto_retry_end","success":true,"attempt":1}');
	applier.handleEventLine('{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3}}}');
	applier.handleEventLine('{"type":"agent_settled"}');
	assert.equal(applier.getStats().lastSubstantive, "thinking", "still the pre-retry thinking segment");
});
