---
source_origin: "https://photon.codes/docs/spectrum-ts/content/polls"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/polls.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "e57ffa8265660ccbe175e92f46862af905e9129a10be598c0cc851d6643a61b9"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Polls

> Send poll prompts and receive selected options as content.

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

Use `poll()` to send a poll with a title and a list of choices. Each choice can be a plain string or a <TypeTooltip name="PollChoiceInput" type={`type PollChoiceInput = string | {
title: string;
};`} /> object. Use `option()` when you want the explicit form.

```ts theme={null}
import { poll, option } from "spectrum-ts";

// Variadic strings
await space.send(poll("Lunch?", "Pizza", "Sushi", "Tacos"));

// Or an array, optionally using option() for clarity
await space.send(poll("Lunch?", [
  option("Pizza"),
  option("Sushi"),
  option("Tacos"),
]));
```

Poll responses arrive as `poll_option` content. See [Messages](/docs/spectrum-ts/messages) for narrowing on incoming votes.
