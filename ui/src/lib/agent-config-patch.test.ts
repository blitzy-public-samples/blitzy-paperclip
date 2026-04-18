// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "./agent-config-patch";

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      env: {
        OPENAI_API_KEY: {
          type: "plain",
          value: "secret",
        },
      },
      promptTemplate: "Work the issue.",
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: {
      canCreateAgents: false,
    },
    metadata: null,
  };
}

function makeOverlay(patch?: Partial<AgentConfigOverlay>): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    heartbeat: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("replaces adapter config and drops env when the last env binding is cleared", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterConfig: {
          env: undefined,
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "claude-sonnet-4-6",
        promptTemplate: "Work the issue.",
      },
      replaceAdapterConfig: true,
    });
  });

  it("preserves adapter-agnostic keys when changing adapter types", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      replaceAdapterConfig: true,
    });
  });

  it("round-trips inheritedConnectors.allowRead when switching to codex_local", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          inheritedConnectors: { allowRead: ["gmail"], allowWrite: [] },
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        inheritedConnectors: { allowRead: ["gmail"], allowWrite: [] },
      },
      replaceAdapterConfig: true,
    });
  });

  it("round-trips inheritedConnectors.allowWrite when switching to codex_local", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          inheritedConnectors: { allowRead: [], allowWrite: ["gmail"] },
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        inheritedConnectors: { allowRead: [], allowWrite: ["gmail"] },
      },
      replaceAdapterConfig: true,
    });
  });

  it("includes inheritedConnectors in the patch when added to an existing codex_local agent", () => {
    const agent = makeAgent();
    agent.adapterType = "codex_local";
    agent.adapterConfig = {
      ...agent.adapterConfig,
      model: "gpt-5.4",
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        adapterConfig: {
          inheritedConnectors: { allowRead: ["gmail", "gcal"], allowWrite: [] },
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "gpt-5.4",
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        inheritedConnectors: { allowRead: ["gmail", "gcal"], allowWrite: [] },
      },
      replaceAdapterConfig: true,
    });
  });

  it("does not inject inheritedConnectors when the overlay omits it", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
      },
      replaceAdapterConfig: true,
    });
    expect(patch.adapterConfig).not.toHaveProperty("inheritedConnectors");
  });

  it("does not inject a hard-coded dangerouslyBypassApprovalsAndSandbox when switching to codex_local", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
        },
      }),
    );

    expect(patch.adapterConfig).not.toHaveProperty(
      "dangerouslyBypassApprovalsAndSandbox",
    );
    expect(patch.adapterConfig).not.toHaveProperty("dangerouslyBypassSandbox");
  });
});
