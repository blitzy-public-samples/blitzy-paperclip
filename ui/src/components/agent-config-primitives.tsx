import { useState, useRef, useEffect, useCallback, useId, createContext, useContext } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpCircle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

/* ---- Help text for (?) tooltips ---- */
export const help: Record<string, string> = {
  name: "Display name for this agent.",
  title: "Job title shown in the org chart.",
  role: "Organizational role. Determines position and capabilities.",
  reportsTo: "The agent this one reports to in the org hierarchy.",
  capabilities: "Describes what this agent can do. Shown in the org chart and used for task routing.",
  adapterType: "How this agent runs: local CLI (Claude/Codex/OpenCode), OpenClaw Gateway, spawned process, or generic HTTP webhook.",
  cwd: "Deprecated legacy working directory fallback for local adapters. Existing agents may still carry this value, but new configurations should use project workspaces instead.",
  promptTemplate: "Sent on every heartbeat. Keep this small and dynamic. Use it for current-task framing, not large static instructions. Supports {{ agent.id }}, {{ agent.name }}, {{ agent.role }} and other template variables.",
  model: "Override the default model used by the adapter.",
  thinkingEffort: "Control model reasoning depth. Supported values vary by adapter/model.",
  chrome: "Enable Claude's Chrome integration by passing --chrome.",
  dangerouslySkipPermissions: "Run unattended by auto-approving adapter permission prompts when supported.",
  dangerouslyBypassSandbox: "Run Codex without sandbox/approvals gates. DANGEROUS — only enable in a hardened environment. This setting is off by default as of GHSA-gqqj-85qm-8qhf.",
  inheritedConnectorsAllowRead: "Comma-separated list of ChatGPT/OpenAI-curated connector names (e.g., gmail, gcal, drive) whose read-classified tools (get_*, search_*, list_*) may be invoked from this agent. Default-deny: empty means no inherited connectors are available for reading.",
  inheritedConnectorsAllowWrite: "Comma-separated list of connector names whose WRITE-classified tools (send_*, create_*, update_*, delete_*) may be invoked. DANGEROUS — write opt-in enables outbound actions on your connected third-party accounts. Independent of allowRead; listing here does NOT implicitly grant read.",
  search: "Enable Codex web search capability during runs.",
  fastMode: "Enable Codex Fast mode. This burns credits/tokens much faster and is currently supported on GPT-5.4 only.",
  workspaceStrategy: "How Paperclip should realize an execution workspace for this agent. Keep project_primary for normal cwd execution, or use git_worktree for issue-scoped isolated checkouts.",
  workspaceBaseRef: "Base git ref used when creating a worktree branch. Leave blank to use the resolved workspace ref or HEAD.",
  workspaceBranchTemplate: "Template for naming derived branches. Supports {{issue.identifier}}, {{issue.title}}, {{agent.name}}, {{project.id}}, {{workspace.repoRef}}, and {{slug}}.",
  worktreeParentDir: "Directory where derived worktrees should be created. Absolute, ~-prefixed, and repo-relative paths are supported.",
  runtimeServicesJson: "Optional workspace runtime service definitions. Use this for shared app servers, workers, or other long-lived companion processes attached to the workspace.",
  maxTurnsPerRun: "Maximum number of agentic turns (tool calls) per heartbeat run.",
  command: "The command to execute (e.g. node, python).",
  localCommand: "Override the path to the CLI command you want the adapter to call (e.g. /usr/local/bin/claude, codex, opencode).",
  args: "Command-line arguments, comma-separated.",
  extraArgs: "Extra CLI arguments for local adapters, comma-separated.",
  envVars: "Environment variables injected into the adapter process. Use plain values or secret references.",
  bootstrapPrompt: "Only sent when Paperclip starts a fresh session. Use this for stable setup guidance that should not be repeated on every heartbeat.",
  payloadTemplateJson: "Optional JSON merged into remote adapter request payloads before Paperclip adds its standard wake and workspace fields.",
  webhookUrl: "The URL that receives POST requests when the agent is invoked.",
  heartbeatInterval: "Run this agent automatically on a timer. Useful for periodic tasks like checking for new work.",
  intervalSec: "Seconds between automatic heartbeat invocations.",
  timeoutSec: "Maximum seconds a run can take before being terminated. 0 means no timeout.",
  graceSec: "Seconds to wait after sending interrupt before force-killing the process.",
  wakeOnDemand: "Allow this agent to be woken by assignments, API calls, UI actions, or automated systems.",
  cooldownSec: "Minimum seconds between consecutive heartbeat runs.",
  maxConcurrentRuns: "Maximum number of heartbeat runs that can execute simultaneously for this agent.",
  budgetMonthlyCents: "Monthly spending limit in cents. 0 means no limit.",
};

