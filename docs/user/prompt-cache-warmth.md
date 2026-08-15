# Prompt-cache warmth

Large agent threads can be expensive to resume after their provider-side prompt cache expires. CPH Code shows that risk before you send:

- Sidebar threads glow with an ember bloom that starts bright enough to cover most of the card, then recedes and dims from the right as the likely cache lifetime elapses. When the estimate expires, the bloom disappears and the card returns to its normal appearance.
- A meter beside the context-window meter shows the estimated cache life, how long the thread has been idle, how much likely warmth remains, and roughly how many context tokens could be resent uncached.

The estimate begins at each provider's documented cache lifetime: one hour for Claude, whose sessions hold their prompt cache for an hour, and five minutes for Codex and any other provider. As CPH Code observes eligible cache hits and complete misses, it learns a separate rolling estimate for each provider account and model. The hover card shows how many observations support the estimate and whether it is still using the fallback, learning, or backed by enough evidence to be treated as learned.

Only comparable observations teach the estimate. New sessions, model changes, compactions, materially smaller contexts, and partial or ambiguous cache results are excluded. CPH Code keeps the newest 100 hits and 100 misses for each provider-account/model pair and blends sparse evidence toward that starting point so one surprising response cannot immediately create a dangerously optimistic estimate. Because misses pull the estimate down, an account that is actually getting a shorter cache than its provider documents — a Claude account in usage overage, for example — corrects itself as evidence arrives.

Cache warmth is a risk estimate, not a guarantee. Providers decide cache reuse from details CPH Code cannot inspect, including exact prompt prefixes, routing, and cache availability. The next response's cache counters are the first definitive evidence of a hit or miss.
