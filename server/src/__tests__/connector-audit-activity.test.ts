// connector-audit-activity.test.ts — Integration regression test for
// GHSA-gqqj-85qm-8qhf (CWE-284, CVSS 8.7 High).
//
// This file verifies the FULL end-to-end persistence path of Directive 4:
//
//   emitConnectorAuditRecord (adapter-codex-local)
//     -> logActivity          (real server-side service)
//       -> activityLog table  (real embedded Postgres via Drizzle)
//
// The sibling unit tests in
// `packages/adapters/codex-local/src/server/connector-audit.test.ts` cover
// the helper's pure-function invariants (stderr mirror shape, conditional
// `reason`, ISO-8601 timestamp, never-throws guarantee) but do NOT exercise
// the cross-package persistence wiring. THIS file is the ONLY integration
// test that proves rows actually land in `activity_log` with
// action="codex.connector.invoked" when the helper is wired to the real
// server-side `logActivity` service.
//
// Critical invariant from the advisory: "No connector-mediated action may
// bypass this emission path." The tests below pin:
//   Test A — allowed read audit record is persisted with correct envelope
//            and ConnectorAuditRecord details JSONB, and reason is ABSENT.
//   Test B — denied write audit record is persisted with the reason field
//            surfacing the missing opt-in.
//   Test C — SYSTEM BOUNDARY: when logActivity rejects (simulated DB
//            failure), the helper RESOLVES without throwing AND the
//            forensic stderr mirror is still emitted. Audit MUST NOT be
//            lost even when persistence fails.
//   Test D — the full fidelity of classification (read/write) and
//            connectorSource (openai-curated/paperclip-native) round-trips
//            through `details` across three invocations.
//   Test E — no-db path: when db/logActivity are omitted (runtime-gate
//            short-circuit), only the forensic mirror is emitted and no
//            row is persisted.
//   Test F — outcome="error" records are persisted with reason and
//            classification intact.
//
// All tests use the canonical embedded-postgres harness, are independently
// seeded, and clean up in FK-correct order (activityLog first).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";

import { emitConnectorAuditRecord } from "@paperclipai/adapter-codex-local/server";

