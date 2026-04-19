# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through GitHub's Security Advisory feature:
[https://github.com/paperclipai/paperclip/security/advisories/new](https://github.com/paperclipai/paperclip/security/advisories/new)

Do not open public issues for security vulnerabilities.

## Disclosed Advisories

### GHSA-gqqj-85qm-8qhf — Improper Access Control in codex_local adapter

Improper Access Control (CWE-284) allowing unintended inheritance of ChatGPT/OpenAI Apps connector credentials into `codex_local` agent runtimes.

- **Severity:** High (CVSS v3.1 8.7)
- **CWE:** CWE-284 (Improper Access Control)
- **Affected versions:** `paperclipai >= 0, <= 2026.403.0`
- **Fixed version:** Resolved in releases above `2026.403.0`.
- **Advisory:** [https://github.com/paperclipai/paperclip/security/advisories/GHSA-gqqj-85qm-8qhf](https://github.com/paperclipai/paperclip/security/advisories/GHSA-gqqj-85qm-8qhf)

**Mitigation — defense in depth across three layers:**

1. **Manifest exclusion (layer 1).** `prepareManagedCodexHome` now sanitizes the managed `CODEX_HOME` seeded for each `codex_local` run: it strips `[plugins."*@openai-curated"]`, `[apps.<name>]`, `[apps.<name>.tools."<tool>"]`, and curated `[mcp_servers.<name>]` tables from the copied `config.toml`, removes any pre-existing `plugins/cache/openai-curated/` directory from the managed home, and re-enables only the connectors explicitly listed in the agent's `inheritedConnectors.allowRead ∪ allowWrite` opt-in.
2. **Runtime gate (layer 2).** The adapter intercepts every `tool_use` item in the Codex JSONL stream whose name matches `mcp__codex_apps__*`, classifies the action as read or write (fail-closed for unknown verbs), and terminates the run with a named authorization error unless the connector is in the agent's `inheritedConnectors.allowRead` (for reads) or `allowWrite` (for writes). This runtime enforcement is authoritative and does not depend on the Codex CLI self-gating via `enabled = false`.
3. **Audit trail (layer 3).** Every connector-mediated invocation emits a structured audit record (timestamp, agent ID, connector source, connector name, tool name, classification, opt-in state, outcome) persisted via the existing activity log with `action = "codex.connector.invoked"`. Allowed records are emitted before the connector action fires; denied records are emitted at denial time.

Additionally, the server-side default for `dangerouslyBypassApprovalsAndSandbox` on newly created `codex_local` agents was changed from `true` to `false`; callers who explicitly set the flag to `true` are unaffected.
