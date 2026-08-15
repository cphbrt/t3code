# In-app action history

CPH Code records semantic UI actions in the environment's local SQLite database so a chronological
narrative can be reconstructed later. This is personal workflow history, not diagnostic logging,
product analytics, or an orchestration event stream.

## Boundary

The web or desktop renderer records an action only when it can identify an activation inside the
CPH Code document:

- a configured application shortcut that resolved to a command and was handled;
- fixed command-list navigation such as `Control-N` and `Control-P`; or
- activation of an actionable element by a mouse or keyboard-generated click. Command lists
  execute a keyboard selection (Enter on the highlighted item) by synthesizing a detail-0 click;
  such synthesized activations are accepted only for controls carrying an explicit
  `data-app-action` name and are recorded with the `shortcut` source.

The recorder does not capture unhandled key presses, text input, pointer movement, coordinates, or
events outside the CPH Code document. Browser, desktop-shell, and operating-system shortcuts that
CPH Code does not handle therefore do not enter the history.

Explicit `data-app-action` and `data-app-action-target` attributes give important controls stable
semantic names such as `thread.open`, `terminal.toggle`, and `commandPalette.execute`. Other
buttons, links, menu items, options, tabs, and tree items receive a bounded generic activation
description. Labels and routes are bounded to 512 characters, and URL query strings and fragments
are omitted.

## Storage

Migration 42 creates `in_app_action_history`. Rows include a client-generated event ID, client and
server timestamps, authenticated session ID, client kind, source (`mouse` or `shortcut`), semantic
action, and optional shortcut, target, label, and before/after route context.

The table is append-only and has no automatic retention or cascading foreign key. The event ID is
unique so retrying a write cannot duplicate an action. The server timestamp is authoritative for
receipt; the client timestamp preserves when the action occurred.

The renderer sends history to the primary environment, even when an action targets another
connected environment. This keeps one continuous UI narrative instead of scattering it among
remote databases.

For example, a local read-only query can reconstruct the ordered narrative:

```sql
SELECT occurred_at, source, action, shortcut, target, label, route_before, route_after
FROM in_app_action_history
ORDER BY occurred_at, sequence;
```

Counts useful for shortcut coaching can be derived without changing the source data:

```sql
SELECT action, source, count(*) AS uses
FROM in_app_action_history
GROUP BY action, source
ORDER BY action, source;
```

The live database and query results are private user data. Do not copy them into fixtures, commits,
screenshots, review documents, CI output, or other published artifacts; use synthetic rows there.
