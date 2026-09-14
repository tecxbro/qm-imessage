import { cloud } from "spectrum-ts";

import type { ProviderLine } from "./capabilities.ts";

export const DEFAULT_LINE_CREDENTIAL_RENEWAL_MARGIN_MS = 300_000;

export interface ScopedLineCredential {
  readonly provider: ProviderLine["reference"]["provider"];
  readonly installationId: string;
  readonly projectId?: string;
  readonly lineId: string;
  readonly phone: string;
  readonly address: string;
  readonly token: string;
  readonly expiresAt: string;
}

export type LineCredentialResolution =
  | { readonly kind: "ready"; readonly credential: ScopedLineCredential }
  | { readonly kind: "unavailable"; readonly code: string };

export interface LineCredentialAcquisitionInput {
  readonly line: ProviderLine;
  readonly acquiredAt: string;
}

export type LineCredentialAcquisition = LineCredentialResolution;

export type LineCredentialAcquirer = (input: LineCredentialAcquisitionInput) => Promise<LineCredentialAcquisition>;

export type TrustedLineAddress = (input: { readonly line: ProviderLine; readonly address: string }) => boolean;

export type PhotonProviderMode = "spectrum" | "advanced";

export type PhotonLineCredentialResolution =
  | {
      readonly kind: "available";
      readonly installationId: string;
      readonly lineId: string;
      readonly mode: PhotonProviderMode;
      readonly bearerToken: string;
      readonly expiresAt?: string;
      readonly provenance: "persisted-line-assignment" | "explicit-runtime-input";
      readonly renewal: "automatic" | "external";
    }
  | { readonly kind: "unavailable"; readonly code: string }
  | { readonly kind: "expired"; readonly code: string };

export interface PhotonLineCredentialResolver {
  resolve(input: {
    readonly installationId: string;
    readonly lineId: string;
    readonly mode: PhotonProviderMode;
    readonly now: string;
  }): Promise<PhotonLineCredentialResolution>;
}

export interface ScopedProjectSecret {
  readonly installationId: string;
  readonly projectId: string;
  readonly projectSecret: string;
}

export type ProjectSecretResolution =
  | { readonly kind: "ready"; readonly credential: ScopedProjectSecret }
  | { readonly kind: "unavailable"; readonly code: string };

export type HostPrivateProjectSecretSource = (input: {
  readonly installationId: string;
  readonly projectId: string;
}) => Promise<ProjectSecretResolution>;

export interface IMessageTokenIssuer {
  issueImessageTokens(projectId: string, projectSecret: string): Promise<unknown>;
}

