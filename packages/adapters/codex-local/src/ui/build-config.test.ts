import { describe, expect, it } from "vitest";
import { buildCodexLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gpt-5.4",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildCodexLocalConfig", () => {
  it("persists the fastMode toggle into adapter config", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        search: true,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it("defaults dangerouslyBypassApprovalsAndSandbox to false when dangerouslyBypassSandbox is omitted (GHSA-gqqj-85qm-8qhf)", () => {
    // Simulate the runtime case where callers omit the bypass field entirely.
    // CreateConfigValues declares this field as required for type safety, but the
    // runtime must handle absence per AAP SYSTEM BOUNDARIES ("MUST preserve existing
    // behavior for agents where callers explicitly pass dangerouslyBypassApprovalsAndSandbox;
    // only the default changes"). The cast models the real-world untyped payload flow.
    const { dangerouslyBypassSandbox: _omitted, ...rest } = makeValues();
    const config = buildCodexLocalConfig(rest as CreateConfigValues);

    expect(config).toMatchObject({
      dangerouslyBypassApprovalsAndSandbox: false,
    });
  });

  it("preserves dangerouslyBypassApprovalsAndSandbox = false when caller explicitly passes false", () => {
    const config = buildCodexLocalConfig(
      makeValues({ dangerouslyBypassSandbox: false }),
    );

    expect(config).toMatchObject({
      dangerouslyBypassApprovalsAndSandbox: false,
    });
  });

  it("omits inheritedConnectors on built config when not provided on input (GHSA-gqqj-85qm-8qhf)", () => {
    const config = buildCodexLocalConfig(makeValues());

    expect(config).not.toHaveProperty("inheritedConnectors");
  });

  it("forwards inheritedConnectors.allowRead when provided (read opt-in)", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        inheritedConnectors: { allowRead: ["gmail"], allowWrite: [] },
      }),
    );

    expect(config).toHaveProperty("inheritedConnectors");
    expect(
      (config as { inheritedConnectors: { allowRead?: string[] } })
        .inheritedConnectors.allowRead,
    ).toEqual(["gmail"]);
  });

  it("forwards inheritedConnectors.allowWrite when provided (write opt-in)", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        inheritedConnectors: { allowRead: [], allowWrite: ["gmail"] },
      }),
    );

    expect(config).toHaveProperty("inheritedConnectors");
    expect(
      (config as { inheritedConnectors: { allowWrite?: string[] } })
        .inheritedConnectors.allowWrite,
    ).toEqual(["gmail"]);
  });

  it("trims whitespace and filters empty strings from connector names", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        inheritedConnectors: {
          allowRead: [" gmail ", "", "drive", "   "],
          allowWrite: [],
        },
      }),
    );

    expect(
      (config as { inheritedConnectors: { allowRead?: string[] } })
        .inheritedConnectors.allowRead,
    ).toEqual(["gmail", "drive"]);
  });

  it("omits inheritedConnectors when both arrays are empty (default-deny preserved by absence)", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        inheritedConnectors: { allowRead: [], allowWrite: [] },
      }),
    );

    expect(config).not.toHaveProperty("inheritedConnectors");
  });
});
