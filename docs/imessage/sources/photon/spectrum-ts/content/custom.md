---
source_origin: "https://photon.codes/docs/spectrum-ts/content/custom"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/custom.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "502ccec12ef61938203a844d6c70855aa31616ba7c5dc94504b4b82d2cfe0cca"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Custom content

> Send provider-specific structured payloads.

Use `custom()` to send structured, platform-specific payloads. Reach for this when the receiving provider supports rich content types that don't fit into the built-in builders.

```ts theme={null}
import { custom } from "spectrum-ts";

await space.send(custom({ type: "card", title: "Order Confirmed" }));
```

The raw payload round-trips through the provider's `send` action. The provider decides how to interpret it.

If you need a reusable provider-specific abstraction, wrap `custom()` in your own helper so call sites still read like product-level actions.
