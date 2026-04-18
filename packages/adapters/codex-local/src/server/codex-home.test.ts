// codex-home.test.ts — Layer 0 defense regression suite for GHSA-gqqj-85qm-8qhf.
//
// Validates the two Layer 0 invariants of `prepareManagedCodexHome`:
//   1. config.toml sanitization: OpenAI-curated connector entries
//      (`[plugins."<name>@openai-curated"]`, `[apps.<name>]`,
//      `[apps.<name>.tools.<tool>]`, `[mcp_servers.<known-openai-host>]`)
//      are stripped/substituted in the copy placed under the managed
//      `CODEX_HOME`, so the spawned Codex CLI cannot resolve unopted
//      connector state even if the upstream CLI fails to honor
//      `enabled = false` (see openai/codex#17588).
//   2. Managed home hygiene: no `plugins/` directory is mirrored into the
//      managed target; the source `CODEX_HOME/plugins/cache/openai-curated/`
//      subtree is read-through only (never mutated); provenance is logged
//      so operators can audit which connectors were permitted for a run.
//
// All tests run against real filesystem under hermetic temp directories
// (via `fs.mkdtemp`). No mocking of `fs`/`os`/`path`; all assertions are
// structural (`.toContain`, `.toMatch`, `.not.toMatch`, `.toEqual`).
// Only the public API `prepareManagedCodexHome` is exercised — the
// internal helpers (`sanitizeCopiedCodexConfig`,
// `rewriteTomlStripConnectorBlocks`, `classifyTomlSection`) are not
// exported and MUST NOT be imported.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { prepareManagedCodexHome } from "./codex-home.js";

// `vi` is imported for parity with the sibling `quota-spawn-error.test.ts`
// pattern even though this file does not mock any modules — the integration
// test exercises the real filesystem rather than mocking it, aligning with
// the AAP's "No mocking of `fs`, `os`, or `path`" directive. A reference to
// `vi` is retained so the import is observable to any tooling that flags
// unused imports (the vitest `expect.extend`/matcher registry is the
// canonical no-op consumer used across the sibling integration tests).
void vi;

