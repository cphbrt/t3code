# Keeping your computer awake

A long turn should not die because your Mac went to sleep while you were away from it. When an agent starts working on this computer, CPH Code stops the machine idle-sleeping. When the last agent finishes, normal sleep behaviour comes back.

You do not have to remember anything, and you do not have to leave a `caffeinate` running.

## What it does and does not do

Only one thing is held off: the computer going to sleep on its own while idle. Everything else is untouched.

- Your display still dims and sleeps on its usual schedule.
- Your screen still locks, and your screensaver still starts.
- Closing the lid still sleeps the computer. No app can override that.

If the app quits or crashes, the hold dies with it. Your Mac can never get stuck awake.

## When it applies

- **Only agents running on this computer count.** If you are looking at a window connected to another environment, its agents are working on that machine, and keeping this one awake would achieve nothing.
- **Only turns in flight count.** A thread that is quietly monitoring something in the background does not hold your computer awake. That is deliberate: otherwise a long-lived watch loop would pin the machine awake indefinitely, which is exactly the problem this replaces.
- **On power by default.** Out of the box, the hold applies only while you are plugged in. On battery, the computer sleeps as usual unless you turn on the battery option.

The behaviour is silent. There is no indicator to watch and nothing to dismiss.

## Settings

Both live in **Settings → General**, in the desktop app.

- **Keep the Mac awake while agents run** — the master switch. On by default.
- **Also on battery** — extends it to battery power. Off by default.
