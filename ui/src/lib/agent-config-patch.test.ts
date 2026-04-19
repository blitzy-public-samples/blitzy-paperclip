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

  // -------------------------------------------------------------------------
  // Cleared / switch-away coverage for inheritedConnectors
  //
  // Finding 3 (CP3 review, MINOR): add coverage for (f) operator explicitly
  // clears both allowRead and allowWrite on an existing codex_local agent,
  // and (g) operator switches adapter type AWAY from codex_local so the
  // adapter-specific inheritedConnectors field is dropped from the patch.
  //
  // These tests codify the additive-field contract for the opt-in shape and
  // confirm that `inheritedConnectors` is (correctly) NOT included in
  // `ADAPTER_AGNOSTIC_KEYS` — it is codex_local-specific.
  // -------------------------------------------------------------------------

  it("preserves an explicit {allowRead:[], allowWrite:[]} clear on an existing codex_local agent (default-deny round-trip)", () => {
    // Start with an existing codex_local agent whose inheritedConnectors is
    // already populated with both lists — this is the realistic state of an
    // agent that was previously opted in. The operator then edits the agent
    // and explicitly clears both allowlists back to empty arrays.
    const agent = makeAgent();
    agent.adapterType = "codex_local";
    agent.adapterConfig = {
      ...agent.adapterConfig,
      model: "gpt-5.4",
      inheritedConnectors: {
        allowRead: ["gmail", "gcal"],
        allowWrite: ["gmail"],
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        adapterConfig: {
          // Operator's explicit clear — both lists empty. This MUST override
          // the persisted non-empty lists and be round-tripped into the patch
          // as-is (the server-side handler then persists the default-deny
          // state, reverting the agent to the safe posture).
          inheritedConnectors: { allowRead: [], allowWrite: [] },
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
        inheritedConnectors: { allowRead: [], allowWrite: [] },
      },
      replaceAdapterConfig: true,
    });

    // Structural assertion: the cleared field must be PRESENT in the patch
    // with empty arrays — NOT omitted. The runtime gate treats "present but
    // empty" and "absent" as semantically identical (default-deny), but the
    // UI contract is that an explicit clear produces an explicit shape so
    // the server-side persistence overwrites the previously opted-in state.
    expect(patch.adapterConfig).toHaveProperty("inheritedConnectors");
    expect(
      (patch.adapterConfig as { inheritedConnectors: unknown })
        .inheritedConnectors,
    ).toEqual({ allowRead: [], allowWrite: [] });
  });

  it("drops inheritedConnectors when switching AWAY from codex_local to a different adapter (adapter-specific field cleanup)", () => {
    // Start with a codex_local agent whose inheritedConnectors is populated.
    // The operator then switches adapterType to claude_local. Because
    // `inheritedConnectors` is adapter-specific to codex_local (it is NOT
    // in ADAPTER_AGNOSTIC_KEYS), it MUST be dropped from the resulting
    // patch — carrying a codex_local-specific allowlist into a claude_local
    // adapter config would be a shape violation and a confusion hazard.
    const agent = makeAgent();
    agent.adapterType = "codex_local";
    agent.adapterConfig = {
      ...agent.adapterConfig,
      model: "gpt-5.4",
      inheritedConnectors: {
        allowRead: ["gmail"],
        allowWrite: ["gmail"],
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4-6",
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "claude-sonnet-4-6",
      },
      replaceAdapterConfig: true,
    });

    // Explicit structural assertion: inheritedConnectors must NOT appear in
    // the patch. This confirms ADAPTER_AGNOSTIC_KEYS correctly excludes it.
    expect(patch.adapterConfig).not.toHaveProperty("inheritedConnectors");
  });
});
