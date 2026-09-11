---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/message-effects"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/message-effects.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "b6558c95ea9fd52271eefd0362e743aa0d5e53b59ec6b4ef6372c2855acb7aa8"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# iMessage message effects

> Send iMessage bubble and screen effects with text, markdown, or attachments.

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

iMessage supports bubble effects, which animate the sent message bubble, and
screen effects, which play a full-screen animation on receive. Wrap any
content with `effect()`:

```ts theme={null}
import { attachment } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";

await space.send(effect("Happy birthday!", imessage.effect.message.celebration));
await space.send(
  effect(
    attachment("/path/to/photo.jpg"),
    imessage.effect.message.confetti
  )
);
```

The wrapped content can be a string, `markdown(...)`, or any
`attachment(...)`. Effects only apply on iMessage. Other platforms see the
inner content unchanged.

<Note>
  Sending effects requires the cloud `@spectrum-ts/imessage` package. The local
  package exports the helper for API consistency but rejects effect sends with
  an <TypeTooltip name="UnsupportedError" type={`declare class UnsupportedError extends Error {
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

<AccordionGroup>
  <Accordion title="Bubble effects" description="Animate the sent message bubble.">
    | Constant                            | Value                                               |
    | ----------------------------------- | --------------------------------------------------- |
    | `imessage.effect.message.slam`      | `"com.apple.MobileSMS.expressivesend.impact"`       |
    | `imessage.effect.message.loud`      | `"com.apple.MobileSMS.expressivesend.loud"`         |
    | `imessage.effect.message.gentle`    | `"com.apple.MobileSMS.expressivesend.gentle"`       |
    | `imessage.effect.message.invisible` | `"com.apple.MobileSMS.expressivesend.invisibleink"` |
  </Accordion>

  <Accordion title="Screen effects" description="Play a full-screen animation on the recipient's device when the message arrives.">
    | Constant                              | Value                                               |
    | ------------------------------------- | --------------------------------------------------- |
    | `imessage.effect.message.confetti`    | `"com.apple.messages.effect.CKConfettiEffect"`      |
    | `imessage.effect.message.fireworks`   | `"com.apple.messages.effect.CKFireworksEffect"`     |
    | `imessage.effect.message.balloons`    | `"com.apple.messages.effect.CKBalloonEffect"`       |
    | `imessage.effect.message.heart`       | `"com.apple.messages.effect.CKHeartEffect"`         |
    | `imessage.effect.message.lasers`      | `"com.apple.messages.effect.CKLasersEffect"`        |
    | `imessage.effect.message.celebration` | `"com.apple.messages.effect.CKHappyBirthdayEffect"` |
    | `imessage.effect.message.sparkles`    | `"com.apple.messages.effect.CKSparklesEffect"`      |
    | `imessage.effect.message.spotlight`   | `"com.apple.messages.effect.CKSpotlightEffect"`     |
    | `imessage.effect.message.echo`        | `"com.apple.messages.effect.CKEchoEffect"`          |
  </Accordion>
</AccordionGroup>
