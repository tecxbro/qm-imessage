---
source_origin: "https://photon.codes/docs/spectrum-ts/content/contacts"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/contacts.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "8f2a4702d7814328bb1b82d0974ef948b0806b5a1b1cf7756be0ff51f1985472"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Contacts

> Share contact cards from structured data, users, or vCards.

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

Use `contact()` to share contact cards. The builder takes either a structured <TypeTooltip name="ContactInput" type={`type ContactInput = Omit<Contact, "type">;`} />, a vCard string, a `vcf` instance, or a known <TypeTooltip name="User" type={`interface User {
readonly __platform: string;
readonly id: string;
readonly kind?: "agent";
}`} /> paired with optional <TypeTooltip name="ContactDetails" type={`type ContactDetails = Omit<ContactInput, "user">;`} />.

<Tabs>
  <Tab title="Structured">
    ```ts theme={null}
    import { contact } from "spectrum-ts";

    await space.send(contact({
      name: { first: "Ada", last: "Lovelace" },
      phones: [{ value: "+15551234567", type: "mobile" }],
      emails: [{ value: "ada@example.com", type: "work" }],
    }));
    ```
  </Tab>

  <Tab title="From a User">
    ```ts theme={null}
    import { contact } from "spectrum-ts";

    // Attach extra details on top of an existing platform user
    await space.send(contact(alice, {
      name: { first: "Alice", last: "Anderson" },
      org: { name: "Acme", title: "Engineer" },
    }));
    ```
  </Tab>

  <Tab title="From vCard">
    ```ts theme={null}
    import { contact, fromVCard } from "spectrum-ts";

    const vcf = await readFile("/path/to/ada.vcf", "utf8");
    await space.send(contact(vcf));

    // Or parse first if you want to inspect/edit the fields
    const parsed = fromVCard(vcf);
    await space.send(contact({ ...parsed, note: "Met at conference" }));
    ```
  </Tab>
</Tabs>

`fromVCard(vcf)` parses a vCard string into a <TypeTooltip name="ContactInput" type={`type ContactInput = Omit<Contact, "type">;`} />. `toVCard(contact)` serializes a resolved <TypeTooltip name="Contact" type={`type Contact = z.infer<typeof contactSchema>;`} /> back to vCard.

<Accordion title="ContactInput" description="The fields you can populate on a contact card. All fields are optional except where the receiving platform requires at least one identifying field.">
  | Field       | Type                                                                                                                                           | Description                                                         |
  | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
  | `user`      | <TypeTooltip name="User" type={`interface User {     readonly __platform: string;     readonly id: string;     readonly kind?: "agent"; }`} /> | Resolved provider user reference.                                   |
  | `name`      | `{ formatted?, first?, last?, middle?, prefix?, suffix? }`                                                                                     | Structured display name.                                            |
  | `phones`    | `Array<{ value, type? }>`                                                                                                                      | Phone numbers. `type` is `"mobile" \| "home" \| "work" \| "other"`. |
  | `emails`    | `Array<{ value, type? }>`                                                                                                                      | Email addresses. `type` is `"home" \| "work" \| "other"`.           |
  | `addresses` | `Array<{ street?, city?, region?, postalCode?, country?, type? }>`                                                                             | Postal addresses.                                                   |
  | `org`       | `{ name?, title?, department? }`                                                                                                               | Employer or org info.                                               |
  | `urls`      | `string[]`                                                                                                                                     | Associated URLs.                                                    |
  | `birthday`  | `string`                                                                                                                                       | ISO date.                                                           |
  | `note`      | `string`                                                                                                                                       | Free-form note.                                                     |
  | `photo`     | `{ mimeType, read() }`                                                                                                                         | Profile photo bytes.                                                |
  | `raw`       | `unknown`                                                                                                                                      | Provider-specific extras passed through untouched.                  |
</Accordion>
