# Files an agent makes for you

When you ask an agent to write something up and show you — a review document, a
screenshot, a recording — it can hand you the finished file instead of pasting
its contents into the conversation.

Nothing interrupts you. The file does not open, no window appears, and the agent
keeps working. The file is recorded against the thread and waits in the
**Artifacts** panel until you go looking for it.

## The Artifacts panel

Artifacts is a right-panel surface, alongside Diff, Files, and Agents. Open it
from the panel's launcher with **R**, or from the **+** menu in the panel's tab
bar.

Each row shows the file's name, the folder it lives in, and how long ago it
arrived. Newest first, with a control in the panel header to flip to oldest
first.

- **The dot** on the left of a row's controls marks it unread. Click it to mark
  a row read or unread yourself.
- **The star** keeps a row highlighted so it stands out later. Starring never
  moves a row — the list stays in time order no matter what you star.
- **Clicking a row** opens the file and marks it read. If it will not open, the
  reason appears on the row itself and stays there, and the row stays unread —
  a file you could not read is not one you have read.

The tab shows a dot while anything is unread, and the launcher card carries the
unread count.

## Opening a file

Clicking a row opens the file on your machine, in your browser, the same way
double-clicking it would.

This works in the desktop app, for threads running on that same machine. In any
other setup the panel still lists everything, still shows you what arrived and
when, and still lets you mark and star rows — only opening goes away, and the
panel tells you why:

- **In a browser tab**, a web page cannot reach files on your computer. Use the
  desktop app to open them.
- **For a thread on another machine**, the file lives on that machine, not this
  one. Opening artifacts from a remote environment is not supported yet.

## Notifications

When new files arrive in a thread and the app is not focused, you get one brief
notification. Clicking it brings the app forward, opens that thread, and opens
its Artifacts panel.

These follow the same rules as the other notifications for a thread that needs
you:

- Several files arriving close together produce **one** notification covering
  them, not one each.
- Nothing fires while the app has focus, or for a snoozed thread.
- A fresh load or a reconnect never produces a burst about files you already
  knew about.
- If a thread starts waiting on you _and_ receives a file at the same moment,
  you get the one about it waiting. The files keep their unread dots and the
  panel's count, so nothing is lost.

**Settings → General → Notify when a thread needs you** turns all of these off
together.

## Asking for one

Just ask — "write that up and show me", "show me the screenshot". Agents know
how to hand a file over and will do it on their own when it fits.

The file stays wherever the agent wrote it. Move or delete it and the row
remains, but it will tell you the file is gone when you try to open it.
