import * as Schema from "effect/Schema";

import { ClientKind } from "./background.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const BoundedActionText = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const InAppActionSource = Schema.Literals(["mouse", "shortcut"]);
export type InAppActionSource = typeof InAppActionSource.Type;

export const InAppActionHistoryInput = Schema.Struct({
  eventId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  occurredAt: Schema.DateTimeUtc,
  clientKind: ClientKind,
  source: InAppActionSource,
  action: BoundedActionText,
  shortcut: Schema.optionalKey(BoundedActionText),
  target: Schema.optionalKey(BoundedActionText),
  label: Schema.optionalKey(BoundedActionText),
  routeBefore: Schema.optionalKey(BoundedActionText),
  routeAfter: Schema.optionalKey(BoundedActionText),
});
export type InAppActionHistoryInput = typeof InAppActionHistoryInput.Type;

export class InAppActionHistoryWriteError extends Schema.TaggedErrorClass<InAppActionHistoryWriteError>()(
  "InAppActionHistoryWriteError",
  { message: Schema.String },
) {}
