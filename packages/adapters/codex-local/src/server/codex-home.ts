import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterExecutionContext,
  InheritedConnectorsConfig,
} from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home")
    : path.resolve(paperclipHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) return;

  await fs.unlink(target);
  await fs.symlink(source, target);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

// ---------------------------------------------------------------------------
// GHSA-gqqj-85qm-8qhf — managed config.toml sanitization (default-deny for
// OpenAI-curated connector inheritance).
// ---------------------------------------------------------------------------

/**
 * Sanitize the managed Codex home's copied `config.toml` to remove OpenAI-curated
 * connector inheritance and re-enable only the connectors explicitly opted in
 * via `inheritedConnectors.allowRead` / `inheritedConnectors.allowWrite`.
 *
 * Strips (or disables) TOML sections matching:
 *   - `[plugins."<name>@openai-curated"]`
 *   - `[apps.<name>]`
 *   - `[apps.<name>.tools."<tool>"]`
 *   - `[mcp_servers.<name>]` where `<name>` is a well-known OpenAI connector host
 *     (`codex_apps`, `openai`, `chatgpt`).
 *
 * Re-enables connectors named in `allowRead ∪ allowWrite` by emitting a minimum
 * `[apps.<name>]\nenabled = true\n` block. All non-connector blocks (e.g.,
 * `[tools]`, `[profile.*]`, top-level `model`, `approval_policy`) are preserved
 * bit-identical.
 *
 * SYSTEM BOUNDARY: Operates only on `targetHome` (the Paperclip-managed copy).
 * Never touches `~/.codex/plugins/cache/openai-curated/` or any path inside the
 * shared source Codex home. `prepareManagedCodexHome` short-circuits when
 * `sourceHome === targetHome`, so this function is only reachable for a managed
 * copy that Paperclip owns.
 *
 * Defense-in-depth: this is defense layer 1 (manifest-level). The runtime gate
 * in `execute.ts` on the Codex JSONL stream is defense layer 2 (authoritative).
 */
async function sanitizeCopiedCodexConfig(
  targetHome: string,
  inheritedConnectors: InheritedConnectorsConfig | undefined,
): Promise<{ allowedConnectors: string[] }> {
  const configPath = path.join(targetHome, "config.toml");
  if (!(await pathExists(configPath))) {
    return { allowedConnectors: [] };
  }
  const raw = await fs.readFile(configPath, "utf8");
  const allowSet = new Set<string>([
    ...(inheritedConnectors?.allowRead ?? []).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    ),
    ...(inheritedConnectors?.allowWrite ?? []).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    ),
  ]);
  const { sanitized, allowedEnabled } = rewriteTomlStripConnectorBlocks(raw, allowSet);
  if (sanitized !== raw) {
    await fs.writeFile(configPath, sanitized, "utf8");
  }
  return { allowedConnectors: Array.from(allowedEnabled) };
}

/**
 * Pure string-rewrite helper that strips OpenAI-curated connector blocks and
 * re-enables allowlisted `[apps.<name>]` blocks. Uses a minimal inline line-based
 * approach to avoid adding a TOML parser dependency.
 *
 * Parsing model:
 *   - Iterate the file line-by-line.
 *   - A "section header" matches `/^\s*\[([^\]]+)\]\s*$/` — the typical Codex
 *     header shape (no multi-line tables, no inline-table syntax). Codex's
 *     connector config never uses those forms.
 *   - A section runs from its header line through to the next header or EOF.
 *     "Preamble" lines before the first header are preserved verbatim.
 *   - For each section, examine the header content (dotted path like
 *     `plugins."gmail@openai-curated"`, `apps.gmail`,
 *     `apps.gmail.tools."search_emails"`, `mcp_servers.codex_apps`).
 *     Decide:
 *       - STRIP: skip the section entirely.
 *       - KEEP:  emit the section verbatim.
 *       - SUBSTITUTE: emit a minimum `[apps.<name>]\nenabled = true\n` block.
 *   - Track which allowlisted connectors were re-enabled.
 *
 * Strip rules (conservative):
 *   - `[plugins."<name>@openai-curated"]` → STRIP.
 *   - `[apps.<name>]` or `[apps.<name>.*]` → STRIP, unless it is the exact
 *     parent `[apps.<name>]` AND `<name>` is in `allowSet`; in that case,
 *     SUBSTITUTE. Deeper `[apps.<name>.tools."<tool>"]` blocks are stripped
 *     regardless — the runtime gate decides tool-level authority.
 *   - `[mcp_servers.<name>]` → STRIP only when `<name>` is a well-known OpenAI
 *     connector host (`codex_apps`, `openai`, `chatgpt`). Other mcp_servers
 *     sections (e.g., paperclip-native plugin servers) are KEPT.
 *   - Everything else → KEEP.
 *
 * Finally, for each connector in `allowSet` that did NOT appear as an existing
 * `[apps.<name>]` section in the source file, APPEND a minimum
 * `[apps.<name>]\nenabled = true\n` block at the end so Codex can still
 * discover the re-enabled connector.
 */
