---
source_origin: "https://photon.codes/docs/spectrum-ts/content/markdown"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/markdown.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "fe92e58a7dca8854e63d4b313cde28f03100cb47886346398067a16f5155988f"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Markdown

> Send styled text that renders through each provider's native formatting model.

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

Use `markdown()` when you want to send styled text written in standard markdown. Spectrum supports CommonMark plus GFM tables and strikethrough.

Each platform renders markdown to its native format. Telegram uses `parse_mode: "HTML"`. iMessage in remote mode uses UTF-16 styled text formatting ranges. Platforms without native markdown support receive readable plain text through the send pipeline's automatic fallback.

```ts theme={null}
import { markdown } from "spectrum-ts";

await space.send(markdown("**Bold** and _italic_ text."));
```

## Streaming markdown

`markdown()` accepts a <TypeTooltip name="StreamTextSource" type={`type StreamTextSource<T = unknown> = {
textStream: AsyncIterable<string> | ReadableStream<string>;
} | AsyncIterable<T> | ReadableStream<T>;`} />, just like `text()`. Markdown streams render progressively on platforms with native support. Everywhere else, the accumulated text falls back through the markdown pipeline instead of surfacing raw `**` markers.

```ts theme={null}
import { markdown } from "spectrum-ts";
import { streamText as aiStreamText } from "ai";

const result = aiStreamText({ model, prompt: message.content.text });
await space.send(markdown(result));
```

Markdown is outbound-only by design. Inbound messages always surface as `text` content regardless of platform formatting.
