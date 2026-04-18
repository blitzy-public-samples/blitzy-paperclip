// @vitest-environment jsdom

/**
 * Regression test for the MAJOR state-management defect addressed by the
 * Checkpoint 3 follow-up fix (see `config-fields.tsx:43-63` for the
 * `effectiveInherited` derivation and commentary).
 *
 * The defect caused edit-mode multi-field configuration of
 * `inheritedConnectors` to silently clobber sibling edits:
 *
 *  1. `eff("adapterConfig", "inheritedConnectors.allowRead", ...)` used a
 *     dotted field name that `eff`'s `in`-operator lookup could never resolve,
 *     so the input always displayed the ORIGINAL (pre-overlay) agent config.
 *  2. `onCommit` spread `config.inheritedConnectors` (the ORIGINAL) when
 *     computing the next overlay value, discarding any prior sibling edit
 *     that the user had made in the same session.
 *
 * Scenario: operator edits `allowRead` to ["gmail"], blurs; then edits
 * `allowWrite` to ["gmail"], blurs. The expected final overlay value is
 * `{ allowRead: ["gmail"], allowWrite: ["gmail"] }`. Before the fix the
 * overlay ended up as `{ allowRead: [], allowWrite: ["gmail"] }` — the
 * `allowRead` edit was silently overwritten.
 *
 * This test drives the real `DraftInput` component (non-immediate, blur
 * commit) through the same stateful harness that `AgentConfigForm` uses,
 * then asserts the final overlay shape and the LAST `mark` call.
 */

import { act, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Radix/shadcn UI primitives used by `agent-config-primitives` to keep
// the test focused on the overlay state-machine. All mocks are passthroughs
// — they do NOT mock `DraftInput`, which is the unit under test (its blur
// commit semantics are what the bug was hiding in).
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/toggle-switch", () => ({
  ToggleSwitch: ({
    checked,
    onChange,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <button
      data-testid="toggle"
      data-checked={checked ? "true" : "false"}
      onClick={() => onChange(!checked)}
    />
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...(props as Record<string, unknown>)}>{children}</button>
  ),
}));

// Minimal `lucide-react` stub — icons aren't exercised structurally in these
// tests. We use an EXPLICIT object (not a `Proxy`) because a `Proxy` that
// returns a value for every property access — including `then`,
// `__esModule`, `Symbol.toStringTag`, and every other meta-property — causes
// vitest's ESM interop to treat the module as a thenable/Promise, which
// results in an infinite hang at module-load time. Only the specific icons
// transitively imported from this test's module graph need to be stubbed:
//   - `agent-config-primitives.tsx`      : HelpCircle, ChevronDown, ChevronRight
//   - `PathInstructionsModal.tsx`        : Apple, Monitor, Terminal
//   - `adapter-display-registry.ts`      : Bot, Code, Gem, MousePointer2,
//                                          Sparkles, Terminal, Cpu
// (The registry is also mocked below, but keeping its icons here keeps the
// mock robust to future refactors.)
vi.mock("lucide-react", () => {
  const FakeIcon = () => null;
  return {
    HelpCircle: FakeIcon,
    ChevronDown: FakeIcon,
    ChevronRight: FakeIcon,
    Apple: FakeIcon,
    Monitor: FakeIcon,
    Terminal: FakeIcon,
    Bot: FakeIcon,
    Code: FakeIcon,
    Gem: FakeIcon,
    MousePointer2: FakeIcon,
    Sparkles: FakeIcon,
    Cpu: FakeIcon,
  };
});

// Avoid pulling the full adapter registry (which imports custom SVG icons).
vi.mock("../adapter-display-registry", () => ({
  getAdapterLabels: () => ({}),
}));

import { CodexLocalConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * React Detect DOM value change helper (see React issue #10140).
 * DraftInput commits via `onBlur` (not `onInput`), but the blur only fires
 * `onCommit(draft)` when `draft !== value`, so we must update the draft via
 * a real input event first.
 */
function setNativeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  const previous = input.value;
  valueSetter?.call(input, value);
  const tracker = (input as HTMLInputElement & {
    _valueTracker?: { setValue: (v: string) => void };
  })._valueTracker;
  tracker?.setValue(previous);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Types a value into a `DraftInput` and commits it by blurring.
 *
 * jsdom's `HTMLElement.prototype.blur()` is a NO-OP unless the element is the
 * current `document.activeElement`. In production browsers the input is
 * naturally focused when the user tabs/clicks into it, so `DraftInput`'s
 * `onBlur` fires on focus-out. In tests we must first `focus()` the input so
 * that a subsequent `blur()` call dispatches a real blur event and triggers
 * React's synthetic `onBlur` handler.
 *
 * Each of the three DOM operations is wrapped in its own `act()` block so
 * React fully flushes state updates between them — this mirrors the order in
 * which the events happen in the browser and makes the `draft !== value`
 * check inside `DraftInput.onBlur` see the latest draft.
 */
function commitViaBlur(input: HTMLInputElement, value: string) {
  act(() => {
    input.focus();
  });
  act(() => {
    setNativeInputValue(input, value);
  });
  act(() => {
    input.blur();
  });
}

/**
 * Stateful harness that mirrors the `overlay[group][field]` storage shape
 * used by `AgentConfigForm`. `eff` reads with the `in`-operator lookup
 * (flat key) exactly as the real implementation does; `mark` writes the
 * whole value under the flat key.
 *
 * This is what the component-under-test interacts with.
 */
function Harness(props: {
  config: Record<string, unknown>;
  onMark?: (field: string, value: unknown) => void;
}) {
  const [adapterConfigOverlay, setAdapterConfigOverlay] = useState<Record<string, unknown>>({});

  const fieldProps = useMemo<AdapterConfigFieldsProps>(() => {
    const eff: AdapterConfigFieldsProps["eff"] = (_group, field, original) => {
      if (field in adapterConfigOverlay) {
        return adapterConfigOverlay[field] as typeof original;
      }
      return original;
    };
    const mark: AdapterConfigFieldsProps["mark"] = (_group, field, value) => {
      // Record for the outer test, then update overlay state so React re-renders
      // with the updated effective value.
      props.onMark?.(field, value);
      setAdapterConfigOverlay((prev) => ({ ...prev, [field]: value }));
    };
    return {
      mode: "edit" as const,
      isCreate: false,
      adapterType: "codex_local",
      values: null,
      set: null,
      config: props.config,
      eff,
      mark,
      models: [],
      hideInstructionsFile: true,
    };
  }, [adapterConfigOverlay, props]);

  return <CodexLocalConfigFields {...fieldProps} />;
}

describe("CodexLocalConfigFields — inheritedConnectors edit-mode overlay state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  /**
   * Finds the `<input>` rendered by the `DraftInput` inside the field whose
   * placeholder identifies it. `allowRead` uses "gmail, gcal, drive";
   * `allowWrite` uses "gmail".
   */
  function findInputByPlaceholder(placeholder: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      `input[placeholder="${placeholder}"]`,
    );
    if (!input) {
      throw new Error(
        `Input with placeholder "${placeholder}" not found. ` +
          `Existing inputs: ${Array.from(container.querySelectorAll("input"))
            .map((el) => el.getAttribute("placeholder") ?? "(no placeholder)")
            .join(", ")}`,
      );
    }
    return input;
  }

  it("preserves sibling field edits: editing allowRead then allowWrite does not clobber allowRead (regression for the dotted-key / currentConfig-spread defect)", () => {
    const onMark = vi.fn<(field: string, value: unknown) => void>();
    root = createRoot(container);

    act(() => {
      root.render(
        <Harness
          config={{
            model: "gpt-5",
            // Simulate an agent that was created with NO inheritedConnectors
            // (default-deny). This is the most realistic starting state.
            inheritedConnectors: { allowRead: [], allowWrite: [] },
          }}
          onMark={onMark}
        />,
      );
    });

    // --- Step 1: user edits allowRead → ["gmail"] ---
    const allowReadInput = findInputByPlaceholder("gmail, gcal, drive");
    commitViaBlur(allowReadInput, "gmail");

    // First `mark` should have written the WHOLE inheritedConnectors object
    // with allowRead populated and allowWrite preserved empty.
    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenLastCalledWith("inheritedConnectors", {
      allowRead: ["gmail"],
      allowWrite: [],
    });

    // --- Step 2: user edits allowWrite → ["gmail"] ---
    // CRITICAL: this is the step that exposed the defect. The onCommit must
    // read the EFFECTIVE (overlay-aware) value, not the original config, so
    // that allowRead=["gmail"] from step 1 is preserved.
    const allowWriteInput = findInputByPlaceholder("gmail");
    commitViaBlur(allowWriteInput, "gmail");

    expect(onMark).toHaveBeenCalledTimes(2);
    expect(onMark).toHaveBeenLastCalledWith("inheritedConnectors", {
      allowRead: ["gmail"],
      allowWrite: ["gmail"],
    });

    // Final overlay must have BOTH edits — the regression would produce
    // `{ allowRead: [], allowWrite: ["gmail"] }` here.
    const finalCall = onMark.mock.calls[onMark.mock.calls.length - 1];
    expect(finalCall).toEqual([
      "inheritedConnectors",
      { allowRead: ["gmail"], allowWrite: ["gmail"] },
    ]);
  });

  it("preserves an existing populated allowWrite when editing allowRead (reverse order: pre-populated config + edit)", () => {
    const onMark = vi.fn<(field: string, value: unknown) => void>();
    root = createRoot(container);

    // Start with a config where allowWrite is pre-populated from persistence.
    // Editing allowRead should NOT wipe the pre-existing allowWrite.
    act(() => {
      root.render(
        <Harness
          config={{
            model: "gpt-5",
            inheritedConnectors: { allowRead: [], allowWrite: ["gcal"] },
          }}
          onMark={onMark}
        />,
      );
    });

    const allowReadInput = findInputByPlaceholder("gmail, gcal, drive");
    commitViaBlur(allowReadInput, "gmail, drive");

    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenLastCalledWith("inheritedConnectors", {
      allowRead: ["gmail", "drive"],
      allowWrite: ["gcal"],
    });
  });

  it("displays overlay value (not original config) after a commit — a user who edits, blurs, then refocuses sees their own edit", () => {
    const onMark = vi.fn<(field: string, value: unknown) => void>();
    root = createRoot(container);

    act(() => {
      root.render(
        <Harness
          config={{
            model: "gpt-5",
            inheritedConnectors: { allowRead: [], allowWrite: [] },
          }}
          onMark={onMark}
        />,
      );
    });

    const allowReadInput = findInputByPlaceholder("gmail, gcal, drive");

    // Initial display reflects the original empty config.
    expect(allowReadInput.value).toBe("");

    commitViaBlur(allowReadInput, "gmail");

    // After blur+commit, the overlay was updated and the component re-rendered.
    // Regression: with the dotted-key `eff` bug, the display would revert to
    // the empty original here.
    const refreshedAllowReadInput = findInputByPlaceholder("gmail, gcal, drive");
    expect(refreshedAllowReadInput.value).toBe("gmail");

    // And the sibling `allowWrite` field should reflect the overlay's preserved
    // empty array (not show stale data).
    const allowWriteInput = findInputByPlaceholder("gmail");
    expect(allowWriteInput.value).toBe("");
  });

  it("trims whitespace and drops empty entries on commit (input sanitization contract)", () => {
    const onMark = vi.fn<(field: string, value: unknown) => void>();
    root = createRoot(container);

    act(() => {
      root.render(
        <Harness
          config={{
            model: "gpt-5",
            inheritedConnectors: { allowRead: [], allowWrite: [] },
          }}
          onMark={onMark}
        />,
      );
    });

    const allowReadInput = findInputByPlaceholder("gmail, gcal, drive");
    commitViaBlur(allowReadInput, "  gmail , , gcal,  ");

    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenLastCalledWith("inheritedConnectors", {
      allowRead: ["gmail", "gcal"],
      allowWrite: [],
    });
  });
});
