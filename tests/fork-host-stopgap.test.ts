import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { FORK_HOST_WARNING_MESSAGE, UNSUPPORTED_HOST_MESSAGE } from "../src/omp.js";
import { setRunNpmForTest } from "../src/update.js";

// Issue #454 stopgap (direction per owner via #452): declared fork hosts
// (PI_ACP_FORK_HOST=1) are admitted but carry a known ref-drift limitation, so
// (a) session_start warns loudly at admission, and (b) ref-resolution failures
// on such hosts log a distinct attribution event pointing at root fix #459.
setRunNpmForTest(async (args) => ({ code: 0, stdout: args[0] === "view" ? "0.0.1\n" : "", stderr: "" }));
process.env.ACP_AUTO_UPDATE = "false";
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.PI_ACP_FORK_HOST;

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
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

type Notify = (msg: string, type?: string) => void;

// OMP-shaped host: getBranch but NOT buildContextEntries.
function ompCtx(notify: Notify, hasUI: boolean) {
  return {
    mode: "rpc",
    hasUI,
    cwd: "/tmp",
    ui: { notify, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "fork-stopgap-session",
      getSessionFile: () => "/tmp/fork-stopgap.session.json",
    },
  };
}

// pi-shaped host: buildContextEntries present.
function piCtx(notify: Notify) {
  return {
    mode: "rpc",
    hasUI: true,
    cwd: "/tmp",
    ui: { notify, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "pi-stopgap-session",
      getSessionFile: () => "/tmp/pi-stopgap.session.json",
    },
  };
}

const startSession = (handlers: any, ctx: any) =>
  handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

describe("Fork-host stopgap (issue #454)", () => {
  test("declared fork host admits but warns once via UI at session_start", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: Array<{ msg: string; type?: string }> = [];
    const notify: Notify = (msg, type) => notes.push({ msg, type });
    const ctx = ompCtx(notify, true);

    process.env.PI_ACP_FORK_HOST = "1";
    try {
      await startSession(handlers, ctx);
      await startSession(handlers, ctx);
    } finally {
      delete process.env.PI_ACP_FORK_HOST;
    }

    const forkNotes = notes.filter((n) => n.msg === FORK_HOST_WARNING_MESSAGE);
    assert.equal(forkNotes.length, 1, "warns exactly once across repeated starts");
    assert.equal(forkNotes[0]!.type, "warning");
    assert.equal(notes.filter((n) => n.msg === UNSUPPORTED_HOST_MESSAGE).length, 0, "no refusal when fork declared");
    // Still serves: cancels host compaction and injects the ACP system prompt.
    assert.deepEqual(handlers.get("session_before_compact")![0]!({}, {}), { cancel: true });
  });

  test("pi host gets no fork warning even when PI_ACP_FORK_HOST is set", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const notes: string[] = [];
    const ctx = piCtx((msg) => notes.push(msg));

    process.env.PI_ACP_FORK_HOST = "1";
    try {
      await startSession(handlers, ctx);
    } finally {
      delete process.env.PI_ACP_FORK_HOST;
    }

    assert.equal(notes.filter((m) => m === FORK_HOST_WARNING_MESSAGE).length, 0, "no fork warning on a pi host");
    assert.equal(notes.filter((m) => m === UNSUPPORTED_HOST_MESSAGE).length, 0);
  });

  test("headless declared fork prints the warning to stderr", async () => {
    const { api, handlers } = captureApi();
    createAcpExtension()(api as any);
    const ctx = ompCtx(() => {}, false);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: any[]) => {
      errs.push(a.join(" "));
    };
    process.env.PI_ACP_FORK_HOST = "1";
    try {
      await startSession(handlers, ctx);
    } finally {
      delete process.env.PI_ACP_FORK_HOST;
      console.error = orig;
    }
    assert.ok(errs.includes(FORK_HOST_WARNING_MESSAGE), "stderr carries the fork warning");
  });
});

describe("Fork-host ref-drift attribution (issue #454 / #459)", () => {
  let dir: string;
  let logFile: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "acp-fork-stopgap-"));
    logFile = path.join(dir, "acp.log");
    process.env.ACP_LOG_FILE = logFile;
  });
  after(async () => {
    delete process.env.ACP_LOG_FILE;
    await rm(dir, { recursive: true, force: true });
  });

  const textOf = (out: any) => (typeof out === "string" ? out : out.content?.[0]?.text ?? String(out));

  async function driveUnknownRefCompress(sm: any) {
    // Drive the tool exactly as the host would: the factory wires the real
    // runtime (adapter bound) into the registered tool definitions.
    const { api } = captureApi();
    createAcpExtension()(api as any);
    const tool = (api.tools as any[]).find((t) => t.name === "compress")!;
    const ctx = {
      mode: "rpc",
      hasUI: false,
      cwd: "/tmp",
      ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
      model: { contextWindow: 200_000 },
      sessionManager: sm,
    };
    const out = await tool.execute(
      "call-drift-1",
      { content: [{ startId: "m99998", endId: "m99999", summary: "s" }] },
      undefined,
      undefined,
      ctx,
    );
    return textOf(out);
  }

  test("ref-resolution failure on a declared fork host logs fork-ref-drift-suspected (#459)", async () => {
    process.env.PI_ACP_FORK_HOST = "1";
    try {
      const text = await driveUnknownRefCompress({
        getBranch: () => [],
        getSessionId: () => "drift-session",
        getSessionFile: () => path.join(dir, "drift.json"),
      });
      assert.match(text, /error/i, "kernel ref errors surface to the model");
      const log = await readFile(logFile, "utf8");
      assert.match(log, /event=fork-ref-drift-suspected/, "drift attribution logged");
      assert.match(log, /seeIssue=#459/);
    } finally {
      delete process.env.PI_ACP_FORK_HOST;
    }
  });

  test("same failure on a pi host logs generic errors only (no drift attribution)", async () => {
    const before = (await readFile(logFile, "utf8").catch(() => ""));
    const text = await driveUnknownRefCompress({
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "pi-drift-session",
      getSessionFile: () => path.join(dir, "pi-drift.json"),
    });
    assert.match(text, /error/i);
    const log = (await readFile(logFile, "utf8")).slice(before.length);
    assert.doesNotMatch(log, /fork-ref-drift-suspected/, "no drift attribution outside declared fork hosts");
  });
});
