// connector-audit.test.ts — Layer 2 forensic-audit regression suite for
// GHSA-gqqj-85qm-8qhf (CWE-284, CVSS 8.7 High).
//
// This file locks down the nine behaviour contracts of
// `emitConnectorAuditRecord` from `./connector-audit.ts`, which is the
// helper the runtime JSONL gate in `./execute.ts` calls for every
// connector-mediated tool invocation observed during a codex_local run
// (AAP Directive 4 / Root Cause 3 — missing-audit vector):
//
//   1. Allowed read invocations produce a fully-populated
//      ConnectorAuditRecord, persist it via the injected `logActivity`
//      (with action = "codex.connector.invoked"), and emit a single-line
//      JSON "forensic mirror" on stderr via `onLog`.
//   2. Denied write invocations include the human-readable `reason` that
//      names the missing opt-in plus the "write" classification.
//   3. When `db` is omitted, persistence is skipped but the forensic
//      mirror is still emitted.
//   4. When `logActivity` is omitted, persistence is skipped but the
//      forensic mirror is still emitted.
//   5. When `logActivity` rejects, the helper catches the error, emits a
//      diagnostic stderr line, still emits the forensic mirror, and
//      RESOLVES (never throws) — preserving the gate's authoritative
//      allow/deny decision in execute.ts.
//   6. The forensic mirror is a single-line JSON payload terminated by
//      exactly one `\n` (grep-friendly; no embedded newlines).
//   7. Paperclip-native source invocations are audited with the
//      `"paperclip-native"` source tag (SYSTEM BOUNDARY: helper never
//      blocks paperclip-native, only audits).
//   8. `outcome: "error"` records carry the supplied `reason`.
//   9. The `ts` field is a valid ISO 8601 timestamp in the wall-clock
//      window of the call.
//
// All tests are pure unit tests: no filesystem, no network, no real
// database. The `db` parameter is an opaque sentinel (`{}` or
// `{ __marker: "fake-db" }`) that the helper never inspects; it is
// forwarded verbatim to the injected `logActivity` spy.

import { describe, expect, it, vi } from "vitest";

import { emitConnectorAuditRecord } from "./connector-audit.js";

