---
source_origin: "https://photon.codes/docs/advanced-kits/imessage/chats"
source_resolved: "https://photon.codes/docs/advanced-kits/imessage/chats.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "6bc31a7e8d4aad09decf805b2bf1c747142d53f2a0d1834bb2ff8ab8ea9c673d"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Chats

> Create chats, read chat state, mark read, set typing, share contact cards, and manage chat backgrounds

`im.chats` creates and manages iMessage conversations. A chat can be a direct conversation or a group conversation.

Most chat methods identify the conversation by `chat.guid`. The exceptions are `create(...)`, which takes email addresses or phone numbers and returns `chat.guid`, and `count(...)`, which does not take a chat argument.

For group names, participants, group icons, and leaving a group, use [groups](/docs/advanced-kits/imessage/groups).

## What You Can Do

| Need                 | Use this when                                                       |
| -------------------- | ------------------------------------------------------------------- |
| Create a chat        | You have one or more email addresses or phone numbers               |
| Get a chat           | You have `chat.guid` and need chat details                          |
| Count chats          | You need the number of currently visible chats                      |
| Mark read            | A user opened the conversation and you want to clear unread state   |
| Set typing           | You want to show or hide the typing indicator                       |
| Share a contact card | You want to send the current account's contact card                 |
| Set a background     | You want to apply an image as the chat background                   |
| Subscribe to events  | You need live changes for read state, archive state, or backgrounds |

## Chat GUIDs

A chat GUID is the server identifier for a conversation:

| Chat type   | GUID shape          | Example                   |
| ----------- | ------------------- | ------------------------- |
| Direct chat | `any;-;{recipient}` | `any;-;alice@example.com` |
| Group chat  | `any;+;{group-id}`  | `any;+;group-id`          |

In normal code, do not hand-write GUIDs. Use the `chat.guid` returned by `im.chats.create(...)`, `im.chats.get(...)`, message results, or event payloads.

## Create a Chat

One address creates a direct chat. Two or more addresses create a group chat:

```ts theme={null}
const { chat } = await im.chats.create(["alice@example.com"]);

console.log(chat.guid);
```

```ts theme={null}
const { chat: group } = await im.chats.create(["alice@example.com", "bob@example.com"]);

console.log(group.guid);
```

Returns `CreateChatResult`:

```jsonc theme={null}
{
  "chat": {                         // Created or resolved Chat
    "guid": "any;-;alice@example.com",
    "displayName": "Alice",
    "isGroup": false
  },
  "initialMessage": {                // Present only when options.message is sent
    "guid": "message-guid"
  }
}
```

