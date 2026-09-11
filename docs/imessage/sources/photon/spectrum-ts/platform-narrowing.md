---
source_origin: "https://photon.codes/docs/spectrum-ts/platform-narrowing"
source_resolved: "https://photon.codes/docs/spectrum-ts/platform-narrowing.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "bf4786f4ecab20832500b0585ceb406281eaf04299f1c6af987cbc980a7d137b"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Platform Narrowing

> Recover platform-specific types and actions from unified Spectrum primitives

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

Every platform provider exports a callable — `imessage`, `localIMessage`,
`slack`, `terminal`, `whatsappBusiness`, `telegram` — that **narrows** generic
Spectrum types into platform-specific ones. The same function handles three
different inputs.

## Narrowing the app

Pass a <TypeTooltip name="SpectrumInstance" type={`type SpectrumInstance<Providers extends PlatformProviderConfig[] = PlatformProviderConfig[]> = SpectrumLike<Providers> & CustomEventStreams<Providers> & {
readonly messages: AsyncIterable<[
    Space,
    Message
]>;
stop(): Promise<void>;
send(space: Space, content: ContentInput): Promise<Message<string, AgentSender> | undefined>;
send(space: Space, ...content: [
    ContentInput,
    ContentInput,
    ...ContentInput[]
]): Promise<Message<string, AgentSender>[]>;
edit(message: Message, newContent: ContentInput): Promise<void>;
responding<T>(space: Space, fn: () => T | Promise<T>): Promise<T>;
webhook(request: Request, handler: WebhookHandler): Promise<Response>;
webhook(request: WebhookRawRequest, handler: WebhookHandler): Promise<WebhookRawResult>;
};`} /> to get a <TypeTooltip name="PlatformInstance" type={`type PlatformInstance<Def extends AnyPlatformDef> = {
readonly messages: AsyncIterable<[
    PlatformSpace<Def>,
    PlatformMessage<Def>
]>;
readonly space: SpaceNamespace<Def>;
user(userID: string): Promise<PlatformUser<Def>>;
} & CustomEventInstanceProperties<Def> & PlatformWiseInstanceMethods<Def> & InstanceActionMethods<Def>;`} /> for that platform. The platform instance gives you `user()` and `space.create()` / `space.get()` resolvers, plus access to any custom events the provider emits.

```ts theme={null}
import { imessage } from "spectrum-ts/providers/imessage";

const im = imessage(app);

const user = await im.user("+15551234567");
const space = await im.space.create(user);

await space.send("Hello from a new conversation.");
```

If the platform isn't registered in the `providers` array, the type of `imessage(app)` resolves to `never` — the call is a compile-time error.

## Narrowing a space

Pass an existing space to access platform-specific fields:

```ts theme={null}
for await (const [space, message] of app.messages) {
  if (message.platform !== "imessage") continue;

  const imessageSpace = imessage(space);
  if (imessageSpace.type === "group") {
    // group chat logic — `type` only exists on iMessage spaces
  }
}
```

Narrowing a space from the wrong platform logs a structured warning at runtime. Always gate on `message.platform` (or a similar signal) first to avoid unexpected behavior.

The local macOS provider is a separate platform. Gate on
`message.platform === "local_imessage"` and narrow with `localIMessage(...)`;
the cloud provider continues to use `"imessage"` and `imessage(...)`.

## Narrowing a message

Same idea for messages — useful when a provider declares a `message.schema` to attach extra properties:

```ts theme={null}
for await (const [space, message] of app.messages) {
  if (message.platform !== "imessage") continue;
  const imessageMessage = imessage(message);
  // imessageMessage carries any iMessage-specific fields
}
```

## Creating group conversations

`space.create(...)` accepts a single user or an array of users. On iMessage:

```ts theme={null}
const im = imessage(app);
const alice = await im.user("+15551111111");
const bob = await im.user("+15552222222");

const group = await im.space.create([alice, bob]);
await group.send("Welcome to the group.");
```

Some platforms support an additional `params` argument for extra space creation options — the shape of those params is defined per-provider through `space.params` on the platform definition.

## Why narrowing matters

The generic <TypeTooltip name="Space" type={`interface Space<_Def = unknown> {
readonly __platform: string;
add(users: MemberInput): Promise<void>;
avatar(input: string | URL, options?: {
    mimeType?: string;
}): Promise<void>;
avatar(input: Buffer, options: {
    mimeType: string;
}): Promise<void>;
edit(message: Message | undefined, newContent: ContentInput): Promise<void>;
getAvatar(): Promise<AvatarData | undefined>;
getDisplayName(): Promise<string | undefined>;
getMembers(): Promise<User[]>;
getMessage(id: string): Promise<Message | undefined>;
readonly id: string;
leave(): Promise<void>;
read(message: Message): Promise<void>;
remove(users: MemberInput): Promise<void>;
rename(displayName: string): Promise<void>;
responding<T>(fn: () => T | Promise<T>): Promise<T>;
send(content: ReactionBuilder): Promise<(Message<string, AgentSender> & {
    content: Reaction;
}) | undefined>;
send(content: ContentInput): Promise<Message<string, AgentSender> | undefined>;
send(...content: [
    ContentInput,
    ContentInput,
    ...ContentInput[]
]): Promise<Message<string, AgentSender>[]>;
startTyping(): Promise<void>;
stopTyping(): Promise<void>;
unsend(message: Message | undefined): Promise<void>;
}`} /> and <TypeTooltip name="Message" type={`interface Message<TPlatform extends string = string, TSender extends User = User, TSpace extends Space = Space> {
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
}`} /> interfaces are deliberately small — just enough to send, react, and reply across every platform. Narrowing is the escape hatch for everything else: typed access to iMessage chat types, WhatsApp phone numbers, or any extra field your [custom platform](/docs/spectrum-ts/custom-platforms) exposes.
