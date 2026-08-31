import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { DraftId } from "../../composerDraftStore";
import { AgentProfilePickerDialog } from "./AgentProfilePickerDialog";
import { TraitsMenuContent, useAgentProfileDialog } from "./TraitsPicker";

/**
 * The agent-profile dialog belongs to each menu's host, rendered beside the
 * menu, because `TraitsMenuContent` lives inside two menu popups it does not
 * own and a closing menu unmounts its popup subtree.
 *
 * `useAgentProfileDialog` is the seam that makes that hoisting possible: it
 * hands a host the dialog element and the callback that opens it, derived from
 * the same props the host already passes to the menu content. These tests
 * exercise that seam directly — the element's real props and the menu content's
 * real markup — rather than asserting on source text.
 */

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const MODEL = "claude-test";
const AGENT_DESCRIPTION = "Reviews changes without touching code";

const AGENT_OPTIONS = [
  { id: "none", label: "None", isDefault: true },
  { id: "reviewer", label: "reviewer", description: AGENT_DESCRIPTION },
];

function models(): ReadonlyArray<ServerProviderModel> {
  const agent: Extract<ProviderOptionDescriptor, { type: "select" }> = {
    id: "agent",
    label: "Agent Profile",
    type: "select",
    options: AGENT_OPTIONS,
  };
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: [agent] } },
  ];
}

/**
 * Call the hook the way a host does and capture what it returns. Rendering is
 * how the hook runs; the probe itself renders nothing.
 */
function callHook(input: { selection: string; threadHasProviderSession: boolean }) {
  let captured: ReturnType<typeof useAgentProfileDialog> | null = null;
  function Probe() {
    captured = useAgentProfileDialog({
      provider: CLAUDE,
      models: models(),
      model: MODEL,
      prompt: "",
      onPromptChange: () => {},
      modelOptions: [{ id: "agent", value: input.selection }],
      threadHasProviderSession: input.threadHasProviderSession,
      draftId: DraftId.make("draft-1"),
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (captured === null) {
    throw new Error("hook did not run");
  }
  return captured as ReturnType<typeof useAgentProfileDialog>;
}

describe("useAgentProfileDialog gives the host a ready-to-render dialog", () => {
  it("returns the picker dialog carrying the descriptor and current selection", () => {
    const { element } = callHook({ selection: "reviewer", threadHasProviderSession: false });

    // The element is what the host renders beside its menu. If the hook ever
    // stopped supplying one, both hosts would silently render nothing at all —
    // which is precisely the failure a source-text assertion cannot see.
    expect(isValidElement(element)).toBe(true);
    const props = (
      element as React.ReactElement<React.ComponentProps<typeof AgentProfilePickerDialog>>
    ).props;
    expect(props.descriptor.id).toBe("agent");
    expect(props.descriptor.options.map((option) => option.id)).toEqual(["none", "reviewer"]);
    expect(props.selectedValue).toBe("reviewer");
    expect(props.open).toBe(false);
  });

  it("marks the dialog read-only exactly when the thread owns a session", () => {
    const unlocked = callHook({ selection: "reviewer", threadHasProviderSession: false });
    const locked = callHook({ selection: "reviewer", threadHasProviderSession: true });

    const readOnlyOf = (element: React.ReactNode) =>
      (element as React.ReactElement<React.ComponentProps<typeof AgentProfilePickerDialog>>).props
        .readOnly;

    expect(readOnlyOf(unlocked.element)).toBe(false);
    expect(readOnlyOf(locked.element)).toBe(true);
  });

  it("renders no dialog when the provider has no agent-profile descriptor", () => {
    // Codex has no agent select, so a host must get nothing to render rather
    // than an empty dialog.
    let captured: ReturnType<typeof useAgentProfileDialog> | null = null;
    function Probe() {
      captured = useAgentProfileDialog({
        provider: ProviderDriverKind.make("codex"),
        models: [{ slug: MODEL, name: MODEL, isCustom: false, capabilities: {} }],
        model: MODEL,
        prompt: "",
        onPromptChange: () => {},
        modelOptions: [],
        draftId: DraftId.make("draft-1"),
      });
      return null;
    }
    renderToStaticMarkup(<Probe />);

    expect(captured!.element).toBeNull();
  });
});

describe("the menu content owns no dialog of its own", () => {
  function renderContent(input: { onBrowseAgentProfiles?: () => void }): string {
    return renderToStaticMarkup(
      <MenuPrimitive.Root open>
        <div>
          <TraitsMenuContent
            provider={CLAUDE}
            models={models()}
            model={MODEL}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={[{ id: "agent", value: "reviewer" }]}
            {...(input.onBrowseAgentProfiles
              ? { onBrowseAgentProfiles: input.onBrowseAgentProfiles }
              : {})}
            draftId={DraftId.make("draft-1")}
          />
        </div>
      </MenuPrimitive.Root>,
    );
  }

  it("shows the row that asks its host to open the dialog", () => {
    expect(renderContent({ onBrowseAgentProfiles: () => {} })).toContain("Browse profiles");
  });

  it("drops the row when no host offers a dialog to open", () => {
    // A row that opens nothing is worse than no row. This is what keeps the
    // dialog's ownership honest: the content cannot conjure the surface itself.
    expect(renderContent({})).not.toContain("Browse profiles");
  });

  it("does not render the profile descriptions itself", () => {
    // The descriptions are the dialog's whole reason to exist and are
    // deliberately absent from the menu, which stays name-only. If a future
    // change put the dialog back inside this content, its descriptions would
    // appear here and this fails.
    expect(renderContent({ onBrowseAgentProfiles: () => {} })).not.toContain(AGENT_DESCRIPTION);
  });
});
