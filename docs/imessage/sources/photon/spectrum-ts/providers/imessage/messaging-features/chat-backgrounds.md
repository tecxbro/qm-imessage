---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/chat-backgrounds"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/chat-backgrounds.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "6a0f5a11c3056296632fb501181cbadd762d2ea2579f35d961102086fe988f83"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# iMessage chat backgrounds

> Set or clear an iMessage conversation background image.

export const TypeTooltip = ({name, type, children}) => {
  const [visible, setVisible] = React.useState(false);
  const [pos, setPos] = React.useState({
    top: 0,
    left: 0
  });
  const triggerRef = React.useRef(null);
  const show = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 6,
        left: rect.left
      });
    }
    setVisible(true);
  };
  const hide = () => setVisible(false);
  return <>
      <span ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} style={{
    cursor: "pointer",
    position: "relative",
    display: "inline"
  }}>
        {children || <code>{name}</code>}
      </span>
      {visible && <span style={{
    position: "fixed",
    top: pos.top,
    left: pos.left,
    zIndex: 9999,
    padding: "8px 12px",
    borderRadius: "8px",
    fontSize: "13px",
    lineHeight: "1.5",
    fontFamily: "'Azeret Mono', monospace",
    whiteSpace: "pre",
    backgroundColor: "var(--tw-prose-pre-bg, #1e1e1e)",
    color: "var(--tw-prose-pre-code, #e5e5e5)",
    border: "1px solid var(--border, rgba(128,128,128,0.2))",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    pointerEvents: "none"
  }}>
          {type}
        </span>}
    </>;
};

Set or clear the chat background image. Import `background` from the iMessage
provider and use the sugar method on a narrowed space:

```ts theme={null}
import { background, imessage } from "spectrum-ts/providers/imessage";

const im = imessage(space);

// Set from a file path - MIME type inferred from the extension
await im.background("./wallpaper.jpg");

// Set from a buffer - mimeType is required
await im.background(buffer, { mimeType: "image/jpeg" });

// Clear the current background
await im.background("clear");
```

`space.background(...)` is sugar for `space.send(background(...))`. The
canonical form works on any space reference:

```ts theme={null}
await space.send(background("./wallpaper.jpg"));
await space.send(background("clear"));
```

After a successful set, the background usually syncs to other users' devices
within `30s`. The background asset is uploaded to iCloud and then distributed
to the other members of the conversation. Display time is not a hard SLA:
network state, iCloud state, and the Messages client state can all affect when
the UI appears.

| Stage                             | What happens                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Before `background(...)` resolves | The provider waits until the background asset reaches a distributable state.                        |
| After `background(...)` resolves  | The conversation has accepted the background change; iCloud distributes the asset to other members. |
| Other members' devices            | The background appears after the device receives the iCloud distribution.                           |

Background UI may not appear in these cases:

| Case                                                                                             | Result                                                          |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| The recipient's network, iCloud, or Messages state is unhealthy                                  | The background may appear late, often after reopening Messages. |
| A group member has never spoken, interacted, or is treated by the system as unknown or untrusted | Apple may not show the background UI to that member.            |

<Note>
  The second case is an Apple Messages display limit, not a Spectrum option. If
  one group member never sees the background, have that member send a message
  in the group, mark the sender as known, or reopen Messages before retrying the
  background change.
</Note>

<Note>
  Chat backgrounds require `@spectrum-ts/imessage`. With
  `@spectrum-ts/imessage-local`, `background()` throws an
  <TypeTooltip name="UnsupportedError" type={`declare class UnsupportedError extends Error {
    readonly kind: UnsupportedKind;
    readonly platform?: string;
    readonly contentType?: string;
    readonly action?: string;
    readonly detail?: string;
    constructor(opts: UnsupportedErrorOptions);
    static content(contentType: string, platform?: string, detail?: string): UnsupportedError;
    static action(action: string, platform?: string, detail?: string): UnsupportedError;
    withPlatform(platform: string): UnsupportedError;
  }`} />.
</Note>

<Note>
  The string `"clear"` is a reserved sentinel. If you have a file literally
  named `clear` with no extension, pass `"./clear"` or load it as a `Buffer`.
</Note>
