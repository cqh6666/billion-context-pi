import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  addRule,
  DEFAULT_RULE_LIMITS,
  formatRulesList,
  listRules,
  RULE_TOOL_DESCRIPTION,
  RULE_TOOL_NAME,
} from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { logInfo } from "./log.js";
import { OMP_UNSUPPORTED_MESSAGE } from "./omp.js";

const RuleParams = Type.Object({
  rule: Type.Optional(Type.String({ description: "Short principle-level reminder to record. Omit to list recorded rules." })),
});

type RuleArgs = Static<typeof RuleParams>;

export function makeRuleTool(runtime: AcpRuntime): ToolDefinition<typeof RuleParams> {
  return {
    name: RULE_TOOL_NAME,
    label: "Rule",
    description: RULE_TOOL_DESCRIPTION,
    parameters: RuleParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? OMP_UNSUPPORTED_MESSAGE }] };
      const text = await handleRule(params as RuleArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text }] };
    },
  };
}

async function handleRule(args: RuleArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state } = await runtime.stateFor(ctx);
  const sid = ctx.sessionManager.getSessionId();
  const rule = args.rule?.trim();
  if (!rule) {
    const rules = listRules(state);
    return rules.length === 0 ? "No rules recorded." : formatRulesList(rules);
  }
  const result = addRule(state, rule, DEFAULT_RULE_LIMITS);
  if (!result.ok) return result.error;
  await runtime.save(state, ctx);
  logInfo("rule", { sid, event: "added", id: result.rule.id });
  return `Recorded ${result.rule.id}: ${result.rule.text}`;
}