function unavailable(code: string): LineCredentialResolution {
  return { kind: "unavailable", code };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function snapshotLine(line: ProviderLine): ProviderLine | undefined {
  try {
    return structuredClone(line);
  } catch {
    return undefined;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

const SAFE_UNAVAILABLE_CODES = new Set([
  "PHOTON_CREDENTIAL_ACQUISITION_FAILED",
  "PHOTON_CREDENTIAL_ACQUISITION_UNSUPPORTED",
  "PHOTON_CREDENTIAL_EXPIRY_INVALID",
  "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY",
  "PHOTON_CREDENTIAL_INVALID",
  "PHOTON_CREDENTIAL_LINE_NOT_FOUND",
  "PHOTON_CREDENTIAL_LINE_SCOPE_UNAVAILABLE",
  "PHOTON_CREDENTIAL_PROJECT_MISSING",
  "PHOTON_CREDENTIAL_REFRESH_FAILED",
  "PHOTON_CREDENTIAL_RESPONSE_INVALID",
  "PHOTON_CREDENTIAL_SCOPE_INVALID",
  "PHOTON_CREDENTIAL_SCOPE_MISMATCH",
  "PHOTON_CREDENTIAL_TIME_INVALID",
  "PHOTON_PROJECT_CREDENTIAL_INVALID",
  "PHOTON_PROJECT_CREDENTIAL_SCOPE_MISMATCH",
  "PHOTON_PROJECT_CREDENTIAL_UNAVAILABLE",
]);

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_UNAVAILABLE_CODES.has(value) ? value : fallback;
}

function providerMode(line: ProviderLine): PhotonProviderMode {
  return line.reference.provider === "advanced-imessage" ? "advanced" : "spectrum";
}

function lineServerAddress(lineId: string): string | undefined {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(lineId)) return undefined;
  return `${lineId}.imsg.photon.codes:443`;
}

export async function resolveLineCredential(input: {
  readonly line: ProviderLine;
  readonly acquire: LineCredentialAcquirer;
  readonly trustedAddress: TrustedLineAddress;
  readonly now?: () => number;
  readonly renewalMarginMs?: number;
}): Promise<LineCredentialResolution> {
  const line = snapshotLine(input.line);
  if (line === undefined) return unavailable("PHOTON_CREDENTIAL_SCOPE_INVALID");
  const renewalMarginMs = input.renewalMarginMs ?? DEFAULT_LINE_CREDENTIAL_RENEWAL_MARGIN_MS;
  if (!Number.isSafeInteger(renewalMarginMs) || renewalMarginMs < 0) {
    throw new TypeError("Line credential renewal margin is invalid");
  }
  const clock = input.now ?? Date.now;
  const startedAt = clock();
  if (!Number.isFinite(startedAt) || Math.abs(startedAt) > 8_640_000_000_000_000) {
    return unavailable("PHOTON_CREDENTIAL_TIME_INVALID");
  }
  const acquiredAt = new Date(startedAt).toISOString();
  try {
    const acquired: unknown = await input.acquire({ line: structuredClone(line), acquiredAt });
    if (!record(acquired)) return unavailable("PHOTON_CREDENTIAL_RESPONSE_INVALID");
    const kind = own(acquired, "kind");
    if (kind === "unavailable") {
      return unavailable(safeCode(own(acquired, "code"), "PHOTON_CREDENTIAL_ACQUISITION_FAILED"));
    }
    const credential = own(acquired, "credential");
    if (kind !== "ready" || !record(credential)) {
      return unavailable("PHOTON_CREDENTIAL_RESPONSE_INVALID");
    }
    const provider = own(credential, "provider");
    const installationId = own(credential, "installationId");
    const projectId = own(credential, "projectId");
    const lineId = own(credential, "lineId");
    const phone = own(credential, "phone");
    const address = own(credential, "address");
    const token = own(credential, "token");
    const expiresAt = own(credential, "expiresAt");
    if (
      (provider !== "advanced-imessage" && provider !== "spectrum-imessage") ||
      !nonempty(installationId) ||
      (projectId !== undefined && !nonempty(projectId)) ||
      !nonempty(lineId) ||
      !nonempty(phone) ||
      !nonempty(address) ||
      !nonempty(token) ||
      !canonicalTimestamp(expiresAt)
    ) {
      return unavailable("PHOTON_CREDENTIAL_INVALID");
    }
    if (
      provider !== line.reference.provider ||
      installationId !== line.reference.installationId ||
      projectId !== line.reference.projectId ||
      lineId !== line.reference.lineId ||
      phone !== line.phone
    ) {
      return unavailable("PHOTON_CREDENTIAL_SCOPE_MISMATCH");
    }
    if (!input.trustedAddress({ line, address })) {
      return unavailable("PHOTON_CREDENTIAL_SCOPE_MISMATCH");
    }
    const completedAt = clock();
    if (!Number.isFinite(completedAt) || completedAt < startedAt || Math.abs(completedAt) > 8_640_000_000_000_000) {
      return unavailable("PHOTON_CREDENTIAL_TIME_INVALID");
    }
    if (Date.parse(expiresAt) <= completedAt + renewalMarginMs) {
      return unavailable("PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY");
    }
    return {
      kind: "ready",
      credential: {
        provider,
        installationId,
        ...(projectId === undefined ? {} : { projectId }),
        lineId,
        phone,
        address,
        token,
        expiresAt,
      },
    };
  } catch {
    return unavailable("PHOTON_CREDENTIAL_ACQUISITION_FAILED");
  }
}

export function createSpectrumCloudLineCredentialAcquirer(options: {
  readonly projectSecrets: HostPrivateProjectSecretSource;
  readonly issuer?: IMessageTokenIssuer;
}): LineCredentialAcquirer {
  const issuer = options.issuer ?? cloud;
  return async ({ line, acquiredAt }) => {
    const scopedLine = snapshotLine(line);
    if (scopedLine === undefined) return unavailable("PHOTON_CREDENTIAL_SCOPE_INVALID");
    if (scopedLine.reference.provider !== "spectrum-imessage") {
      return unavailable("PHOTON_CREDENTIAL_ACQUISITION_UNSUPPORTED");
    }
    if (scopedLine.kind !== "dedicated") return unavailable("PHOTON_CREDENTIAL_LINE_SCOPE_UNAVAILABLE");
    if (
      !nonempty(scopedLine.reference.installationId) ||
      !nonempty(scopedLine.reference.lineId) ||
      !nonempty(scopedLine.phone) ||
      !canonicalTimestamp(acquiredAt)
    ) {
      return unavailable("PHOTON_CREDENTIAL_SCOPE_INVALID");
    }
    const projectId = scopedLine.reference.projectId;
    if (!nonempty(projectId)) return unavailable("PHOTON_CREDENTIAL_PROJECT_MISSING");
    let projectResolution: unknown;
    try {
      projectResolution = await options.projectSecrets({
        installationId: scopedLine.reference.installationId,
        projectId,
      });
    } catch {
      return unavailable("PHOTON_PROJECT_CREDENTIAL_UNAVAILABLE");
    }
    let projectSecret: string;
    try {
      if (!record(projectResolution)) return unavailable("PHOTON_PROJECT_CREDENTIAL_UNAVAILABLE");
      const projectKind = own(projectResolution, "kind");
      if (projectKind === "unavailable") return unavailable("PHOTON_PROJECT_CREDENTIAL_UNAVAILABLE");
      const projectCredential = own(projectResolution, "credential");
      if (projectKind !== "ready" || !record(projectCredential)) {
        return unavailable("PHOTON_PROJECT_CREDENTIAL_INVALID");
      }
      if (
        own(projectCredential, "installationId") !== scopedLine.reference.installationId ||
        own(projectCredential, "projectId") !== projectId
      ) {
        return unavailable("PHOTON_PROJECT_CREDENTIAL_SCOPE_MISMATCH");
      }
      const value = own(projectCredential, "projectSecret");
      if (!nonempty(value)) return unavailable("PHOTON_PROJECT_CREDENTIAL_INVALID");
      projectSecret = value;
    } catch {
      return unavailable("PHOTON_PROJECT_CREDENTIAL_INVALID");
    }
    let tokenData: unknown;
    try {
      tokenData = await issuer.issueImessageTokens(projectId, projectSecret);
    } catch {
      return unavailable("PHOTON_CREDENTIAL_REFRESH_FAILED");
    }
    try {
      if (!record(tokenData)) return unavailable("PHOTON_CREDENTIAL_RESPONSE_INVALID");
      const type = own(tokenData, "type");
      if (type === "shared") {
        return unavailable("PHOTON_CREDENTIAL_LINE_SCOPE_UNAVAILABLE");
      }
      const auth = own(tokenData, "auth");
      const numbers = own(tokenData, "numbers");
      if (type !== "dedicated" || !record(auth) || !record(numbers)) {
        return unavailable("PHOTON_CREDENTIAL_RESPONSE_INVALID");
      }
      const token = own(auth, scopedLine.reference.lineId);
      const phone = own(numbers, scopedLine.reference.lineId);
      const address = lineServerAddress(scopedLine.reference.lineId);
      if (!nonempty(token) || !nonempty(phone) || address === undefined) {
        return unavailable("PHOTON_CREDENTIAL_LINE_NOT_FOUND");
      }
      if (phone !== scopedLine.phone) return unavailable("PHOTON_CREDENTIAL_SCOPE_MISMATCH");
      const expiresIn = own(tokenData, "expiresIn");
      if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
        return unavailable("PHOTON_CREDENTIAL_EXPIRY_INVALID");
      }
      const acquiredAtMilliseconds = Date.parse(acquiredAt);
      const expiresAtMilliseconds = acquiredAtMilliseconds + expiresIn * 1_000;
      if (
        !Number.isFinite(expiresAtMilliseconds) ||
        expiresAtMilliseconds <= acquiredAtMilliseconds ||
        Math.abs(expiresAtMilliseconds) > 8_640_000_000_000_000
      ) {
        return unavailable("PHOTON_CREDENTIAL_EXPIRY_INVALID");
      }
      return {
        kind: "ready",
        credential: {
          provider: "spectrum-imessage",
          installationId: scopedLine.reference.installationId,
          projectId,
          lineId: scopedLine.reference.lineId,
          phone,
          address,
          token,
          expiresAt: new Date(expiresAtMilliseconds).toISOString(),
        },
      };
    } catch {
      return unavailable("PHOTON_CREDENTIAL_RESPONSE_INVALID");
    }
  };
}

