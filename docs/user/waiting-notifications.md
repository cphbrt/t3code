# Notifications when a thread needs you

When an agent stops and starts waiting on you, and the app is in the background, a brief system
notification tells you which thread it is. Four states trigger one:

- **Pending approval** — the agent is blocked on a tool, command, or file approval.
- **Awaiting input** — the agent asked you a question.
- **Turn completed** — a turn finished and you have not opened the thread since.
- **Interrupted** or **Agent error** — the runtime disappeared, or the turn failed.

These are the same states the sidebar marks with a colored status, so a notification never
disagrees with the thread list.

Each notification names the state and the thread. Click it to bring the app forward and open that
thread. Notifications close themselves after a few seconds so nothing collects in Notification
Center, and a newer state for the same thread replaces its earlier notification instead of stacking
beside it.

## When you will not be notified

- While the app has focus. You are already looking at it.
- For a snoozed thread, unless it needs you badly enough to break through the snooze — a pending
  approval or question, a fresh failure, or a run that completed after you snoozed it.
- On a fresh load or after a reconnect. Threads are read once, quietly, so opening the app never
  produces a burst of notifications about work you already knew about.
- Repeatedly for the same state. A thread notifies again only after that state resolves and
  happens again.

## Turning it off

**Settings → General → Notify when a thread needs you** controls the feature. It is on by default.

In a browser, notifications also need the browser's permission. Turning the setting on asks for it;
if you decline, the feature stays quiet until you grant permission in your browser's site settings.
The desktop app grants it for you.
