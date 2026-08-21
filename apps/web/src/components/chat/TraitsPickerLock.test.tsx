import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { DraftId } from "../../composerDraftStore";
import { AgentProfileRows } from "./AgentProfilePickerDialog";
import { TraitsMenuContent } from "./TraitsPicker";

// The locked agent select is a render-shape guarantee: exactly one row, plus an
// explanatory line. The write-path guard in handleSelectChange cannot catch a
// group that renders zero rows, so this pins the markup.

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const MODEL = "claude-test";

const AGENT_DESCRIPTION = "Reviews changes without touching code";
/** The rendered attribute, not the word — see the locked-rows test. */
const DISABLED_ATTRIBUTE = 'disabled=""';
const EFFORT_DESCRIPTION = "Thinks harder before answering";

const AGENT_OPTIONS = [
  { id: "none", label: "None", isDefault: true },
  { id: "reviewer", label: "reviewer", description: AGENT_DESCRIPTION, declaresModel: "haiku" },
  { id: "planner", label: "planner" },
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
 * A model carrying both the agent select and an effort select whose options
 * have descriptions, so a test can prove the description suppression is scoped
 * to the agent descriptor rather than applied to every select.
 */
function modelsWithEffort(): ReadonlyArray<ServerProviderModel> {
  const agent: Extract<ProviderOptionDescriptor, { type: "select" }> = {
    id: "agent",
    label: "Agent Profile",
    type: "select",
    options: AGENT_OPTIONS,
  };
  const effort: Extract<ProviderOptionDescriptor, { type: "select" }> = {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "low", label: "Low", isDefault: true },
      { id: "high", label: "High", description: EFFORT_DESCRIPTION },
    ],
  };
  return [
    {
      slug: MODEL,
      name: MODEL,
      isCustom: false,
      capabilities: { optionDescriptors: [effort, agent] },
    },
  ];
}

function renderMenuWithEffort(input: {
  selection: string;
  threadHasProviderSession: boolean;
}): string {
  return renderToStaticMarkup(
    <MenuPrimitive.Root open>
      <div>
        <TraitsMenuContent
          provider={CLAUDE}
          models={modelsWithEffort()}
          model={MODEL}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={[{ id: "agent", value: input.selection }]}
          threadHasProviderSession={input.threadHasProviderSession}
          draftId={DraftId.make("draft-1")}
        />
      </div>
    </MenuPrimitive.Root>,
  );
}

function renderMenu(input: { selection: string; threadHasProviderSession: boolean }): string {
  const modelOptions: ReadonlyArray<ProviderOptionSelection> = [
    { id: "agent", value: input.selection },
  ];
  // MenuRadioItem needs a Menu.Root ancestor for context. The app's MenuPopup
  // also wraps a Portal, which renders nothing server-side, so this supplies
  // the root directly and renders the items inline.
  return renderToStaticMarkup(
    <MenuPrimitive.Root open>
      <div>
        <TraitsMenuContent
          provider={CLAUDE}
          models={models()}
          model={MODEL}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={modelOptions}
          threadHasProviderSession={input.threadHasProviderSession}
          draftId={DraftId.make("draft-1")}
        />
      </div>
    </MenuPrimitive.Root>,
  );
}

/**
 * Split the markup into radio rows, anchored on the role Base UI gives each one
 * rather than on incidental text placement.
 */
function radioRows(markup: string): ReadonlyArray<string> {
  return markup.split('role="menuitemradio"').slice(1);
}

describe("locked agent select rendering", () => {
  it("offers every profile while no session exists", () => {
    const markup = renderMenu({ selection: "reviewer", threadHasProviderSession: false });

    expect(radioRows(markup)).toHaveLength(3);
    expect(markup).toContain("None");
    expect(markup).toContain("reviewer");
    expect(markup).toContain("planner");
    expect(markup).not.toContain("Start a new thread");
  });

  it("shows exactly the active profile plus the explanation once a session exists", () => {
    const markup = renderMenu({ selection: "reviewer", threadHasProviderSession: true });
    const rows = radioRows(markup);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("reviewer");
    expect(markup).toContain("Start a new thread");
    // The alternatives are gone entirely rather than rendered disabled.
    expect(markup).not.toContain("planner");
  });

  it("names an active profile the server never discovered instead of claiming None", () => {
    // A worktree-local profile is a legitimate live selection the probe cannot
    // see, because the list is scanned from the server's cwd while the profile
    // resolves against the thread's cwd. Without the option injection in
    // getProviderModelOptionDescriptors the shared resolver clamps this to the
    // default, and the popover would say "None" while the adapter passed the
    // real --agent name.
    const markup = renderMenu({
      selection: "worktree-local",
      threadHasProviderSession: true,
    });
    const rows = radioRows(markup);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("worktree-local");
    expect(rows[0]).not.toContain("None");
    expect(markup).toContain("Start a new thread");
  });

  it("names an undiscovered profile even while the select is still editable", () => {
    // The clamping bug is not lock-specific: a fresh thread must not silently
    // show None for a sticky profile the probe cannot see.
    const markup = renderMenu({
      selection: "worktree-local",
      threadHasProviderSession: false,
    });

    expect(markup).toContain("worktree-local");
  });

  it("keeps the locked row disabled so the dead choice cannot be re-picked", () => {
    const lockedRows = radioRows(
      renderMenu({ selection: "reviewer", threadHasProviderSession: true }),
    );
    const openRows = radioRows(
      renderMenu({ selection: "reviewer", threadHasProviderSession: false }),
    );

    // Scoped to the row itself, and contrasted against the unlocked render so
    // the assertion cannot pass on some unrelated disabled element.
    expect(lockedRows[0]).toContain('aria-disabled="true"');
    expect(openRows.every((row) => !row.includes('aria-disabled="true"'))).toBe(true);
  });
});

