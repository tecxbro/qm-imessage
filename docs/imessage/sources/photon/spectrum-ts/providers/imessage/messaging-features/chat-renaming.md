---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/chat-renaming"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/chat-renaming.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "47e2e1621f87a5c60ec88531f863aac5a510145d6344fd6729efc147fd87960d"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# iMessage chat renaming

> Rename an iMessage group chat.

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

Rename a group chat using `space.rename()` or the canonical `rename()` content
builder:

```ts theme={null}
import { rename } from "spectrum-ts";

// Sugar
await space.rename("Book Club");

// Canonical
await space.send(rename("Book Club"));
```

Renaming requires `@spectrum-ts/imessage` and only works on group chats. With
`@spectrum-ts/imessage-local`, or on a DM, `rename()` throws an
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
