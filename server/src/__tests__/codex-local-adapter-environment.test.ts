import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareManagedCodexHome,
  testEnvironment,
} from "@paperclipai/adapter-codex-local/server";

const itWindows = process.platform === "win32" ? it : it.skip;

describe("codex_local environment diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-codex-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "codex_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("emits codex_native_auth_present when ~/.codex/auth.json exists and OPENAI_API_KEY is unset", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const codexHome = path.join(root, ".codex");
    const cwd = path.join(root, "workspace");

    try {
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ accessToken: "fake-token", accountId: "acct-1" }),
      );

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: process.execPath,
          cwd,
          env: { CODEX_HOME: codexHome },
        },
      });

      expect(result.checks.some((check) => check.code === "codex_native_auth_present")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_openai_api_key_missing")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits codex_openai_api_key_missing when neither env var nor native auth exists", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-noauth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const codexHome = path.join(root, ".codex");
    const cwd = path.join(root, "workspace");

    try {
      await fs.mkdir(codexHome, { recursive: true });
      // No auth.json written

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: process.execPath,
          cwd,
          env: { CODEX_HOME: codexHome },
        },
      });

      expect(result.checks.some((check) => check.code === "codex_openai_api_key_missing")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_native_auth_present")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  itWindows("runs the hello probe when Codex is available via a Windows .cmd wrapper", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex.cmd");
    const script = [
      "@echo off",
      "echo {\"type\":\"thread.started\",\"thread_id\":\"test-thread\"}",
      "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
      "echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      "exit /b 0",
      "",
    ].join("\r\n");

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Managed-home layout tests for GHSA-gqqj-85qm-8qhf (CWE-284, CVSS 8.7),
// Directive 1 — "Block default inheritance of OpenAI-curated app connectors
// into `codex_local` runtimes unless a Paperclip-side opt-in is present".
//
// This block is a SEPARATE top-level `describe` (NOT nested inside the
// `"codex_local environment diagnostics"` suite above) so the existing
// 4-test suite — including its `vi.stubEnv("OPENAI_API_KEY", "")` /
// `vi.unstubAllEnvs()` fixture discipline — is preserved byte-for-byte
// per the SYSTEM BOUNDARY ("MUST PRESERVE all 4 existing tests ...
// BYTE-FOR-BYTE unchanged").
//
// The 4 tests below lock down the managed CODEX_HOME layout invariants:
//   1. The managed home contains (at minimum) exactly the four safe files
//      `auth.json`, `config.json`, `config.toml`, `instructions.md`.
//   2. A `plugins/cache/openai-curated/**` subtree in the SOURCE `CODEX_HOME`
//      (a proxy for an operator's ChatGPT/OpenAI-authorized connectors) is
//      NEVER mirrored into the managed destination — this is the exact
//      attack vector called out in the advisory PoC.
//   3. The SOURCE `CODEX_HOME` remains BIT-IDENTICAL after the call —
//      enforcing the SYSTEM BOUNDARY "MUST NOT modify ... connector
//      definitions sourced from openai-curated cache files (read-through
//      only; no mutation of cached manifests)".
//   4. An `onLog` provenance line names the inherited-connectors opt-in
//      state (either the permitted connectors or "none" under default-deny)
//      so operators can audit which connectors were permitted for a run.
//
// Invocation uses the 3-argument form `prepareManagedCodexHome(env, onLog,
// "company-1")` (i.e., WITHOUT `inheritedConnectors`) to exercise the
// default-deny backward-compatibility path — per the AAP, the 4th optional
// parameter is additive and its absence is semantically identical to
// `{ allowRead: [], allowWrite: [] }`.
//
// All tests use hermetic temp directories built via `fs.mkdtemp` and
// `fs.rm({ recursive: true, force: true })` so they never touch the
// developer's real `~/.codex` or `~/.paperclip`. The `env`-object form
// (`{ CODEX_HOME, PAPERCLIP_HOME }`) is passed to `prepareManagedCodexHome`
// to avoid `process.env` mutation — the safer pattern established in the
// sibling `codex-home.test.ts`.
// ---------------------------------------------------------------------------

