import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ListIcon, UserRoundCogIcon, ZapIcon } from "lucide-react";
import { buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { AgentProfilePickerDialog } from "./AgentProfilePickerDialog";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelOptionDescriptors } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/** Descriptor id of the Claude agent-profile select. */
const AGENT_DESCRIPTOR_ID = "agent";

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function DefaultBadge() {
  return (
    <Badge
      variant="outline"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center gap-0 border-border/70 bg-muted/60 px-1.5 py-0 font-semibold text-[10px] text-muted-foreground leading-none sm:h-4"
    >
      Default
    </Badge>
  );
}

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

/**
 * Whether a select descriptor is the agent-profile one and must render
 * read-only. Claude reads its system prompt only when the session is created,
 * so once a session exists a mid-thread change would silently do nothing —
 * the control stays visible showing the active profile rather than offering an
 * edit that cannot take effect.
 */
export function isAgentSelectLocked(input: {
  descriptorId: string;
  threadHasProviderSession: boolean;
}): boolean {
  return input.descriptorId === AGENT_DESCRIPTOR_ID && input.threadHasProviderSession;
}

/**
 * The agent-profile label to show on the collapsed trigger, or null when there
 * is nothing worth the horizontal space. The descriptor's own default choice —
 * "None" today — is the overwhelmingly common case and stays silent; reading
 * the default off the descriptor rather than hardcoding its id keeps this
 * correct if the server ever changes it. A real profile is named because the
 * selection is sticky across new threads and would otherwise be discoverable
 * only by opening the popover.
 *
 * Falls back to the raw value when the option is missing: the server
 * deliberately does not clamp the selection against the discovered list, so a
 * persisted worktree-local profile can outlive its option.
 */
export function getAgentTriggerLabel(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null | undefined,
): string | null {
  if (!descriptor || descriptor.id !== AGENT_DESCRIPTOR_ID) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  if (typeof value !== "string") {
    return null;
  }
  const defaultOptionId = descriptor.options.find((option) => option.isDefault)?.id;
  if (value === defaultOptionId) {
    return null;
  }
  return getProviderOptionCurrentLabel(descriptor) ?? value;
}

/**
 * The single row a locked agent select shows. Read-only means showing the
 * active profile, not a wall of greyed-out alternatives the user cannot pick.
 *
 * Synthesizes a row when the value is not among the options, so the popover
 * always agrees with the trigger rather than rendering an empty group. Reached
 * only when callers pass a raw selection: `getProviderOptionDescriptors`
 * clamps an unlisted value to the default before it gets here.
 */
export function getLockedAgentOptions(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  selectedValue: string,
): ReadonlyArray<Extract<ProviderOptionDescriptor, { type: "select" }>["options"][number]> {
  const matching = descriptor.options.filter((option) => option.id === selectedValue);
  return matching.length > 0 ? matching : [{ id: selectedValue, label: selectedValue }];
}

/**
 * Resolve the descriptors this picker renders.
 *
 * Shared with the dispatch payload via `getProviderModelOptionDescriptors`, so
 * the agent-profile injection applies to both and the picker can never display
 * a different profile than the one actually sent.
 */