import { logActivity } from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// ---------------------------------------------------------------------------
// Embedded-postgres test-harness scaffolding.
//
// Follows the canonical pattern established by the sibling
// activity-service.test.ts: probe for host support at module load, then
// select `describe` or `describe.skip` so the whole suite self-skips on
// hosts that cannot start embedded-postgres (CI/ARM64/musl/root-user).
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres connector-audit activity tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "emitConnectorAuditRecord + logActivity integration (GHSA-gqqj-85qm-8qhf)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
      null;

    beforeAll(async () => {
      // UNIQUE prefix per AAP: ensures no collision with other test-file
      // Postgres instances run in parallel (e.g. activity-service.test.ts uses
      // "paperclip-activity-service-").
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-connector-audit-activity-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      // FK-correct deletion order so referential-integrity constraints do
      // not reject the cleanup:
      //   activityLog(agentId, runId) references heartbeatRuns & agents
      //   heartbeatRuns(companyId, agentId) references companies & agents
      //   agents(companyId) references companies
      //
      // Delete children before parents:
      //   activityLog -> heartbeatRuns -> agents -> companies
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    // -----------------------------------------------------------------------
    // Per-test seeding helper.
    //
    // activityLog has two nullable FKs that our audit records always
    // populate:
    //   - agentId   -> agents.id
    //   - runId     -> heartbeatRuns.id   (parent requires companyId+agentId)
    //
    // Each test gets a fresh {companyId, agentId, runId} triplet so that
    // `WHERE companyId = ?` queries are strictly scoped to the test at hand,
    // making row-count assertions deterministic regardless of ordering.
    //
    // `issuePrefix` is derived from the first 6 hex chars of the company UUID
    // (uppercased, prefixed with "T") because it has a UNIQUE constraint and
    // deterministic UUID-derived prefixes avoid collisions between parallel
    // tests while remaining reproducible within a single test.
    // -----------------------------------------------------------------------
    async function seedCompanyAgentRun(): Promise<{
      companyId: string;
      agentId: string;
      runId: string;
    }> {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      // heartbeatRuns only requires {id, companyId, agentId}; other columns
      // (invocationSource, status, contextSnapshot, usageJson, resultJson,
      // timestamps) default appropriately.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
      });

      return { companyId, agentId, runId };
    }

    // =======================================================================
    // Test A — Allowed read audit record persists via real logActivity.
    //
    // Verifies the primary Directive-4 success path: the helper, when wired
    // to the real server-side logActivity service and a real embedded Postgres
    // database, produces exactly one row in `activity_log` with:
    //   - action = "codex.connector.invoked"
    //   - actorType/entityType = "agent"
    //   - actorId/entityId/agentId = the agent UUID
    //   - runId = the heartbeatRuns UUID
    //   - details = the full ConnectorAuditRecord JSONB
    //
    // Additionally verifies that `reason` is ABSENT from details on allowed
    // records (conditional spread in the helper) and that the forensic
    // stderr mirror is emitted exactly once with the magic string
    // `"type":"connector-audit"`.
    // =======================================================================
    it(
      "persists allowed read audit record via logActivity with action codex.connector.invoked",
      async () => {
        const { companyId, agentId, runId } = await seedCompanyAgentRun();
        const onLog = vi.fn();

        await emitConnectorAuditRecord({
          db,
          logActivity,
          runId,
          agentId,
          companyId,
          connectorSource: "openai-curated",
          connectorName: "gmail",
          toolName: "mcp__codex_apps__gmail_search_emails",
          classification: "read",
          optInState: { allowRead: ["gmail"], allowWrite: [] },
          outcome: "allowed",
          onLog,
        });

        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId));

        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.action).toBe("codex.connector.invoked");
        expect(row.actorType).toBe("agent");
        expect(row.actorId).toBe(agentId);
        expect(row.entityType).toBe("agent");
        expect(row.entityId).toBe(agentId);
        expect(row.agentId).toBe(agentId);
        expect(row.runId).toBe(runId);

        const details = row.details as Record<string, unknown>;
        expect(details.connectorSource).toBe("openai-curated");
        expect(details.connectorName).toBe("gmail");
        expect(details.toolName).toBe("mcp__codex_apps__gmail_search_emails");
        expect(details.classification).toBe("read");
        expect(details.outcome).toBe("allowed");
        expect(details.optInState).toEqual({
          allowRead: ["gmail"],
          allowWrite: [],
        });
        // `reason` MUST be absent on allowed outcomes — the helper spreads
        // `reason` conditionally so operational dashboards do not have to
        // distinguish between "missing" and "empty" reasons on the happy
        // path.
        expect(Object.hasOwn(details, "reason")).toBe(false);
        // `ts` is an ISO-8601 UTC timestamp with optional millisecond
        // fraction and trailing Z. Matches toISOString() output.
        expect(typeof details.ts).toBe("string");
        expect(details.ts).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/,
        );

        // Forensic stderr mirror was emitted exactly once (no more, no
        // less) so grepping run logs post-incident produces one hit per
        // invocation.
        const stderrCalls = onLog.mock.calls.filter(
          (c) => c[0] === "stderr" && typeof c[1] === "string",
        );
        expect(
          stderrCalls.some((c) =>
            (c[1] as string).includes('"type":"connector-audit"'),
          ),
        ).toBe(true);
        expect(
          stderrCalls.filter((c) =>
            (c[1] as string).includes('"type":"connector-audit"'),
          ),
        ).toHaveLength(1);
      },
      30_000,
    );

    // =======================================================================
    // Test B — Denied write audit record persists with reason intact.
    //
    // Verifies the denial path: a gmail_send_email invocation with write
    // opt-in absent produces an audit row with outcome="denied",
    // classification="write", and a reason string naming the missing
    // `inheritedConnectors.allowWrite` entry so operators can triage the
    // denial without reconstructing state.
    // =======================================================================
    it(
      "persists denied write audit record via logActivity with denial reason in details",
      async () => {
        const { companyId, agentId, runId } = await seedCompanyAgentRun();
        const onLog = vi.fn();

        await emitConnectorAuditRecord({
          db,
          logActivity,
          runId,
          agentId,
          companyId,
          connectorSource: "openai-curated",
          connectorName: "gmail",
          toolName: "mcp__codex_apps__gmail_send_email",
          classification: "write",
          optInState: { allowRead: ["gmail"], allowWrite: [] },
          outcome: "denied",
          reason: "connector 'gmail' not in inheritedConnectors.allowWrite",
          onLog,
        });

        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId));

        expect(rows).toHaveLength(1);
        const details = rows[0]!.details as Record<string, unknown>;
        expect(details.outcome).toBe("denied");
        expect(details.classification).toBe("write");
        expect(details.reason).toBe(
          "connector 'gmail' not in inheritedConnectors.allowWrite",
        );
        expect(details.connectorName).toBe("gmail");
        expect(details.toolName).toBe("mcp__codex_apps__gmail_send_email");
      },
      30_000,
    );

    // =======================================================================
    // Test C — SYSTEM BOUNDARY: audit MUST NOT be lost when DB persistence
    //          fails.
    //
    // This pins the invariant that the forensic stderr mirror is the
    // LAST-RESORT audit surface: it is emitted unconditionally, including
    // on the failure path where `logActivity` rejects (simulated DB
    // outage, schema drift, or constraint violation).
    //
    // The test injects a deliberately-throwing stub for logActivity so the
    // real server-side service is NOT exercised (bypassing the sanitized
    // insert into activity_log). It then asserts:
    //   1. emitConnectorAuditRecord RESOLVES (does not propagate the throw).
    //   2. The stub was called exactly once (the helper did attempt
    //      persistence before failing gracefully).
    //   3. The forensic mirror is still present in onLog's stderr stream.
    //   4. No row landed in activity_log (the stub short-circuited
    //      persistence, so there is nothing to clean up beyond seeded
    //      parents — verifying the failure was NOT quietly retried via a
    //      side channel).
    // =======================================================================
    it(
      "forensic stderr mirror is emitted even when logActivity rejects (SYSTEM BOUNDARY: audit MUST NOT be lost)",
      async () => {
        const { companyId, agentId, runId } = await seedCompanyAgentRun();
        const onLog = vi.fn();

        const throwingLogActivity = vi
          .fn()
          .mockRejectedValue(new Error("simulated DB failure"));

        await expect(
          emitConnectorAuditRecord({
            db,
            // Cast: the stub has the same call signature as the real
            // logActivity; Vitest's vi.fn() is structurally compatible but
            // TypeScript cannot infer the narrowed type from a generic
            // spy.
            logActivity: throwingLogActivity as unknown as typeof logActivity,
            runId,
            agentId,
            companyId,
            connectorSource: "openai-curated",
            connectorName: "gmail",
            toolName: "mcp__codex_apps__gmail_get_profile",
            classification: "read",
            optInState: { allowRead: ["gmail"], allowWrite: [] },
            outcome: "allowed",
            onLog,
          }),
        ).resolves.toBeUndefined();

        // logActivity was attempted exactly once, even though it threw.
        expect(throwingLogActivity).toHaveBeenCalledTimes(1);

        // The forensic mirror line is present in onLog — this is the
        // SYSTEM-BOUNDARY invariant: audit MUST NOT be lost.
        const stderrCalls = onLog.mock.calls.filter(
          (c) => c[0] === "stderr" && typeof c[1] === "string",
        );
        const mirrorLines = stderrCalls.filter((c) =>
          (c[1] as string).includes('"type":"connector-audit"'),
        );
        expect(mirrorLines).toHaveLength(1);
        // Single-line JSON terminated by \n — grep-friendly run log.
        expect(mirrorLines[0]![1] as string).toMatch(/\n$/);

        // No row landed in activity_log (the stub did not actually invoke
        // the real persistence path).
        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId));
        expect(rows).toHaveLength(0);
      },
      30_000,
    );

    // =======================================================================
    // Test D — Classification and connectorSource fidelity across three
    //          invocations.
    //
    // Mirrors the advisory's Directive-4 validation example:
    //   "Invoke one allowed read, one denied write, and one invocation
    //    against a non-inherited connector; assert exactly three audit
    //    records are produced with correct classification and outcome
    //    fields."
    //
    // This test invokes three audit emissions on the SAME company/agent/run
    // (because the per-invocation envelope distinguishes them via toolName
    // and connectorSource — no new seeding required per invocation):
    //   1. openai-curated + gmail + read  (gmail_list_messages)
    //   2. openai-curated + gmail + write (gmail_send_email, allowed)
    //   3. paperclip-native + acme.linear + read (acme.linear:search-issues)
    //
    // Then verifies that each row round-trips classification and
    // connectorSource correctly, proving the JSONB details column preserves
    // the record faithfully across persistence.
    // =======================================================================
    it(
      "preserves classification (read/write) and connectorSource (openai-curated/paperclip-native) in details across three invocations",
      async () => {
        const { companyId, agentId, runId } = await seedCompanyAgentRun();
        const onLog = vi.fn();

        await emitConnectorAuditRecord({
          db,
          logActivity,
          runId,
          agentId,
          companyId,
          connectorSource: "openai-curated",
          connectorName: "gmail",
          toolName: "mcp__codex_apps__gmail_list_messages",
          classification: "read",
          optInState: { allowRead: ["gmail"], allowWrite: [] },
          outcome: "allowed",
          onLog,
        });

        await emitConnectorAuditRecord({
          db,
          logActivity,
          runId,
          agentId,
          companyId,
          connectorSource: "openai-curated",
          connectorName: "gmail",
          toolName: "mcp__codex_apps__gmail_send_email",
          classification: "write",
          optInState: { allowRead: ["gmail"], allowWrite: ["gmail"] },
          outcome: "allowed",
          onLog,
        });

        await emitConnectorAuditRecord({
          db,
          logActivity,
          runId,
          agentId,
          companyId,
          connectorSource: "paperclip-native",
          connectorName: "acme.linear",
          toolName: "acme.linear:search-issues",
          classification: "read",
          optInState: { allowRead: [], allowWrite: [] },
          outcome: "allowed",
          onLog,
        });

        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId));

        expect(rows).toHaveLength(3);
        // Envelope is consistent across all three records.
        for (const row of rows) {
          expect(row.action).toBe("codex.connector.invoked");
          expect(row.actorType).toBe("agent");
          expect(row.entityType).toBe("agent");
        }

        // Index by toolName so the assertions are independent of insert
        // order (Postgres does not guarantee ordering without an ORDER BY
        // clause, and an unstable assertion order would produce flaky
        // tests).
        const byTool = new Map(
          rows.map((r) => {
            const d = r.details as Record<string, unknown>;
            return [d.toolName as string, d];
          }),
        );

        const readGmail = byTool.get("mcp__codex_apps__gmail_list_messages")!;
        expect(readGmail.classification).toBe("read");
        expect(readGmail.connectorSource).toBe("openai-curated");
        expect(readGmail.connectorName).toBe("gmail");

        const writeGmail = byTool.get("mcp__codex_apps__gmail_send_email")!;
        expect(writeGmail.classification).toBe("write");
        expect(writeGmail.connectorSource).toBe("openai-curated");
        expect(writeGmail.connectorName).toBe("gmail");

        const paperclipNative = byTool.get("acme.linear:search-issues")!;
        expect(paperclipNative.classification).toBe("read");
        expect(paperclipNative.connectorSource).toBe("paperclip-native");
        expect(paperclipNative.connectorName).toBe("acme.linear");

        // Exactly three forensic mirror lines — one per invocation.
        const stderrCalls = onLog.mock.calls.filter(
          (c) => c[0] === "stderr" && typeof c[1] === "string",
        );
        const mirrorLines = stderrCalls.filter((c) =>
          (c[1] as string).includes('"type":"connector-audit"'),
        );
        expect(mirrorLines).toHaveLength(3);
      },
      30_000,
    );

    // =======================================================================
    // Test E — No-db path: forensic mirror only (no persistence).
    //
    // Exercises the runtime-gate short-circuit in execute.ts where
    // emitConnectorAuditRecord is called WITHOUT injecting db/logActivity
    // (e.g., in a host environment that lacks a database handle, or during
    // the gate's initial bootstrap).
    //
    // Invariants verified:
    //   1. No row is persisted to activity_log (db was not provided, so
    //      the persistence branch in the helper is skipped).
    //   2. The forensic mirror is still emitted (the helper's
    //      unconditional stderr replay path).
    //   3. For denied outcomes, the `reason` field is present in the
    //      mirror payload so operators investigating the run log still
    //      see why the gate denied the invocation.
    // =======================================================================
    it(
      "no-db path: emits forensic mirror but does NOT persist when db/logActivity are omitted",
      async () => {
        const { companyId, agentId, runId } = await seedCompanyAgentRun();
        const onLog = vi.fn();

        await emitConnectorAuditRecord({
          // no db, no logActivity — mirrors the runtime-gate call path in
          // execute.ts when it does not have a persistence handle to
          // inject.
          runId,
          agentId,
          companyId,
          connectorSource: "openai-curated",
          connectorName: "gmail",
          toolName: "mcp__codex_apps__gmail_send_email",
          classification: "write",
          optInState: { allowRead: [], allowWrite: [] },
          outcome: "denied",
          reason: "connector 'gmail' not in inheritedConnectors.allowWrite",
          onLog,
        });

        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId));
        expect(rows).toHaveLength(0);

        const stderrCalls = onLog.mock.calls.filter(
          (c) => c[0] === "stderr" && typeof c[1] === "string",
        );
        const mirrorLines = stderrCalls.filter((c) =>
          (c[1] as string).includes('"type":"connector-audit"'),
        );
        expect(mirrorLines).toHaveLength(1);

        // Verify mirror payload parses as JSON and includes reason for
        // denied outcome — ensures the forensic trail carries enough
        // context to triage without DB access.
        const parsed = JSON.parse(
          (mirrorLines[0]![1] as string).trimEnd(),
        ) as Record<string, unknown>;
        expect(parsed.type).toBe("connector-audit");
        expect(parsed.outcome).toBe("denied");
        expect(parsed.reason).toBe(
          "connector 'gmail' not in inheritedConnectors.allowWrite",
        );
      },
      30_000,
    );

    // =======================================================================
    // Test F — outcome="error" is persisted with reason and classification.
    //
    // Covers the third outcome tier: gate error handling. When the gate
    // itself fails (classifier exception, unexpected input shape), the
    // helper emits an "error" outcome with a reason string. This path
    // shares the denied-outcome contract that `reason` is present in the
    // persisted details.
    // =======================================================================
    it(
      "persists error outcome audit record with reason and classification",
      async () => {
        const { companyId, agentId, runId } = await seedCompanyAgentRun();
        const onLog = vi.fn();

        await emitConnectorAuditRecord({
          db,
          logActivity,
          runId,
          agentId,
          companyId,
          connectorSource: "openai-curated",
          connectorName: "gmail",
          toolName: "mcp__codex_apps__gmail_send_email",
          classification: "write",
          optInState: { allowRead: ["gmail"], allowWrite: ["gmail"] },
          outcome: "error",
          reason: "unexpected classifier failure",
          onLog,
        });

        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId));

        expect(rows).toHaveLength(1);
        const details = rows[0]!.details as Record<string, unknown>;
        expect(details.outcome).toBe("error");
        expect(details.reason).toBe("unexpected classifier failure");
        expect(details.classification).toBe("write");
      },
      30_000,
    );
  },
);
