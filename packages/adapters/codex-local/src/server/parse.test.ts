import { describe, expect, it } from "vitest";
import { isCodexUnknownSessionError, parseCodexJsonl } from "./parse.js";

describe("parseCodexJsonl", () => {
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: "resume failed",
    });
  });

  it("uses the last agent message as the summary when commentary updates precede the final answer", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the heartbeat procedure" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I’m checking out the issue and reading the docs now." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Fixed the issue and verified the targeted tests pass." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Fixed the issue and verified the targeted tests pass.",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: null,
    });
  });

  it("preserves existing summary extraction when mcp__codex_apps__* item.completed events are present", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_gmail_1" }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "tool_use",
          id: "call_1",
          name: "mcp__codex_apps__gmail_get_profile",
          input: {},
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "tool_use",
          id: "call_1",
          name: "mcp__codex_apps__gmail_get_profile",
          input: {},
          output: { email: "user@example.com" },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Looked up the profile." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 3 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_gmail_1",
      summary: "Looked up the profile.",
      usage: {
        inputTokens: 5,
        cachedInputTokens: 1,
        outputTokens: 3,
      },
      errorMessage: null,
    });
  });

  it("tolerates item.started events for mcp__codex_apps__gmail_search_emails tool_use items without altering the returned shape", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_gmail_2" }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "tool_use",
          id: "call_2",
          name: "mcp__codex_apps__gmail_search_emails",
          input: { query: "invoice" },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Searched emails." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 2 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_gmail_2",
      summary: "Searched emails.",
      usage: {
        inputTokens: 7,
        cachedInputTokens: 0,
        outputTokens: 2,
      },
      errorMessage: null,
    });
  });

  it("tolerates item.started events for mcp__codex_apps__gmail_send_email tool_use items without altering the returned shape", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_gmail_3" }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "tool_use",
          id: "call_3",
          name: "mcp__codex_apps__gmail_send_email",
          input: { to: "test@example.com", subject: "Test", body: "Hi" },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Drafted an email." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_gmail_3",
      summary: "Drafted an email.",
      usage: {
        inputTokens: 9,
        cachedInputTokens: 0,
        outputTokens: 4,
      },
      errorMessage: null,
    });
  });

  it("handles item.started events with missing item fields gracefully (additive-only parser robustness)", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_robust" }),
      JSON.stringify({ type: "item.started" }),
      JSON.stringify({ type: "item.started", item: {} }),
      JSON.stringify({ type: "item.started", item: { type: "tool_use" } }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_robust",
      summary: "Done.",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      },
      errorMessage: null,
    });
  });
});

describe("isCodexUnknownSessionError", () => {
  it("detects the current missing-rollout thread error", () => {
    expect(
      isCodexUnknownSessionError(
        "",
        "Error: thread/resume: thread/resume failed: no rollout found for thread id d448e715-7607-4bcc-91fc-7a3c0c5a9632",
      ),
    ).toBe(true);
  });

  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});
