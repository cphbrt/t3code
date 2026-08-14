# Ideas

## Neovim-style workspace control

CPH Code should support a keyboard-first, modal way to navigate its native UI
while agent sessions continue running. The aim is not to embed a terminal or
replace CPH Code's structured agent experience: it is to make the app feel
like Neovim's terminal workflow, where leaving insert mode lets Chris inspect,
copy, and move through the surrounding workspace without interrupting the
agent.

### Interaction model

- **Insert mode** keeps the existing composer behavior: typing edits the draft
  and sends prompts to the agent.
- **Normal mode** is entered with `Ctrl+Space`. It blurs the composer while
  retaining its draft and cursor, then routes keys to workspace navigation.
- Do not repurpose `Escape`; dialogs, prompts, and other focused native controls
  must retain their normal keyboard behavior.
- Show a small persistent mode indicator so it is always clear whether typed
  keys will edit the composer.
- `i` or `a` returns to Insert mode and restores composer focus.

### Normal-mode navigation

- `j` / `k` move a logical cursor through conversation entries.
- `Ctrl+u` / `Ctrl+d` and `g` / `G` navigate the timeline; `G` returns to the
  live edge.
- Move among the sidebar, timeline, composer, and right panel with a small,
  coherent set of directional commands.
- Add keyboard traversal of threads and right-panel tabs (files, diff, preview,
  and agents).
- `Enter` activates the selected item: expand a work group, open a diff, or
  show agents as appropriate.
- A later Visual mode can select one or more logical entries; `y` should copy
  the selected semantic content rather than depend on browser text selection.

### Technical shape

The native conversation is a virtualized, rich timeline rather than an editable
text buffer. Navigation should therefore track stable timeline-row identifiers,
not DOM nodes or character positions. A row may represent a user message,
assistant response, work group, plan, or other structured event. This remains
reliable while rows are virtualized, folded, or streaming.

Implement the behavior as one client-side workspace-mode controller with clear
key-routing precedence for dialogs, menus, text fields, the command palette,
and pending user-input or approval flows. Normal-mode timeline navigation should
also disable live-follow so an agent can continue streaming while Chris reads
history; returning to the end re-enables it.

This should not require provider, server, PTY, or Electron architecture changes
for the first version. Start with Insert/Normal mode, `Ctrl+Space`, a visible
mode indicator, and thread/panel/timeline navigation. Add a selected logical
row and semantic copy/actions afterwards.
