---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/contact-card-sharing"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/contact-card-sharing.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "f96ec1311476f01e4f055f3badb7295d3c9859f56caeb81976b8c23eec6e4f98"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Native iMessage contact card sharing

> Share the bot account's own iMessage contact card in a chat.

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

Share the bot account's own iMessage contact card directly in a chat. Use
`nativeContactCard()` to build the content, or the `space.shareContactCard()`
sugar method on a narrowed iMessage space:

<Tabs>
  <Tab title="Sugar (space.shareContactCard)">
    ```ts theme={null}
    import { imessage } from "spectrum-ts/providers/imessage";

    const im = imessage(space);
    await im.shareContactCard();
    ```
  </Tab>

  <Tab title="Canonical (space.send)">
    ```ts theme={null}
    import { nativeContactCard } from "spectrum-ts/providers/imessage";

    await space.send(nativeContactCard());
    ```
  </Tab>
</Tabs>

This shares the bot's own contact card as it appears in iMessage. Recipients
can tap it to save the contact. Use it in onboarding flows where you want users
to add your bot to their contacts.

<Note>
  Native contact card sharing requires `@spectrum-ts/imessage`. With
  `@spectrum-ts/imessage-local`, `nativeContactCard()` throws an
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
