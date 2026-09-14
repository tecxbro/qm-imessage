import assert from "node:assert/strict";
import { test } from "node:test";

import { decryptSecret, deriveConnectorKey, encryptSecret } from "../../chassis/src/secret-box.ts";
import type { InstallationRecord } from "../src/ports.ts";
import type {
  PhotonCliInvocation,
  PhotonCliProcessResult,
  PhotonCliRunOptions,
  PhotonCliRunner,
} from "../src/setup/cli-process.ts";
import { PhotonCliInstallationService } from "../src/setup/installation.ts";
import {
  createEncryptedPhotonInstallationStore,
  type PhotonInstallationCiphertextRecord,
  type PhotonInstallationCiphertextStore,
  type PhotonInstallationSecretCodec,
  type PhotonInstallationStoreAdapter,
} from "../src/setup/installation-store.ts";

class StrictCiphertextStore implements PhotonInstallationCiphertextStore {
  readonly records = new Map<string, PhotonInstallationCiphertextRecord>();
  readonly versions: number[] = [];

  async read(installationId: string): Promise<PhotonInstallationCiphertextRecord | undefined> {
    const record = this.records.get(installationId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async create(record: PhotonInstallationCiphertextRecord): Promise<boolean> {
    this.#validate(record);
    if (record.version !== 1 || this.records.has(record.installationId)) return false;
    this.records.set(record.installationId, structuredClone(record));
    this.versions.push(record.version);
    return true;
  }

  async compareAndSet(
    installationId: string,
    expectedVersion: number,
    next: PhotonInstallationCiphertextRecord,
  ): Promise<boolean> {
    this.#validate(next);
    if (
      this.records.get(installationId)?.version !== expectedVersion ||
      next.installationId !== installationId ||
      next.version !== expectedVersion + 1
    ) {
      return false;
    }
    this.records.set(installationId, structuredClone(next));
    this.versions.push(next.version);
    return true;
  }

  #validate(record: PhotonInstallationCiphertextRecord): void {
    assert.deepEqual(Object.keys(record).sort(), [
      "ciphertext",
      "installationId",
      "ownerRevision",
      "version",
      "wrappingKeyId",
    ]);
    assert.equal(typeof record.installationId, "string");
    assert.equal(typeof record.ownerRevision, "string");
    assert.equal(Number.isSafeInteger(record.version), true);
    assert.equal(typeof record.wrappingKeyId, "string");
    assert.equal(typeof record.ciphertext, "string");
  }
}

class SetupCli implements PhotonCliRunner {
  configDirectory(installationId: string): string {
    return `/private/photon/${installationId}`;
  }

  async verifyVersion(): Promise<string> {
    return "2.2.0";
  }

