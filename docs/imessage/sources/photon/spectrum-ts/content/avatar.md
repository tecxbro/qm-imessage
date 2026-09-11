---
source_origin: "https://photon.codes/docs/spectrum-ts/content/avatar"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/avatar.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "91b4282d329127036a22b5e5e83981cc905e2f235168d504fdc9dafcdf1cb3a6"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Avatar

> Set or clear group chat avatars.

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

Use `avatar()` to set or clear the chat avatar, also called a group icon. It is fire-and-forget: `space.send(avatar(...))` resolves to `undefined`.

```ts theme={null}
import { avatar } from "spectrum-ts";

// Set from a file path - MIME type inferred from the extension
await space.send(avatar("./icon.png"));

// Set from a buffer - mimeType is required
await space.send(avatar(buffer, { mimeType: "image/jpeg" }));

// Clear the current avatar
await space.send(avatar("clear"));
```

`space.avatar(...)` is sugar for `space.send(avatar(...))`. Per-platform constraints, such as iMessage requiring remote mode and a group chat, surface as an <TypeTooltip name="UnsupportedError" type={`declare class UnsupportedError extends Error {
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

The <TypeTooltip name="Avatar" type={`type Avatar = z.infer<typeof avatarSchema>;`} /> content is bidirectional: on platforms that report it (iMessage remote mode today), someone else changing the icon arrives as an inbound message with `content.type === "avatar"` — `action.kind === "set"` carries the fetched icon behind `action.read()` with its `mimeType`, and `"clear"` mirrors icon removal. Over the Spectrum webhook, a `set` arrives metadata-only (its `read()` throws); fetch the current icon via `space.getAvatar()` instead, which returns <TypeTooltip name="AvatarData" type={`interface AvatarData {
data: Buffer;
mimeType: string;
}`} /> with the image bytes and MIME type. `message.sender` is the user who changed it, or `undefined` when the platform recorded no actor.

<Note>
  The string `"clear"` is a reserved sentinel. If you have a file literally named `clear` with no extension, pass `"./clear"` or load it as a `Buffer`.
</Note>