describe("emitConnectorAuditRecord (GHSA-gqqj-85qm-8qhf)", () => {
  it("emits forensic mirror JSON and calls logActivity for an allowed read invocation", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const db = { __marker: "fake-db" };

    await emitConnectorAuditRecord({
      db,
      logActivity,
      runId: "run-allow-read",
      agentId: "agent-1",
      companyId: "company-1",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_get_profile",
      classification: "read",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    // 1. logActivity was invoked exactly once, with the fake db and the
    //    correct activity-log envelope.
    expect(logActivity).toHaveBeenCalledTimes(1);
    const [dbArg, input] = logActivity.mock.calls[0];
    expect(dbArg).toBe(db);
    expect(input.companyId).toBe("company-1");
    expect(input.actorType).toBe("agent");
    expect(input.actorId).toBe("agent-1");
    expect(input.action).toBe("codex.connector.invoked");
    expect(input.entityType).toBe("agent");
    expect(input.entityId).toBe("agent-1");
    expect(input.agentId).toBe("agent-1");
    expect(input.runId).toBe("run-allow-read");

    // 2. The details object matches the ConnectorAuditRecord shape.
    const record = input.details as Record<string, unknown>;
    expect(typeof record.ts).toBe("string");
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(record.agentId).toBe("agent-1");
    expect(record.runId).toBe("run-allow-read");
    expect(record.connectorSource).toBe("openai-curated");
    expect(record.connectorName).toBe("gmail");
    expect(record.toolName).toBe("mcp__codex_apps__gmail_get_profile");
    expect(record.classification).toBe("read");
    expect(record.outcome).toBe("allowed");
    expect(record.optInState).toEqual({ allowRead: ["gmail"], allowWrite: [] });

    // 3. `reason` MUST NOT be present on allowed outcomes — allowed
    //    records are compact and carrying a spurious reason would be a
    //    confusing operational signal.
    expect(record.reason).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(record, "reason")).toBe(false);

    // 4. Forensic mirror was emitted via onLog("stderr", ...).
    const stderrCalls = onLog.mock.calls.filter(
      ([stream]) => stream === "stderr",
    );
    expect(stderrCalls.length).toBeGreaterThanOrEqual(1);
    const forensicCall = stderrCalls.find(
      ([, chunk]) =>
        typeof chunk === "string" && chunk.includes('"type":"connector-audit"'),
    );
    expect(forensicCall).toBeDefined();
  });

  it("includes reason and write classification in the audit record for a denied write invocation", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: {},
      logActivity,
      runId: "run-deny-write",
      agentId: "agent-2",
      companyId: "company-2",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_send_email",
      classification: "write",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "denied",
      reason: "connector 'gmail' not in inheritedConnectors.allowWrite",
      onLog,
    });

    expect(logActivity).toHaveBeenCalledTimes(1);
    const [, input] = logActivity.mock.calls[0];
    const record = input.details as Record<string, unknown>;
    expect(record.outcome).toBe("denied");
    expect(record.classification).toBe("write");
    expect(record.reason).toBe(
      "connector 'gmail' not in inheritedConnectors.allowWrite",
    );
  });

  it("emits only the forensic mirror when db is not provided (logActivity skipped)", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      // `db` deliberately omitted — persistence MUST be skipped.
      logActivity,
      runId: "run-no-db",
      agentId: "agent-3",
      companyId: "company-3",
      connectorSource: "paperclip-native",
      connectorName: "acme.linear",
      toolName: "acme.linear:search-issues",
      classification: "read",
      optInState: { allowRead: [], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    // logActivity MUST NOT be called when db is absent — the injected
    // function requires a db argument per its structural contract.
    expect(logActivity).not.toHaveBeenCalled();

    // Forensic mirror MUST still be emitted so operators always have a
    // post-incident trail, even on hosts without a database handle.
    const stderrCalls = onLog.mock.calls.filter(
      ([stream]) => stream === "stderr",
    );
    const forensicCall = stderrCalls.find(
      ([, chunk]) =>
        typeof chunk === "string" && chunk.includes('"type":"connector-audit"'),
    );
    expect(forensicCall).toBeDefined();
    const message = String(forensicCall![1]);
    expect(message).toContain('"connectorSource":"paperclip-native"');
    expect(message).toContain('"toolName":"acme.linear:search-issues"');
  });

  it("emits only the forensic mirror when logActivity is not provided", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: { __marker: "fake-db" },
      // `logActivity` deliberately omitted — helper must not throw
      // reaching for a non-existent persistence dependency.
      runId: "run-no-logactivity",
      agentId: "agent-4",
      companyId: "company-4",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_get_profile",
      classification: "read",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    // onLog received the forensic mirror; the call succeeded without
    // throwing. Test validates the helper's "never-throws" contract when
    // the caller wires it without a logActivity dependency.
    const stderrCalls = onLog.mock.calls.filter(
      ([stream]) => stream === "stderr",
    );
    const forensicCall = stderrCalls.find(
      ([, chunk]) =>
        typeof chunk === "string" && chunk.includes('"type":"connector-audit"'),
    );
    expect(forensicCall).toBeDefined();
  });

  it("catches logActivity rejections, continues, and still emits the forensic mirror", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi
      .fn()
      .mockRejectedValue(new Error("db connection lost"));

    // The helper MUST resolve (not throw), even when logActivity
    // rejects — the gate in execute.ts is authoritative for allow/deny
    // decisions, so audit persistence failures MUST NOT crash the gate.
    await expect(
      emitConnectorAuditRecord({
        db: {},
        logActivity,
        runId: "run-db-error",
        agentId: "agent-5",
        companyId: "company-5",
        connectorSource: "openai-curated",
        connectorName: "gmail",
        toolName: "mcp__codex_apps__gmail_get_profile",
        classification: "read",
        optInState: { allowRead: ["gmail"], allowWrite: [] },
        outcome: "allowed",
        onLog,
      }),
    ).resolves.toBeUndefined();

    // An error-diagnostic line was emitted to stderr AND the forensic
    // mirror was ALSO emitted — persistence failure must never suppress
    // the forensic trail.
    const stderrChunks = onLog.mock.calls
      .filter(([stream]) => stream === "stderr")
      .map(([, chunk]) => String(chunk));
    const joined = stderrChunks.join("");
    expect(joined).toMatch(/connector-audit persistence error/i);
    expect(joined).toContain("db connection lost");
    expect(joined).toContain('"type":"connector-audit"');
  });

  it("emits the forensic mirror as a single line terminated by exactly one newline", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      runId: "run-single-line",
      agentId: "agent-6",
      companyId: "company-6",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_get_profile",
      classification: "read",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    const stderrChunks = onLog.mock.calls
      .filter(([stream]) => stream === "stderr")
      .map(([, chunk]) => String(chunk));
    const forensic = stderrChunks.find((c) =>
      c.includes('"type":"connector-audit"'),
    );
    expect(forensic).toBeDefined();
    const line = forensic!;

    // Terminates with exactly one trailing newline — downstream log
    // aggregators (journald, stackdriver, CloudWatch) reliably split on
    // `\n` boundaries, so the record is always the last line's payload.
    expect(line.endsWith("\n")).toBe(true);

    // No internal newlines — single-line JSON for grep-ability. SREs
    // can `grep '"type":"connector-audit"' run.log` and get one match
    // per record.
    expect(line.slice(0, -1).includes("\n")).toBe(false);

    // Payload (after stripping the trailing newline) parses as JSON.
    const parsed = JSON.parse(line.slice(0, -1));
    expect(parsed.type).toBe("connector-audit");
    expect(parsed.toolName).toBe("mcp__codex_apps__gmail_get_profile");
    expect(parsed.classification).toBe("read");
    expect(parsed.outcome).toBe("allowed");
  });

  it("correctly records paperclip-native connector invocations as allowed with the source tag", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    // SYSTEM BOUNDARY: the helper MUST NOT block paperclip-native
    // connector invocations — it only audits them so operators have
    // a provenance trail. Blocking is reserved for the runtime gate
    // in execute.ts which only acts on `mcp__codex_apps__*` tools.
    await emitConnectorAuditRecord({
      db: {},
      logActivity,
      runId: "run-paperclip-native",
      agentId: "agent-7",
      companyId: "company-7",
      connectorSource: "paperclip-native",
      connectorName: "acme.linear",
      toolName: "acme.linear:search-issues",
      classification: "read",
      optInState: { allowRead: [], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });

    const [, input] = logActivity.mock.calls[0];
    const record = input.details as Record<string, unknown>;
    expect(record.connectorSource).toBe("paperclip-native");
    expect(record.connectorName).toBe("acme.linear");
    expect(record.toolName).toBe("acme.linear:search-issues");
    expect(record.outcome).toBe("allowed");
  });

  it("records outcome 'error' with a reason for exceptional gate failures", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    await emitConnectorAuditRecord({
      db: {},
      logActivity,
      runId: "run-error",
      agentId: "agent-8",
      companyId: "company-8",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_get_profile",
      classification: "read",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "error",
      reason: "gate helper threw unexpected classification error",
      onLog,
    });

    const [, input] = logActivity.mock.calls[0];
    const record = input.details as Record<string, unknown>;
    expect(record.outcome).toBe("error");
    expect(record.reason).toBe(
      "gate helper threw unexpected classification error",
    );
  });

  it("stamps the record with a valid ISO 8601 timestamp", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);

    // Timing-robust: capture wall-clock bounds on either side of the
    // call and assert the stamped `ts` falls within the window. No
    // mocking of Date or system clock is required or permitted.
    const beforeMs = Date.now();
    await emitConnectorAuditRecord({
      db: {},
      logActivity,
      runId: "run-ts",
      agentId: "agent-9",
      companyId: "company-9",
      connectorSource: "openai-curated",
      connectorName: "gmail",
      toolName: "mcp__codex_apps__gmail_get_profile",
      classification: "read",
      optInState: { allowRead: ["gmail"], allowWrite: [] },
      outcome: "allowed",
      onLog,
    });
    const afterMs = Date.now();

    const [, input] = logActivity.mock.calls[0];
    const record = input.details as Record<string, unknown>;
    const ts = String(record.ts);

    // ISO 8601 with millisecond precision and trailing Z (UTC) — this
    // is the exact format produced by `Date.prototype.toISOString()`.
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const parsedMs = new Date(ts).getTime();
    expect(Number.isFinite(parsedMs)).toBe(true);
    expect(parsedMs).toBeGreaterThanOrEqual(beforeMs);
    expect(parsedMs).toBeLessThanOrEqual(afterMs);
  });
});
