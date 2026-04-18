# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through GitHub's Security Advisory feature:
[https://github.com/paperclipai/paperclip/security/advisories/new](https://github.com/paperclipai/paperclip/security/advisories/new)

Do not open public issues for security vulnerabilities.

## Disclosed Advisories

### GHSA-gqqj-85qm-8qhf — Improper Access Control in codex_local adapter

Improper Access Control (CWE-284) allowing unintended inheritance of ChatGPT/OpenAI Apps connector credentials into `codex_local` agent runtimes.

- **Affected versions:** `paperclipai >= 0, <= 2026.403.0`
- **Fixed version:** Resolved in releases above `2026.403.0`.
- **Advisory:** [https://github.com/paperclipai/paperclip/security/advisories/GHSA-gqqj-85qm-8qhf](https://github.com/paperclipai/paperclip/security/advisories/GHSA-gqqj-85qm-8qhf)

**Mitigation summary:**

1. Inherited OpenAI-curated app connectors are no longer loaded into `codex_local` runtimes by default; operators must opt in per-agent via the new `inheritedConnectors` configuration (with separate `allowRead` and `allowWrite` lists).
2. The default value of `dangerouslyBypassApprovalsAndSandbox` on newly created `codex_local` agents was changed from `true` to `false`; callers who explicitly set the flag are unaffected.
3. Every connector-mediated tool invocation emits a structured audit record (timestamp, agent ID, connector source, connector name, tool name, classification, opt-in state, outcome) persisted via the existing activity log.
