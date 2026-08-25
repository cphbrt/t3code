import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  getAgentTriggerLabel,
  getLockedAgentOptions,
  isAgentSelectLocked,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("shows the bolt instead of a text label when fast mode is on", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
      agentLabel: null,
    });
  });

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({
      label: "High",
      showFastModeIcon: false,
      agentLabel: null,
    });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({
      label: "High",
      showFastModeIcon: true,
      agentLabel: null,
    });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({
      label: "High · Flex",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({
      label: "Standard",
      showFastModeIcon: false,
      agentLabel: null,
    });
    expect(display([serviceTierDescriptor("priority")])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({
      label: "High · Thinking On",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
      agentLabel: null,
    });
    expect(display([fastModeDescriptor(false)])).toEqual({
      label: "Normal",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({
      label: "",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("still renders the prompt-controlled ultrathink label alongside the bolt", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink", showFastModeIcon: true, agentLabel: null });
  });

  it("reports an active agent profile separately and stays silent on None", () => {
    const agent = selectDescriptor(
      "agent",
      [
        { id: "none", label: "None", isDefault: true },
        { id: "reviewer", label: "reviewer" },
      ],
      "reviewer",
    );

    // A real profile is reported on its own field so the trigger can mark it as
    // a profile, and never merged into the "·"-joined trait label.
    expect(display([EFFORT, agent])).toEqual({
      label: "High",
      showFastModeIcon: false,
      agentLabel: "reviewer",
    });

    // None is the default and the common case: it must not occupy the trigger.
    expect(display([EFFORT, { ...agent, currentValue: "none" }])).toEqual({
      label: "High",
      showFastModeIcon: false,
      agentLabel: null,
    });
  });

  it("treats an unset agent descriptor as None via its default option", () => {
    const agent: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "agent",
      label: "Agent Profile",
      type: "select",
      options: [
        { id: "none", label: "None", isDefault: true },
        { id: "reviewer", label: "reviewer" },
      ],
    };

    expect(display([EFFORT, agent]).agentLabel).toBeNull();
  });

  it("keeps fast mode as the sole-trait fallback when only an agent profile joins it", () => {
    // agentLabel is not a member of `labels`, so it must not stop fast mode
    // from falling back to its text label.
    const agent = selectDescriptor(
      "agent",
      [
        { id: "none", label: "None", isDefault: true },
        { id: "reviewer", label: "reviewer" },
      ],
      "reviewer",
    );

    expect(display([fastModeDescriptor(true), agent])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
      agentLabel: "reviewer",
    });
  });
});

describe("getAgentTriggerLabel", () => {
  function agentDescriptor(
    currentValue: string | undefined,
  ): Extract<ProviderOptionDescriptor, { type: "select" }> {
    return {
      id: "agent",
      label: "Agent Profile",
      type: "select",
      options: [
        { id: "none", label: "None", isDefault: true },
        { id: "reviewer", label: "reviewer" },
      ],
      ...(currentValue ? { currentValue } : {}),
    };
  }

  it("names an active profile and stays null for None or no descriptor", () => {
    expect(getAgentTriggerLabel(agentDescriptor("reviewer"))).toBe("reviewer");
    expect(getAgentTriggerLabel(agentDescriptor("none"))).toBeNull();
    expect(getAgentTriggerLabel(agentDescriptor(undefined))).toBeNull();
    expect(getAgentTriggerLabel(null)).toBeNull();
  });

  it("falls back to the raw value for a profile missing from the option list", () => {
    // Defence in depth only. In the real pipeline `getSelectedTraits` injects
    // an undiscovered profile as an option before resolution, because
    // `getProviderOptionDescriptors` would otherwise clamp it to the default.
    expect(getAgentTriggerLabel(agentDescriptor("worktree-local"))).toBe("worktree-local");
  });

  it("ignores descriptors that are not the agent select", () => {
    expect(
      getAgentTriggerLabel({ ...agentDescriptor("reviewer"), id: "contextWindow" }),
    ).toBeNull();
  });
});

describe("getLockedAgentOptions", () => {
  const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
    id: "agent",
    label: "Agent Profile",
    type: "select",
    options: [
      { id: "none", label: "None", isDefault: true },
      { id: "reviewer", label: "reviewer" },
    ],
  };

  it("returns just the active option", () => {
    expect(getLockedAgentOptions(descriptor, "reviewer")).toEqual([
      { id: "reviewer", label: "reviewer" },
    ]);
  });

  it("never returns an empty list, which would render an empty group", () => {
    expect(getLockedAgentOptions(descriptor, "worktree-local")).toEqual([
      { id: "worktree-local", label: "worktree-local" },
    ]);
  });
});

describe("isAgentSelectLocked", () => {
  it("locks only the agent select, and only once a provider session exists", () => {
    expect(isAgentSelectLocked({ descriptorId: "agent", threadHasProviderSession: true })).toBe(
      true,
    );
    expect(isAgentSelectLocked({ descriptorId: "agent", threadHasProviderSession: false })).toBe(
      false,
    );
  });

  it("never locks the other selects, which stay changeable mid-thread", () => {
    for (const descriptorId of ["reasoningEffort", "contextWindow", "serviceTier"]) {
      expect(isAgentSelectLocked({ descriptorId, threadHasProviderSession: true })).toBe(false);
    }
  });
});
