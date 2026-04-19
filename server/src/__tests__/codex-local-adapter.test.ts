import { describe, expect, it, vi } from "vitest";
import {
  emitConnectorAuditRecord,
  isCodexUnknownSessionError,
  parseCodexJsonl,
} from "@paperclipai/adapter-codex-local/server";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { printCodexStreamEvent } from "@paperclipai/adapter-codex-local/cli";

describe("codex_local parser", () => {
  it("extracts session, summary, usage, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 } }),
      JSON.stringify({ type: "turn.failed", error: { message: "model access denied" } }),
    ].join("\n");

    const parsed = parseCodexJsonl(stdout);
    expect(parsed.sessionId).toBe("thread-123");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(parsed.errorMessage).toBe("model access denied");
  });
});

describe("codex_local stale session detection", () => {
  it("treats missing rollout path as an unknown session error", () => {
    const stderr =
      "2026-02-19T19:58:53.281939Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c775d-967c-7ef1-acc7-e396dc2c87cc";

    expect(isCodexUnknownSessionError("", stderr)).toBe(true);
  });
});

describe("codex_local ui stdout parser", () => {
  it("parses turn and reasoning lifecycle events", () => {
    const ts = "2026-02-20T00:00:00.000Z";

    expect(parseCodexStdoutLine(JSON.stringify({ type: "turn.started" }), ts)).toEqual([
      { kind: "system", ts, text: "turn started" },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "reasoning", text: "**Preparing to use paperclip skill**" },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "thinking", ts, text: "**Preparing to use paperclip skill**" },
    ]);
  });

  it("parses command execution and file changes", () => {
    const ts = "2026-02-20T00:00:00.000Z";

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.started",
          item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "command_execution",
        toolUseId: "item_2",
        input: { id: "item_2", command: "/bin/zsh -lc ls" },
      },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "command_execution",
            command: "/bin/zsh -lc ls",
            aggregated_output: "agents\n",
            exit_code: 0,
            status: "completed",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "item_2",
        content: "command: /bin/zsh -lc ls\nstatus: completed\nexit_code: 0\n\nagents",
        isError: false,
      },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_52",
            type: "file_change",
            changes: [{ path: "/Users/paperclipuser/project/ui/src/pages/AgentDetail.tsx", kind: "update" }],
            status: "completed",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "system",
        ts,
        text: "file changes: update /Users/paperclipuser/project/ui/src/pages/AgentDetail.tsx",
      },
    ]);
  });

  it("parses error items and failed turns", () => {
    const ts = "2026-02-20T00:00:00.000Z";

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "error",
            message: "This session was recorded with model `gpt-5.2-pro` but is resuming with `gpt-5.2-codex`.",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "stderr",
        ts,
        text: "This session was recorded with model `gpt-5.2-pro` but is resuming with `gpt-5.2-codex`.",
      },
    ]);

    expect(
      parseCodexStdoutLine(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "model access denied" },
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "",
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        costUsd: 0,
        subtype: "turn.failed",
        isError: true,
        errors: ["model access denied"],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("codex_local cli formatter", () => {
  it("prints lifecycle, command execution, file change, and error events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printCodexStreamEvent(JSON.stringify({ type: "turn.started" }), false);
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.started",
          item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "command_execution",
            command: "/bin/zsh -lc ls",
            aggregated_output: "agents\n",
            exit_code: 0,
            status: "completed",
          },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_52",
            type: "file_change",
            changes: [{ path: "/home/user/project/ui/src/pages/AgentDetail.tsx", kind: "update" }],
            status: "completed",
          },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "model access denied" },
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
        false,
      );
      printCodexStreamEvent(
        JSON.stringify({
          type: "item.completed",
          item: { type: "error", message: "resume model mismatch" },
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(expect.arrayContaining([
        "turn started",
        "tool_call: command_execution",
        "/bin/zsh -lc ls",
        "tool_result: command_execution command=\"/bin/zsh -lc ls\" status=completed exit_code=0",
        "agents",
        "file_change: update /home/user/project/ui/src/pages/AgentDetail.tsx",
        "turn failed: model access denied",
        "tokens: in=10 out=4 cached=2",
        "error: resume model mismatch",
      ]));
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// GHSA-gqqj-85qm-8qhf (CWE-284, CVSS 8.7 High) — remediation unit tests
// ---------------------------------------------------------------------------
// The following two `describe` blocks lock down Phase 3 (parser tolerance of
// connector-mediated `tool_use` item.started events) and Phase 4 (audit
// helper forensic mirror + logActivity injection) of the security fix. They
// are unit tests — no real database is constructed and no `logActivity`
// service is imported; the helper accepts `logActivity` via dependency
// injection to keep the `@paperclipai/adapter-codex-local` package free of
// a hard dependency on `@paperclipai/server`.
//
// End-to-end gate-and-execute behavior is validated separately in
// `codex-local-execute.test.ts`; integration against a real `activityLog`
// table is covered by `connector-audit-activity.test.ts`.

describe("codex_local parser: surfaces item.started for tool_use (GHSA-gqqj-85qm-8qhf)", () => {
  // The extended parser in `parse.ts` now explicitly acknowledges
  // `item.started` events for `tool_use` items (rather than letting them fall
  // through as unknown) so the runtime connector gate in `execute.ts` can
  // intercept them BEFORE they propagate past the gate. At the post-exit
  // parse layer, the returned shape — `{sessionId, summary, usage,
  // errorMessage}` — is intentionally unaltered; forensic extraction of
  // tool_use data is delegated to the separate stream-time interception in
  // `execute.ts`. These tests lock that contract in place.

  it("continues to extract session and usage when an mcp__codex_apps__ tool_use item.started precedes turn.completed", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-gate-1" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "tu_1",
          type: "tool_use",
          name: "mcp__codex_apps__gmail_send_email",
          input: { to: "x@example.com", subject: "hello", body: "hi" },
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread-gate-1",
      summary: "",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      errorMessage: null,
    });
  });

  it("tolerates multiple mcp__codex_apps__* tool_use item.started events in sequence without surfacing errors", () => {
    // Covers the advisory PoC sequence: get_profile → search_emails →
    // send_email. Regardless of how many connector-mediated tool_use items
    // the stream contains, the parser's returned shape MUST remain the
    // documented quadruple.
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-gate-2" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "tu_a",
          type: "tool_use",
          name: "mcp__codex_apps__gmail_get_profile",
          input: {},
        },
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "tu_b",
          type: "tool_use",
          name: "mcp__codex_apps__gmail_search_emails",
          input: { q: "from:me" },
        },
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "tu_c",
          type: "tool_use",
          name: "mcp__codex_apps__gmail_send_email",
          input: { to: "x@example.com" },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Completed the three-step Gmail flow." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread-gate-2",
      summary: "Completed the three-step Gmail flow.",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      errorMessage: null,
    });
  });

  it("does NOT produce an errorMessage for parseable tool_use items without an input field", () => {
    // Robustness: item.started payloads with missing `input`, missing
    // `item.id`, or a minimal connector tool reference MUST NOT produce a
    // spurious parse-level error. errorMessage stays null unless a
    // turn.failed / turn.error event is observed.
    const stdout = [
      JSON.stringify({
        type: "item.started",
        item: {
          id: "tu_empty",
          type: "tool_use",
          name: "mcp__codex_apps__gmail_get_profile",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      }),
    ].join("\n");

    const parsed = parseCodexJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("codex_local: emitConnectorAuditRecord forensic mirror (GHSA-gqqj-85qm-8qhf Directive 4)", () => {
  // Unit-level contract of the audit helper:
  //   1. Every invocation (allowed / denied / error) emits a single-line
  //      JSON forensic mirror on stderr tagged with `"type":"connector-audit"`.
  //   2. The mirror is UNCONDITIONAL — it fires even when `logActivity`
  //      rejects (e.g., DB unavailable). Operators must always have the
  //      audit trail in the raw run log.
  //   3. When both `db` and `logActivity` are supplied, the helper persists
  //      the record via `logActivity` with `action = "codex.connector.invoked"`
  //      and `entityType = "agent"`.
  //   4. The helper never throws. Any downstream failure (persistence or
  //      onLog) is swallowed so the gate in `execute.ts` remains authoritative.
  //
  // `db` is passed as `null` (NOT `undefined`) to trigger the logActivity
  // persistence path per the implementation's `params.db !== undefined` gate.

  it("emits a structured JSON line to stderr for an allowed read invocation and persists via logActivity", async () => {
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog = vi.fn(async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    });
    const logActivitySpy = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: null,
      logActivity: logActivitySpy,
      runId: "run-allow-read",
      agentId: "agent-allow-read",
      companyId: "company-allow-read",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_search_emails",
      classification: "read",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    // Forensic mirror: exactly one stderr chunk with JSON containing
    // "type":"connector-audit".
    const auditChunks = logs
      .filter((log) => log.stream === "stderr")
      .filter((log) => log.chunk.includes("\"type\":\"connector-audit\""));
    expect(auditChunks).toHaveLength(1);

    // Parse the JSON line and verify structure — all 10 fields per AAP 0.5.1.4.
    const line = auditChunks[0].chunk.trim();
    const parsed = JSON.parse(line) as {
      type: string;
      ts: string;
      agentId: string;
      runId: string;
      connectorSource: string;
      connectorName: string;
      toolName: string;
      classification: string;
      optInState: { allowRead: string[]; allowWrite: string[] };
      outcome: string;
      reason?: string;
    };
    expect(parsed.type).toBe("connector-audit");
    expect(parsed.outcome).toBe("allowed");
    expect(parsed.classification).toBe("read");
    expect(parsed.connectorSource).toBe("openai-curated");
    expect(parsed.connectorName).toBe("gmail");
    expect(parsed.toolName).toBe("mcp__codex_apps__gmail_search_emails");
    expect(parsed.optInState).toEqual({ allowRead: ["gmail"], allowWrite: [] });
    // Allowed records MUST NOT carry a `reason` key (implementation spreads
    // reason only when `outcome !== "allowed"`).
    expect(parsed.reason).toBeUndefined();
    // Timestamp is ISO 8601 (YYYY-MM-DDTHH:MM:SS...).
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(parsed.agentId).toBe("agent-allow-read");
    expect(parsed.runId).toBe("run-allow-read");

    // logActivity was called exactly once with the right action/entity shape.
    expect(logActivitySpy).toHaveBeenCalledTimes(1);
    const [dbArg, input] = logActivitySpy.mock.calls[0] as [
      unknown,
      {
        companyId: string;
        actorType: string;
        actorId: string;
        action: string;
        entityType: string;
        entityId: string;
        agentId: string;
        runId: string;
        details: unknown;
      },
    ];
    expect(dbArg).toBeNull();
    expect(input.action).toBe("codex.connector.invoked");
    expect(input.entityType).toBe("agent");
    expect(input.actorType).toBe("agent");
    expect(input.actorId).toBe("agent-allow-read");
    expect(input.entityId).toBe("agent-allow-read");
    expect(input.agentId).toBe("agent-allow-read");
    expect(input.runId).toBe("run-allow-read");
    expect(input.companyId).toBe("company-allow-read");
  });

  it("emits a denied record with a reason naming the missing allowWrite opt-in", async () => {
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog = vi.fn(async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    });
    const logActivitySpy = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: null,
      logActivity: logActivitySpy,
      runId: "run-deny-write",
      agentId: "agent-deny-write",
      companyId: "company-deny-write",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_send_email",
      classification: "write",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "denied",
      reason: "connector 'gmail' not in inheritedConnectors.allowWrite",
      onLog,
    });

    const auditChunks = logs
      .filter((log) => log.stream === "stderr")
      .filter((log) => log.chunk.includes("\"type\":\"connector-audit\""));
    expect(auditChunks).toHaveLength(1);
    const record = JSON.parse(auditChunks[0].chunk.trim()) as {
      outcome: string;
      classification: string;
      reason?: string;
    };
    expect(record.outcome).toBe("denied");
    expect(record.classification).toBe("write");
    expect(record.reason).toBe("connector 'gmail' not in inheritedConnectors.allowWrite");
    expect(logActivitySpy).toHaveBeenCalledTimes(1);
  });

  it("emits an error record with a reason when the helper is given outcome: error", async () => {
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog = vi.fn(async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    });
    const logActivitySpy = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: null,
      logActivity: logActivitySpy,
      runId: "run-error",
      agentId: "agent-error",
      companyId: "company-error",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_send_email",
      classification: "write",
      optInState: { allowRead: [], allowWrite: [] },
      outcome: "error",
      reason: "unexpected gate failure",
      onLog,
    });

    const auditChunks = logs
      .filter((log) => log.stream === "stderr")
      .filter((log) => log.chunk.includes("\"type\":\"connector-audit\""));
    expect(auditChunks).toHaveLength(1);
    const record = JSON.parse(auditChunks[0].chunk.trim()) as {
      outcome: string;
      reason?: string;
    };
    expect(record.outcome).toBe("error");
    expect(record.reason).toBe("unexpected gate failure");
  });

  it("continues to emit the forensic mirror even when logActivity rejects (DB unavailable)", async () => {
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog = vi.fn(async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    });
    const logActivitySpy = vi.fn().mockRejectedValue(new Error("db down"));

    // MUST NOT throw — the helper's never-throws contract.
    await emitConnectorAuditRecord({
      db: null,
      logActivity: logActivitySpy,
      runId: "run-db-down",
      agentId: "agent-db-down",
      companyId: "company-db-down",
      connectorSource: "paperclip-native",
      connectorName: "acme.linear",
      toolName: "acme.linear:search-issues",
      classification: "read",
      optInState: { allowRead: [], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    // Forensic mirror IS present even though persistence failed.
    const auditChunks = logs
      .filter((log) => log.stream === "stderr")
      .filter((log) => log.chunk.includes("\"type\":\"connector-audit\""));
    expect(auditChunks).toHaveLength(1);

    // Diagnostic stderr line surfaces the persistence failure for operators.
    const errorDiagnostic = logs.find(
      (log) =>
        log.stream === "stderr" &&
        log.chunk.includes("connector-audit persistence error") &&
        log.chunk.includes("db down"),
    );
    expect(errorDiagnostic).toBeDefined();

    // logActivity was still attempted.
    expect(logActivitySpy).toHaveBeenCalledTimes(1);
  });

  it("tags a paperclip-native invocation with connectorSource: 'paperclip-native'", async () => {
    // Per AAP SYSTEM BOUNDARY: paperclip-native connectors are NEVER blocked,
    // but their invocations ARE audited uniformly for complete provenance.
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog = vi.fn(async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    });
    const logActivitySpy = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: null,
      logActivity: logActivitySpy,
      runId: "run-native",
      agentId: "agent-native",
      companyId: "company-native",
      connectorSource: "paperclip-native",
      connectorName: "acme.linear",
      toolName: "acme.linear:search-issues",
      classification: "read",
      optInState: { allowRead: [], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    const auditChunks = logs
      .filter((log) => log.stream === "stderr")
      .filter((log) => log.chunk.includes("\"type\":\"connector-audit\""));
    expect(auditChunks).toHaveLength(1);
    const record = JSON.parse(auditChunks[0].chunk.trim()) as {
      connectorSource: string;
      connectorName: string;
      toolName: string;
      classification: string;
    };
    expect(record.connectorSource).toBe("paperclip-native");
    expect(record.connectorName).toBe("acme.linear");
    expect(record.toolName).toBe("acme.linear:search-issues");
    expect(record.classification).toBe("read");
  });
});

