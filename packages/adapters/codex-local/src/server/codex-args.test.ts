import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain("currently only supported on gpt-5.4");
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });
});

describe("buildCodexExecArgs bypass approvals and sandbox (GHSA-gqqj-85qm-8qhf)", () => {
  it("does NOT append --dangerously-bypass-approvals-and-sandbox when dangerouslyBypassApprovalsAndSandbox is false", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      dangerouslyBypassApprovalsAndSandbox: false,
    });

    expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("does NOT append --dangerously-bypass-approvals-and-sandbox when dangerouslyBypassApprovalsAndSandbox is omitted", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
    });

    expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("does NOT append --dangerously-bypass-approvals-and-sandbox when both bypass fields are false", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassSandbox: false,
    });

    expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("DOES append --dangerously-bypass-approvals-and-sandbox when dangerouslyBypassApprovalsAndSandbox is explicitly true", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    expect(result.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("DOES append --dangerously-bypass-approvals-and-sandbox when legacy field dangerouslyBypassSandbox is explicitly true", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      dangerouslyBypassSandbox: true,
    });

    expect(result.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});
