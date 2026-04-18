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

  // -------------------------------------------------------------------------
  // Managed-home layout tests for GHSA-gqqj-85qm-8qhf (Directive 1, Layer 0).
  //
  // These tests call prepareManagedCodexHome directly (via the adapter's
  // /server subpath barrel) and assert structural properties of the seeded
  // Paperclip-managed CODEX_HOME directory. Specifically, they guard:
  //   - Top-level entries: ONLY auth.json, config.json, config.toml,
  //     instructions.md MAY appear.
  //   - No plugins/ directory (even if the source CODEX_HOME contains one).
  //   - No plugins/cache/openai-curated/** subtree (read-through from source
  //     MUST NOT be mirrored).
  //   - config.toml sanitization at the copy site strips
  //     [plugins."*@openai-curated"], [apps.*], [apps.*.tools.*], and
  //     openai-curated [mcp_servers.*] tables under default-deny.
  //
  // Each test uses a hermetic root directory under os.tmpdir() and cleans
  // up via fs.rm recursive.
  // -------------------------------------------------------------------------

  it("seeds managed CODEX_HOME with only the four permitted entries (auth.json, config.json, config.toml, instructions.md)", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-mh-layout-only-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sourceHome = path.join(root, "source-codex");
    const paperclipHome = path.join(root, "paperclip-home");

    try {
      // Seed source with the four expected entries plus extraneous items
      // that MUST NOT be mirrored into the managed home.
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ accessToken: "fake-token" }),
      );
      await fs.writeFile(path.join(sourceHome, "config.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "config.toml"), "");
      await fs.writeFile(path.join(sourceHome, "instructions.md"), "# notes\n");
      // Extraneous entries — must NOT appear under managed home.
      await fs.writeFile(path.join(sourceHome, "session.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "random-other-file"), "x");
      await fs.mkdir(path.join(sourceHome, "history"), { recursive: true });
      await fs.writeFile(path.join(sourceHome, "history", "log.txt"), "entry");

      const managedHome = await prepareManagedCodexHome(
        { CODEX_HOME: sourceHome, PAPERCLIP_HOME: paperclipHome } as NodeJS.ProcessEnv,
        async () => undefined,
        undefined,
        { allowRead: [], allowWrite: [] },
      );

      const entries = (await fs.readdir(managedHome)).sort();
      expect(entries).toEqual(
        ["auth.json", "config.json", "config.toml", "instructions.md"].sort(),
      );
      // Extraneous entries are NOT mirrored.
      expect(entries).not.toContain("session.json");
      expect(entries).not.toContain("random-other-file");
      expect(entries).not.toContain("history");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not mirror a source plugins/ directory into the managed CODEX_HOME", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-mh-no-plugins-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sourceHome = path.join(root, "source-codex");
    const paperclipHome = path.join(root, "paperclip-home");

    try {
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(path.join(sourceHome, "auth.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "config.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "config.toml"), "");
      await fs.writeFile(path.join(sourceHome, "instructions.md"), "# notes\n");
      // Source has a plugins/ tree.
      await fs.mkdir(path.join(sourceHome, "plugins", "cache"), { recursive: true });
      await fs.writeFile(path.join(sourceHome, "plugins", "readme.txt"), "marker");

      const managedHome = await prepareManagedCodexHome(
        { CODEX_HOME: sourceHome, PAPERCLIP_HOME: paperclipHome } as NodeJS.ProcessEnv,
        async () => undefined,
        undefined,
        { allowRead: [], allowWrite: [] },
      );

      // The managed home MUST NOT contain a plugins/ directory.
      await expect(fs.stat(path.join(managedHome, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not mirror source plugins/cache/openai-curated/** subtree into the managed CODEX_HOME", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-mh-no-curated-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sourceHome = path.join(root, "source-codex");
    const paperclipHome = path.join(root, "paperclip-home");

    try {
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(path.join(sourceHome, "auth.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "config.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "config.toml"), "");
      await fs.writeFile(path.join(sourceHome, "instructions.md"), "# notes\n");
      // Source has a rich openai-curated cache tree with multiple connectors.
      const curatedRoot = path.join(
        sourceHome,
        "plugins",
        "cache",
        "openai-curated",
      );
      await fs.mkdir(path.join(curatedRoot, "gmail"), { recursive: true });
      await fs.mkdir(path.join(curatedRoot, "drive"), { recursive: true });
      await fs.mkdir(path.join(curatedRoot, "github"), { recursive: true });
      await fs.writeFile(
        path.join(curatedRoot, "gmail", ".app.json"),
        JSON.stringify({ name: "gmail", enabled: true }),
      );
      await fs.writeFile(
        path.join(curatedRoot, "drive", ".app.json"),
        JSON.stringify({ name: "drive", enabled: true }),
      );
      await fs.writeFile(
        path.join(curatedRoot, "github", ".app.json"),
        JSON.stringify({ name: "github", enabled: true }),
      );

      const managedHome = await prepareManagedCodexHome(
        { CODEX_HOME: sourceHome, PAPERCLIP_HOME: paperclipHome } as NodeJS.ProcessEnv,
        async () => undefined,
        undefined,
        { allowRead: [], allowWrite: [] },
      );

      // No portion of the openai-curated cache subtree is mirrored into the
      // managed home — the entire plugins/ directory is absent by construction.
      await expect(fs.stat(path.join(managedHome, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(managedHome, "plugins", "cache", "openai-curated")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(managedHome, "plugins", "cache", "openai-curated", "gmail", ".app.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      // The source subtree is untouched (read-through only, per SYSTEM BOUNDARIES).
      const sourceGmail = await fs.readFile(
        path.join(curatedRoot, "gmail", ".app.json"),
        "utf8",
      );
      expect(JSON.parse(sourceGmail)).toEqual({ name: "gmail", enabled: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("strips [plugins.*@openai-curated], [apps.*], and openai-curated [mcp_servers.*] connector tables from the managed config.toml under default-deny", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-mh-sanitize-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sourceHome = path.join(root, "source-codex");
    const paperclipHome = path.join(root, "paperclip-home");

    try {
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(path.join(sourceHome, "auth.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "config.json"), "{}");
      await fs.writeFile(path.join(sourceHome, "instructions.md"), "# notes\n");
      // Source config.toml carries all three categories of connector entries
      // that Layer 0 defense MUST strip under default-deny.
      await fs.writeFile(
        path.join(sourceHome, "config.toml"),
        [
          'model = "gpt-5-codex"',
          "",
          '[plugins."gmail@openai-curated"]',
          "enabled = true",
          "",
          "[apps.gmail]",
          "enabled = true",
          "destructive_enabled = true",
          "",
          '[apps.gmail.tools."send_email"]',
          "enabled = true",
          "",
          "[mcp_servers.codex_apps]",
          'command = "some-cli"',
          "",
          "[tools]",
          "shell = true",
          "",
        ].join("\n"),
      );

      const managedHome = await prepareManagedCodexHome(
        { CODEX_HOME: sourceHome, PAPERCLIP_HOME: paperclipHome } as NodeJS.ProcessEnv,
        async () => undefined,
        undefined,
        { allowRead: [], allowWrite: [] },
      );

      const sanitized = await fs.readFile(
        path.join(managedHome, "config.toml"),
        "utf8",
      );

      // All three connector categories stripped.
      expect(sanitized).not.toMatch(/^\[plugins\."gmail@openai-curated"\]/m);
      expect(sanitized).not.toMatch(/^\[apps\.gmail\]/m);
      expect(sanitized).not.toMatch(/^\[apps\.gmail\.tools\."send_email"\]/m);
      expect(sanitized).not.toMatch(/^\[mcp_servers\.codex_apps\]/m);
      // Specifically no destructive_enabled leak.
      expect(sanitized).not.toMatch(/destructive_enabled\s*=\s*true/);
      // Non-connector sections and top-level preamble preserved verbatim.
      expect(sanitized).toMatch(/^model\s*=\s*"gpt-5-codex"/m);
      expect(sanitized).toMatch(/^\[tools\]/m);
      expect(sanitized).toMatch(/^shell\s*=\s*true/m);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
