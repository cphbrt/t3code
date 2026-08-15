# Background work after a turn settles

An agent can leave native background work running after its turn finishes: subagents and workflow
runs keep working, and watch loops (monitors and background shells) keep watching. The sidebar
shows this as a **Working** or **Monitoring** status on the thread — **Working** while any agent
work is live, **Monitoring** when watch loops are the only live work.

## The background-task roster

While background work is live, a banner sits above the composer summarizing it — for example
**Monitoring 2 background tasks**. Expand the banner with its chevron to see one row per live
task:

- what the task is — the agent or watch description reported by the provider;
- the command a background shell or monitor is actually running;
- how long it has been running.

Collapse the banner with the same chevron. **Stop** ends all of the thread's background work.

The roster reflects live work only. After the server restarts, orphaned background work is no
longer running, so the banner and sidebar status clear until new background tasks start.
