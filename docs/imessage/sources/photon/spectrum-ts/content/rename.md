---
source_origin: "https://photon.codes/docs/spectrum-ts/content/rename"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/rename.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "6579aa3b519f1887690e0376b6e6d53b83c4c92c917ebcd5b9b728ff8147047e"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Rename

> Rename chats through the content pipeline.

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

Use `rename()` to rename the current chat. It is fire-and-forget: `space.send(rename(...))` resolves to `undefined`.

```ts theme={null}
import { rename } from "spectrum-ts";

await space.send(rename("New Chat Name"));
```

`space.rename(displayName)` is sugar for `space.send(rename(displayName))`. The builder throws at construction time if `displayName` is empty.

Per-platform constraints, such as iMessage requiring remote mode and a group chat, surface as an <TypeTooltip name="UnsupportedError" type={`declare class UnsupportedError extends Error {
readonly kind: UnsupportedKind;
readonly platform?: string;
readonly contentType?: string;
readonly action?: string;
readonly detail?: string;
constructor(opts: UnsupportedErrorOptions);
static content(contentType: string, platform?: string, detail?: string): UnsupportedError;
static action(action: string, platform?: string, detail?: string): UnsupportedError;
withPlatform(platform: string): UnsupportedError;
}`} /> from the provider's send action.

The <TypeTooltip name="Rename" type={`type Rename = z.infer<typeof renameSchema>;`} /> content is bidirectional: on platforms that report it (iMessage remote mode today), someone else renaming the chat arrives as an inbound message with `content.type === "rename"` and the new `displayName`. `message.sender` is the user who renamed the chat, or `undefined` when the platform recorded no actor.