| Input                     | Rule                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `addresses`               | At least one full email address or E.164 phone number                                                                                |
| `options.message`         | Optional opening text; sent as part of the same call                                                                                 |
| `options.effect`          | Optional effect for the opening message; values are listed under [message effects](/docs/advanced-kits/imessage/messages#message-effects) |
| `options.clientMessageId` | Optional idempotency key for retrying the same logical create operation                                                              |

The server normalizes addresses and rejects short codes, service numbers, invalid email addresses, and duplicate recipients.

`effect` only applies when `options.message` is present. It is not a chat property. For more complex sends, such as formatting or replies, create the chat first and then use the [messages API](/docs/advanced-kits/imessage/messages).

<Note>
  `clientMessageId` is only needed when your job system might retry the same write after a crash or timeout. Most direct calls can omit it. See [error handling](/docs/advanced-kits/imessage/error-handling) for details.
</Note>

## Get a Chat

```ts theme={null}
const chat = await im.chats.get("any;-;alice@example.com");

console.log(chat.displayName, chat.unreadCount, chat.isGroup);
```

Returns `Chat`:

```jsonc theme={null}
{
  "guid": "any;-;alice@example.com",  // Chat GUID used by chat and message APIs
  "displayName": "Alice",            // Display name
  "isGroup": false,                  // Whether this is a group chat
  "participants": [                  // Chat participants
    {
      "address": "alice@example.com",
      "service": "iMessage"
    }
  ],
  "service": "iMessage",             // Chat service
  "isArchived": false,               // Whether the chat is archived
  "isFiltered": false,               // Whether the system filtered this chat
  "unreadCount": 0,                  // Unread count; may be absent
  "lastMessage": {}                  // Latest message when available
}
```

`get(...)` throws `NotFoundError` when the chat does not exist or cannot be resolved.

## Count Chats

By default, archived chats are excluded:

```ts theme={null}
const active = await im.chats.count();
```

Include archived chats with `includeArchived: true`:

```ts theme={null}
const total = await im.chats.count({ includeArchived: true });
```

Returns `number`.

## Read and Typing State

### Mark Read

```ts theme={null}
await im.chats.markRead(chat.guid);
```

Returns `void`. Calling it again when the chat has no unread messages is safe.

### Typing Indicator

Show typing:

```ts theme={null}
await im.chats.setTyping(chat.guid, true);
```

Stop typing:

```ts theme={null}
await im.chats.setTyping(chat.guid, false);
```

Returns `void`. Typing is temporary UI state. It is not written to the durable event log and cannot be caught up after a disconnect.

## Contact Card

```ts theme={null}
await im.chats.shareContactInfo(chat.guid);
```

Returns `void`. The contact card comes from the Mac running the service. The SDK cannot choose which fields are included.

## Chat Backgrounds

Chat backgrounds use raw image bytes. They are not attachment GUIDs, and you do not upload them through `im.attachments` first.

### Set a Background

```ts theme={null}
await im.chats.setBackground(chat.guid, await readFile("background.jpg"));
```

Returns `void`. `data` must not be empty. The server detects the image type from the bytes. JPEG, PNG, HEIC, and HEIF are supported.

After `setBackground(...)` succeeds, the background usually syncs to other participants' devices within `30s`. The image is uploaded to iCloud and then distributed to the conversation. This is not a hard SLA: network state, iCloud state, and the Messages client state all affect when the background appears.

| Stage                               | What happens                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Before `setBackground(...)` returns | The server waits until the background asset is uploaded and ready for distribution |
| After `setBackground(...)` returns  | The chat background change has been submitted, and iCloud distributes the asset    |
| On other devices                    | The background appears after Messages receives the iCloud-distributed asset        |

Common reasons the background UI may not appear:

| Situation                                                                                  | Result                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| The recipient's network, iCloud, or Messages state is unhealthy                            | The background may appear late, often after reopening Messages |
| A group member has never spoken, interacted, or is treated by Apple as unknown / untrusted | Apple may not show the background UI to that member            |

<Note>
  The last case is a Messages display rule, not an SDK option. If one group member never sees the background, it is usually more effective for that member to send a message, mark the sender as known, or reopen Messages than to call `setBackground(...)` repeatedly.
</Note>

### Check Background State

```ts theme={null}
const hasCustom = await im.chats.hasBackground(chat.guid);
```

Returns `boolean`.

### Remove a Background

```ts theme={null}
await im.chats.removeBackground(chat.guid);
```

Returns `void`. Removing a background is safe to repeat, even when no custom background is set.

## Chat Events

`subscribeEvents(...)` returns `TypedEventStream<ChatEvent>`. Use the stream to observe changes made by other people, other devices, or another part of your system. Immediately after your code calls a write method, use that method's return value or completion status.

### Scope

Only one chat:

```ts theme={null}
const stream = im.chats.subscribeEvents({
  chat: chat.guid,
});
```

All visible chat events:

```ts theme={null}
const stream = im.chats.subscribeEvents();
```

### Event Shape

Every chat event has the same outer fields:

```jsonc theme={null}
{
  "type":       "chat.markedRead",       // Event type
  "chatGuid":   "any;-;alice@example.com",
  "sequence":   123,                     // Event sequence for ordering and catch-up
  "isFromMe":   true,                    // Triggered by the current account
  "occurredAt": "2026-01-01T12:00:00Z",  // Event time
  "actor": {                             // Participant that triggered the event; may be absent
    "address": "alice@example.com",
    "service": "iMessage"
  }
}
```

### Event Types

| `event.type`             | Meaning                                 |
| ------------------------ | --------------------------------------- |
| `chat.backgroundChanged` | A custom background was set or replaced |
| `chat.backgroundRemoved` | The custom background was removed       |
| `chat.markedRead`        | The chat was marked read                |
| `chat.archived`          | The chat was archived                   |
| `chat.unarchived`        | The chat was unarchived                 |

### Handle Events

```ts theme={null}
for await (const event of im.chats.subscribeEvents({ chat: chat.guid })) {
  switch (event.type) {
    case "chat.backgroundChanged":
    case "chat.backgroundRemoved":
    case "chat.markedRead":
    case "chat.archived":
    case "chat.unarchived":
      console.log(event.type, event.sequence);
      break;
  }
}
```

When you subscribe to all visible chats, use `event.chatGuid` to identify the chat:

```ts theme={null}
for await (const event of im.chats.subscribeEvents()) {
  console.log(event.chatGuid, event.type);
}
```

If the stream disconnects, use [events](/docs/advanced-kits/imessage/events) to catch up on missed durable events, then continue consuming the live stream.

## Next Steps

1. [Messages](/docs/advanced-kits/imessage/messages) — send, read, edit, and unsend messages with `chat.guid`
2. [Groups](/docs/advanced-kits/imessage/groups) — manage group names, participants, group icons, and leaving
3. [Events](/docs/advanced-kits/imessage/events) — catch up on durable events after a disconnect
4. [Error Handling](/docs/advanced-kits/imessage/error-handling) — handle `NotFoundError`, `ValidationError`, and idempotent retries
