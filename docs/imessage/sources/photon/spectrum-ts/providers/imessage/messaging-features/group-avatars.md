---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/group-avatars"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/group-avatars.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "70c7bf4ba02b59f3c88bfb47b6301998e8b6d1f2ceb867dbf07dee7d5fe49cf3"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# iMessage group avatars

> Set, clear, and retrieve iMessage group chat icons.

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

Set or clear the group chat icon using `space.avatar()` or the canonical
`avatar()` content builder:

```ts theme={null}
import { avatar } from "spectrum-ts";

// Sugar - set from a file path
await space.avatar("./icon.png");

// Sugar - clear the current avatar
await space.avatar("clear");

// Canonical
await space.send(avatar("./icon.png"));
```

Read the current icon back with `space.getAvatar()`. It resolves to
<TypeTooltip name="AvatarData" type={`interface AvatarData {
data: Buffer;
mimeType: string;
}`} /> or
`undefined` when the group has no icon. The result round-trips into the setter:

```ts theme={null}
const icon = await space.getAvatar();
if (icon) {
  await otherGroup.avatar(icon.data, { mimeType: icon.mimeType });
}
```

Group avatars require `@spectrum-ts/imessage` and only work on group chats.
With `@spectrum-ts/imessage-local`, or on a DM, `avatar()` and `getAvatar()`
throw an <TypeTooltip name="UnsupportedError" type={`declare class UnsupportedError extends Error {
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
