---
source_origin: "https://photon.codes/docs/cli/projects"
source_resolved: "https://photon.codes/docs/cli/projects.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "bdf51faeb855600efa5b7c799f0a5276c71d61797fb1d311c50cb1a860835bda"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Projects

> Create, manage, and configure Photon projects from the CLI

Projects are the top-level container in Photon. Each project has its own Spectrum configuration, users, lines, and billing subscription.

## List projects

```sh theme={null}
photon projects ls
photon projects ls --json
```

Aliases: `project ls`, `projects list`.

## Show project details

```sh theme={null}
photon projects show
photon projects show <project-id>
```

Defaults to `$PHOTON_PROJECT_ID` if no ID is given. Aliases: `projects get`.

## Create a project

```sh theme={null}
photon projects create
```

Without flags, the CLI walks you through an interactive prompt. You can also pass flags directly:

```sh theme={null}
photon projects create --name "My Project" --location us-east --spectrum
```

| Flag               | Description                     |
| ------------------ | ------------------------------- |
| `--name <name>`    | Project name                    |
| `--location <loc>` | Deployment region               |
| `--spectrum`       | Enable Spectrum for the project |

Aliases: `projects new`.

## Update a project

```sh theme={null}
photon projects update <project-id> --name "New Name"
```

Fetches the current project, overlays your changes, and patches. Defaults to `$PHOTON_PROJECT_ID` if no ID is given.

Aliases: `projects edit`, `projects set`.

## Delete a project

```sh theme={null}
photon projects delete <project-id>
photon projects delete <project-id> -y   # skip confirmation
```

<Warning>
  This is a permanent, irreversible operation. The CLI asks for confirmation unless you pass `-y`.
</Warning>

Aliases: `projects rm`, `projects remove`.

## Rotate the Spectrum API secret

```sh theme={null}
photon projects regenerate-secret <project-id>
photon projects regenerate-secret -y
```

Generates a new Spectrum API secret for the project. The old secret stops working immediately.

Aliases: `projects rotate-secret`.

## Open in the dashboard

```sh theme={null}
photon projects open
photon projects open <project-id>
photon projects open --no-browser   # prints the URL instead
```

Opens the project's Dashboard page in your default browser.

## Upgrade subscription

Use this command to subscribe a project or manage its existing subscription. The CLI routes you to the right Stripe surface based on the project's current state:

* **Free or unsubscribed projects** — opens Stripe Checkout
* **Active or past-due subscriptions** — opens the Stripe Customer Portal (change plan, payment method, cancel, etc.)

```sh theme={null}
# Interactive picker (recommended)
photon projects upgrade

# Skip the picker with a positional tier
photon projects upgrade pro
photon projects upgrade <project-id> business

# Force a specific flow
photon projects upgrade --checkout         # always Checkout, even if subscribed
photon projects upgrade --manage           # always Portal (downgrade / cancel / change card)

# Use a specific Stripe price (escape hatch)
photon projects upgrade --plan price_xxx
```

Available tiers: `pro`, `business`, `enterprise`.

| Flag                | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `[tier]`            | Positional tier (`pro` / `business` / `enterprise`). Skips the picker.    |
| `--plan <price-id>` | Stripe price ID. Escape hatch when you need a specific price.             |
| `--qty <n>`         | Quantity (default 1)                                                      |
| `--checkout`        | Force Checkout even if the project already has a subscription             |
| `--manage`          | Force the Stripe Customer Portal (use this for downgrades / cancellation) |
| `--no-browser`      | Print the URL instead of opening it                                       |
| `--json`            | Output `{action, url, tier?}` as JSON and skip opening the browser        |

<Note>
  `--manage` wins over `[tier]` / `--plan` / `--checkout` when both are passed. Downgrades and cancellations live in the Stripe Portal — there's no dedicated `downgrade` command.
</Note>

## Check phone number availability

```sh theme={null}
photon projects check-phone +15551234567
```

Checks whether a phone number is available for Spectrum.

## Common flags

These flags are available on most project commands:

| Flag                  | Env var             | Description                                  |
| --------------------- | ------------------- | -------------------------------------------- |
| `-p, --project <id>`  | `PHOTON_PROJECT_ID` | Target project (defaults to env var)         |
| `--api-host <url>`    | `PHOTON_API_HOST`   | Override the backend URL                     |
| `-t, --token <token>` | `PHOTON_TOKEN`      | Use this token instead of stored credentials |
| `--json`              | —                   | Output as JSON                               |
| `-y, --yes`           | —                   | Skip confirmation prompts                    |
