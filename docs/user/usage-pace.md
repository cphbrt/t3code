# Usage pace

A quota percentage on its own does not tell you much. "47% used" is comfortable four hours into a five-hour window and alarming one hour in. CPH Code shows both halves: every provider allowance window carries a small mark for where an even spend would have reached by now, so you can see at a glance which side of it you are on.

Pace appears wherever quota windows already do — the composer's quota chip and its details popover, the model picker's usage card, and **Plan limits** on the Usage page. Each bar shows the fill, a tick at the on-pace target, and the gap in percentage points: `12 pts ahead`, `on pace`, `8 pts behind`.

**Behind is good.** It means you are spending slower than the window refills, and you have headroom.

## Colour, and what it can and cannot say

A window is coloured by whichever is more urgent: how full it is, or how fast it is filling. Pace can raise the alarm level but never lower it — a window at 97% is not calm because it got there slowly. Below the warning line, a measured window that is coasting reads green and one tracking an even spend reads blue, so "we looked, and you are fine" never appears in the same grey as "we could not tell".

Colour is never the only channel. Amber could mean "80% full" or "30% full but sprinting", and those call for opposite responses, so the gap is always written out next to the bar as well.

Once a window is exhausted the tick and the gap disappear. At that point the only thing you can do is wait, and the reset countdown is the fact worth reading.

## Counting only the hours you work

By default, "how far through the window am I" is measured on the wall clock. That is the wrong measure if you keep regular hours: a five-hour allowance that opened at 6am has burned two of its hours before your day starts, and a plain clock would report you as behind before you had begun.

**Settings → General → Usage pace schedule** lets you count only the time you actually work:

- **Weekdays only** — Monday through Friday.
- **Set hours** — a **Day starts** and **Day ends** hour, in your local time.

The two switches are independent, so you can restrict hours without restricting days: 7am to 10pm including evenings and weekends is a perfectly good answer. Both are off by default, which is the plain wall clock.

Windows are read in whatever time zone your device is in right now, and the setting lives on this device rather than travelling with your account. Daylight-saving changes are handled — a nine-to-five day really is eight hours on the day the clocks go forward.

On the Usage page, the projected-burn line on the cycle chart follows the same schedule: it climbs during counted hours and lies flat through evenings and weekends, which is what the burn actually looks like.

## When there is no pace

Some windows cannot have one, and CPH Code says which rather than showing a zero that would read as "nothing spent":

- **The window rolls continuously.** One of Codex's allowances has no cycle at all — it always reports a reset a full period ahead, so there is no "part-way through" to measure. CPH Code works this out from the window's own history and stops guessing.
- **The provider did not say when the window resets, or how long it runs.** Without both, the window has no start, and there is nothing to be ahead or behind of.
- **Your counted hours have not started yet.** This one resolves itself; it is marked as temporary.

A freshly installed environment has no quota history yet, so it may take a couple of days before a rolling window is recognised as one.

Pace is arithmetic on the provider's own numbers, not a prediction. It assumes the rest of the window looks like the part you have already spent.
