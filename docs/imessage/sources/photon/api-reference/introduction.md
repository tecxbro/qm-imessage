---
source_origin: "https://photon.codes/docs/api-reference/introduction"
source_resolved: "https://photon.codes/docs/api-reference/introduction.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "231ddc4b38587e33f7ff6f9638dacdcbdfc97231d11fa35ea0c6e8991c1369bc"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Introduction

> Manage Spectrum projects, webhooks, and platform configuration over HTTPS.

The Spectrum API is the HTTP surface for managing a project's webhooks, platforms, lines, and users. It's the same thing the [Photon dashboard](https://app.photon.codes) and the [`photon` CLI](/docs/cli/overview) call under the hood — reach for it when you want to automate setup, drive changes from CI, or build your own internal tooling.

If you're sending and receiving messages at runtime, you want the [`spectrum-ts` SDK](/docs/spectrum-ts/getting-started) or [webhooks](/docs/webhooks/overview) instead. This API is for the management plane around them.

## Base URL

Every endpoint lives under a single host. HTTPS only — plaintext requests are rejected.

```
https://spectrum.photon.codes
```

## Authentication

The API uses HTTP Basic auth. The username is your `projectId` and the password is your `projectSecret`. Credentials are scoped to a single project and never expire on their own.

```sh theme={null}
curl -u "$PROJECT_ID:$PROJECT_SECRET" \
  "https://spectrum.photon.codes/projects/$PROJECT_ID/webhooks/"
```

Retrieve credentials with [`photon projects show`](/docs/cli/projects) or from the dashboard. If a secret leaks, rotate it with [`photon projects regenerate-secret`](/docs/cli/projects#rotate-the-spectrum-api-secret).

<Warning>
  Project credentials grant full management access to a project. Store them in a secrets manager, not in source control or shell history.
</Warning>

<Note>
  Basic auth with project credentials applies to the Spectrum API only. The Dashboard API on `app.photon.codes` authenticates with bearer tokens instead — your own token from the CLI's [device flow](/docs/cli/authentication), or user-consented [OAuth 2.1 access tokens](/docs/api-reference/oauth) if you're building an app for other Photon users.
</Note>

## Response format

Every response is JSON wrapped in a `{ succeed, data }` envelope. On success, `data` holds the resource:

```json theme={null}
{
  "succeed": true,
  "data": {
    "id": "6a4d2e8c-7b1f-4d3a-9a8e-2c5d6f7e8a9b",
    "webhookUrl": "https://your-app.com/spectrum-webhook",
    "createdAt": "2026-05-14T19:00:00Z",
    "updatedAt": "2026-05-14T19:00:00Z"
  }
}
```

On error, `succeed` is `false` and the body carries an explanation:

```json theme={null}
{
  "succeed": false,
  "message": "webhookUrl must be a valid URL"
}
```

List endpoints return an array under `data` rather than a single object. The HTTP status code is the source of truth for whether a call succeeded — branch on it first, then read `data`.

## Response codes

| Code  | Meaning                                                              |
| ----- | -------------------------------------------------------------------- |
| `200` | Request succeeded.                                                   |
| `401` | Missing or invalid project credentials.                              |
| `404` | Resource not found or already deleted.                               |
| `409` | Conflict — for example, a resource with the same key already exists. |
| `422` | Request body failed schema validation.                               |
| `5xx` | Spectrum-side error. Safe to retry with backoff.                     |

## Where to next

<CardGroup cols={2}>
  <Card title="Get project" icon="braces" href="/docs/api-reference/projects/get-project">
    The simplest endpoint to try first — fetch a project by id.
  </Card>

  <Card title="Get started with the SDK" icon="rocket" href="/docs/spectrum-ts/getting-started">
    Send and receive messages from your agent server with `spectrum-ts`.
  </Card>
</CardGroup>
