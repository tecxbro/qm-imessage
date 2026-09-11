---
source_origin: "https://photon.codes/docs/spectrum-ts/content/edits"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/edits.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "811ca335bfdecbf29977a2196f1fd5be25d7192bef777aecd0e3ef0e616d7966"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Edits

> Rewrite previously sent outbound messages.

Use `edit()` to rewrite the content of a previously sent outbound message. Edits are fire-and-forget: `space.send(edit(...))` resolves to `undefined`.

```ts theme={null}
import { edit, text } from "spectrum-ts";

const sent = await space.send("Draft");
await space.send(edit(text("Final version"), sent));
```

`edit()` cannot wrap `edit`, `reply`, `reaction`, `group`, `typing`, `rename`, `avatar`, `addMember`, `removeMember`, `leaveSpace`, `unsend`, or `read` content.

Provider constraints surface at send time. For example, a provider may reject edits after its native edit window closes.

## Update an iMessage app card

iMessage app cards support in-place updates. Save the message returned by the original send and use it as the edit target:

```ts theme={null}
import { app, edit } from "spectrum-ts";

const card = await space.send(app("https://example.com/status/pending"));

await space.send(
  edit(app("https://example.com/status/complete"), card)
);
```

The original send returns the message record that identifies the card. The edit itself returns `undefined`, so keep using `card` if you need to update it again.

App-card updates require `@spectrum-ts/imessage`; they are not supported by
`@spectrum-ts/imessage-local`. See [App cards](/docs/spectrum-ts/content/app#update-an-app-card-in-place)
for live rendering and session details, or
[Customized iMessage Apps](/docs/spectrum-ts/providers/imessage/messaging-features/apps#update-an-imessage-app)
when you own the iMessage extension.
