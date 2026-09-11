---
source_origin: "https://photon.codes/docs/cli/installation"
source_resolved: "https://photon.codes/docs/cli/installation.md"
retrieved_at: "2026-09-11T01:18:42.118Z"
source_sha256: "43297faebaf47e98f31429649c313244b37a5eb3b5e39123e2d34cb7807295ed"
retrieval_format: "official-markdown"
---
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.photon.codes/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Installation

> Install the Photon CLI via npm, or as a standalone binary

## One-off — no install

You can run any CLI command on demand without a global install:

<CodeGroup>
  ```sh npx theme={null}
  npx @photon-ai/cli login
  npx @photon-ai/cli projects ls
  ```

  ```sh pnpx theme={null}
  pnpx @photon-ai/cli login
  pnpx @photon-ai/cli projects ls
  ```

  ```sh yarn dlx theme={null}
  # Yarn Berry / v2+ only
  yarn dlx @photon-ai/cli login
  yarn dlx @photon-ai/cli projects ls
  ```

  ```sh bunx theme={null}
  bunx @photon-ai/cli login
  bunx @photon-ai/cli projects ls
  ```
</CodeGroup>

Each time you run it, it pulls the latest release automatically. This is useful for scripts, throwaway machines, or trying the CLI before committing.

## Global install

For daily use, you can install globally so `photon` is always on your `PATH`:

<CodeGroup>
  ```sh npm theme={null}
  npm install -g @photon-ai/cli
  ```

  ```sh pnpm theme={null}
  pnpm add -g @photon-ai/cli
  ```

  ```sh yarn theme={null}
  yarn global add @photon-ai/cli
  ```

  ```sh bun theme={null}
  bun add -g @photon-ai/cli
  ```
</CodeGroup>

```sh theme={null}
photon login
```

The `pho` shortcut alias is created automatically the first time you run `photon`.

<Note>
  You need Node.js >= 18 to run the CLI. You can also use Bun, but it's not required.
</Note>

## Standalone binary

If you don't want any runtime dependency (e.g. CI environments), you can download a prebuilt binary directly. Replace `<os>` and `<arch>` with your platform:

```sh theme={null}
# <os>: darwin | linux
# <arch>: arm64 | x64
curl -L -o /usr/local/bin/photon \
  https://github.com/photon-hq/cli/releases/latest/download/photon-<os>-<arch>
chmod +x /usr/local/bin/photon
photon --version
```

For example, on an Apple Silicon Mac:

```sh theme={null}
curl -L -o /usr/local/bin/photon \
  https://github.com/photon-hq/cli/releases/latest/download/photon-darwin-arm64
chmod +x /usr/local/bin/photon
```

Available platforms:

| Platform | Architectures |
| -------- | ------------- |
| macOS    | arm64, x64    |
| Linux    | arm64, x64    |

Each binary ships with a corresponding `.sha256` checksum on the [release page](https://github.com/photon-hq/cli/releases/latest).

## Update

The CLI shows a notification when a new version is available. To update:

<CodeGroup>
  ```sh npm theme={null}
  npm update -g @photon-ai/cli
  ```

  ```sh pnpm theme={null}
  pnpm update -g @photon-ai/cli
  ```

  ```sh yarn theme={null}
  yarn global upgrade @photon-ai/cli
  ```

  ```sh bun theme={null}
  bun update -g @photon-ai/cli
  ```
</CodeGroup>

If you installed via a standalone binary, re-download the latest release:

```sh theme={null}
curl -L -o /usr/local/bin/photon \
  https://github.com/photon-hq/cli/releases/latest/download/photon-<os>-<arch>
chmod +x /usr/local/bin/photon
```

If you use a one-off runner (`npx` / `pnpx` / `yarn dlx` / `bunx`), you automatically pick up new releases — no manual update needed. These tools cache resolved versions, so to force the latest immediately, pin to `@latest`:

```sh theme={null}
npx @photon-ai/cli@latest projects ls
```

<Note>
  To suppress the update notification, set `PHOTON_NO_UPDATE_NOTIFIER=1`.
</Note>

## Verify the installation

```sh theme={null}
photon --version
photon ping
```

`photon ping` hits the Photon API health endpoint — if you see a success response, you're ready to [authenticate](/docs/cli/authentication).