export function createSpectrumCloudLineCredentialResolver(options: {
  readonly line: ProviderLine;
  readonly projectSecrets: HostPrivateProjectSecretSource;
  readonly issuer?: IMessageTokenIssuer;
  readonly now?: () => number;
  readonly renewalMarginMs?: number;
}): { resolve(): Promise<LineCredentialResolution> } {
  const acquire = createSpectrumCloudLineCredentialAcquirer(options);
  return {
    resolve: async () =>
      await resolveLineCredential({
        line: options.line,
        acquire,
        trustedAddress: ({ line, address }) => address === lineServerAddress(line.reference.lineId),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.renewalMarginMs === undefined ? {} : { renewalMarginMs: options.renewalMarginMs }),
      }),
  };
}

export function createPhotonLineCredentialResolver(options: {
  readonly line: ProviderLine;
  readonly projectSecrets: HostPrivateProjectSecretSource;
  readonly issuer?: IMessageTokenIssuer;
  readonly renewalMarginMs?: number;
  readonly now?: () => number;
}): PhotonLineCredentialResolver {
  return {
    resolve: async (input) => {
      const line = snapshotLine(options.line);
      if (line === undefined) return { kind: "unavailable", code: "PHOTON_CREDENTIAL_SCOPE_INVALID" };
      const expectedMode = providerMode(line);
      if (
        input.installationId !== line.reference.installationId ||
        input.lineId !== line.reference.lineId ||
        input.mode !== expectedMode
      ) {
        return { kind: "unavailable", code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH" };
      }
      if (!canonicalTimestamp(input.now)) {
        return { kind: "unavailable", code: "PHOTON_CREDENTIAL_TIME_INVALID" };
      }
      let clockReads = 0;
      const resolver = createSpectrumCloudLineCredentialResolver({
        ...options,
        line,
        now: () => (clockReads++ === 0 ? Date.parse(input.now) : (options.now ?? Date.now)()),
      });
      const result = await resolver.resolve();
      if (result.kind === "unavailable") {
        return result.code === "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY"
          ? { kind: "expired", code: result.code }
          : result;
      }
      return {
        kind: "available",
        installationId: result.credential.installationId,
        lineId: result.credential.lineId,
        mode: expectedMode,
        bearerToken: result.credential.token,
        expiresAt: result.credential.expiresAt,
        provenance: "persisted-line-assignment",
        renewal: "external",
      };
    },
  };
}
