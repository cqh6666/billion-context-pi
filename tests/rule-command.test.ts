import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { ACP_RULE_CUSTOM_TYPE } from "../src/messages.js";

type SentMessage = { customType: string; content: string; display: boolean };

function captureApi(sendMessage?: (m: SentMessage) => void) {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
    sendMessage,
  };
  return { api, handlers };
}

function fakeCtx(entries: any[], stateFile: string, notifies: Array<{ msg: string; type?: string }> = []) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: (t: string, type?: string) => { notifies.push({ msg: t, type }); }, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

async function setup(entries: any[], stateFile: string, opts?: { rules?: boolean; coreOverrides?: Record<string, unknown>; sendMessage?: (m: SentMessage) => void; keepSidecar?: boolean }) {
  const { api, handlers } = captureApi(opts?.sendMessage);
  createAcpExtension({ modelContextLimit: 200_000, rules: opts?.rules, coreOverrides: opts?.coreOverrides })(api as any);
  if (!opts?.keepSidecar) await rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx(entries, stateFile);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const command = api.commands.get("acp-rule") as { handler: (args: string, ctx: any) => Promise<void> } | undefined;
  return { api, ctx, command };
}

test("/acp-rule is registered alongside /acp-cache and lists recorded rules via sendMessage (#527)", async () => {
  const sent: SentMessage[] = [];
  const stateFile = "/tmp/pai-acp-rule-list.session.json";
  const { api, command } = await setup([], stateFile, { rules: true, sendMessage: (m) => sent.push(m) });
  assert.ok(command, "acp-rule command registered");
  assert.ok(api.commands.has("acp-cache"), "acp-cache still registered");

  await command!.handler("", fakeCtx([], stateFile));
  assert.equal(sent.length, 1, "one custom message sent");
  assert.equal(sent[0]!.customType, ACP_RULE_CUSTOM_TYPE);
  assert.equal(sent[0]!.display, true);
  assert.equal(sent[0]!.content, "No rules recorded.", "empty state is a friendly message, not an empty list");
});

test("/acp-rule <text> records via the kernel API, echoes the same confirmation as the model path, then lists it (#527)", async () => {
  const sent: SentMessage[] = [];
  const stateFile = "/tmp/pai-acp-rule-record.session.json";
  const { command } = await setup([], stateFile, { rules: true, sendMessage: (m) => sent.push(m) });

  await command!.handler("  always run typecheck before done  ", fakeCtx([], stateFile));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.content, "Recorded rule1: always run typecheck before done", "trimmed text recorded, same echo as the acp_rule tool");

  await command!.handler("", fakeCtx([], stateFile));
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.content, "1. [rule1] always run typecheck before done", "list renders kernel formatRulesList output");

  const sidecar = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8")) as { rules?: Array<{ id: string; text: string }> };
  assert.deepEqual(sidecar.rules, [{ id: "rule1", text: "always run typecheck before done" }], "rule persisted in the session sidecar");
});

test("/acp-rule records survive a restart (fresh extension reading the same sidecar) (#527)", async () => {
  const stateFile = "/tmp/pai-acp-rule-restart.session.json";
  const first = await setup([], stateFile, { rules: true });
  await first.command!.handler("prefer pnpm", fakeCtx([], stateFile));

  const sent: SentMessage[] = [];
  const second = await setup([], stateFile, { rules: true, sendMessage: (m) => sent.push(m), keepSidecar: true });
  await second.command!.handler("", fakeCtx([], stateFile));
  assert.equal(sent[0]!.content, "1. [rule1] prefer pnpm", "recorded rule listed from the reloaded sidecar state");
});

test("/acp-rule surfaces kernel validation errors verbatim without recording (#527)", async () => {
  const sent: SentMessage[] = [];
  const notifies: Array<{ msg: string; type?: string }> = [];
  const stateFile = "/tmp/pai-acp-rule-invalid.session.json";
  const { command } = await setup([], stateFile, {
    rules: true,
    coreOverrides: { rules: { maxRuleChars: 10 } },
    sendMessage: (m) => sent.push(m),
  });

  await command!.handler("this text is far longer than ten characters", fakeCtx([], stateFile, notifies));
  assert.equal(sent.length, 0, "no transcript message for a rejected record");
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0]!.type, "error");
  assert.match(notifies[0]!.msg, /10/);

  await command!.handler("", fakeCtx([], stateFile, notifies));
  assert.equal(notifies.length, 1, "nothing was recorded by the rejected call");
});

test("/acp-rule warns with the enablement hint instead of an empty list when the feature is off (#527)", async () => {
  const sent: SentMessage[] = [];
  const notifies: Array<{ msg: string; type?: string }> = [];
  const stateFile = "/tmp/pai-acp-rule-off.session.json";
  const { command } = await setup([], stateFile, { rules: false, sendMessage: (m) => sent.push(m) });

  await command!.handler("", fakeCtx([], stateFile, notifies));
  assert.equal(sent.length, 0, "no transcript write when disabled");
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0]!.type, "warning");
  assert.match(notifies[0]!.msg, /"rules": true/);

  await command!.handler("some rule", fakeCtx([], stateFile, notifies));
  assert.equal(sent.length, 0, "record path also gated");
  assert.equal(notifies.length, 2, "record path shows the same hint");
});

test("/acp-rule falls back to raw-text ui.notify on hosts without sendMessage (#527)", async () => {
  const notifies: Array<{ msg: string; type?: string }> = [];
  const stateFile = "/tmp/pai-acp-rule-notify.session.json";
  const { command } = await setup([], stateFile, { rules: true });

  await command!.handler("prefer pnpm", fakeCtx([], stateFile, notifies));
  assert.deepEqual(notifies.map((n) => n.msg), ["Recorded rule1: prefer pnpm"]);
});
