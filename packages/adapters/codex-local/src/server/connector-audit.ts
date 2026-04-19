/**
 * Connector audit helper for the Codex Local adapter.
 *
 * Addresses GHSA-gqqj-85qm-8qhf (CWE-284, CVSS 8.7 High) — every connector-
 * mediated tool invocation observed by the Codex JSONL stream gate in
 * `./execute.ts` MUST flow through `emitConnectorAuditRecord()` so that:
 *   - a structured ConnectorAuditRecord is forensically logged via `onLog`
 *     (single-line JSON on stderr, grep-friendly);
 *   - when a database handle and `logActivity` injection are available, the
 *     record is persisted to the `activityLog` table with
 *     `action = "codex.connector.invoked"`.
 *
 * Timing discipline per AAP 0.5.1.4 / Directive 4:
 *   - outcome "allowed"  : the caller invokes BEFORE the event propagates
 *                          past the gate (before the connector action fires).
 *   - outcome "denied"   : the caller invokes at denial time (before SIGTERM).
 *   - outcome "error"    : the caller invokes as part of gate error handling.
 *
 * Cross-package boundary: this module does NOT import `logActivity` from the
 * server package. The caller injects `logActivity` via `params.logActivity`
 * so the adapter-codex-local package remains free of a hard dependency on
 * the server package.
 */

import type { AdapterExecutionContext, ConnectorAuditRecord } from "@paperclipai/adapter-utils";

/**
 * Opaque database handle type. The audit helper never inspects this value —
 * it is forwarded verbatim to the injected `logActivity` function. Tests use
 * empty-object sentinels; production code passes the real `Db` instance.
 */
export type ConnectorAuditDb = unknown;

/**
 * Minimal interface matching the `logActivity` contract in
 * `server/src/services/activity-log.ts`. Duplicated here as a structural type
 * so this adapter package does not import from the server package directly.
 *
 * IMPORTANT: this type MUST remain a STRUCTURAL SUBSET of the server's
 * `logActivity(db, input)` signature so the real function can be passed in
 * via dependency injection at the call site.
 */
export type LogActivityFn = (
  db: ConnectorAuditDb,
  input: {
    companyId: string;
    actorType: "agent";
    actorId: string;
    action: "codex.connector.invoked";
    entityType: "agent";
    entityId: string;
    agentId: string;
    runId: string;
    details: ConnectorAuditRecord;
  },
) => Promise<unknown>;

/**
 * Parameters accepted by `emitConnectorAuditRecord`.
 *
 * - `db` and `logActivity` are BOTH optional; when either is missing, the
 *   helper still emits the forensic stderr mirror and returns successfully.
 * - `reason` is included on the emitted record ONLY when `outcome !== "allowed"`.
 *   Allowed records are compact.
 */
export type ConnectorAuditParams = {
  db?: ConnectorAuditDb;
  logActivity?: LogActivityFn;
  runId: string;
  agentId: string;
  companyId: string;
  connectorSource: "openai-curated" | "paperclip-native";
  connectorName: string;
  toolName: string;
  classification: "read" | "write";
  optInState: { allowRead: string[]; allowWrite: string[] };
  outcome: "allowed" | "denied" | "error";
  reason?: string;
  onLog: AdapterExecutionContext["onLog"];
};

/**
 * Emit a single connector-audit record. See module-level doc comment for
 * invariants.
 *
 * Behavior:
 *   1. Constructs a `ConnectorAuditRecord` with an ISO 8601 timestamp and
 *      defensive shallow-copies of the opt-in arrays so later caller mutation
 *      does not retroactively change the logged record.
 *   2. When both `db` and `logActivity` are supplied, persists the record via
 *      the injected `logActivity` with `action = "codex.connector.invoked"`.
 *      Persistence errors are caught and surfaced as a stderr diagnostic
 *      line — they never propagate to the caller.
 *   3. Always mirrors the record as a single-line JSON payload on stderr
 *      (`{"type":"connector-audit", ...}\n`) so operators can grep run logs
 *      post-incident even when the database is unavailable.
 *
 * Never throws. The gate in `execute.ts` is the authoritative source of the
 * allow/deny decision; audit emission failures MUST NOT undermine that
 * decision.
 */
export async function emitConnectorAuditRecord(
  params: ConnectorAuditParams,
): Promise<void> {
  // 1. Construct the structured record. `reason` is spread conditionally so
  //    that allowed records do not carry a spurious `reason` key, and empty-
  //    string reasons are treated as absent.
  const record: ConnectorAuditRecord = {
    ts: new Date().toISOString(),
    agentId: params.agentId,
    runId: params.runId,
    connectorSource: params.connectorSource,
    connectorName: params.connectorName,
    toolName: params.toolName,
    classification: params.classification,
    optInState: {
      allowRead: Array.isArray(params.optInState?.allowRead)
        ? [...params.optInState.allowRead]
        : [],
      allowWrite: Array.isArray(params.optInState?.allowWrite)
        ? [...params.optInState.allowWrite]
        : [],
    },
    outcome: params.outcome,
    ...(params.outcome !== "allowed" &&
    typeof params.reason === "string" &&
    params.reason.length > 0
      ? { reason: params.reason }
      : {}),
  };

  // 2. Best-effort persistence to the activityLog via injected `logActivity`.
  //    Only attempted when BOTH `db` and `logActivity` are present. On
  //    failure, emit a diagnostic stderr line but DO NOT throw — the gate's
  //    allow/deny decision remains authoritative regardless of persistence
  //    success.
  if (params.db !== undefined && typeof params.logActivity === "function") {
    try {
      await params.logActivity(params.db, {
        companyId: params.companyId,
        actorType: "agent",
        actorId: params.agentId,
        action: "codex.connector.invoked",
        entityType: "agent",
        entityId: params.agentId,
        agentId: params.agentId,
        runId: params.runId,
        details: record,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await params.onLog(
          "stderr",
          `[paperclip] connector-audit persistence error: ${message}\n`,
        );
      } catch {
        // onLog itself failed — nothing more we can do; swallow to avoid
        // surfacing an error from the audit helper into the gate.
      }
    }
  }

  // 3. Forensic replay mirror — emitted unconditionally (single-line JSON,
  //    newline-terminated) so operators can grep run logs post-incident.
  try {
    const mirrorPayload = JSON.stringify({ type: "connector-audit", ...record });
    await params.onLog("stderr", `${mirrorPayload}\n`);
  } catch {
    // onLog failure is swallowed to preserve the helper's never-throws
    // contract. The gate in execute.ts still makes the authoritative
    // allow/deny decision.
  }
}