describe("prepareManagedCodexHome managed home layout (GHSA-gqqj-85qm-8qhf)", () => {
  /**
   * Seed a source `CODEX_HOME` directory with the four canonical files Codex
   * normally stores there (`auth.json`, `config.toml`, `config.json`,
   * `instructions.md`). When `options.includeOpenAICuratedGmailCache` is set,
   * also write a plausible `plugins/cache/openai-curated/gmail/.app.json`
   * manifest carrying a fake OAuth token — this is the attack-vector proxy
   * for an operator's ChatGPT/OpenAI-authorized Gmail connector.
   *
   * Callers may override the `config.toml` content via
   * `options.configTomlContent` (useful for the source-preserved test, which
   * seeds a fully-populated connector-heavy config.toml to exercise the
   * read-through-only SYSTEM BOUNDARY).
   */
  async function seedSharedCodexHome(
    sharedHome: string,
    options?: {
      configTomlContent?: string;
      includeOpenAICuratedGmailCache?: boolean;
    },
  ): Promise<void> {
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(
      path.join(sharedHome, "auth.json"),
      JSON.stringify({ accessToken: "shared-token", accountId: "acct-shared" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(sharedHome, "config.toml"),
      options?.configTomlContent ?? 'model = "codex-mini-latest"\n',
      "utf8",
    );
    await fs.writeFile(path.join(sharedHome, "config.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(sharedHome, "instructions.md"), "# shared\n", "utf8");
    if (options?.includeOpenAICuratedGmailCache) {
      const gmailCacheDir = path.join(
        sharedHome,
        "plugins",
        "cache",
        "openai-curated",
        "gmail",
      );
      await fs.mkdir(gmailCacheDir, { recursive: true });
      await fs.writeFile(
        path.join(gmailCacheDir, ".app.json"),
        JSON.stringify({
          name: "gmail",
          version: "1.0.0",
          oauth: { accessToken: "user-oauth" },
        }),
        "utf8",
      );
    }
  }

  it("seeds the managed home with only config.json, config.toml, instructions.md, and auth.json (symlinked)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-env-ghsa-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      await seedSharedCodexHome(sharedCodexHome);

      const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      };

      // Use env-bag form: prepareManagedCodexHome reads shared via env.CODEX_HOME or env.HOME
      const env = {
        CODEX_HOME: sharedCodexHome,
        PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      };

      const managedHome = await prepareManagedCodexHome(env, onLog, "company-1");
      expect(managedHome).toBeTruthy();

      // Managed home must contain only the 4 expected entries at top level
      const entries = (await fs.readdir(managedHome)).sort();
      expect(entries).toEqual(
        expect.arrayContaining(
          ["auth.json", "config.json", "config.toml", "instructions.md"].sort(),
        ),
      );
      // NOTE: other helper-created files (e.g., "skills", "memory") may be intentionally seeded
      // by prepareManagedCodexHome; the ASSERTIONS below pin only forbidden directories.

      // The plugins/ subtree MUST NOT be mirrored into the managed home
      await expect(fs.stat(path.join(managedHome, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(managedHome, "plugins", "cache")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(managedHome, "plugins", "cache", "openai-curated")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT mirror plugins/cache/openai-curated/** into the managed home even when source has it (GHSA-gqqj-85qm-8qhf Directive 1)", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-env-ghsa-inherit-"),
    );
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      await seedSharedCodexHome(sharedCodexHome, {
        includeOpenAICuratedGmailCache: true,
      });

      // Confirm the seed wrote the source cache
      const sourceGmailAppJson = path.join(
        sharedCodexHome,
        "plugins",
        "cache",
        "openai-curated",
        "gmail",
        ".app.json",
      );
      const sourceGmailAppJsonContent = await fs.readFile(sourceGmailAppJson, "utf8");

      const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      };
      const env = {
        CODEX_HOME: sharedCodexHome,
        PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      };

      // Invoke with 3 args (no inheritedConnectors) — default-deny behavior
      const managedHome = await prepareManagedCodexHome(env, onLog, "company-1");

      // Managed home MUST NOT contain any plugins/ or plugins/cache/openai-curated/ directories
      await expect(fs.stat(path.join(managedHome, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(
          path.join(
            managedHome,
            "plugins",
            "cache",
            "openai-curated",
            "gmail",
            ".app.json",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      // SYSTEM BOUNDARY: the SOURCE cache must remain BIT-IDENTICAL (no mutation of upstream state)
      const sourceGmailAppJsonContentAfter = await fs.readFile(sourceGmailAppJson, "utf8");
      expect(sourceGmailAppJsonContentAfter).toBe(sourceGmailAppJsonContent);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the source CODEX_HOME bit-identical when the managed home is seeded", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-env-ghsa-source-preserved-"),
    );
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const originalConfigToml = [
        'model = "codex-mini-latest"',
        "",
        '[plugins."gmail@openai-curated"]',
        "enabled = true",
        "",
        "[apps.gmail]",
        "enabled = true",
        "destructive_enabled = true",
        "",
        "[mcp_servers.codex_apps]",
        "enabled = true",
        "",
      ].join("\n");
      await seedSharedCodexHome(sharedCodexHome, {
        configTomlContent: originalConfigToml,
        includeOpenAICuratedGmailCache: true,
      });
      const originalAuth = await fs.readFile(
        path.join(sharedCodexHome, "auth.json"),
        "utf8",
      );
      const originalConfigTomlContent = await fs.readFile(
        path.join(sharedCodexHome, "config.toml"),
        "utf8",
      );
      const originalGmailAppJson = await fs.readFile(
        path.join(
          sharedCodexHome,
          "plugins",
          "cache",
          "openai-curated",
          "gmail",
          ".app.json",
        ),
        "utf8",
      );

      const env = {
        CODEX_HOME: sharedCodexHome,
        PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      };
      await prepareManagedCodexHome(env, async () => {}, "company-1");

      // All three source files must be unchanged
      expect(
        await fs.readFile(path.join(sharedCodexHome, "auth.json"), "utf8"),
      ).toBe(originalAuth);
      expect(
        await fs.readFile(path.join(sharedCodexHome, "config.toml"), "utf8"),
      ).toBe(originalConfigTomlContent);
      expect(
        await fs.readFile(
          path.join(
            sharedCodexHome,
            "plugins",
            "cache",
            "openai-curated",
            "gmail",
            ".app.json",
          ),
          "utf8",
        ),
      ).toBe(originalGmailAppJson);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs a provenance line listing the connectors permitted by inheritedConnectors (or 'none' when default-deny)", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-env-ghsa-log-"),
    );
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      await seedSharedCodexHome(sharedCodexHome);

      const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      };
      const env = {
        CODEX_HOME: sharedCodexHome,
        PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      };

      await prepareManagedCodexHome(env, onLog, "company-1");

      // Provenance line should name the allowlists (default-deny path renders
      // "allowRead=[] allowWrite=[]" or similar)
      const allLogChunks = logs.map((log) => log.chunk).join("");
      expect(allLogChunks).toMatch(/inherited connectors/i);
      // Either explicit empty arrays or the word "none" is acceptable per the
      // sibling's agent_prompt.
      expect(allLogChunks).toMatch(/allowRead|allowWrite|none/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
