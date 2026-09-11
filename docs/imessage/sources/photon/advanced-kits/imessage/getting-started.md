---
source_origin: "https://photon.codes/docs/advanced-kits/imessage/getting-started"
source_resolved: "https://photon.codes/docs/advanced-kits/imessage/getting-started.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "0ea8284fe707db60c1b43b138afca52241385d7ba7caaca5c8b5193457478277"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Getting Started

> Install the Advanced iMessage SDK, connect to a server, and send your first iMessage

<Note>
  Most apps should start with [Spectrum](/docs/spectrum-ts/getting-started). It gives you one API across iMessage, WhatsApp Business, and other channels. Use `@photon-ai/advanced-imessage` directly when you need low-level iMessage features that Spectrum does not expose.
</Note>

## Before You Start

You need three things: a runtime, Photon credentials, and a recipient that can receive iMessage.

### Runtime

Use Node.js `>=18.17` or Bun. If you are using Node, check your version first:

```bash theme={null}
node --version
```

### Photon Credentials

Copy these two values:

| Value          | Format                                                |
| -------------- | ----------------------------------------------------- |
| Server address | `host:port`, for example `"imessage.example.com:443"` |
| Bearer token   | A token string for the server                         |

The server address is only the host and port. Do not include `https://`. For the first working example, put the server address directly in `send.ts`.

<Warning>
  Put the bearer token in an environment variable. Do not commit it to source control.
</Warning>

<CodeGroup>
  ```bash macOS/Linux theme={null}
  export IMESSAGE_TOKEN="your-token"
  ```

  ```powershell Windows PowerShell theme={null}
  $env:IMESSAGE_TOKEN="your-token"
  ```
</CodeGroup>

This sets the variable only for the current terminal session. If you close the terminal, set it again. In production, set `IMESSAGE_TOKEN` through your deployment platform or secret manager.

### Recipient

Prepare an address that can receive iMessage:

* an email address, such as `alice@example.com`
* an E.164 phone number, such as `+15551234567`

The example below uses that address to create a chat, then sends a message to the returned `chat.guid`.

## Install

<CodeGroup>
  ```bash npm theme={null}
  npm install @photon-ai/advanced-imessage
  ```

  ```bash pnpm theme={null}
  pnpm add @photon-ai/advanced-imessage
  ```

  ```bash yarn theme={null}
  yarn add @photon-ai/advanced-imessage
  ```

  ```bash bun theme={null}
  bun add @photon-ai/advanced-imessage
  ```
</CodeGroup>

## Send Your First Message

The first send has three steps:

1. **Create a client** with your server address and token.
2. **Resolve the recipient** with `im.chats.create(...)`. This gives you a `chat.guid`.
3. **Send text** with `im.messages.sendText(...)`.

Create `send.ts`, then replace `imessage.example.com:443` and `alice@example.com`:

```ts theme={null}
import { createClient } from "@photon-ai/advanced-imessage";

const im = createClient({
  address: "imessage.example.com:443",
  token: process.env.IMESSAGE_TOKEN!,
});

try {
  // Message APIs need chat.guid, not the raw email address or phone number.
  const { chat } = await im.chats.create(["alice@example.com"]);

  const message = await im.messages.sendText(chat.guid, "Hello from the SDK");
  console.log(message.guid);
} finally {
  await im.close();
}
```

`im.chats.create(...)` returns a server chat GUID. Direct chats and group chats use different shapes:

| Chat type   | GUID shape          | Example                   |
| ----------- | ------------------- | ------------------------- |
| Direct chat | `any;-;{recipient}` | `any;-;alice@example.com` |
| Group chat  | `any;+;{group-id}`  | `any;+;group-id`          |

Message APIs take `chat.guid`, not the raw email address or phone number:

```ts theme={null}
await im.messages.sendText(chat.guid, "Hello from the SDK");
```

### Run It

Node.js can run TypeScript through [`tsx`](https://github.com/privatenumber/tsx). Bun runs `.ts` files directly.

<CodeGroup>
  ```bash npm theme={null}
  npx tsx send.ts
  ```

  ```bash pnpm theme={null}
  pnpm dlx tsx send.ts
  ```

  ```bash yarn theme={null}
  yarn dlx tsx send.ts
  ```

  ```bash bun theme={null}
  bun send.ts
  ```
</CodeGroup>

On success, the script prints `message.guid`. Seeing that GUID means the message was accepted and sent.

## Client Options

`createClient(...)` accepts these options:

| Option    | Type                      | Required | Description                                                                           |
| --------- | ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `address` | `string`                  | Yes      | Server address in `host:port` format. Do not include `https://`.                      |
| `token`   | `string`                  | Yes      | Bearer token.                                                                         |
| `tls`     | `boolean`                 | No       | Encrypt the gRPC connection. Defaults to `true`; keep the default for hosted servers. |
| `timeout` | `number`                  | No       | Timeout, in milliseconds, for unary requests. Streams stay open.                      |
| `retry`   | `boolean \| RetryOptions` | No       | Retry retryable unary failures. Streams are not retried automatically.                |

## SDK Overview

The client is organized by resource:

| Namespace        | What it does                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `im.messages`    | Send text, attachments, mini app cards, multipart messages, replies, reactions, stickers, edits, unsends, list queries, and message events |
| `im.chats`       | Create chats, read chat state, count chats, mark read, set typing, share contact cards, and manage chat backgrounds                        |
| `im.groups`      | Rename groups, manage participants, set group icons, and leave groups                                                                      |
| `im.attachments` | Upload files, read metadata, and stream downloads                                                                                          |
| `im.polls`       | Create polls, vote, unvote, add options, and subscribe to poll events                                                                      |
| `im.addresses`   | Check address metadata, Focus silence state, and iMessage availability                                                                     |
| `im.locations`   | Read Find My shared friend locations, request location sharing, and watch live updates                                                     |
| `im.events`      | Replay durable events after a disconnect                                                                                                   |

## Next Steps

Core path:

1. [Messages](/docs/advanced-kits/imessage/messages) — send text, attachments, mini app cards, multipart messages, reactions, edits, unsends, and subscribe to message events
2. [Chats](/docs/advanced-kits/imessage/chats) — create chats, mark read, set typing, and manage chat backgrounds
3. [Events](/docs/advanced-kits/imessage/events) — catch up on durable events after a disconnect
4. [Error Handling](/docs/advanced-kits/imessage/error-handling) — understand error classes, retries, and idempotency keys

Use as needed:

* [Groups](/docs/advanced-kits/imessage/groups) — manage group names, participants, icons, and leaving
* [Attachments](/docs/advanced-kits/imessage/attachments) — upload files, read metadata, and stream downloads
* [Polls](/docs/advanced-kits/imessage/polls) — create polls, vote, and subscribe to poll events
* [Addresses](/docs/advanced-kits/imessage/addresses) — check addresses, Focus state, and iMessage availability
* [Locations](/docs/advanced-kits/imessage/locations) — read Find My shared friend locations and request location sharing
