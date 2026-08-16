import {
  DesktopDictationAvailabilityInputSchema,
  DesktopDictationAvailabilitySchema,
  DesktopDictationTranscribeInputSchema,
  DesktopDictationTranscribeResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DictationService from "../../dictation/DictationService.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const transcribe = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_TRANSCRIBE_CHANNEL,
  payload: DesktopDictationTranscribeInputSchema,
  result: DesktopDictationTranscribeResultSchema,
  handler: Effect.fn("desktop.ipc.dictation.transcribe")(function* ({ wavData, language }) {
    const dictation = yield* DictationService.Dictation;
    return yield* dictation.transcribe({ wavData, language });
  }),
});

export const checkAvailability = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_CHECK_AVAILABILITY_CHANNEL,
  payload: DesktopDictationAvailabilityInputSchema,
  result: DesktopDictationAvailabilitySchema,
  handler: Effect.fn("desktop.ipc.dictation.checkAvailability")(function* (input) {
    const dictation = yield* DictationService.Dictation;
    return yield* dictation.checkAvailability(input);
  }),
});

export const methods = [transcribe, checkAvailability] as const;
