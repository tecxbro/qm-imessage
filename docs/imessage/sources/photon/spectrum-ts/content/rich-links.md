---
source_origin: "https://photon.codes/docs/spectrum-ts/content/rich-links"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/rich-links.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "337325bf6aab25168f6026bd99552b885bd75a7d75de23b0c582872c4945427e"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Rich links

> Let each platform render a URL with its native rich-link preview.

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

Use `richlink()` to build <TypeTooltip name="Richlink" type={`type Richlink = z.infer<typeof richlinkSchema>;`} /> content from a URL. Spectrum carries only the URL. It does not fetch Open Graph metadata.

```ts theme={null}
import { richlink } from "spectrum-ts";

await space.send(richlink("https://example.com/article"));
```

Each provider asks its native client to render or unfurl the URL. Platforms without rich-link support fall back to plain text.
