---
source_origin: "https://photon.codes/docs/spectrum-ts/content/text"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/text.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "f0dd86ab78e5e062d3a8cf01fcdb37b4ed6d8bcb2fb505b895959cf3431c00ef"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Text

> Send plain text and stream text through Spectrum.

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

Use `text()` for plain outbound text. You can also pass a plain string anywhere Spectrum accepts content.

```ts theme={null}
import { text } from "spectrum-ts";

await space.send(text("Hello, world."));

// Plain strings are equivalent:
await space.send("Hello, world.");
```

## Streaming text

Both `text()` and `markdown()` accept a <TypeTooltip name="StreamTextSource" type={`type StreamTextSource<T = unknown> = {
textStream: AsyncIterable<string> | ReadableStream<string>;
} | AsyncIterable<T> | ReadableStream<T>;`} />: an AI SDK result, an `AsyncIterable`, or a `ReadableStream`.

On platforms that support it, text streams live. iMessage in remote mode sends the first chunk as a real message and edits in place as more text arrives. Telegram private chats animate a native draft preview. Platforms without streaming support wait for the stream to finish and send the full text as one message.

<Tabs>
  <Tab title="Vercel AI SDK">
    ```ts theme={null}
    import { text } from "spectrum-ts";
    import { streamText as aiStreamText } from "ai";

    const result = aiStreamText({ model, prompt: message.content.text });
    await space.send(text(result));
    ```
  </Tab>

  <Tab title="AsyncIterable">
    ```ts theme={null}
    import { text } from "spectrum-ts";

    async function* generate() {
      yield "Hello, ";
      yield "world!";
    }

    await space.send(text(generate()));
    ```
  </Tab>

  <Tab title="Custom extractor">
    ```ts theme={null}
    import { text } from "spectrum-ts";

    await space.send(
      text(customStream, {
        extract: (chunk) => chunk.delta?.text ?? null,
      }),
    );
    ```
  </Tab>
</Tabs>

A stream can only be sent once.

<Accordion title="TextStreamOptions" description="">
  | Option     | Type                      | Description                                                                                                                                                                                   |
  | ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `extract?` | `DeltaExtractor&lt;T&gt;` | Map each chunk to its incremental text. Omit to rely on built-in auto-detection of the common SDK shapes (OpenAI chat/responses, Anthropic messages, AI SDK text streams, and plain strings). |
</Accordion>
