import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "item.started") {
      // GHSA-gqqj-85qm-8qhf: item.started events are observed at stream time by
      // the runtime connector gate in execute.ts for early denial of inherited
      // tool_use invocations. At this post-exit parse layer, we explicitly
      // acknowledge the event type so it does not fall through silently. Any
      // forensic extraction of tool_use data is performed via the separately
      // exported extractToolUseEvents(stdout) helper.
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    errorMessage,
  };
}

/**
 * GHSA-gqqj-85qm-8qhf — a single tool_use event surfaced from a Codex JSONL
 * stream. `phase` distinguishes the invocation's lifecycle stage so that
 * consumers (forensic replay, test assertions, audit inspection) can
 * correlate the earliest observable signal of an inherited tool call
 * (`started`) with its eventual `completed` event.
 *
 * This is a LOCAL type to parse.ts and intentionally not re-exported via the
 * adapter barrel — the runtime connector gate in execute.ts uses an INLINE
 * classifier over streaming stdout chunks (so it can SIGTERM the child
 * before the side effect fires) and does not depend on this type.
 */
export type ToolUseEvent = {
  phase: "started" | "completed";
  name: string;
  input: unknown;
  toolUseId: string | null;
};

/**
 * GHSA-gqqj-85qm-8qhf — extract tool_use events from a Codex JSONL stream.
 *
 * Surfaces both `item.started` and `item.completed` events whose inner item
 * has type "tool_use". Used for forensic replay and for test assertions that
 * validate the runtime connector gate in execute.ts.
 *
 * NOTE: The primary runtime gate operates INLINE on streaming stdout chunks
 * in execute.ts (so it can SIGTERM the child before the side effect fires).
 * This post-exit helper is NOT the authoritative enforcement point.
 *
 * Malformed or non-tool_use lines are skipped silently via the same
 * null-guards used by parseCodexJsonl, so this function is safe to call on
 * arbitrary stdout content (including interleaved non-JSON log lines).
 */
export function extractToolUseEvents(stdout: string): ToolUseEvent[] {
  const out: ToolUseEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    let phase: "started" | "completed" | null = null;
    if (type === "item.started") phase = "started";
    else if (type === "item.completed") phase = "completed";
    if (!phase) continue;

    const item = parseObject(event.item);
    if (asString(item.type, "") !== "tool_use") continue;

    const name = asString(item.name, "");
    if (!name) continue;

    const input = item.input;
    const toolUseId = asString(item.id, "") || null;
    out.push({ phase, name, input, toolUseId });
  }
  return out;
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}
