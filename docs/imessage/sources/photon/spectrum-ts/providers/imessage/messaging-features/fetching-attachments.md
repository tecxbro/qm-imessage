---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/fetching-attachments"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/fetching-attachments.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "836566e9499f33b3dfb7442b33267a9ebd47b5aa2298260a3320c6d4509bbf5f"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Fetching iMessage attachments

> Retrieve cloud iMessage attachments directly by GUID.

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

Retrieve an attachment by its iMessage GUID using `getAttachment` on the
narrowed platform instance. The returned
<TypeTooltip name="Attachment" type={`type Attachment = z.infer<typeof attachmentSchema>;`} /> is
lazy. `.read()` and `.stream()` each trigger an independent download, so cache
`.read()` if you need the bytes more than once.

```ts theme={null}
import { imessage } from "spectrum-ts/providers/imessage";

const im = imessage(app);
const att = await im.getAttachment("p:0/GUID");

if (att) {
  console.log(att.name, att.mimeType, att.size);
  const bytes = await att.read();
}
```

In multi-phone mode, pass the phone number as the second argument to route the
request through the correct instance:

```ts theme={null}
const att = await im.getAttachment("p:0/GUID", "+15559999999");
```

When only one phone is configured, or in shared-pool mode, the phone parameter
is optional.

<Note>
  `getAttachment` requires `@spectrum-ts/imessage`. With
  `@spectrum-ts/imessage-local`, it throws an
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
  Local inbound attachments are still available through each incoming
  message's content.
</Note>