import { getAdapterLabels } from "../adapters/adapter-display-registry";

export const adapterLabels = getAdapterLabels();

export const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/* ---- Primitive components ---- */

/**
 * Context that propagates a generated `id` from a labelled container (`Field`,
 * `InlineField`, etc.) down to nested input primitives so that form controls
 * can automatically wire up `id`/`htmlFor` associations for screen readers
 * (WCAG 2.1 AA — 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value).
 */
const FieldContext = createContext<{ id: string } | null>(null);

/**
 * Consumer hook used by input primitives (`DraftInput`, `DraftTextarea`,
 * `DraftNumberInput`, `AutoExpandTextarea`) to retrieve the container-
 * provided `id`. Returns `undefined` when the input is not rendered inside
 * a `Field`/`InlineField` (in which case the caller retains full control
 * over the `id` attribute via props).
 */
function useFieldId(): string | undefined {
  return useContext(FieldContext)?.id;
}

export function HintIcon({ text, ariaLabel }: { text: string; ariaLabel?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? text}
          className="inline-flex rounded-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        >
          <HelpCircle className="h-3 w-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function Field({
  label,
  hint,
  children,
  id: idProp,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /**
   * Optional id override. When omitted, a stable id is generated via
   * `useId()` and provided through `FieldContext` so nested input primitives
   * (`DraftInput`, `DraftTextarea`, `DraftNumberInput`, `AutoExpandTextarea`)
   * can pick it up automatically for `<label htmlFor>` → `<input id>`
   * association. WCAG 2.1 AA — 1.3.1 Info and Relationships, 4.1.2 Name,
   * Role, Value.
   */
  id?: string;
}) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
        {hint && <HintIcon text={hint} ariaLabel={`${label} — help`} />}
      </div>
      <FieldContext.Provider value={{ id }}>{children}</FieldContext.Provider>
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  toggleTestId,
  ariaLabel,
  id: idProp,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  toggleTestId?: string;
  /**
   * Optional explicit accessible name for the underlying switch. Defaults to
   * the visible `label` text. Security-sensitive toggles (e.g. "Bypass
   * sandbox") SHOULD pass an explicit value to make the purpose unambiguous
   * for assistive technology. WCAG 2.1 AA — 4.1.2 Name, Role, Value.
   */
  ariaLabel?: string;
  id?: string;
}) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-xs text-muted-foreground cursor-pointer">
          {label}
        </label>
        {hint && <HintIcon text={hint} ariaLabel={`${label} — help`} />}
      </div>
      <ToggleSwitch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-label={ariaLabel ?? label}
        data-testid={toggleTestId}
      />
    </div>
  );
}

