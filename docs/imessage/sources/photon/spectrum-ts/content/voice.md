---
source_origin: "https://photon.codes/docs/spectrum-ts/content/voice"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/voice.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "2dab42f05b1b55979445127bf82e038843318b63acbc7afb143b7f898c139b6d"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Voice

> Send voice notes with audio metadata and provider fallbacks.

Use `voice()` to send a voice note. It uses the same input shape as `attachment`: a path, a `URL`, or a `Buffer` plus optional metadata.

<Note>
  This page covers audio clips sent inside messages. To place or receive a live
  call, see [Voice calls over SIP](/docs/spectrum-ts/providers/voice).
</Note>

```ts theme={null}
import { voice } from "spectrum-ts";

// From a file path
await space.send(voice("/path/to/note.m4a"));

// From a buffer - duration in seconds is optional but useful for waveform UIs
await space.send(voice(buffer, {
  name: "note.m4a",
  mimeType: "audio/mp4",
  duration: 12,
}));
```

Platforms that don't support voice notes typically downgrade to a regular audio attachment. If the MIME type can't be inferred and `options.mimeType` is omitted, the builder throws at send time.

<Accordion title="Voice" description="Resolved voice content delivered alongside the message.">
  | Field      | Type                            | Description                                    |
  | ---------- | ------------------------------- | ---------------------------------------------- |
  | `mimeType` | `string`                        | The audio MIME type, such as `audio/mp4`.      |
  | `name`     | `string` (optional)             | Filename for the underlying clip.              |
  | `duration` | `number` (optional)             | Length in seconds.                             |
  | `size`     | `number` (optional)             | Byte length, when known up front.              |
  | `read()`   | `() => Promise<Buffer>`         | Materialize the bytes.                         |
  | `stream()` | `() => Promise<ReadableStream>` | Stream the bytes. Prefer this for large clips. |
</Accordion>