function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const descriptors = getProviderModelOptionDescriptors({
    models,
    model,
    provider,
    selections: modelOptions,
  });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === AGENT_DESCRIPTOR_ID) ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);

  return {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  /**
   * True once the thread owns a provider session, which locks the agent-profile
   * select. Defaults to false so the settings surfaces, which edit new-thread
   * defaults and have no session at all, keep it editable.
   */
  threadHasProviderSession?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  threadHasProviderSession = false,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  // Owned here rather than by TraitsPicker because this content is also
  // rendered inside CompactComposerControlsMenu's popup, a menu it does not
  // own. Keeping the dialog with the row that opens it is the only placement
  // that reaches both surfaces.
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    agentDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    // Ahead of every side effect below: a keyboard or programmatic pick must
    // not persist a profile the running session will never read.
    if (isAgentSelectLocked({ descriptorId: descriptor.id, threadHasProviderSession })) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => {
        const selectedValue =
          ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
            ? "ultrathink"
            : (getDescriptorStringValue(descriptor) ?? "");
        const agentLocked = isAgentSelectLocked({
          descriptorId: descriptor.id,
          threadHasProviderSession,
        });
        const isAgentDescriptor = descriptor.id === AGENT_DESCRIPTOR_ID;

        return (
          <div key={descriptor.id}>
            {index > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                  option.
                </div>
              ) : null}
              {agentLocked ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  Fixed when this thread&apos;s session began. Start a new thread to use a different
                  profile.
                </div>
              ) : null}
              {isAgentDescriptor ? (
                <MenuItem
                  // Above the options, per the design: it is the way to read
                  // what the names below actually mean.
                  //
                  // The menu closes on click, as a menu should. The dialog
                  // survives that close because both hosts render their
                  // MenuPopup with `keepMounted`: this content lives inside
                  // menu popups it does not own, so without that the closing
                  // menu would unmount the dialog with it.
                  onClick={() => {
                    setIsAgentDialogOpen(true);
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    <ListIcon aria-hidden="true" className="size-3.5 opacity-70" />
                    <span>{agentLocked ? "View profile details…" : "Browse profiles…"}</span>
                  </span>
                </MenuItem>
              ) : null}
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleSelectChange(descriptor, value)}
              >
                {(agentLocked
                  ? getLockedAgentOptions(descriptor, selectedValue)
                  : descriptor.options
                ).map((option) => (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    hideIndicator
                    // Base UI keeps radio menus open by default. Close on pick so
                    // the traits menu behaves like the model picker.
                    closeOnClick
                    disabled={
                      agentLocked ||
                      (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id)
                    }
                  >
                    <span className="flex w-full min-w-0 flex-col">
                      <span className="flex w-full min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {option.label}
                          {option.isDefault ? (
                            <>
                              {" "}
                              <DefaultBadge />
                            </>
                          ) : null}
                        </span>
                      </span>
                      {/*
                        The agent select is names-only: a description under
                        every profile made this popover too tall to use. The
                        descriptions are not lost — they still ride the
                        descriptor and are the whole point of the expanded
                        picker one row above. Scoped to this descriptor so
                        every other select keeps its inline descriptions.
                      */}
                      {option.description && !isAgentDescriptor ? (
                        <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";

        return (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => {
                  updateDescriptors(
                    replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
                  );
                }}
              >
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span>{value === "on" ? "On" : "Off"}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {agentDescriptor ? (
        <AgentProfilePickerDialog
          descriptor={agentDescriptor}
          selectedValue={getDescriptorStringValue(agentDescriptor) ?? ""}
          open={isAgentDialogOpen}
          onOpenChange={setIsAgentDialogOpen}
          readOnly={isAgentSelectLocked({
            descriptorId: agentDescriptor.id,
            threadHasProviderSession,
          })}
          onSelect={(value) => {
            handleSelectChange(agentDescriptor, value);
            setIsAgentDialogOpen(false);
          }}
        />
      ) : null}
    </>
  );
});

/**
 * Build the traits trigger's text label plus whether the fast-mode bolt should
 * render. Fast mode is a lightning bolt when on and nothing at all when off —
 * "Normal" is the near-universal case and isn't worth the horizontal space. The
 * one exception is when fast mode is the only trait, where a bare bolt (or bare
 * chevron) would leave the trigger unreadable.
 */
export function buildTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
}): { label: string; showFastModeIcon: boolean; agentLabel: string | null } {
  let hasFastMode = false;
  let fastModeEnabled = false;
  let agentLabel: string | null = null;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      hasFastMode = true;
      fastModeEnabled = descriptor.currentValue === true;
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.id === "serviceTier" &&
      descriptor.type === "select"
    ) {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      if (fastTier && (currentValue === "default" || currentValue === fastTier.id)) {
        hasFastMode = true;
        fastModeEnabled = currentValue === fastTier.id;
        continue;
      }
    }
    // The agent profile is reported separately so the trigger can mark it as a
    // profile rather than let a bare name read as another effort level. It
    // stays out of the display entirely when it is None, so a Claude trigger
    // does not grow a permanent "· None" for a control most threads never
    // touch.
    if (descriptor.id === AGENT_DESCRIPTOR_ID && descriptor.type === "select") {
      agentLabel = getAgentTriggerLabel(descriptor);
      continue;
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : getProviderOptionCurrentLabel(descriptor);
    if (typeof label === "string" && label.length > 0) {
      labels.push(label);
    }
  }

  // Only fall back to text when fast mode is genuinely the sole trait. Keying
  // off an empty label list alone would also catch descriptors that resolved to
  // no label at all, printing a bogus "Normal" for a model without fast mode.
  if (labels.length === 0 && hasFastMode) {
    return { label: fastModeEnabled ? "Fast" : "Normal", showFastModeIcon: false, agentLabel };
  }
  return { label: labels.join(" · "), showFastModeIcon: fastModeEnabled, agentLabel };
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  threadHasProviderSession = false,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    })
  ) {
    return null;
  }

  const {
    label: triggerLabel,
    showFastModeIcon,
    agentLabel,
  } = buildTraitsTriggerDisplay({
    provider,
    descriptors,
    primarySelectDescriptorId: primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled,
  });
  const fastModeIcon = showFastModeIcon ? (
    <>
      <ComposerControlIcon
        icon={ZapIcon}
        className={cn(
          "fill-current opacity-80",
          provider === "claudeAgent" ? "text-[#d97757]" : "text-foreground",
        )}
      />
      <span className="sr-only">Fast mode on</span>
    </>
  ) : null;

  // The agent-profile selection is sticky across new threads, so an active
  // profile has to be readable without opening the popover. The icon marks it
  // as a profile rather than another effort word, and the width bound keeps a
  // long profile name from pushing the composer footer around.
  const agentProfileSegment =
    agentLabel === null ? null : (
      <span className="flex min-w-0 items-center gap-1">
        <ComposerControlIcon icon={UserRoundCogIcon} className="opacity-80" />
        <span className="sr-only">agent profile </span>
        {/*
          No native title here: repo lint forbids it as a tooltip, and wrapping
          the whole MenuTrigger in a Tooltip would change hover behaviour for
          every trait, not just a clipped name. The popover already shows the
          full name un-truncated one click away.
        */}
        <span className="min-w-0 max-w-24 truncate">{agentLabel}</span>
      </span>
    );

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                : "shrink-0 whitespace-nowrap",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-1.5 overflow-hidden">
            {fastModeIcon}
            {triggerLabel ? <span className="min-w-0 truncate">{triggerLabel}</span> : null}
            {agentProfileSegment}
            <ComposerControlChevron />
          </span>
        ) : (
          <>
            {fastModeIcon}
            {triggerLabel ? <span>{triggerLabel}</span> : null}
            {agentProfileSegment}
            <ComposerControlChevron />
          </>
        )}
      </MenuTrigger>
      {/*
        keepMounted so the agent-profile dialog this content can open survives
        the menu closing; without it the dialog unmounts with its host popup.
      */}
      <MenuPopup align="start" keepMounted>
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          threadHasProviderSession={threadHasProviderSession}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
