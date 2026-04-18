import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferOpenAiCompatibleBiller,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type InheritedConnectorsConfig,
  type ConnectorAuditRecord,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  resolveCommandForLogs,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  joinPromptSections,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseCodexJsonl, isCodexUnknownSessionError } from "./parse.js";
import { pathExists, prepareManagedCodexHome, resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { emitConnectorAuditRecord } from "./connector-audit.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyPaperclipRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyPaperclipRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyPaperclipRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailablePaperclipSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

// -----------------------------------------------------------------------------
// GHSA-gqqj-85qm-8qhf runtime-layer enforcement — classification helpers
// -----------------------------------------------------------------------------
//
// These helpers implement the runtime gate used by the streaming JSONL consumer
// in `runAttempt()` to decide whether an `item.started` `tool_use` event for an
// inherited ChatGPT/OpenAI-curated connector is permitted for the current agent.
//
// Directive 2 (AAP 0.5.1.3): "Write classification MUST be enforced at the
// runtime invocation layer, not only in the tool manifest." — because upstream
// config `enabled = false` is not reliably honored by the Codex CLI (see
// openai/codex#17588). The gate here is authoritative.
//
// Fail-closed posture: tool names that match neither the read nor write regex
// are classified as **write**. This ensures new or unknown tool verbs cannot
// accidentally be treated as read-only.

/**
 * Classification info produced by `classifyConnectorInvocation` for a single
 * `tool_use` item observed on the Codex JSONL stream.
 */
type ConnectorInvocationClassification = {
  /** True when the tool name matches a known connector namespace pattern. */
  isConnector: boolean;
  /** True when the tool name is an inherited `mcp__codex_apps__*` tool (gated). */
  isCodexAppsInherited: boolean;
  /** Short connector name, e.g. "gmail" for `mcp__codex_apps__gmail_send_email`. */
  connectorName: string;
  /** Action verb suffix, e.g. "send_email" for `mcp__codex_apps__gmail_send_email`. */
  action: string;
  /** Classification result — "write" for ambiguous names (fail-closed). */
  classification: "read" | "write";
  /** Origin marker for the audit record's `connectorSource` field. */
  connectorSource: "openai-curated" | "paperclip-native";
};

/** Regex that identifies inherited ChatGPT/OpenAI-curated connector tool names. */
const CODEX_APPS_TOOL_RE = /^mcp__codex_apps__(.+)$/;

/**
 * Canonical read-action prefixes. `get_profile` is matched via the `get_`
 * prefix; no special-case needed at the regex level.
 */
const READ_ACTION_RE = /^(get_|search_|list_|read_|fetch_|find_|query_)/;

/**
 * Explicit write-action prefixes per AAP 0.5.1.3. Matches `send_email`,
 * `send_draft`, `send_*`, `create_*`, `delete_*`, `update_*`, `modify_*`,
 * and related verbs. `send_email` and `send_draft` are listed explicitly so
 * the regex stays readable alongside the broader `send_` prefix — redundant
 * but intentional per the AAP's enumeration.
 */
const WRITE_ACTION_RE =
  /^(send_|send_email|send_draft|update_|create_|delete_|modify_|remove_|archive_|trash_|move_|revoke_|post_|put_|patch_|upsert_|insert_|write_|push_|mark_)/;

/**
 * Classify a single tool-action verb as "read" or "write".
 *
 * Fail-closed: unknown verbs default to "write" so the gate never lets an
 * ambiguous tool invoke a destructive connector round-trip without an explicit
 * `allowWrite` opt-in.
 */
function classifyActionName(action: string): "read" | "write" {
  const normalized = action.toLowerCase();
  if (READ_ACTION_RE.test(normalized)) return "read";
  if (WRITE_ACTION_RE.test(normalized)) return "write";
  // Fail-closed: ambiguous classifies as write (never read).
  return "write";
}

/**
 * Classify a single tool name observed on the Codex JSONL stream.
 *
 * Three possible outcomes:
 *   - `mcp__codex_apps__<connector>_<action>` — inherited ChatGPT/OpenAI-
 *     curated connector (isConnector=true, isCodexAppsInherited=true). Split
 *     the remainder on the FIRST underscore: everything before is the connector
 *     name, everything after is the action verb.
 *   - paperclip-native tools with `:` or `.` separator (e.g. `acme.linear:search-issues`)
 *     — audited but NOT blocked (SYSTEM BOUNDARY: paperclip-native connectors
 *     are intentionally configured and must not be altered beyond audit).
 *   - Any other name — not a connector (isConnector=false); the gate ignores it.
 */
function classifyConnectorInvocation(toolName: string): ConnectorInvocationClassification {
  const codexAppsMatch = CODEX_APPS_TOOL_RE.exec(toolName);
  if (codexAppsMatch) {
    const suffix = codexAppsMatch[1];
    const underscoreIdx = suffix.indexOf("_");
    const connectorName = underscoreIdx >= 0 ? suffix.slice(0, underscoreIdx) : suffix;
    const action = underscoreIdx >= 0 ? suffix.slice(underscoreIdx + 1) : "";
    return {
      isConnector: true,
      isCodexAppsInherited: true,
      connectorName,
      action,
      classification: classifyActionName(action),
      connectorSource: "openai-curated",
    };
  }
  // Paperclip-native namespace heuristic: names with ":" or "." separator.
  // Split on the LAST separator so prefixes like "acme.linear:search-issues"
  // keep "acme.linear" as the connector name and "search-issues" as the action.
  if (/[:.]/.test(toolName)) {
    const separatorIdx = Math.max(toolName.lastIndexOf(":"), toolName.lastIndexOf("."));
    const action = separatorIdx >= 0 ? toolName.slice(separatorIdx + 1) : toolName;
    const connectorName = separatorIdx >= 0 ? toolName.slice(0, separatorIdx) : "";
    return {
      isConnector: true,
      isCodexAppsInherited: false,
      connectorName,
      action,
      classification: classifyActionName(action),
      connectorSource: "paperclip-native",
    };
  }
  return {
    isConnector: false,
    isCodexAppsInherited: false,
    connectorName: "",
    action: "",
    classification: "read",
    connectorSource: "paperclip-native",
  };
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  linkSkill?: (source: string, target: string) => Promise<void>;
};

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[paperclip] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailablePaperclipSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // GHSA-gqqj-85qm-8qhf (AAP 0.5.1.5, Directives 1+2): read the per-agent
  // `inheritedConnectors` opt-in allowlist from the adapter config and
  // normalize both arrays to defined string[] defaults. Semantics:
  //   - Omitted field -> default-deny ({ allowRead: [], allowWrite: [] }).
  //   - Non-array / non-string entries are silently dropped.
  //   - `allowRead` and `allowWrite` are independent gates: read opt-in does
  //     NOT imply write opt-in (see ConnectorAuditRecord.optInState JSDoc).
  //
  // Source-of-truth precedence (per AAP 0.5.1.5 + test contract):
  //   1. `config.inheritedConnectors` — this is the runtime-effective config
  //      derived from the agent's `adapterConfig` PLUS any per-issue / per-run
  //      overrides (see heartbeat.ts: issueAssigneeOverrides.adapterConfig is
  //      merged into `runtimeConfig` which is passed as `config`). When the
  //      production path supplies `inheritedConnectors` via `config`, it takes
  //      precedence so per-issue overrides are honored.
  //   2. `agent.adapterConfig.inheritedConnectors` — fallback that honors the
  //      opt-in set directly on the agent record. This is the authoritative
  //      source in test doubles (which hand-construct `agent` and `config` as
  //      independent objects) and also correctly handles the rare production
  //      edge where `config` has been stripped of the field by upstream
  //      transforms.
  //
  // The normalized value is used BOTH:
  //   - as the 4th argument to `prepareManagedCodexHome(...)` below, so the
  //     managed CODEX_HOME's `config.toml` is sanitized to expose only the
  //     connectors the agent has explicitly opted into at the manifest level
  //     (defense layer 1); and
  //   - as the live opt-in snapshot in the streaming JSONL gate further down
  //     in `runAttempt()`, where it is the authoritative source of truth for
  //     the runtime allow/deny decision (defense layer 2).
  const inheritedConnectorsFromConfig = (config as Record<string, unknown>).inheritedConnectors;
  const agentAdapterConfigRecord =
    typeof agent.adapterConfig === "object" && agent.adapterConfig !== null
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;
  const inheritedConnectorsFromAgent = agentAdapterConfigRecord
    ? agentAdapterConfigRecord.inheritedConnectors
    : undefined;
  const inheritedConnectorsRaw =
    inheritedConnectorsFromConfig !== undefined
      ? inheritedConnectorsFromConfig
      : inheritedConnectorsFromAgent;
  const inheritedConnectorsObj =
    typeof inheritedConnectorsRaw === "object" && inheritedConnectorsRaw !== null
      ? (inheritedConnectorsRaw as Record<string, unknown>)
      : {};
  const normalizedInheritedConnectors: InheritedConnectorsConfig & {
    allowRead: string[];
    allowWrite: string[];
  } = {
    allowRead: Array.isArray(inheritedConnectorsObj.allowRead)
      ? (inheritedConnectorsObj.allowRead as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
      : [],
    allowWrite: Array.isArray(inheritedConnectorsObj.allowWrite)
      ? (inheritedConnectorsObj.allowWrite as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
      : [],
  };

  const preparedManagedCodexHome =
    configuredCodexHome
      ? null
      : await prepareManagedCodexHome(
          process.env,
          onLog,
          agent.companyId,
          normalizedInheritedConnectors,
        );
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
  // Inject skills into the same CODEX_HOME that Codex will actually run with
  // (managed home in the default case, or an explicit override from adapter config).
  const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
  await ensureCodexSkillsInjected(
    onLog,
    {
      skillsHome: codexSkillsDir,
      skillsEntries: codexSkillEntries,
      desiredSkillNames,
    },
  );
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.CODEX_HOME = effectiveCodexHome;
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const repoAgentsNote =
    "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.";
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  instructionsChars = promptInstructionsPrefix.length;
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      return [repoAgentsNote];
    }
    if (instructionsPrefix.length > 0) {
      if (shouldUseResumeDeltaPrompt) {
        return [
          `Loaded agent instructions from ${instructionsFilePath}`,
          "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
          repoAgentsNote,
        ];
      }
      return [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        repoAgentsNote,
      ];
    }
    return [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      repoAgentsNote,
    ];
  })();
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const execArgs = buildCodexExecArgs(config, { resumeSessionId });
    const args = execArgs.args;
    const commandNotesWithFastMode =
      execArgs.fastModeIgnoredReason == null
        ? commandNotes
        : [...commandNotes, execArgs.fastModeIgnoredReason];
    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command: resolvedCommand,
        cwd,
        commandNotes: commandNotesWithFastMode,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    // ---------------------------------------------------------------------
    // GHSA-gqqj-85qm-8qhf — runtime-layer connector enforcement state
    // ---------------------------------------------------------------------
    //
    // Per-attempt state held in the closure of this invocation so that a
    // single `runAttempt` lifetime observes consistent gate behaviour.
    //
    //   childPid / childProcessGroupId : populated by `wrappedOnSpawn` below,
    //       used for SIGTERM targeting on denial. `processGroupId` is preferred
    //       (negative pid -> signal the whole group, including grandchildren)
    //       and falls back to the direct child pid on platforms where pgid is
    //       unavailable (e.g. Windows).
    //   gateDenied                     : set on the FIRST denial observed on
    //       this attempt. Later tool_use events after the SIGTERM latency
    //       window do not overwrite the first denial — the first reason is
    //       the one surfaced in the AdapterExecutionResult.
    //   stdoutLineBuffer               : accumulator for partial JSONL lines
    //       streamed in from the child. The Codex CLI emits one JSON object
    //       per stdout line (newline-terminated), but Node may deliver chunks
    //       that split a line or concatenate multiple lines. We split on `\n`
    //       and only parse complete (up-to-last-newline) content.
    //   gateHandledStartItemIds        : dedupe set keyed by `item.id`. If
    //       the Codex CLI re-emits an `item.started` event for the same id
    //       (observed during retries or internal recovery paths), the gate
    //       emits an audit record at MOST once per item.
    let childPid: number | null = null;
    let childProcessGroupId: number | null = null;
    let gateDenied:
      | {
          toolName: string;
          connectorName: string;
          action: string;
          classification: "read" | "write";
          reason: string;
        }
      | null = null;
    let stdoutLineBuffer = "";
    const gateHandledStartItemIds = new Set<string>();

    /**
     * onSpawn wrapper that captures the child's pid and (platform-dependent)
     * process group id for use by the SIGTERM path in `processStdoutLine` on
     * denial. Always delegates to the original `onSpawn` (when provided) so
     * existing observers receive their lifecycle signal unchanged.
     */
    const wrappedOnSpawn = async (meta: {
      pid: number;
      processGroupId: number | null;
      startedAt: string;
    }) => {
      childPid = meta.pid;
      childProcessGroupId = meta.processGroupId;
      if (onSpawn) {
        await onSpawn(meta);
      }
    };

    /**
     * Send SIGTERM to the child process. Mirrors the existing
     * `signalRunningProcess` pattern in adapter-utils/server-utils: prefer
     * the negative-pgid form (signals the whole group) on non-Windows
     * platforms; fall back to the direct pid. Both paths are wrapped in
     * try/catch because the child may have already exited (ESRCH) or
     * permissions may have changed (EPERM). Silent failure is preferred —
     * the gate's `denied` authority comes from the audit record + returned
     * `gateDenied` state, not from the success of the signal delivery.
     */
    const sendSigtermToChild = (): void => {
      if (
        process.platform !== "win32" &&
        childProcessGroupId !== null &&
        childProcessGroupId > 0
      ) {
        try {
          process.kill(-childProcessGroupId, "SIGTERM");
          return;
        } catch {
          // Fall through to direct-pid kill.
        }
      }
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          // Child already exited or signal not permitted; safe to ignore.
        }
      }
    };

    /**
     * Parse a single complete stdout line from the Codex JSONL stream and
     * route `item.started` `tool_use` events through the connector gate.
     *
     * Silent on parse failures (the Codex stream may include non-JSON
     * banner lines, informational messages, etc.). The gate only fires on
     * structurally-valid JSON objects with `type === "item.started"` and
     * a `tool_use` `item`.
     *
     * Timing discipline (Directive 4):
     *   - openai-curated allowed -> emit audit BEFORE returning so the
     *     record is logged before the connector round-trip fires.
     *   - openai-curated denied  -> emit audit BEFORE SIGTERM is sent to
     *     the child.
     *   - paperclip-native       -> emit audit (allowed) but NEVER block
     *     (SYSTEM BOUNDARY: paperclip-native connectors are intentionally
     *     configured and must not be altered beyond audit emission).
     */
    const processStdoutLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // non-JSON content in the stdout stream; ignore for gate purposes
      }
      if (!event || typeof event !== "object") return;
      const eventRecord = event as Record<string, unknown>;
      if (eventRecord.type !== "item.started") return;
      const item = eventRecord.item;
      if (!item || typeof item !== "object") return;
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type !== "tool_use") return;
      const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "";
      if (!toolName) return;

      // Dedupe by `item.id` so retried or re-emitted `item.started` events
      // for the same tool invocation do not produce duplicate audit records.
      const itemId = typeof itemRecord.id === "string" ? itemRecord.id : "";
      if (itemId) {
        if (gateHandledStartItemIds.has(itemId)) return;
        gateHandledStartItemIds.add(itemId);
      }

      const info = classifyConnectorInvocation(toolName);
      if (!info.isConnector) return;

      // Paperclip-native path: audit-only, never blocked. SYSTEM BOUNDARY
      // from AAP 0.10.4: "MUST NOT alter connectors intentionally configured
      // inside Paperclip (`paperclip-native` source) beyond adding audit
      // emission." Failures in audit emission are swallowed by the helper;
      // the gate never blocks paperclip-native tools under any circumstance.
      if (info.connectorSource === "paperclip-native") {
        try {
          await emitConnectorAuditRecord({
            runId,
            agentId: agent.id,
            companyId: agent.companyId,
            connectorSource: "paperclip-native",
            connectorName: info.connectorName,
            toolName,
            classification: info.classification,
            optInState: normalizedInheritedConnectors,
            outcome: "allowed",
            onLog,
          });
        } catch {
          // Audit emission is best-effort; never affect the run outcome.
        }
        return;
      }

      // openai-curated inherited connector path — gate against the
      // per-agent opt-in allowlist. Read and write are independent gates
      // per AAP 0.5.1.5: read opt-in does NOT imply write opt-in.
      const allowList =
        info.classification === "read"
          ? normalizedInheritedConnectors.allowRead
          : normalizedInheritedConnectors.allowWrite;
      const permitted = allowList.includes(info.connectorName);

      if (permitted) {
        // Directive 4 timing: emit `allowed` audit BEFORE the gate returns
        // and the event is allowed to propagate past the consumer — so the
        // provenance is recorded before any potential connector side effect.
        try {
          await emitConnectorAuditRecord({
            runId,
            agentId: agent.id,
            companyId: agent.companyId,
            connectorSource: "openai-curated",
            connectorName: info.connectorName,
            toolName,
            classification: info.classification,
            optInState: normalizedInheritedConnectors,
            outcome: "allowed",
            onLog,
          });
        } catch {
          // Audit emission is best-effort; never affect the run outcome.
        }
        return;
      }

      // Denied path. Structure the reason to name the exact opt-in that was
      // missing, then emit the `denied` audit BEFORE SIGTERM so the record
      // is present even if the child exits instantaneously.
      const listName = info.classification === "read" ? "allowRead" : "allowWrite";
      const reason = `connector '${info.connectorName}' not in inheritedConnectors.${listName}`;
      try {
        await emitConnectorAuditRecord({
          runId,
          agentId: agent.id,
          companyId: agent.companyId,
          connectorSource: "openai-curated",
          connectorName: info.connectorName,
          toolName,
          classification: info.classification,
          optInState: normalizedInheritedConnectors,
          outcome: "denied",
          reason,
          onLog,
        });
      } catch {
        // Audit emission is best-effort; proceed with SIGTERM regardless.
      }

      // Record the FIRST denial only — later tool_use events within the
      // SIGTERM latency window do not overwrite the first reason.
      if (!gateDenied) {
        gateDenied = {
          toolName,
          connectorName: info.connectorName,
          action: info.action,
          classification: info.classification,
          reason,
        };
      }

      // Terminate the child process. Upstream Codex CLI may already be mid
      // tool-invocation; SIGTERM here aborts before the round-trip completes
      // in the typical case. If the upstream CLI has already fired the
      // connector round-trip, the denial is still recorded in the audit log
      // — defense-in-depth between the config.toml sanitization (AAP 0.5.1.2)
      // and this runtime gate (AAP 0.5.1.3) means the connector should not
      // have been visible to the CLI in the first place.
      sendSigtermToChild();
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn: wrappedOnSpawn,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          // Forward the chunk to the outer consumer FIRST so UI/transcript
          // feed remains real-time. The gate runs on completed JSONL lines
          // immediately after so SIGTERM is delivered with minimum latency.
          await onLog(stream, chunk);

          // Accumulate chunks into the per-attempt line buffer, then split
          // off any complete (newline-terminated) lines for gate processing.
          // Partial trailing content stays in the buffer for the next chunk.
          stdoutLineBuffer += chunk;
          const lastNewline = stdoutLineBuffer.lastIndexOf("\n");
          if (lastNewline >= 0) {
            const completed = stdoutLineBuffer.slice(0, lastNewline);
            stdoutLineBuffer = stdoutLineBuffer.slice(lastNewline + 1);
            for (const candidateLine of completed.split("\n")) {
              try {
                await processStdoutLine(candidateLine);
              } catch {
                // Never allow a gate failure to interrupt the stream pump.
                // Authoritative allow/deny already returned via `gateDenied`.
              }
            }
          }
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });

    // After process exit, flush any trailing stdout content that did not end
    // in a newline. This is a best-effort pass so the final tool_use event
    // (if any) is still considered by the gate even when the CLI exits
    // without a terminating newline.
    if (stdoutLineBuffer.trim()) {
      try {
        await processStdoutLine(stdoutLineBuffer);
      } catch {
        // Best-effort; ignore final-flush errors.
      }
      stdoutLineBuffer = "";
    }

    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
      gateDenied,
    };
  };

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      rawStderr: string;
      parsed: ReturnType<typeof parseCodexJsonl>;
      // GHSA-gqqj-85qm-8qhf: set by the streaming JSONL gate inside
      // `runAttempt` when a connector invocation is denied by the agent's
      // `inheritedConnectors` allowlist. When non-null this ALWAYS produces
      // an authorization-failure result that takes precedence over any
      // downstream exit-code or stderr-derived error message.
      gateDenied?: {
        toolName: string;
        connectorName: string;
        action: string;
        classification: "read" | "write";
        reason: string;
      } | null;
    },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    // GHSA-gqqj-85qm-8qhf Directive 2 — the runtime gate's authorization
    // decision takes precedence over every other error-reporting path. The
    // gate has already emitted a structured `denied` audit record AND sent
    // SIGTERM to the child, so the child's exit code / signal will look
    // like signal-terminated noise. Surface the real cause — the missing
    // opt-in — at the very top of the result construction so operators see
    // the actionable reason rather than "Codex exited with code -1".
    if (attempt.gateDenied) {
      const listName =
        attempt.gateDenied.classification === "read" ? "allowRead" : "allowWrite";
      const authorizationError =
        `Authorization error: connector '${attempt.gateDenied.connectorName}' ` +
        `tool '${attempt.gateDenied.action}' ` +
        `requires inheritedConnectors.${listName} to include ` +
        `'${attempt.gateDenied.connectorName}' for this agent`;
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: authorizationError,
        errorCode: "codex.connector.denied",
        errorMeta: {
          toolName: attempt.gateDenied.toolName,
          connectorName: attempt.gateDenied.connectorName,
          action: attempt.gateDenied.action,
          classification: attempt.gateDenied.classification,
          missingOptIn: `inheritedConnectors.${listName}`,
          reason: attempt.gateDenied.reason,
        },
        usage: attempt.parsed.usage,
        sessionId: attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null,
        sessionParams: null,
        sessionDisplayId:
          attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null,
        provider: "openai",
        biller: resolveCodexBiller(effectiveEnv, billingType),
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: clearSessionOnMissingSession,
      };
    }

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);

  // GHSA-gqqj-85qm-8qhf Phase 2h — a gate denial is a FINAL, authoritative
  // decision. It MUST NOT trigger the unknown-session resume retry below,
  // because a resumed session would face the same connector allowlist and
  // either deny again (wasting work) or — worse — succeed if the session
  // resume path introduced configuration drift. Short-circuit the retry
  // and surface the authorization error immediately.
  if (initial.gateDenied) {
    return toResult(initial);
  }

  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
