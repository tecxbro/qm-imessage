import { stripVTControlCharacters } from "node:util";

import { PhotonCliProcessError, type PhotonCliRunner } from "./cli-process.ts";

export const PHOTON_MANAGEMENT_ORIGIN = "https://app.photon.codes";

export interface PhotonDeviceAuthorizationDisplay {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface PhotonDeviceLoginAttempt {
  authorization: Promise<PhotonDeviceAuthorizationDisplay>;
  completion: Promise<void>;
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export class PhotonDeviceAuthorizationParser {
  #output = "";
  #authorization: Omit<PhotonDeviceAuthorizationDisplay, "expiresAt"> | undefined;

  public feed(chunk: string): Omit<PhotonDeviceAuthorizationDisplay, "expiresAt"> | undefined {
    if (this.#authorization !== undefined) return this.#authorization;
    this.#output = `${this.#output}${chunk}`.slice(-16_384);
    const plain = stripVTControlCharacters(this.#output).replace(/\r/gu, "");
    const visit = /(?:^|\n)\s*Visit:\s*(https:\/\/[^\s]+)/iu.exec(plain)?.[1];
    const code = /(?:^|\n)\s*Code:\s*([A-Z0-9][A-Z0-9-]{1,63})[ \t]*\n/iu.exec(plain)?.[1];
    if (visit === undefined || code === undefined) return undefined;
    try {
      const parsed = new URL(visit);
      if (parsed.origin !== PHOTON_MANAGEMENT_ORIGIN || parsed.username !== "" || parsed.password !== "") {
        return undefined;
      }
    } catch {
      return undefined;
    }
    this.#authorization = { userCode: code, verificationUrl: visit };
    return this.#authorization;
  }

  public finish(): Omit<PhotonDeviceAuthorizationDisplay, "expiresAt"> {
    if (this.#authorization === undefined) throw new PhotonCliProcessError("command-failed");
    return this.#authorization;
  }
}

export function beginPhotonDeviceLogin(
  cli: PhotonCliRunner,
  installationId: string,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    now?: () => Date;
  },
): PhotonDeviceLoginAttempt {
  const timeoutMs = options.timeoutMs ?? 1_800_000;
  const now = options.now ?? (() => new Date());
  const display = deferred<PhotonDeviceAuthorizationDisplay>();
  const parser = new PhotonDeviceAuthorizationParser();
  let published = false;

  const completion = (async () => {
    try {
      await cli.verifyVersion(installationId, options.signal);
      await cli.run(
        installationId,
        { command: "login" },
        {
          signal: options.signal,
          timeoutMs,
          onOutput: (_stream, chunk) => {
            const authorization = parser.feed(chunk);
            if (authorization === undefined || published) return;
            published = true;
            display.resolve({
              ...authorization,
              expiresAt: new Date(now().getTime() + timeoutMs).toISOString(),
            });
          },
        },
      );
      parser.finish();
    } catch (error) {
      if (!published) display.reject(error);
      throw error;
    }
  })();
  void completion.catch(() => undefined);

  return { authorization: display.promise, completion };
}
