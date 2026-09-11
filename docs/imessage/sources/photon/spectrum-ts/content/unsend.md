---
source_origin: "https://photon.codes/docs/spectrum-ts/content/unsend"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/unsend.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "33990e586a91cccb6fda6e3ddd21741beba99ba018bc887022f8c07730d01892"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Unsend

> Retract a previously sent outbound message.

Use `unsend()` to retract a previously sent outbound message. Unsends are fire-and-forget: `space.send(unsend(...))` resolves to `undefined`.

```ts theme={null}
import { unsend } from "spectrum-ts";

const sent = await space.send("Oops");
await space.send(unsend(sent));
```

`message.unsend()` and `space.unsend(message)` are sugar for `space.send(unsend(message))`.

Only outbound messages can be unsent. The builder throws at build time for inbound targets. Platform constraints, such as iMessage's roughly two-minute unsend window for regular messages, surface from the provider at send time.
