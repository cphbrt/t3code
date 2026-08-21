import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

type AgentSelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type AgentChoice = AgentSelectDescriptor["options"][number];

/**
 * The expanded agent-profile picker.
 *
 * The popover's select is deliberately name-only, because a description under
 * every option makes a compact control unreadably tall. This is where the
 * descriptions live instead: one row per profile, full text, no truncation and
 * no hover required. It renders descriptor data the client already has, so
 * opening it costs no wire traffic.
 */
export function AgentProfilePickerDialog(props: {
  descriptor: AgentSelectDescriptor;
  selectedValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  /**
   * True once the thread's session exists. The rows become read-only rather
   * than disappearing: the descriptions are the reason this surface exists, and
   * a locked thread is exactly when a user wants to read what the profile it is
   * already running actually does.
   */
  readOnly?: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Agent profile</DialogTitle>
          <DialogDescription>
            {props.readOnly
              ? "Fixed when this thread's session began. Start a new thread to use a different profile."
              : "Sets the system prompt and tool policy for this thread's main agent."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-1">
          <AgentProfileRows
            descriptor={props.descriptor}
            selectedValue={props.selectedValue}
            onSelect={props.onSelect}
            readOnly={props.readOnly ?? false}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The dialog's row list, split out so it can be render-tested directly: the
 * dialog itself renders through a Portal, which produces no markup
 * server-side.
 */
export function AgentProfileRows(props: {
  descriptor: AgentSelectDescriptor;
  selectedValue: string;
  onSelect: (value: string) => void;
  readOnly: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Agent profile">
      {props.descriptor.options.map((option) => (
        <AgentProfileRow
          key={option.id}
          option={option}
          isSelected={option.id === props.selectedValue}
          readOnly={props.readOnly}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

function AgentProfileRow(props: {
  option: AgentChoice;
  isSelected: boolean;
  readOnly: boolean;
  onSelect: (value: string) => void;
}) {
  const { option } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.isSelected}
      // A locked thread can still read every row; it just cannot pick one.
      // `disabled` rather than removing the rows, matching the menu's
      // disabled idiom, because the descriptions are the point of this surface.
      disabled={props.readOnly}
      onClick={() => {
        if (props.readOnly) return;
        props.onSelect(option.id);
      }}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        props.readOnly
          ? "cursor-not-allowed disabled:opacity-64"
          : "cursor-pointer hover:bg-accent/60",
        props.isSelected && "bg-accent/40",
      )}
    >
      <CheckIcon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", props.isSelected ? "opacity-100" : "opacity-0")}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-sm">{option.label}</span>
          {option.declaresModel ? (
            // Honest by requirement: a profile's `model:` frontmatter is inert
            // for the main conversation, so this reports what the profile asks
            // for and says plainly that it does not happen. The model chosen in
            // the picker alongside this one is what actually runs.
            <span className="text-muted-foreground/80 text-xs">
              declares {option.declaresModel} · not applied
            </span>
          ) : null}
        </span>
        {option.description ? (
          // Full text, deliberately unclamped — the popover is where space is
          // scarce, not here.
          <span className="text-pretty text-muted-foreground text-xs">{option.description}</span>
        ) : null}
      </span>
    </button>
  );
}
