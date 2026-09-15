import { test } from "node:test";
import assert from "node:assert/strict";
import { usageAnchorPredatesCompression } from "../src/floor-stale.js";

// The issue #257 floor must be skipped while the host's provider-usage anchor
// (the usage on the last valid assistant message) predates the last
// successful compress toolResult — right after a compress the anchor still
// reflects the pre-compress (larger) request.

const USAGE = { input: 175_000, cacheRead: 0, cacheWrite: 0 };
const PANEL_OK = "▣ ACP | 42.3K → 18.9K tokens (~23.4K reclaimed, 3 blocks)";
const PANEL_NOOP = "▣ ACP | 42.3K → 42.3K tokens (~0 reclaimed, 0 blocks)";

const msg = (id: string, message: Record<string, unknown>) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { timestamp: Date.now(), ...message },
});

const assistantUsage = (id: string, over: Record<string, unknown> = {}) =>
  msg(id, { role: "assistant", content: "ok", usage: USAGE, ...over });

const compressResult = (id: string, text: string, over: Record<string, unknown> = {}) =>
  msg(id, { role: "toolResult", toolName: "compress", toolCallId: "c1", content: [{ type: "text", text }], ...over });

test("fresh anchor: usage after the compress is not stale", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK),
    assistantUsage("e3"), // post-compress assistant carries fresh usage
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("stale anchor: successful compress after the last usage", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_OK),
    msg("e3", { role: "assistant", content: "continuing" }), // no usage field
  ];
  assert.equal(usageAnchorPredatesCompression(entries), true);
});

test("no compress at all is never stale", () => {
  const entries = [msg("e0", { role: "user", content: "go" }), assistantUsage("e1")];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("failed compress does not invalidate the anchor", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", "Error: Range not found", { isError: true }),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("noop compress (0-block panel) does not invalidate the anchor", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    compressResult("e2", PANEL_NOOP),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});

test("error / aborted / zero-usage assistants are not anchors", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1", { stopReason: "error" }),
    assistantUsage("e2", { stopReason: "aborted" }),
    assistantUsage("e3", { usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
    compressResult("e4", PANEL_OK),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), true);
});

test("usage via totalTokens alone counts as an anchor", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    msg("e1", { role: "assistant", content: "ok", usage: { totalTokens: 90_000 } }),
    compressResult("e2", PANEL_OK),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), true);
});

test("non-compress toolResults are ignored", () => {
  const entries = [
    msg("e0", { role: "user", content: "go" }),
    assistantUsage("e1"),
    msg("e2", { role: "toolResult", toolName: "read", toolCallId: "c9", content: [{ type: "text", text: PANEL_OK }] }),
  ];
  assert.equal(usageAnchorPredatesCompression(entries), false);
});
