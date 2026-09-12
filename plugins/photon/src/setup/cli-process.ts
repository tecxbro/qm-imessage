import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

export const PINNED_PHOTON_CLI_VERSION = "2.2.0";

export type PhotonCliInvocation =
  | { command: "version" }
  | { command: "login" }
  | { command: "whoami" }
  | { command: "projects-list" }
  | { command: "project-show"; projectId: string }
  | { command: "project-secret"; projectId: string }
  | { command: "project-create"; name: string }
  | { command: "users-list"; projectId: string }
  | { command: "lines-list"; projectId: string };

export type PhotonCliProcessFailureCode =
  | "authorization-denied"
  | "authorization-expired"
  | "cancelled"
  | "command-failed"
  | "not-authenticated"
  | "output-limit"
  | "spawn-failed"
  | "timeout"
  | "unsafe-config"
  | "unsupported-version";

export class PhotonCliProcessError extends Error {
  public readonly code: PhotonCliProcessFailureCode;

  public constructor(code: PhotonCliProcessFailureCode) {
    super(code);
    this.name = "PhotonCliProcessError";
    this.code = code;
  }
}

export interface PhotonCliProcessResult {
  stdout: string;
  stderr: string;
}

export interface PhotonCliRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface PhotonCliRunner {
  configDirectory(installationId: string): string;
  verifyVersion(installationId: string, signal?: AbortSignal): Promise<string>;
  run(
    installationId: string,
    invocation: PhotonCliInvocation,
    options?: PhotonCliRunOptions,
  ): Promise<PhotonCliProcessResult>;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function projectName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Project name is invalid");
  }
  return normalized;
}

export function photonCliArgv(invocation: PhotonCliInvocation): readonly string[] {
  switch (invocation.command) {
    case "version":
      return ["--version"];
    case "login":
      return ["login", "--no-browser"];
    case "whoami":
      return ["whoami"];
    case "projects-list":
      return ["projects", "ls", "--json"];
    case "project-show":
      return ["projects", "show", identifier(invocation.projectId, "Project ID"), "--json"];
    case "project-secret":
      return ["projects", "secret", identifier(invocation.projectId, "Project ID"), "--json"];
    case "project-create":
      return [
        "projects",
        "create",
        "--name",
        projectName(invocation.name),
        "--location",
        "United States",
        "--platforms",
        "imessage",
        "--json",
      ];
    case "users-list":
      return ["spectrum", "users", "ls", "--project", identifier(invocation.projectId, "Project ID"), "--json"];
    case "lines-list":
      return ["spectrum", "lines", "ls", "--project", identifier(invocation.projectId, "Project ID"), "--json"];
  }
}

function classifiedFailure(output: string): PhotonCliProcessFailureCode {
  const normalized = stripVTControlCharacters(output).toLowerCase();
  if (normalized.includes("authorization was denied") || normalized.includes("access_denied")) {
    return "authorization-denied";
  }
  if (normalized.includes("device code expired") || normalized.includes("expired_token")) {
    return "authorization-expired";
  }
  if (
    normalized.includes("not authenticated") ||
    normalized.includes("session expired") ||
    normalized.includes("run `photon login`")
  ) {
    return "not-authenticated";
  }
  return "command-failed";
}

async function hardenTree(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new PhotonCliProcessError("unsafe-config");
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await hardenTree(join(path, entry));
    return;
  }
  if (!metadata.isFile()) throw new PhotonCliProcessError("unsafe-config");
  await chmod(path, 0o600);
}

