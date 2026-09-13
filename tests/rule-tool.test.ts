import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { setRunNpmForTest } from "../src/update.js";

// Hermetic session_start (mirrors omp-refuse.test.ts): no network.
setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;

function captureApi() {
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
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function fakeCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

function toolText(out: any): string {
  return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
}

async function setup(adapterExtra: Record<string, unknown>, stateFile: string) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false, ...adapterExtra })(api as any);
  await rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx([userMsg("e1", "hello world")], stateFile);
  await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
  const ruleTool = api.tools.find((t: any) => t.name === "acp_rule");
  return { api, handlers, ctx, ruleTool };
}

describe("acp_rule tool registration (issue #433)", () => {
  test("not registered by default (off)", async () => {
    const { ruleTool } = await setup({}, "/tmp/pai-acp-rule-off.session.json");
    assert.equal(ruleTool, undefined, "acp_rule must be off by default");
  });

  test("registered when rules: true", async () => {
    const { ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-on.session.json");
    assert.ok(ruleTool, "acp_rule tool must be registered when enabled");
    assert.equal(ruleTool!.label, "Rule");
  });

  test("explicitly disabled with rules: false", async () => {
    const { ruleTool } = await setup({ rules: false }, "/tmp/pai-acp-rule-explicit-off.session.json");
    assert.equal(ruleTool, undefined);
  });
});

describe("acp_rule add/list semantics (issue #433)", () => {
  test("add records and echoes the rule", async () => {
    const { ctx, ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-add.session.json");
    assert.ok(ruleTool);
    const out = await ruleTool.execute("t1", { rule: "Always run tests before committing" }, undefined, undefined, ctx);
    assert.equal(toolText(out), "Recorded rule-1: Always run tests before committing");
  });

  test("add trims surrounding whitespace", async () => {
    const { ctx, ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-trim.session.json");
    assert.ok(ruleTool);
    const out = await ruleTool.execute("t1", { rule: "  Trimmed rule  " }, undefined, undefined, ctx);
    assert.equal(toolText(out), "Recorded rule-1: Trimmed rule");
  });

  test("omitted or blank rule lists instead of recording", async () => {
    const { ctx, ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-list.session.json");
    assert.ok(ruleTool);
    assert.equal(toolText(await ruleTool.execute("t1", {}, undefined, undefined, ctx)), "No rules recorded.");
    assert.equal(toolText(await ruleTool.execute("t2", { rule: "   " }, undefined, undefined, ctx)), "No rules recorded.");

    await ruleTool.execute("t3", { rule: "First lesson" }, undefined, undefined, ctx);
    await ruleTool.execute("t4", { rule: "Second lesson" }, undefined, undefined, ctx);
    const listed = toolText(await ruleTool.execute("t5", {}, undefined, undefined, ctx));
    assert.match(listed, /^Recorded rules \(2\)/);
    assert.match(listed, /1\. First lesson/);
    assert.match(listed, /2\. Second lesson/);
  });

  test("rules persist to the .acp.json sidecar", async () => {
    const stateFile = "/tmp/pai-acp-rule-persist.session.json";
    const { ctx, ruleTool } = await setup({ rules: true }, stateFile);
    assert.ok(ruleTool);
    await ruleTool.execute("t1", { rule: "Never force-push to master" }, undefined, undefined, ctx);
    const raw = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
    assert.equal(raw.rules?.[0]?.id, "rule-1");
    assert.equal(raw.rules?.[0]?.text, "Never force-push to master");
  });

  test("validation failures are soft plain-text errors", async () => {
    const { ctx, ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-val.session.json");
    assert.ok(ruleTool);
    await ruleTool.execute("t1", { rule: "Keep summaries dense" }, undefined, undefined, ctx);
    let out = await ruleTool.execute("t2", { rule: "Keep summaries dense" }, undefined, undefined, ctx);
    assert.match(toolText(out), /already recorded/);

    out = await ruleTool.execute("t3", { rule: "x".repeat(301) }, undefined, undefined, ctx);
    assert.match(toolText(out), /rule too long/);
  });

  test("maxRules cap rejects further adds", async () => {
    const { ctx, ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-cap.session.json");
    assert.ok(ruleTool);
    for (let i = 1; i <= 50; i++) {
      const out = await ruleTool.execute(`t${i}`, { rule: `lesson ${i}` }, undefined, undefined, ctx);
      assert.match(toolText(out), /^Recorded rule-\d+/, `add ${i} failed: ${toolText(out)}`);
    }
    const out = await ruleTool.execute("t51", { rule: "one too many" }, undefined, undefined, ctx);
    assert.match(toolText(out), /limit reached \(50\)/);
  });
});

describe("system prompt untouched (issue #433)", () => {
  test("no acp_rule content injected into the system prompt even when enabled", async () => {
    const { handlers, ruleTool } = await setup({ rules: true }, "/tmp/pai-acp-rule-sysprompt.session.json");
    assert.ok(ruleTool);
    const res = await handlers.get("before_agent_start")![0]!({ systemPrompt: "base-prompt" }, {});
    const sp: string = res.systemPrompt;
    assert.match(sp, /base-prompt/);
    assert.ok(!sp.includes("acp_rule"), "system prompt must stay untouched per owner decision");
  });
});