export function ToggleWithNumber({
  label,
  hint,
  checked,
  onCheckedChange,
  number,
  onNumberChange,
  numberLabel,
  numberHint,
  numberPrefix,
  showNumber,
  ariaLabel,
  numberAriaLabel,
  id: idProp,
  numberId: numberIdProp,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  number: number;
  onNumberChange: (v: number) => void;
  numberLabel: string;
  numberHint?: string;
  numberPrefix?: string;
  showNumber: boolean;
  /**
   * Optional explicit accessible name for the toggle switch. Defaults to the
   * visible `label` text. WCAG 2.1 AA — 4.1.2 Name, Role, Value.
   */
  ariaLabel?: string;
  /**
   * Optional explicit accessible name for the number input. Defaults to a
   * composite of `numberPrefix` + visible `numberLabel` so screen readers
   * announce the full control purpose (e.g. "Every 30 seconds"). WCAG 2.1 AA
   * — 4.1.2, 1.3.1.
   */
  numberAriaLabel?: string;
  id?: string;
  numberId?: string;
}) {
  const generatedToggleId = useId();
  const generatedNumberId = useId();
  const toggleId = idProp ?? generatedToggleId;
  const numberInputId = numberIdProp ?? generatedNumberId;
  const composedNumberAriaLabel =
    numberAriaLabel ??
    (numberPrefix ? `${numberPrefix} ${numberLabel}`.trim() : numberLabel);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <label
            htmlFor={toggleId}
            className="text-xs text-muted-foreground cursor-pointer"
          >
            {label}
          </label>
          {hint && <HintIcon text={hint} ariaLabel={`${label} — help`} />}
        </div>
        <ToggleSwitch
          id={toggleId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={ariaLabel ?? label}
        />
      </div>
      {showNumber && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {numberPrefix && <span>{numberPrefix}</span>}
          <input
            id={numberInputId}
            type="number"
            aria-label={composedNumberAriaLabel}
            className="w-16 rounded-md border border-input px-2 py-0.5 bg-transparent text-xs font-mono text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            value={number}
            onChange={(e) => onNumberChange(Number(e.target.value))}
          />
          <label htmlFor={numberInputId} className="cursor-pointer">
            {numberLabel}
          </label>
          {numberHint && (
            <HintIcon text={numberHint} ariaLabel={`${numberLabel} — help`} />
          )}
        </div>
      )}
    </div>
  );
}

export function CollapsibleSection({
  title,
  icon,
  open,
  onToggle,
  bordered,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  // Use a stable id tying the disclosure button to its region so AT users
  // can navigate between the trigger and the revealed content. WCAG 2.1 AA
  // — 4.1.2 Name, Role, Value (aria-expanded/aria-controls).
  const regionId = useId();
  return (
    <div className={cn(bordered && "border-t border-border")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        className="flex items-center gap-2 w-full px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/30 hover:text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 focus-visible:rounded-sm"
        onClick={onToggle}
      >
        {open ? <ChevronDown aria-hidden className="h-3 w-3" /> : <ChevronRight aria-hidden className="h-3 w-3" />}
        {icon}
        {title}
      </button>
      {open && <div id={regionId} className="px-4 pb-3">{children}</div>}
    </div>
  );
}

export function AutoExpandTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  minRows,
  id: idProp,
  "aria-label": ariaLabelProp,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minRows?: number;
} & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange" | "onBlur" | "placeholder" | "style" | "ref"
>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;
  // Auto-wire the `id` from the surrounding <Field> so `<label htmlFor>`
  // associates with this textarea. Explicit prop takes precedence. WCAG
  // 2.1 AA — 1.3.1, 4.1.2.
  const contextId = useFieldId();
  const id = idProp ?? contextId;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      aria-label={ariaLabelProp}
      className="w-full rounded-md border border-input px-2.5 py-1.5 bg-transparent text-sm font-mono placeholder:text-muted-foreground/70 resize-none overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      style={{ minHeight }}
      {...rest}
    />
  );
}

/**
 * Text input that manages internal draft state.
 * Calls `onCommit` on blur (and optionally on every change if `immediate` is set).
 *
 * Auto-consumes the nearest `<Field>` id via {@link useFieldId} so the
 * surrounding `<label htmlFor>` associates with this input unless an explicit
 * `id` prop is supplied. WCAG 2.1 AA — 1.3.1 Info and Relationships,
 * 4.1.2 Name, Role, Value.
 */
