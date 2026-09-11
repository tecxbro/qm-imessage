---
source_origin: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/group-membership"
source_resolved: "https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/group-membership.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "9e046c199c41d25d3192ead799ffbe8b6ca0f3c14aff3e3959731133cb140413"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# iMessage group membership

> Add, remove, list, and leave members of an iMessage group chat.

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

Add or remove members with `space.add()` / `space.remove()`, or leave the group
with `space.leave()` — or use the canonical `addMember()` / `removeMember()` /
`leaveSpace()` content builders:

```ts theme={null}
import { addMember, leaveSpace, removeMember } from "spectrum-ts";

// Sugar
await space.add("+15553333333");
await space.add([alice, "carol@example.com"]); // batches land in one call
await space.remove("+15553333333");
await space.leave();

// Canonical
await space.send(addMember("+15553333333"));
await space.send(removeMember("+15553333333"));
await space.send(leaveSpace());
```

Members are E.164 phone numbers or emails — the same handles `space.create`
accepts.

List the current roster with `space.getMembers()`. Each entry's `id` is the
canonical address, so the results feed straight back into `add()` / `remove()`
/ `space.create()`; the agent's own number is excluded:

```ts theme={null}
import { imessage } from "spectrum-ts/providers/imessage";

const members = await space.getMembers();
await space.remove(members.filter((member) => member.id.endsWith("@example.com")));

// Typed extras (address/country/service) via the narrowed instance
const im = imessage(app);
const detailed = await im.getMembers(space);
for (const member of detailed) {
  console.log(member.address, member.service);
}
```

Membership management requires `@spectrum-ts/imessage` and only works on group
chats. With `@spectrum-ts/imessage-local`, or on a DM, it throws an
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
}`} /> — a DM cannot be converted into a group, so create a new
group with `space.create` instead. `getMembers()` has the same constraints.
