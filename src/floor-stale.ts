// pi's getContextUsage() anchors on the last assistant message with valid
// provider usage. A successful compress lands AFTER that anchor, so the
// floor must be skipped for the next LLM call (mirrors pi's own
// "usage source must be post-compaction" compaction check).
import { isCompressSuccessText } from "./compress-tool.js";
import { extractText } from "./messages.js";

type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null | undefined;

type AnchorEntry = {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: UsageLike;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: unknown;
  };
};

function validAnchorUsage(u: UsageLike): boolean {
  if (!u) return false;
  const total = (u.totalTokens ?? 0) || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return total > 0;
}

/** True when the last valid assistant usage anchor comes strictly BEFORE the
 *  last successful compress toolResult — the host's provider-usage number
 *  still reflects the pre-compression request. Failed/no-op compresses don't
 *  count (nothing was reclaimed). */
export function usageAnchorPredatesCompression(entries: AnchorEntry[]): boolean {
  let lastUsageIdx = -1;
  let lastCompressIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const m = entries[i]!.message;
    if (!m) continue;
    if (m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error" && validAnchorUsage(m.usage)) {
      lastUsageIdx = i;
    } else if (
      m.role === "toolResult" &&
      m.toolName === "compress" &&
      m.toolCallId !== undefined &&
      m.isError !== true &&
      isCompressSuccessText(extractText(m.content))
    ) {
      lastCompressIdx = i;
    }
  }
  return lastCompressIdx > lastUsageIdx;
}