export function DraftInput({
  value,
  onCommit,
  immediate,
  className,
  id: idProp,
  ...props
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const contextId = useFieldId();
  const id = idProp ?? contextId;

  return (
    <input
      id={id}
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      {...props}
    />
  );
}

/**
 * Auto-expanding textarea with draft state and blur-commit.
 *
 * Accepts all standard `<textarea>` attributes (except the reserved
 * `value`/`onChange`/`onBlur`/`placeholder`/`style`/`ref`) so callers may
 * supply `aria-label`, `aria-describedby`, etc. When no explicit `id` is
 * provided, the `id` from the surrounding `<Field>` is auto-consumed via
 * {@link useFieldId} so `<label htmlFor>` associates with the textarea.
 * WCAG 2.1 AA — 1.3.1, 2.4.7, 4.1.2.
 */
export function DraftTextarea({
  value,
  onCommit,
  immediate,
  placeholder,
  minRows,
  id: idProp,
  "aria-label": ariaLabelProp,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  placeholder?: string;
  minRows?: number;
} & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange" | "onBlur" | "placeholder" | "style" | "ref"
>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;
  const contextId = useFieldId();
  const id = idProp ?? contextId;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [draft, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      aria-label={ariaLabelProp}
      className="w-full rounded-md border border-input px-2.5 py-1.5 bg-transparent text-sm font-mono placeholder:text-muted-foreground/70 resize-none overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      style={{ minHeight }}
      {...rest}
    />
  );
}

/**
 * Number input with draft state and blur-commit.
 *
 * Auto-consumes the nearest `<Field>` id via {@link useFieldId} so the
 * surrounding `<label htmlFor>` associates with this input unless an explicit
 * `id` prop is supplied. WCAG 2.1 AA — 1.3.1, 4.1.2.
 */
export function DraftNumberInput({
  value,
  onCommit,
  immediate,
  className,
  id: idProp,
  ...props
}: {
  value: number;
  onCommit: (v: number) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className" | "type">) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const contextId = useFieldId();
  const id = idProp ?? contextId;

  return (
    <input
      id={id}
      type="number"
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(Number(e.target.value) || 0);
      }}
      onBlur={() => {
        const num = Number(draft) || 0;
        if (num !== value) onCommit(num);
      }}
      {...props}
    />
  );
}

/**
 * "Choose" button that opens a dialog explaining the user must manually
 * type the path due to browser security limitations.
 */
export function ChoosePathButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center rounded-md border border-input px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        onClick={() => setOpen(true)}
      >
        Choose
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Specify path manually</DialogTitle>
            <DialogDescription>
              Browser security blocks apps from reading full local paths via a file picker.
              Copy the absolute path and paste it into the input.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">macOS (Finder)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Find the folder in Finder.</li>
                <li>Hold <kbd>Option</kbd> and right-click the folder.</li>
                <li>Click "Copy &lt;folder name&gt; as Pathname".</li>
                <li>Paste the result into the path input.</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">Windows (File Explorer)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Find the folder in File Explorer.</li>
                <li>Hold <kbd>Shift</kbd> and right-click the folder.</li>
                <li>Click "Copy as path".</li>
                <li>Paste the result into the path input.</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                C:\Users\yourname\Documents\project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">Terminal fallback (macOS/Linux)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Run <code>cd /path/to/folder</code>.</li>
                <li>Run <code>pwd</code>.</li>
                <li>Copy the output and paste it into the path input.</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Label + input rendered on the same line (inline layout for compact fields).
 *
 * The `<label>` is wired to the child control via `htmlFor` / `id`. An `id`
 * is auto-generated when not supplied, and the child control auto-consumes
 * that id through the `FieldContext` provided below. Callers using
 * primitives that do not consume the context may pass an explicit `id`
 * and pair it with a matching `id` attribute on the rendered control.
 * WCAG 2.1 AA — 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value.
 */
export function InlineField({
  label,
  hint,
  children,
  id: idProp,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  id?: string;
}) {
  const reactId = useId();
  const id = idProp ?? reactId;
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 shrink-0">
        <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} ariaLabel={`${label} — help`} />}
      </div>
      <div className="w-24 ml-auto">
        <FieldContext.Provider value={{ id }}>
          {children}
        </FieldContext.Provider>
      </div>
    </div>
  );
}
