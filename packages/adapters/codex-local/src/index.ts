export const type = "codex_local";
export const label = "Codex (local)";
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.3-codex";
/**
 * Default value applied to `dangerouslyBypassApprovalsAndSandbox` when a
 * `codex_local` agent is created without the caller specifying it explicitly.
 *
 * Security-driven flip: as part of GHSA-gqqj-85qm-8qhf (CWE-284, CVSS 8.7 High)
 * this default was changed from `true` to `false`. Setting `true` bypasses the
 * Codex CLI approval and sandbox gates (invoked via
 * `--dangerously-bypass-approvals-and-sandbox`), which, combined with the
 * previously-unfiltered inheritance of ChatGPT/OpenAI-curated connector state
 * into the managed `CODEX_HOME`, enabled silent outward writes (e.g., Gmail
 * send) from newly created agents. Shipping `false` as the default restores
 * per-invocation approval gates by default.
 *
 * Callers MAY still pass `dangerouslyBypassApprovalsAndSandbox: true`
 * explicitly — the flag remains fully functional; only the implicit default
 * changed. Enable `true` only inside a hardened, isolated environment
 * (non-production or equivalently protected sandbox). Existing agent records
 * already persisted with `true` are not retroactively mutated.
 *
 * See: SECURITY.md (Disclosed Advisories) and the advisory at
 * https://github.com/paperclipai/paperclip/security/advisories/GHSA-gqqj-85qm-8qhf
 */
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = false;
export const CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS = ["gpt-5.4"] as const;

export function isCodexLocalFastModeSupported(model: string | null | undefined): boolean {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  return CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.includes(
    normalizedModel as (typeof CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS)[number],
  );
}

export const models = [
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: DEFAULT_CODEX_LOCAL_MODEL, label: DEFAULT_CODEX_LOCAL_MODEL },
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5", label: "gpt-5" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gpt-5-mini", label: "gpt-5-mini" },
  { id: "gpt-5-nano", label: "gpt-5-nano" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "codex-mini-latest", label: "Codex Mini" },
];

export const agentConfigurationDoc = `# codex_local agent configuration

Adapter: codex_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, optional): Codex model id
- modelReasoningEffort (string, optional): reasoning effort override (minimal|low|medium|high|xhigh) passed via -c model_reasoning_effort=...
- promptTemplate (string, optional): run prompt template
- search (boolean, optional): run codex with --search
- fastMode (boolean, optional): enable Codex Fast mode; currently supported on GPT-5.4 only and consumes credits faster
- dangerouslyBypassApprovalsAndSandbox (boolean, optional, default: false): run Codex with --dangerously-bypass-approvals-and-sandbox. DANGEROUS — only enable inside a hardened environment. As of GHSA-gqqj-85qm-8qhf, this defaults to false; explicit true is required to opt into the bypass.
- inheritedConnectors (object, optional, default: { allowRead: [], allowWrite: [] }): per-agent opt-in allowlists for ChatGPT/OpenAI-curated app connectors inherited from the shared Codex home. Shape: { allowRead?: string[]; allowWrite?: string[] }. Read and write are INDEPENDENT gates: read opt-in does NOT imply write opt-in. A connector name (e.g., "gmail", "gcal", "drive", "github", "linear") must appear in allowRead for read-classified tools (get_*, search_*, list_*, ...) and in allowWrite for write-classified tools (send_*, create_*, update_*, delete_*, ...). Default-deny: omitted or empty arrays mean no inherited connectors are available. Added as part of GHSA-gqqj-85qm-8qhf remediation.
- command (string, optional): defaults to "codex"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin (Codex receives "-" prompt argument).
- If instructionsFilePath is configured, Paperclip prepends that file's contents to the stdin prompt on every run.
- Codex exec automatically applies repo-scoped AGENTS.md instructions from the active workspace. Paperclip cannot suppress that discovery in exec mode, so repo AGENTS.md files may still apply even when you only configured an explicit instructionsFilePath.
- Paperclip injects desired local skills into the effective CODEX_HOME/skills/ directory at execution time so Codex can discover "$paperclip" and related skills without polluting the project working directory. In managed-home mode (the default) this is ~/.paperclip/instances/<id>/companies/<companyId>/codex-home/skills/; when CODEX_HOME is explicitly overridden in adapter config, that override is used instead.
- Unless explicitly overridden in adapter config, Paperclip runs Codex with a per-company managed CODEX_HOME under the active Paperclip instance and seeds auth/config from the shared Codex home (the CODEX_HOME env var, when set, or ~/.codex).
- Some model/tool combinations reject certain effort levels (for example minimal with web search enabled).
- Fast mode is currently supported on GPT-5.4 only. When enabled, Paperclip applies \`service_tier="fast"\` and \`features.fast_mode=true\`.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- ChatGPT/OpenAI-curated app connectors (gmail, gcal, drive, github, linear, ...) configured via the Codex CLI / ChatGPT Apps UI are NOT inherited into codex_local runtimes by default. To expose inherited connectors to an agent, populate inheritedConnectors.allowRead (read actions) and/or inheritedConnectors.allowWrite (write actions) with the connector names. Paperclip sanitizes the managed CODEX_HOME config.toml to disable non-opted-in openai-curated plugin/app/mcp_server entries and enforces a runtime gate on tool invocations matching mcp__codex_apps__* — denied invocations terminate the run with a named authorization error. Every connector-mediated invocation emits a structured audit record (action: "codex.connector.invoked") to the activityLog. See GHSA-gqqj-85qm-8qhf.
`;