function safeEnvironment(configDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: configDirectory,
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PHOTON_CONFIG_DIR: configDirectory,
    PHOTON_NO_COLOR: "1",
    PHOTON_NO_UPDATE_NOTIFIER: "1",
  };
  for (const key of ["LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "TZ"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class PhotonCliProcess implements PhotonCliRunner {
  readonly #executable: string;
  readonly #configRoot: string;
  readonly #defaultTimeoutMs: number;
  readonly #defaultMaxOutputBytes: number;

  public constructor(options: {
    configRoot: string;
    executable?: string;
    defaultTimeoutMs?: number;
    defaultMaxOutputBytes?: number;
  }) {
    if (!isAbsolute(options.configRoot)) throw new TypeError("Photon config root must be absolute");
    this.#configRoot = resolve(options.configRoot);
    this.#executable = options.executable ?? "photon";
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 65_536;
  }

  public configDirectory(installationId: string): string {
    const normalized = identifier(installationId, "Installation ID");
    const digest = createHash("sha256").update(normalized).digest("hex");
    return join(this.#configRoot, "installations", digest);
  }

  public async verifyVersion(installationId: string, signal?: AbortSignal): Promise<string> {
    const result = await this.run(installationId, { command: "version" }, signal === undefined ? {} : { signal });
    const version = stripVTControlCharacters(result.stdout).trim().replace(/^v/u, "");
    if (version !== PINNED_PHOTON_CLI_VERSION) throw new PhotonCliProcessError("unsupported-version");
    return version;
  }

  public async run(
    installationId: string,
    invocation: PhotonCliInvocation,
    options: PhotonCliRunOptions = {},
  ): Promise<PhotonCliProcessResult> {
    const configDirectory = this.configDirectory(installationId);
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await hardenTree(this.#configRoot);
    if (options.signal?.aborted === true) throw new PhotonCliProcessError("cancelled");
    const argv = photonCliArgv(invocation);
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.#defaultMaxOutputBytes;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Photon CLI timeout is invalid");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new TypeError("Photon CLI output limit is invalid");
    }

    return await new Promise<PhotonCliProcessResult>((resolveResult, rejectResult) => {
      const child = spawn(this.#executable, [...argv], {
        cwd: configDirectory,
        detached: false,
        env: safeEnvironment(configDirectory),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const stdout: string[] = [];
      const stderr: string[] = [];
      let outputBytes = 0;
      let forcedKill: NodeJS.Timeout | undefined;
      let termination: PhotonCliProcessFailureCode | undefined;
      let settled = false;

      const terminate = (code: PhotonCliProcessFailureCode) => {
        if (termination !== undefined) return;
        termination = code;
        child.kill("SIGTERM");
        forcedKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forcedKill.unref();
      };
      const onAbort = () => terminate("cancelled");
      const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
      timeout.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const receive = (stream: "stdout" | "stderr", chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          terminate("output-limit");
          return;
        }
        const decoded = stream === "stdout" ? stdoutDecoder.write(chunk) : stderrDecoder.write(chunk);
        if (stream === "stdout") stdout.push(decoded);
        else stderr.push(decoded);
        options.onOutput?.(stream, decoded);
      };

      child.stdout.on("data", (chunk: Buffer) => receive("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => receive("stderr", chunk));

      const finish = async (exitCode: number | null, spawnFailed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forcedKill !== undefined) clearTimeout(forcedKill);
        options.signal?.removeEventListener("abort", onAbort);
        stdout.push(stdoutDecoder.end());
        stderr.push(stderrDecoder.end());
        try {
          await hardenTree(configDirectory);
        } catch {
          rejectResult(new PhotonCliProcessError("unsafe-config"));
          return;
        }
        if (termination !== undefined) {
          rejectResult(new PhotonCliProcessError(termination));
          return;
        }
        if (spawnFailed) {
          rejectResult(new PhotonCliProcessError("spawn-failed"));
          return;
        }
        const result = { stdout: stdout.join(""), stderr: stderr.join("") };
        if (exitCode !== 0) {
          rejectResult(new PhotonCliProcessError(classifiedFailure(`${result.stdout}\n${result.stderr}`)));
          return;
        }
        resolveResult(result);
      };

      child.once("error", () => void finish(null, true));
      child.once("close", (exitCode) => void finish(exitCode, false));
    });
  }
}
