---
source_origin: "https://photon.codes/docs/cli/spectrum"
source_resolved: "https://photon.codes/docs/cli/spectrum.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "5af57fd1a7d9271e42768f13c97512c375a3fd4e820ff619a1acc3699f670596"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Spectrum

> Manage Spectrum profiles, users, lines, platforms, and avatars from the CLI

The `photon spectrum` commands manage your project's messaging configuration — the Spectrum profile, users, phone lines, platform toggles, and avatar.

All Spectrum commands require an active project. Set `$PHOTON_PROJECT_ID` or pass `--project <id>`.

## Spectrum profile

View or update the Spectrum profile attached to your project.

```sh theme={null}
# View the current profile
photon spectrum profile show

# Update profile fields
photon spectrum profile update --display-name "Support Bot"
```

Aliases: `spectrum profile edit`.

## Users

Manage users that can interact through your project's Spectrum instance.

### List users

```sh theme={null}
photon spectrum users ls
photon spectrum users ls --json
```

Aliases: `spectrum users list`.

### Add a user

```sh theme={null}
photon spectrum users add
```

Aliases: `spectrum users create`.

### Remove a user

```sh theme={null}
photon spectrum users remove <user-id>
```

<Warning>
  Removing a user is irreversible. The CLI asks for confirmation unless you pass `-y`.
</Warning>

Aliases: `spectrum users rm`, `spectrum users delete`.

## Lines

Manage the phone lines assigned to your project.

### List lines

```sh theme={null}
photon spectrum lines ls
```

Aliases: `spectrum lines list`.

### Add a line

```sh theme={null}
photon spectrum lines add
```

Currently supports iMessage lines only.

### Remove a line

```sh theme={null}
photon spectrum lines remove <line-id>
```

## Platforms

View and toggle messaging platforms for your project.

### List platforms

```sh theme={null}
photon spectrum platforms ls
```

Aliases: `spectrum platforms list`.

### Enable a platform

```sh theme={null}
photon spectrum platforms enable <platform-name>
```

### Disable a platform

```sh theme={null}
photon spectrum platforms disable <platform-name>
```

## Avatar

Upload a custom avatar image for your project's Spectrum profile.

```sh theme={null}
photon spectrum avatar upload photo.png
```

The CLI requests a presigned upload URL from the API, uploads the file directly, and patches the Spectrum profile to use it.

| Flag                  | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `--no-update-profile` | Upload the file but don't update the Spectrum profile to use it |

## Common flags

| Flag                  | Env var             | Description                                  |
| --------------------- | ------------------- | -------------------------------------------- |
| `-p, --project <id>`  | `PHOTON_PROJECT_ID` | Target project                               |
| `--api-host <url>`    | `PHOTON_API_HOST`   | Override the backend URL                     |
| `-t, --token <token>` | `PHOTON_TOKEN`      | Use this token instead of stored credentials |
| `--json`              | —                   | Output as JSON (where supported)             |