describe("prepareManagedCodexHome (GHSA-gqqj-85qm-8qhf)", () => {
  let sourceHome: string;
  let paperclipHome: string;
  let onLogCalls: Array<{ stream: "stdout" | "stderr"; chunk: string }>;

  const makeEnv = (): NodeJS.ProcessEnv => ({
    CODEX_HOME: sourceHome,
    PAPERCLIP_HOME: paperclipHome,
  });

  const onLog = async (
    stream: "stdout" | "stderr",
    chunk: string,
  ): Promise<void> => {
    onLogCalls.push({ stream, chunk });
  };

  const stdoutLog = (): string =>
    onLogCalls
      .filter((entry) => entry.stream === "stdout")
      .map((entry) => entry.chunk)
      .join("");

  const managedTargetPath = (companyId?: string): string =>
    companyId
      ? path.resolve(
          paperclipHome,
          "instances",
          "default",
          "companies",
          companyId,
          "codex-home",
        )
      : path.resolve(paperclipHome, "instances", "default", "codex-home");

  const seedSourceFile = async (
    relative: string,
    content: string,
  ): Promise<void> => {
    const target = path.join(sourceHome, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  };

  const readManagedConfigToml = async (companyId?: string): Promise<string> => {
    const target = path.join(managedTargetPath(companyId), "config.toml");
    return fs.readFile(target, "utf8");
  };

  beforeEach(async () => {
    sourceHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-ghsa-source-"),
    );
    paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-ghsa-home-"),
    );
    onLogCalls = [];
  });

  afterEach(async () => {
    await fs
      .rm(sourceHome, { recursive: true, force: true })
      .catch(() => undefined);
    await fs
      .rm(paperclipHome, { recursive: true, force: true })
      .catch(() => undefined);
  });

  describe("config.toml sanitization", () => {
    it('strips [plugins."<name>@openai-curated"] blocks while preserving top-level settings', async () => {
      await seedSourceFile(
        "config.toml",
        [
          'model = "gpt-5-codex"',
          "",
          '[plugins."gmail@openai-curated"]',
          "enabled = true",
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      // Top-level setting must survive sanitization.
      expect(managed).toContain('model = "gpt-5-codex"');
      // The entire `[plugins."gmail@openai-curated"]` section must be stripped.
      expect(managed).not.toMatch(/\[plugins\."gmail@openai-curated"\]/);
    });

    it("strips [apps.<name>] blocks when the connector is not in allowRead or allowWrite", async () => {
      await seedSourceFile(
        "config.toml",
        [
          "[apps.gmail]",
          "enabled = true",
          'arbitrary_key = "leaked-value"',
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      // Section header must be absent entirely.
      expect(managed).not.toMatch(/^\[apps\.gmail\]/m);
      // No keys from within the section may leak into the output.
      expect(managed).not.toContain('arbitrary_key = "leaked-value"');
    });

    it("substitutes [apps.<name>] down to a minimum enabled = true block when the connector is in allowRead", async () => {
      await seedSourceFile(
        "config.toml",
        [
          "[apps.gmail]",
          "enabled = false",
          'arbitrary_key = "should-be-dropped"',
          "ambient_setting = 42",
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: ["gmail"],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      // Substituted block present with only the minimum fields.
      expect(managed).toMatch(/^\[apps\.gmail\]$/m);
      expect(managed).toMatch(/^enabled = true$/m);
      // Arbitrary keys from the source section MUST NOT carry through.
      expect(managed).not.toContain('arbitrary_key = "should-be-dropped"');
      expect(managed).not.toContain("ambient_setting = 42");
      // Source `enabled = false` MUST NOT leak through — substitution
      // emits `enabled = true` canonically.
      expect(managed).not.toMatch(/^enabled = false$/m);
    });

    it("drops destructive_enabled = true from substituted [apps.<name>] blocks even when the connector is in allowWrite", async () => {
      // The runtime invocation-layer gate is authoritative for write
      // classification. Config-file `destructive_enabled = true` on a
      // substituted block MUST NOT be preserved — otherwise the CLI would
      // be informed a write capability is permitted at the manifest
      // layer in contradiction to the runtime gate.
      await seedSourceFile(
        "config.toml",
        [
          "[apps.gmail]",
          "enabled = true",
          "destructive_enabled = true",
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: ["gmail"],
      });

      const managed = await readManagedConfigToml();
      expect(managed).toMatch(/^\[apps\.gmail\]$/m);
      expect(managed).toMatch(/^enabled = true$/m);
      // destructive_enabled MUST NOT survive substitution — runtime
      // enforcement is the sole authority for write capability.
      expect(managed).not.toContain("destructive_enabled");
    });

    it("strips [apps.<name>.tools.<tool>] sub-tables regardless of whether the parent is allowlisted", async () => {
      await seedSourceFile(
        "config.toml",
        [
          "[apps.gmail]",
          "enabled = true",
          "",
          '[apps.gmail.tools."search_emails"]',
          "enabled = true",
          "destructive = false",
          "",
          '[apps.gmail.tools."send_email"]',
          "enabled = true",
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: ["gmail"],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      // Parent app block substituted (since gmail is in allowRead).
      expect(managed).toMatch(/^\[apps\.gmail\]$/m);
      // Sub-table headers MUST be stripped regardless of parent allow state.
      expect(managed).not.toMatch(/\[apps\.gmail\.tools\."search_emails"\]/);
      expect(managed).not.toMatch(/\[apps\.gmail\.tools\."send_email"\]/);
      // Contents of sub-tables MUST NOT survive the strip.
      expect(managed).not.toContain("destructive = false");
    });

    it("strips [mcp_servers.<name>] blocks sourced from known openai-curated hosts", async () => {
      await seedSourceFile(
        "config.toml",
        [
          "[mcp_servers.codex_apps]",
          "enabled = true",
          'command = "codex-app-server"',
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      // Known openai-curated MCP host name `codex_apps` MUST be stripped.
      expect(managed).not.toMatch(/\[mcp_servers\.codex_apps\]/);
      expect(managed).not.toContain('command = "codex-app-server"');
    });

    it("preserves [mcp_servers.<name>] blocks sourced from non-openai-curated hosts", async () => {
      // Paperclip-native MCP server configurations MUST be preserved
      // verbatim — the SYSTEM BOUNDARY prohibits altering connectors
      // intentionally configured inside Paperclip.
      await seedSourceFile(
        "config.toml",
        [
          "[mcp_servers.my_paperclip_plugin]",
          'command = "my-plugin-cmd"',
          "enabled = true",
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      expect(managed).toMatch(/\[mcp_servers\.my_paperclip_plugin\]/);
      expect(managed).toContain('command = "my-plugin-cmd"');
    });

    it("preserves unrelated config sections ([tools], [profile.*]) alongside connector strips", async () => {
      await seedSourceFile(
        "config.toml",
        [
          "[tools]",
          "shell = true",
          "",
          "[profile.default]",
          'model = "gpt-5-codex"',
          'approval_policy = "on-failure"',
          "",
          '[plugins."gmail@openai-curated"]',
          "enabled = true",
          "",
          "[apps.gmail]",
          "enabled = true",
          "",
        ].join("\n"),
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      // Non-connector sections MUST be preserved bit-identically.
      expect(managed).toMatch(/^\[tools\]$/m);
      expect(managed).toMatch(/^shell = true$/m);
      expect(managed).toMatch(/^\[profile\.default\]$/m);
      expect(managed).toContain('model = "gpt-5-codex"');
      expect(managed).toContain('approval_policy = "on-failure"');
      // Connector sections MUST be stripped.
      expect(managed).not.toMatch(/\[plugins\."gmail@openai-curated"\]/);
      expect(managed).not.toMatch(/^\[apps\.gmail\]/m);
    });

    it("appends a minimum [apps.<name>] enabled = true block when an allowlisted connector has no source [apps.<name>] section", async () => {
      // When an operator opts into a connector whose `[apps.<name>]`
      // entry is absent from the source config.toml, the sanitizer must
      // append a minimum block so the Codex CLI can surface the connector.
      await seedSourceFile("config.toml", ['model = "gpt-5-codex"', ""].join("\n"));

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: ["drive"],
        allowWrite: [],
      });

      const managed = await readManagedConfigToml();
      expect(managed).toContain('model = "gpt-5-codex"');
      expect(managed).toMatch(/^\[apps\.drive\]$/m);
      expect(managed).toMatch(/^enabled = true$/m);
    });
  });

  describe("managed home hygiene", () => {
    it("removes a pre-existing plugins/ directory under the managed target home and logs the removal", async () => {
      await seedSourceFile("config.toml", 'model = "gpt-5-codex"\n');

      const targetHome = managedTargetPath();
      const pluginsDir = path.join(targetHome, "plugins");
      await fs.mkdir(pluginsDir, { recursive: true });
      // Seed a nested plugin artifact to ensure recursive removal.
      await fs.writeFile(
        path.join(pluginsDir, "cache-marker.txt"),
        "seed",
        "utf8",
      );

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      // plugins/ directory must have been removed by the hygiene pass.
      await expect(fs.stat(pluginsDir)).rejects.toMatchObject({
        code: "ENOENT",
      });

      // Operator provenance: removal must be logged.
      const log = stdoutLog();
      expect(log).toMatch(/unexpected plugins\//);
      expect(log).toContain(pluginsDir);
    });

    it("does not mutate source CODEX_HOME/plugins/cache/openai-curated/ (read-through only)", async () => {
      // SYSTEM BOUNDARY: `~/.codex/plugins/cache/openai-curated/**` is
      // owned by the Codex CLI. Paperclip MUST NOT delete, modify, or
      // rewrite any file in that subtree under the source CODEX_HOME.
      const sourceCacheFile = path.join(
        sourceHome,
        "plugins",
        "cache",
        "openai-curated",
        "gmail",
        ".app.json",
      );
      const originalContent = '{"name":"gmail","enabled":true}';
      await fs.mkdir(path.dirname(sourceCacheFile), { recursive: true });
      await fs.writeFile(sourceCacheFile, originalContent, "utf8");

      await seedSourceFile("config.toml", 'model = "gpt-5-codex"\n');

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      // Source cache file MUST still exist with original content — the
      // sanitizer only touches the managed target, never the source.
      const stillExists = await fs.readFile(sourceCacheFile, "utf8");
      expect(stillExists).toBe(originalContent);
    });

    it("emits a provenance log enumerating each permitted inherited connector", async () => {
      await seedSourceFile("config.toml", 'model = "gpt-5-codex"\n');

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: ["gmail", "drive"],
        allowWrite: ["github"],
      });

      const log = stdoutLog();
      expect(log).toMatch(/codex_local inherited connectors/);
      // Each permitted connector name must appear somewhere in the log.
      expect(log).toContain("gmail");
      expect(log).toContain("drive");
      expect(log).toContain("github");
      // The label format must enumerate the two lists.
      expect(log).toMatch(/allowRead=\[[^\]]*gmail[^\]]*\]/);
      expect(log).toMatch(/allowWrite=\[[^\]]*github[^\]]*\]/);
    });

    it("emits a provenance log with 'none' when both allowRead and allowWrite are empty", async () => {
      await seedSourceFile("config.toml", 'model = "gpt-5-codex"\n');

      await prepareManagedCodexHome(makeEnv(), onLog, undefined, {
        allowRead: [],
        allowWrite: [],
      });

      const log = stdoutLog();
      expect(log).toMatch(/codex_local inherited connectors/);
      // Empty lists must render as the literal word `none` inside the
      // label brackets so operators can unambiguously identify the
      // default-deny posture from a raw log tail.
      expect(log).toContain("allowRead=[none]");
      expect(log).toContain("allowWrite=[none]");
    });

    it("supports calls that omit the inheritedConnectors argument (default-deny applied; returns string path)", async () => {
      // Backward-compatible call shape — the adapter-side callers that
      // existed prior to the IC4 signature extension still pass
      // (env, onLog, companyId?) and MUST NOT break. When
      // `inheritedConnectors` is omitted the sanitizer applies the
      // default-deny posture and the provenance log emits `none` for
      // both lists.
      await seedSourceFile(
        "config.toml",
        ['model = "gpt-5-codex"', "", "[apps.gmail]", "enabled = true", ""].join(
          "\n",
        ),
      );

      const result = await prepareManagedCodexHome(
        makeEnv(),
        onLog,
        "acme-co",
      );

      // Return value must be the managed target path for the given companyId.
      expect(typeof result).toBe("string");
      expect(result).toBe(managedTargetPath("acme-co"));

      // Default-deny: the source [apps.gmail] block is stripped because
      // no opt-in was supplied.
      const managed = await readManagedConfigToml("acme-co");
      expect(managed).toContain('model = "gpt-5-codex"');
      expect(managed).not.toMatch(/^\[apps\.gmail\]/m);

      // Provenance log still emits the two labels with `none`.
      const log = stdoutLog();
      expect(log).toContain("allowRead=[none]");
      expect(log).toContain("allowWrite=[none]");
    });
  });
});