  async run(
    _installationId: string,
    invocation: PhotonCliInvocation,
    options: PhotonCliRunOptions = {},
  ): Promise<PhotonCliProcessResult> {
    if (invocation.command === "login") {
      options.onOutput?.("stdout", "Visit: https://app.photon.codes/device\nCode: ABCD-EFGH\n");
      return { stdout: "", stderr: "" };
    }
    if (invocation.command === "project-create") {
      return { stdout: JSON.stringify({ id: "project-a", name: invocation.name }), stderr: "" };
    }
    if (invocation.command === "project-secret") {
      return {
        stdout: JSON.stringify({ id: invocation.projectId, projectSecret: "runtime-project-secret" }),
        stderr: "",
      };
    }
    if (invocation.command === "users-list") {
      return {
        stdout: JSON.stringify([
          { id: "recipient-a", phoneNumber: "+14155550101", assignedPhoneNumber: "+14155550999" },
        ]),
        stderr: "",
      };
    }
    if (invocation.command === "projects-list") {
      return { stdout: JSON.stringify([{ id: "project-a", name: "QM iMessage" }]), stderr: "" };
    }
    return { stdout: "Signed in", stderr: "" };
  }
}

function codec(
  material = "persistent-installation-key",
  wrappingKeyId = "installation-key-1",
  historical: Readonly<Record<string, string>> = {},
) {
  const keys = new Map(
    Object.entries({ ...historical, [wrappingKeyId]: material }).map(([keyId, keyMaterial]) => [
      keyId,
      deriveConnectorKey(keyMaterial, "photon-installation"),
    ]),
  );
  return {
    wrappingKeyId,
    encrypt: (value: string) => encryptSecret(value, keys.get(wrappingKeyId)!),
    decrypt: (value: string, keyId: string) => {
      const key = keys.get(keyId);
      if (key === undefined) throw new Error("unknown wrapping key");
      return decryptSecret(value, key);
    },
  } satisfies PhotonInstallationSecretCodec;
}

function service(store: PhotonInstallationStoreAdapter, installationId = "installation-a") {
  return new PhotonCliInstallationService({
    installationId,
    store,
    ownerRevision: { read: async () => "owner-revision-1" },
    cli: new SetupCli(),
  });
}

function connectedRecord(installationId: string, version = 1): InstallationRecord {
  const projectId = `project-${installationId}`;
  return {
    installation: { installationId, projectId },
    status: {
      state: "connected",
      installationId,
      projectId,
      lines: [{ lineId: `line-${installationId}`, maskedAddress: "+1•••0999" }],
      management: { credentialPath: `/private/photon/${installationId}` },
      runtime: { projectSecret: `secret-${installationId}` },
    },
    ownerRevision: "owner-revision-1",
    version,
  };
}

test("the installation service persists one ciphertext record and resumes after restart", async () => {
  const persisted = new StrictCiphertextStore();
  const encrypted = createEncryptedPhotonInstallationStore(persisted, codec());
  const first = service(encrypted);
  assert.equal(
    (
      await first.start({
        project: { kind: "create-project", name: "QM iMessage" },
        assignment: { kind: "shared-recipient", address: "+14155550101" },
      })
    ).state,
    "awaiting-authorization",
  );
  const connected = await first.waitForCompletion();
  assert.deepEqual(connected, {
    state: "connected",
    installationId: "installation-a",
    projectId: "project-a",
    lines: [{ lineId: "recipient-a", maskedAddress: "+1•••0999" }],
  });
  assert.deepEqual(persisted.versions, [1, 2, 3, 4, 5, 6, 7]);
  const stored = persisted.records.get("installation-a")!;
  assert.deepEqual(Object.keys(stored).sort(), [
    "ciphertext",
    "installationId",
    "ownerRevision",
    "version",
    "wrappingKeyId",
  ]);
  assert.match(stored.ciphertext, /^v2:/u);
  assert.doesNotMatch(
    JSON.stringify(stored),
    /runtime-project-secret|project-a|recipient-a|credentialPath|private\/photon/u,
  );
  assert.doesNotMatch(JSON.stringify(connected), /runtime-project-secret|ciphertext|credentialPath/u);

  const restarted = service(createEncryptedPhotonInstallationStore(persisted, codec()));
  assert.deepEqual(await restarted.status(), connected);
});

test("the adapter preserves compare-and-set and rejects invalid service records", async () => {
  const persisted = new StrictCiphertextStore();
  const encrypted = createEncryptedPhotonInstallationStore(persisted, codec());
  const initial = connectedRecord("installation-a");
  assert.equal(await encrypted.create(initial), true);
  assert.equal(await encrypted.create(connectedRecord("installation-b")), true);
  assert.equal(await encrypted.compareAndSet("installation-a", 0, { ...initial, version: 2 }), false);
  assert.equal(await encrypted.compareAndSet("installation-a", 1, { ...initial, version: 2 }), true);
  assert.throws(
    () =>
      encrypted.compareAndSet("installation-a", 2, {
        ...initial,
        status: { ...initial.status, runtime: { credentialCiphertext: "ciphertext" } },
        version: 3,
      }),
    { message: "PHOTON_INSTALLATION_SERVICE_SECRET_INVALID" },
  );
  assert.throws(
    () =>
      encrypted.create({
        ...initial,
        status: { state: "invalid", installationId: "installation-a", safeCode: "unsafe" },
      } as unknown as InstallationRecord),
    { message: "PHOTON_INSTALLATION_SERVICE_SECRET_INVALID" },
  );
  assert.throws(
    () =>
      encrypted.create({
        ...initial,
        status: {
          ...initial.status,
          lines: [{ lineId: "line-installation-a", maskedAddress: "+1•••0999", secret: "unexpected" }],
        },
      } as unknown as InstallationRecord),
    { message: "PHOTON_INSTALLATION_SERVICE_SECRET_INVALID" },
  );
});

test("wrong keys, tampering, and ciphertext or row swaps fail with a secret-free code", async () => {
  const persisted = new StrictCiphertextStore();
  const originalCodec = codec();
  const encrypted = createEncryptedPhotonInstallationStore(persisted, originalCodec);
  assert.equal(await encrypted.create(connectedRecord("installation-a")), true);
  assert.equal(await encrypted.create(connectedRecord("installation-b")), true);

  await assert.rejects(createEncryptedPhotonInstallationStore(persisted, codec("wrong-key")).read("installation-a"), {
    message: "PHOTON_INSTALLATION_SECRET_INVALID",
  });
  await assert.rejects(
    createEncryptedPhotonInstallationStore(persisted, codec("persistent-installation-key", "installation-key-2")).read(
      "installation-a",
    ),
    { message: "PHOTON_INSTALLATION_SECRET_INVALID" },
  );

  const before = persisted.records.get("installation-a")!;
  const other = persisted.records.get("installation-b")!;
  const otherCiphertext = other.ciphertext;
  other.ciphertext = before.ciphertext;
  await assert.rejects(encrypted.read("installation-b"), { message: "PHOTON_INSTALLATION_SECRET_INVALID" });
  other.ciphertext = otherCiphertext;

  const rotated = createEncryptedPhotonInstallationStore(
    persisted,
    codec("replacement-installation-key", "installation-key-2", {
      "installation-key-1": "persistent-installation-key",
    }),
  );
  const beforeRotation = await rotated.read("installation-a");
  assert.equal(beforeRotation?.status.state, "connected");
  assert.equal(await rotated.compareAndSet("installation-a", 1, { ...beforeRotation!, version: 2 }), true);
  assert.equal(persisted.records.get("installation-a")?.wrappingKeyId, "installation-key-2");

  const first = persisted.records.get("installation-a")!;
  const firstCiphertext = first.ciphertext;

  first.version = 3;
  await assert.rejects(rotated.read("installation-a"), { message: "PHOTON_INSTALLATION_SECRET_INVALID" });

  first.version = 2;
  const separator = firstCiphertext.lastIndexOf(":") + 1;
  const replacement = firstCiphertext[separator] === "A" ? "B" : "A";
  first.ciphertext = `${firstCiphertext.slice(0, separator)}${replacement}${firstCiphertext.slice(separator + 1)}`;
  await assert.rejects(rotated.read("installation-a"), { message: "PHOTON_INSTALLATION_SECRET_INVALID" });

  persisted.records.set("installation-a", structuredClone(persisted.records.get("installation-b")!));
  await assert.rejects(encrypted.read("installation-a"), { message: "PHOTON_INSTALLATION_SECRET_INVALID" });
});

test("the adapter requires an explicit wrapping-key identifier", () => {
  const persisted = new StrictCiphertextStore();
  assert.throws(() => createEncryptedPhotonInstallationStore(persisted, codec("persistent-installation-key", "")), {
    message: "PHOTON_INSTALLATION_WRAPPING_KEY_ID_INVALID",
  });
});