function rewriteTomlStripConnectorBlocks(
  raw: string,
  allowSet: Set<string>,
): { sanitized: string; allowedEnabled: Set<string> } {
  const lines = raw.split("\n");
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  const output: string[] = [];
  const allowedEnabled = new Set<string>();
  let i = 0;
  // Emit preamble (lines before any section header) verbatim.
  while (i < lines.length && !headerRe.test(lines[i])) {
    output.push(lines[i]);
    i++;
  }
  while (i < lines.length) {
    const headerMatch = headerRe.exec(lines[i]);
    if (!headerMatch) {
      // Shouldn't happen given the loop invariant, but be defensive.
      output.push(lines[i]);
      i++;
      continue;
    }
    const headerName = headerMatch[1].trim();
    // Collect this section's body: from the header line until the next header or EOF.
    const sectionStart = i;
    i++;
    while (i < lines.length && !headerRe.test(lines[i])) {
      i++;
    }
    const sectionEnd = i; // exclusive
    const sectionLines = lines.slice(sectionStart, sectionEnd);

    const decision = classifyTomlSection(headerName, allowSet);
    if (decision.action === "keep") {
      output.push(...sectionLines);
    } else if (decision.action === "substitute") {
      // Minimum enabled block for an allowlisted app.
      output.push(`[apps.${decision.appName}]`);
      output.push(`enabled = true`);
      // Preserve a trailing empty line if the original section had one, to
      // minimize cosmetic churn.
      if (sectionLines[sectionLines.length - 1] === "") {
        output.push("");
      }
      allowedEnabled.add(decision.appName);
    }
    // "strip" → emit nothing for this section.
  }
  // Append allowlisted connectors that were not present as `[apps.<name>]` in
  // the source file (so Codex can discover their manifests once re-enabled).
  for (const appName of allowSet) {
    if (!allowedEnabled.has(appName)) {
      // Ensure a blank line separator before the appended block if not already present.
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(`[apps.${appName}]`);
      output.push(`enabled = true`);
      allowedEnabled.add(appName);
    }
  }
  return { sanitized: output.join("\n"), allowedEnabled };
}

/**
 * Classify a TOML section header to decide strip vs. keep vs. substitute.
 * See {@link rewriteTomlStripConnectorBlocks} for the rule matrix.
 */
function classifyTomlSection(
  headerName: string,
  allowSet: Set<string>,
):
  | { action: "keep" }
  | { action: "strip" }
  | { action: "substitute"; appName: string } {
  // [plugins."<name>@openai-curated"] → STRIP
  if (/^plugins\."[^"]+@openai-curated"$/.test(headerName)) {
    return { action: "strip" };
  }
  // [apps.<name>] → SUBSTITUTE if allowlisted, else STRIP.
  // Deeper sub-tables like [apps.<name>.tools."<tool>"] are also stripped —
  // the runtime gate is authoritative for tool-level decisions.
  const appsMatch = /^apps\.([^.]+)(?:\..+)?$/.exec(headerName);
  if (appsMatch) {
    const appName = appsMatch[1];
    const isParent = headerName === `apps.${appName}`;
    if (isParent && allowSet.has(appName)) {
      return { action: "substitute", appName };
    }
    return { action: "strip" };
  }
  // [mcp_servers.<name>] → STRIP when name is a well-known OpenAI connector host.
  const mcpMatch = /^mcp_servers\.([^.]+)(?:\..+)?$/.exec(headerName);
  if (mcpMatch) {
    const serverName = mcpMatch[1];
    if (serverName === "codex_apps" || serverName === "openai" || serverName === "chatgpt") {
      return { action: "strip" };
    }
    return { action: "keep" };
  }
  // All other sections (tools, profile.*, model, approval_policy, etc.) → KEEP.
  return { action: "keep" };
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  inheritedConnectors?: InheritedConnectorsConfig,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  // GHSA-gqqj-85qm-8qhf — defensively remove any pre-existing `plugins/`
  // directory under the managed Codex home. The managed home must never carry
  // inherited connector state; this handles stale content from pre-fix runs.
  // SYSTEM BOUNDARY: operates only on `targetHome` (managed copy); the shared
  // `~/.codex/plugins/cache/openai-curated/` tree is read-through only.
  const pluginsDir = path.join(targetHome, "plugins");
  if (await pathExists(pluginsDir)) {
    await onLog(
      "stdout",
      `[paperclip] unexpected plugins/ directory under managed Codex home; removing: ${pluginsDir}\n`,
    );
    await fs.rm(pluginsDir, { recursive: true, force: true }).catch(() => {});
  }

  for (const name of SYMLINKED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, name), source);
  }

  for (const name of COPIED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    await ensureCopiedFile(path.join(targetHome, name), source);
  }

  // GHSA-gqqj-85qm-8qhf — sanitize the copied `config.toml` to strip
  // OpenAI-curated connector entries (default-deny). Re-enable only the
  // connectors explicitly listed in `inheritedConnectors.allowRead` or
  // `inheritedConnectors.allowWrite`. The managed CODEX_HOME must not present
  // inherited connector state to the spawned Codex CLI unless the agent
  // opted in. This runs AFTER the copy loop so the config file exists.
  await sanitizeCopiedCodexConfig(targetHome, inheritedConnectors);

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );

  // GHSA-gqqj-85qm-8qhf — companion log line naming the current opt-in state
  // for observability and forensic replay.
  const allowReadList = inheritedConnectors?.allowRead ?? [];
  const allowWriteList = inheritedConnectors?.allowWrite ?? [];
  await onLog(
    "stdout",
    `[paperclip] codex_local inherited connectors: ` +
      `allowRead=[${allowReadList.length > 0 ? allowReadList.join(",") : "none"}], ` +
      `allowWrite=[${allowWriteList.length > 0 ? allowWriteList.join(",") : "none"}]\n`,
  );

  return targetHome;
}
