---
source_origin: "https://photon.codes/docs/spectrum-ts/content/membership"
source_resolved: "https://photon.codes/docs/spectrum-ts/content/membership.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "009d7a2eeede558e61e3120560dec41956159f82c7698f75b269aa22ebf4d53b"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Membership

> Add or remove group members and leave chats through the content pipeline.

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

Use `addMember()` and `removeMember()` to manage a group chat's members, and `leaveSpace()` to make the agent's own account leave the chat. All three are fire-and-forget: `space.send(...)` resolves to `undefined`.

```ts theme={null}
import { addMember, leaveSpace, removeMember } from "spectrum-ts";

await space.send(addMember("+15551234567"));
await space.send(removeMember(["+15551234567", "carol@example.com"]));
await space.send(leaveSpace());
```

`space.add(users)`, `space.remove(users)`, and `space.leave()` are sugar for the canonical forms above.

```ts theme={null}
await space.add(alice);
await space.add(["+15551234567", bob]);
await space.remove("+15551234567");
await space.leave();
```

`addMember()` and `removeMember()` accept <TypeTooltip name="MemberInput" type={`type MemberInput = User | string | (User | string)[];`} />: a <TypeTooltip name="User" type={`interface User {
readonly __platform: string;
readonly id: string;
readonly kind?: "agent";
}`} /> resolved by the current platform or a raw id, either alone or in a batch. Ids use the same platform handle format `space.create` accepts (for iMessage: an E.164 phone number or email); they are passed to the provider verbatim, with no resolution step. Both return a <TypeTooltip name="ContentBuilder" type={`interface ContentBuilder {
build(): Promise<Content>;
}`} /> that validates when it builds — an empty member list rejects at `space.send(...)` time, not at construction.

Per-platform constraints surface as an <TypeTooltip name="UnsupportedError" type={`declare class UnsupportedError extends Error {
readonly kind: UnsupportedKind;
readonly platform?: string;
readonly contentType?: string;
readonly action?: string;
readonly detail?: string;
constructor(opts: UnsupportedErrorOptions);
static content(contentType: string, platform?: string, detail?: string): UnsupportedError;
static action(action: string, platform?: string, detail?: string): UnsupportedError;
withPlatform(platform: string): UnsupportedError;
}`} /> from the provider's send action. iMessage requires remote mode and a group chat — a DM cannot be converted into a group, so on a DM the error points you at creating a group via `space.create` instead.

## Inbound membership events

On platforms that report membership changes (iMessage remote mode today), the same content types arrive as inbound <TypeTooltip name="Message" type={`interface Message<TPlatform extends string = string, TSender extends User = User, TSpace extends Space = Space> {
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
}`} /> values on `app.messages` — what you send is what you observe when someone else does it:

```ts theme={null}
for await (const [space, message] of app.messages) {
  switch (message.content.type) {
    case "addMember":
      console.log(`${message.sender?.id ?? "someone"} added ${message.content.members.join(", ")}`);
      break;
    case "removeMember":
      console.log(`${message.sender?.id ?? "someone"} removed ${message.content.members.join(", ")}`);
      break;
    case "leaveSpace":
      // leaveSpace carries no members — the sender IS the leaver
      console.log(`${message.sender?.id ?? "someone"} left`);
      break;
  }
}
```

The envelope carries the event semantics:

* `message.sender` is the acting user — who added or removed the members. It is `undefined` when the platform recorded no actor. A self-join surfaces with the joiner as both sender and member.
* A voluntary leave and a removal are distinct types: `leaveSpace` (sender = the leaver) vs `removeMember` (sender = the remover, `members` = who was removed).
* `members` are platform handles in the same format `space.create` accepts — compare them against `space.getMembers()` or feed them back into `space.add(...)`.
* The agent's own actions are suppressed: `space.add(...)` does not echo back as an inbound event.
