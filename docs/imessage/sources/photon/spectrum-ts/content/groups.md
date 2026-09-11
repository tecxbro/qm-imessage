---
source_origin: "https://photon.codes/docs/spectrum-ts/content/groups"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/groups.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "361727d72ee6d79d6a9d4ebb4e6562a2cb1357eaa3521a7dad2353803c6e88ef"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Groups

> Bundle multiple messages into one logical visual group.

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

Use `group()` to bundle multiple messages into one logical unit, such as an album of images or a multi-attachment reply.

Each item is delivered as its own <TypeTooltip name="Message" type={`interface Message<TPlatform extends string = string, TSender extends User = User, TSpace extends Space = Space> {
content: Content;
direction: "inbound" | "outbound";
edit(newContent: ContentInput): Promise<void>;
readonly id: string;
platform: TPlatform;
react(reaction: string): Promise<(Message<TPlatform, AgentSender, TSpace> & {
    content: Reaction;
}) | undefined>;
read(): Promise<void>;
reply(content: ContentInput): Promise<Message<TPlatform, AgentSender, TSpace> | undefined>;
reply(...content: [
    ContentInput,
    ContentInput,
    ...ContentInput[]
]): Promise<Message<TPlatform, AgentSender, TSpace>[]>;
sender: TSender | undefined;
space: TSpace;
timestamp: Date;
unsend(): Promise<void>;
}`} /> envelope, but the items ship together so the receiving platform can render them as a single visual group when supported.

```ts theme={null}
import { group, attachment } from "spectrum-ts";

await space.send(group(
  attachment("/path/to/photo-1.jpg"),
  attachment("/path/to/photo-2.jpg"),
  attachment("/path/to/photo-3.jpg"),
));
```

Groups don't nest, and reactions can't be group members. The builder enforces both at construction time. Platforms that don't support grouping fall back to sending each item sequentially.
