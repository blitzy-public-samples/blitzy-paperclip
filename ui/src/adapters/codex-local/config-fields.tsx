import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
} from "@paperclipai/adapter-codex-local";

// WCAG 2.1 AA styling contract for the codex-local config input:
//  - `border-input` consumes the raised `--input` theme token (3.89:1 L / 3.97:1 D)
//    so the field is discernible per 1.4.11 Non-text Contrast.
//  - `placeholder:text-muted-foreground/70` raises placeholder opacity to meet
//    3:1 minimum for informational UI text (1.4.11).
//  - `focus-visible` outline utilities restore the visible focus indicator that
//    the removed `outline-none` used to suppress — required by 2.4.7 Focus Visible.
const inputClass =
  "w-full rounded-md border border-input px-2.5 py-1.5 bg-transparent text-sm font-mono placeholder:text-muted-foreground/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime. Note: Codex may still auto-apply repo-scoped AGENTS.md files from the workspace.";

export function CodexLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const bypassEnabled =
    config.dangerouslyBypassApprovalsAndSandbox === true || config.dangerouslyBypassSandbox === true;
  const fastModeEnabled = isCreate
    ? Boolean(values!.fastMode)
    : eff("adapterConfig", "fastMode", Boolean(config.fastMode));
  const currentModel = isCreate
    ? String(values!.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const fastModeSupported = isCodexLocalFastModeSupported(currentModel);
  const supportedModelsLabel = CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ");

  // Edit-mode overlay-aware read of `inheritedConnectors`. The overlay stores
  // `inheritedConnectors` under a FLAT key (the whole object). We must therefore
  // look it up via `eff("adapterConfig", "inheritedConnectors", ...)` — never via
  // a dotted path like `"inheritedConnectors.allowRead"`, which `eff`'s `in`-operator
  // lookup can never resolve (resulting in silent fallback to the ORIGINAL agent
  // config and, on commit, clobbering prior-field edits via the spread).
  // Mirrors the canonical pattern in `openclaw-gateway/config-fields.tsx:67-91`.
  const configuredInherited =
    config.inheritedConnectors &&
    typeof config.inheritedConnectors === "object" &&
    !Array.isArray(config.inheritedConnectors)
      ? (config.inheritedConnectors as {
          allowRead?: string[];
          allowWrite?: string[];
        })
      : { allowRead: [] as string[], allowWrite: [] as string[] };
  const effectiveInherited = !isCreate
    ? ((eff("adapterConfig", "inheritedConnectors", configuredInherited) as
        | { allowRead?: string[]; allowWrite?: string[] }
        | undefined) ?? { allowRead: [], allowWrite: [] })
    : configuredInherited;

  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <ToggleField
        label="Bypass sandbox"
        // Explicit accessible name for the underlying switch — per the
        // `ToggleField` primitive's JSDoc guidance, security-sensitive
        // toggles SHOULD pass an unambiguous name so assistive technology
        // users understand that flipping this removes Codex approval and
        // sandbox gates. Without this, a screen reader would announce only
        // "Bypass sandbox, switch" which is easy to misread as a general
        // sandbox escape rather than the specific security-critical behavior
        // it controls. WCAG 2.1 AA — 4.1.2 Name, Role, Value.
        ariaLabel="Bypass Codex approval and sandbox gates (security-critical — leave off unless running in a hardened environment)"
        hint={help.dangerouslyBypassSandbox}
        checked={
          isCreate
            ? values!.dangerouslyBypassSandbox
            : eff(
                "adapterConfig",
                "dangerouslyBypassApprovalsAndSandbox",
                bypassEnabled,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslyBypassSandbox: v })
            : mark("adapterConfig", "dangerouslyBypassApprovalsAndSandbox", v)
        }
      />
      <Field
        label="Inherited connectors (read-only)"
        hint={
          help.inheritedConnectorsAllowRead ??
          "Comma-separated connector names (e.g., gmail, gcal, drive). Default-deny: empty means no inherited connectors are exposed to this agent for read actions."
        }
      >
        <DraftInput
          value={
            isCreate
              ? (values!.inheritedConnectors?.allowRead ?? []).join(", ")
              : (effectiveInherited.allowRead ?? []).join(", ")
          }
          onCommit={(v) => {
            const parsed = v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (isCreate) {
              const current =
                values!.inheritedConnectors ?? { allowRead: [], allowWrite: [] };
              set!({
                inheritedConnectors: { ...current, allowRead: parsed },
              });
            } else {
              // Spread the EFFECTIVE (overlay-aware) value so that a prior edit
              // to the sibling `allowWrite` field in the same edit session is
              // preserved. Spreading the raw `config.inheritedConnectors` here
              // would read the ORIGINAL agent config and clobber the sibling.
              mark("adapterConfig", "inheritedConnectors", {
                ...effectiveInherited,
                allowRead: parsed,
              });
            }
          }}
          className={inputClass}
          placeholder="gmail, gcal, drive"
        />
      </Field>
      <Field
        label="Inherited connectors (write)"
        hint={
          help.inheritedConnectorsAllowWrite ??
          "Comma-separated connector names whose WRITE-classified tools (send_*, create_*, update_*, delete_*) may be invoked. DANGEROUS — enables outbound actions on your connected third-party accounts. Independent of read opt-in."
        }
      >
        <DraftInput
          value={
            isCreate
              ? (values!.inheritedConnectors?.allowWrite ?? []).join(", ")
              : (effectiveInherited.allowWrite ?? []).join(", ")
          }
          onCommit={(v) => {
            const parsed = v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (isCreate) {
              const current =
                values!.inheritedConnectors ?? { allowRead: [], allowWrite: [] };
              set!({
                inheritedConnectors: { ...current, allowWrite: parsed },
              });
            } else {
              // Spread the EFFECTIVE (overlay-aware) value so that a prior edit
              // to the sibling `allowRead` field in the same edit session is
              // preserved. See the companion comment on the `allowRead` commit
              // handler above.
              mark("adapterConfig", "inheritedConnectors", {
                ...effectiveInherited,
                allowWrite: parsed,
              });
            }
          }}
          className={inputClass}
          placeholder="gmail"
        />
      </Field>
      <ToggleField
        label="Enable search"
        hint={help.search}
        checked={
          isCreate
            ? values!.search
            : eff("adapterConfig", "search", !!config.search)
        }
        onChange={(v) =>
          isCreate
            ? set!({ search: v })
            : mark("adapterConfig", "search", v)
        }
      />
      <ToggleField
        label="Fast mode"
        hint={help.fastMode}
        checked={fastModeEnabled}
        onChange={(v) =>
          isCreate
            ? set!({ fastMode: v })
            : mark("adapterConfig", "fastMode", v)
        }
      />
      {fastModeEnabled && (
        <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          {fastModeSupported
            ? "Fast mode consumes credits/tokens much faster than standard Codex runs."
            : `Fast mode currently only works on ${supportedModelsLabel}. Paperclip will ignore this toggle until the model is switched.`}
        </div>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}
