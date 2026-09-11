---
source_origin: "https://photon.codes/docs/spectrum-ts/content"
source_resolved: "https://photon.codes/docs/spectrum-ts/content.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "ff7fc65dfecc07fc3e760115262c14b3439b36e2f9fe2a3f109cee9e619bd42d"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Content

> Build every outbound message shape with Spectrum content builders.

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

Spectrum exposes a family of content builders for text, markdown, attachments, rich previews, replies, edits, typing indicators, chat metadata, and provider-specific payloads. Any API that takes a <TypeTooltip name="ContentInput" type={`type ContentInput = string | ContentBuilder;`} /> accepts a plain string or a <TypeTooltip name="ContentBuilder" type={`interface ContentBuilder {
build(): Promise<Content>;
}`} />.

Use this section when you need to choose the right outbound content shape or understand how a builder degrades across providers.

<CardGroup cols={2}>
  <Card title="Text" icon="message-square-text" href="/docs/spectrum-ts/content/text">
    Send plain text and stream generated text into supported providers.
  </Card>

  <Card title="Markdown" icon="pilcrow" href="/docs/spectrum-ts/content/markdown">
    Send styled text that renders through each provider's native formatting model.
  </Card>

  <Card title="Attachments" icon="paperclip" href="/docs/spectrum-ts/content/attachments">
    Send files from paths, URLs, or buffers with stable attachment IDs.
  </Card>

  <Card title="Voice" icon="audio-lines" href="/docs/spectrum-ts/content/voice">
    Send voice notes with audio metadata and provider fallbacks.
  </Card>

  <Card title="Contacts" icon="contact" href="/docs/spectrum-ts/content/contacts">
    Share contact cards from structured data, users, or vCards.
  </Card>

  <Card title="Rich links" icon="link" href="/docs/spectrum-ts/content/rich-links">
    Let each platform render URLs with its native preview behavior.
  </Card>

  <Card title="App link cards" icon="panel-top" href="/docs/spectrum-ts/content/app">
    Present URLs as tappable app-style cards where providers support them.
  </Card>

  <Card title="Polls" icon="list-checks" href="/docs/spectrum-ts/content/polls">
    Send poll prompts and receive selected options as content.
  </Card>

  <Card title="Groups" icon="images" href="/docs/spectrum-ts/content/groups">
    Bundle multiple messages into one logical visual group.
  </Card>

  <Card title="Custom content" icon="braces" href="/docs/spectrum-ts/content/custom">
    Send provider-specific structured payloads.
  </Card>

  <Card title="Replies" icon="reply" href="/docs/spectrum-ts/content/replies">
    Thread content under an existing message.
  </Card>

  <Card title="Edits" icon="square-pen" href="/docs/spectrum-ts/content/edits">
    Rewrite previously sent outbound messages.
  </Card>

  <Card title="Unsend" icon="undo-2" href="/docs/spectrum-ts/content/unsend">
    Retract a previously sent outbound message.
  </Card>

  <Card title="Typing indicators" icon="ellipsis" href="/docs/spectrum-ts/content/typing-indicators">
    Send start and stop typing signals.
  </Card>

  <Card title="Rename" icon="type" href="/docs/spectrum-ts/content/rename">
    Rename chats through the content pipeline.
  </Card>

  <Card title="Avatar" icon="image" href="/docs/spectrum-ts/content/avatar">
    Set or clear group chat avatars.
  </Card>

  <Card title="Membership" icon="users" href="/docs/spectrum-ts/content/membership">
    Add or remove group members and leave chats.
  </Card>

  <Card title="Composing content" icon="layers" href="/docs/spectrum-ts/content/composing-content">
    Send multiple content items or reply with multiple parts.
  </Card>
</CardGroup>

## Builder shortcut

Plain strings are equivalent to `text()`:

```ts theme={null}
await space.send("Hello, world.");
await space.send(text("Hello, world."));
```

Reach for an explicit builder when you need provider-aware behavior, structured metadata, or a content type that is not plain text.