describe("compact agent select plus expanded picker", () => {
  it("lists agent profiles by name only, leaving other selects' descriptions alone", () => {
    // Descriptions under every profile made this popover too tall. They stay in
    // the descriptor (the expanded picker is built from them) but stop
    // rendering inline here. The effort select in the same popover is the
    // control: its description must survive, or this became a blanket change.
    const markup = renderMenuWithEffort({
      selection: "reviewer",
      threadHasProviderSession: false,
    });

    expect(markup).toContain("reviewer");
    expect(markup).not.toContain(AGENT_DESCRIPTION);
    expect(markup).toContain(EFFORT_DESCRIPTION);
  });

  it("offers a row that opens the expanded picker", () => {
    const markup = renderMenu({ selection: "reviewer", threadHasProviderSession: false });

    expect(markup).toContain("Browse profiles");
  });

  it("keeps the expanded-picker row on a locked thread, worded as read-only", () => {
    // The lock removes the alternatives from the select, but the descriptions
    // are exactly what a user wants to read about the profile the thread is
    // already running, so the row stays and changes verb.
    const markup = renderMenu({ selection: "reviewer", threadHasProviderSession: true });

    expect(markup).toContain("View profile details");
    expect(markup).not.toContain("Browse profiles");
  });
});

describe("expanded agent-profile picker rows", () => {
  function rows(markup: string): ReadonlyArray<string> {
    return markup.split('role="radio"').slice(1);
  }

  function renderRows(input: { selectedValue: string; readOnly: boolean }): string {
    return renderToStaticMarkup(
      <AgentProfileRows
        descriptor={{
          id: "agent",
          label: "Agent Profile",
          type: "select",
          options: AGENT_OPTIONS,
        }}
        selectedValue={input.selectedValue}
        onSelect={() => {}}
        readOnly={input.readOnly}
      />,
    );
  }

  it("lists every profile with its full description and declared model", () => {
    const markup = renderRows({ selectedValue: "none", readOnly: false });

    expect(rows(markup)).toHaveLength(AGENT_OPTIONS.length);
    expect(markup).toContain("reviewer");
    expect(markup).toContain(AGENT_DESCRIPTION);
    expect(markup).toContain("planner");
    // Reported and explicitly disclaimed: a profile's model frontmatter is
    // inert, so the row must not imply the model will be used.
    expect(markup).toContain("declares haiku");
    expect(markup).toContain("not applied");
  });

  it("keeps None as a selectable row", () => {
    const markup = renderRows({ selectedValue: "reviewer", readOnly: false });
    const noneRow = rows(markup).find((row) => row.includes("None"));

    expect(noneRow).toBeDefined();
    expect(noneRow).not.toContain(DISABLED_ATTRIBUTE);
  });

  it("marks the active profile as checked", () => {
    const markup = renderRows({ selectedValue: "reviewer", readOnly: false });
    const selected = rows(markup).filter((row) => row.includes('aria-checked="true"'));

    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("reviewer");
  });

  it("renders every row readable but unpickable when the thread is locked", () => {
    const locked = rows(renderRows({ selectedValue: "reviewer", readOnly: true }));

    // Still the full list, so the descriptions remain readable, but no row can
    // be chosen. Matched on the rendered attribute rather than the substring
    // "disabled", which also occurs in the row's own `disabled:` style
    // utilities and made this assertion pass with the state ignored entirely.
    expect(locked).toHaveLength(AGENT_OPTIONS.length);
    expect(locked.every((row) => row.includes(DISABLED_ATTRIBUTE))).toBe(true);
    expect(
      rows(renderRows({ selectedValue: "reviewer", readOnly: false })).every(
        (row) => !row.includes(DISABLED_ATTRIBUTE),
      ),
    ).toBe(true);
  });
});
