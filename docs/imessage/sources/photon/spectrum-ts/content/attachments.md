---
source_origin: "https://photon.codes/docs/spectrum-ts/content/attachments"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/attachments.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "c93e553cdf6d9e19ffdbb9fd6fe0c2c485fd418dd6a0422b8da0991230707d64"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Attachments

> Send files from paths, URLs, or buffers with stable attachment IDs.

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

Use `attachment()` to send files. Pass a file path, a `URL`, or a `Buffer`. MIME types are detected from the file extension. Override with `options.mimeType` when you already have the bytes.

```ts theme={null}
import { attachment } from "spectrum-ts";

// From a file path - name and MIME type inferred
await space.send(attachment("/path/to/photo.jpg"));

// From a buffer - provide name and MIME type
await space.send(attachment(buffer, {
  name: "report.pdf",
  mimeType: "application/pdf",
}));
```

If the MIME type can't be inferred from the name and you didn't pass `options.mimeType`, `attachment()` throws when the content is built.

## Attachment IDs

Every resolved attachment carries a stable `id`. When the attachment originates from a provider, the ID preserves the provider-native identifier, such as an iMessage GUID, Slack file ID, or WhatsApp media ID.

For outbound attachments built with `attachment()`, Spectrum assigns a random UUID unless you pass `options.id`:

```ts theme={null}
await space.send(attachment(buffer, {
  id: "custom-id",
  name: "report.pdf",
  mimeType: "application/pdf",
}));
```

Use the resolved <TypeTooltip name="Attachment" type={`type Attachment = z.infer<typeof attachmentSchema>;`} /> and accepted <TypeTooltip name="AttachmentInput" type={`type AttachmentInput = string | Buffer | URL;`} /> input types in your own signatures:

```ts theme={null}
import { type Attachment, type AttachmentInput } from "spectrum-ts";
```
