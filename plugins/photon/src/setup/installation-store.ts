import { isDeepStrictEqual } from "node:util";

import {
  assertJsonSafe,
  parseInstallationReference,
  projectInstallationForDashboard,
  type PrivateInstallationStatus,
} from "../../../chassis/src/photon-contract.ts";
import type { InstallationRecord } from "../ports.ts";

export interface PhotonInstallationCiphertextRecord {
  installationId: string;
  ownerRevision: string;
  version: number;
  wrappingKeyId: string;
  ciphertext: string;
}

export interface PhotonInstallationCiphertextStore {
  read(installationId: string): Promise<PhotonInstallationCiphertextRecord | undefined>;
  create(record: PhotonInstallationCiphertextRecord): Promise<boolean>;
  compareAndSet(
    installationId: string,
    expectedVersion: number,
    next: PhotonInstallationCiphertextRecord,
  ): Promise<boolean>;
}

export interface PhotonInstallationStoreAdapter {
  read(installationId: string): Promise<InstallationRecord | undefined>;
  create(record: InstallationRecord): Promise<boolean>;
  compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean>;
}

export interface PhotonInstallationSecretCodec {
  wrappingKeyId: string;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string, wrappingKeyId: string): string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be non-empty`);
  return value;
}

function wrappingKeyId(value: unknown): string {
  const keyId = nonempty(value, "wrappingKeyId");
  if (keyId.length > 256 || /[\u0000-\u001f\u007f]/u.test(keyId)) {
    throw new TypeError("wrappingKeyId is invalid");
  }
  return keyId;
}

function privateStatus(value: PrivateInstallationStatus): void {
  const input = object(value, "installationRecord.status");
  const display = projectInstallationForDashboard(value);
  const publicInput = Object.fromEntries(Object.keys(display).map((key) => [key, input[key]]));
  if (!isDeepStrictEqual(publicInput, display)) throw new TypeError("installationRecord.status is invalid");
  keys(
    input,
    [...Object.keys(display), "management", "managementOrigin", "runtime", "deviceCode"],
    "installationRecord.status",
  );
  if (input.management !== undefined) {
    const management = object(input.management, "installationRecord.status.management");
    keys(management, ["accessToken", "credentialPath"], "installationRecord.status.management");
    if (management.accessToken !== undefined) {
      nonempty(management.accessToken, "installationRecord.status.management.accessToken");
    }
    if (management.credentialPath !== undefined) {
      nonempty(management.credentialPath, "installationRecord.status.management.credentialPath");
    }
  }
  if (input.managementOrigin !== undefined) {
    nonempty(input.managementOrigin, "installationRecord.status.managementOrigin");
  }
  if (input.runtime !== undefined) {
    const runtime = object(input.runtime, "installationRecord.status.runtime");
    keys(runtime, ["projectSecret"], "installationRecord.status.runtime");
    nonempty(runtime.projectSecret, "installationRecord.status.runtime.projectSecret");
  }
  if (input.deviceCode !== undefined) nonempty(input.deviceCode, "installationRecord.status.deviceCode");
}

function serviceRecord(value: unknown): InstallationRecord {
  assertJsonSafe(value, "installationRecord");
  const input = object(value, "installationRecord");
  keys(input, ["installation", "status", "ownerRevision", "version"], "installationRecord");
  const installation = parseInstallationReference(input.installation);
  const status = input.status as PrivateInstallationStatus;
  privateStatus(status);
  if (status.installationId !== installation.installationId) {
    throw new TypeError("installation record identity mismatch");
  }
  if (status.state === "connected" && status.projectId !== installation.projectId) {
    throw new TypeError("connected installation project mismatch");
  }
  nonempty(input.ownerRevision, "installationRecord.ownerRevision");
  if (typeof input.version !== "number" || !Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TypeError("installationRecord.version must be a positive safe integer");
  }
  return value as unknown as InstallationRecord;
}

function binding(record: InstallationRecord, wrappingKeyId: string) {
  return {
    format: "qm-photon-installation/v1",
    installationId: record.installation.installationId,
    ownerRevision: record.ownerRevision,
    version: record.version,
    wrappingKeyId,
  };
}

function forStorage(
  record: InstallationRecord,
  codec: PhotonInstallationSecretCodec,
): PhotonInstallationCiphertextRecord {
  try {
    const next = serviceRecord(record);
    return {
      installationId: next.installation.installationId,
      ownerRevision: next.ownerRevision,
      version: next.version,
      wrappingKeyId: codec.wrappingKeyId,
      ciphertext: codec.encrypt(JSON.stringify({ ...binding(next, codec.wrappingKeyId), record: next })),
    };
  } catch {
    throw new Error("PHOTON_INSTALLATION_SERVICE_SECRET_INVALID");
  }
}

function forService(
  stored: PhotonInstallationCiphertextRecord,
  codec: PhotonInstallationSecretCodec,
): InstallationRecord {
  try {
    assertJsonSafe(stored, "photonInstallationCiphertextRecord");
    const outer = object(stored, "photonInstallationCiphertextRecord");
    keys(
      outer,
      ["installationId", "ownerRevision", "version", "wrappingKeyId", "ciphertext"],
      "photonInstallationCiphertextRecord",
    );
    nonempty(stored.installationId, "photonInstallationCiphertextRecord.installationId");
    nonempty(stored.ownerRevision, "photonInstallationCiphertextRecord.ownerRevision");
    wrappingKeyId(stored.wrappingKeyId);
    nonempty(stored.ciphertext, "photonInstallationCiphertextRecord.ciphertext");
    if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
      throw new TypeError("invalid ciphertext binding");
    }
    const decoded = object(
      JSON.parse(codec.decrypt(stored.ciphertext, stored.wrappingKeyId)) as unknown,
      "photonInstallationEnvelope",
    );
    const expected = {
      format: "qm-photon-installation/v1",
      installationId: stored.installationId,
      ownerRevision: stored.ownerRevision,
      version: stored.version,
      wrappingKeyId: stored.wrappingKeyId,
    };
    keys(decoded, [...Object.keys(expected), "record"], "photonInstallationEnvelope");
    if (
      Object.keys(decoded).length !== Object.keys(expected).length + 1 ||
      Object.entries(expected).some(([key, field]) => decoded[key] !== field)
    ) {
      throw new TypeError("ciphertext context mismatch");
    }
    const record = serviceRecord(decoded.record);
    if (
      record.installation.installationId !== stored.installationId ||
      record.ownerRevision !== stored.ownerRevision ||
      record.version !== stored.version
    ) {
      throw new TypeError("ciphertext record mismatch");
    }
    return record;
  } catch {
    throw new Error("PHOTON_INSTALLATION_SECRET_INVALID");
  }
}

export function createEncryptedPhotonInstallationStore(
  persisted: PhotonInstallationCiphertextStore,
  codec: PhotonInstallationSecretCodec,
): PhotonInstallationStoreAdapter {
  try {
    wrappingKeyId(codec.wrappingKeyId);
  } catch {
    throw new Error("PHOTON_INSTALLATION_WRAPPING_KEY_ID_INVALID");
  }
  return {
    async read(installationId) {
      const record = await persisted.read(installationId);
      if (record === undefined) return undefined;
      if (record.installationId !== installationId) throw new Error("PHOTON_INSTALLATION_SECRET_INVALID");
      return forService(record, codec);
    },
    create(record) {
      return persisted.create(forStorage(record, codec));
    },
    compareAndSet(installationId, expectedVersion, next) {
      return persisted.compareAndSet(installationId, expectedVersion, forStorage(next, codec));
    },
  };
}
