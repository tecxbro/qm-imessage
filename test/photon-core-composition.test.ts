import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ConversationReference,
  NormalizedPhotonInput,
  ProviderActorReference,
  QmChannelOperationRequest,
} from "../plugins/chassis/src/photon-contract.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../plugins/chassis/src/secret-box.ts";
import type {
  PhotonInstallationCiphertextRecord,
  PhotonInstallationCiphertextStore,
} from "../plugins/photon/src/ports.ts";
import { createEncryptedPhotonInstallationStore } from "../plugins/photon/src/setup/installation-store.ts";
import { photonRedeliveryKey } from "../src/api/photon-authorization.ts";
import { personalScope } from "../src/types.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const actorId = "photon-composition-human";
const providerActor: ProviderActorReference & { kind: "human" } = {
  actorId: "provider-composition-human",
  kind: "human",
  providerAddress: "+15555550155",
};
const conversation: ConversationReference = {
  provider: "spectrum-imessage",
  installationId: "installation-composition",
  projectId: "project-composition",
  lineId: "line-composition",
  conversationId: "conversation-composition",
};

class CiphertextStore implements PhotonInstallationCiphertextStore {
  record: PhotonInstallationCiphertextRecord | undefined;

  async read(installationId: string): Promise<PhotonInstallationCiphertextRecord | undefined> {
    return this.record?.installationId === installationId ? structuredClone(this.record) : undefined;
  }

  async create(record: PhotonInstallationCiphertextRecord): Promise<boolean> {
    if (this.record || record.version !== 1) return false;
    this.record = structuredClone(record);
    return true;
  }

  async compareAndSet(
    installationId: string,
    expectedVersion: number,
    next: PhotonInstallationCiphertextRecord,
  ): Promise<boolean> {
    if (
      this.record?.installationId !== installationId ||
      this.record.version !== expectedVersion ||
      next.installationId !== installationId ||
      next.version !== expectedVersion + 1
    )
      return false;
    this.record = structuredClone(next);
    return true;
  }
}

function source(): {
  event: NormalizedPhotonInput["event"];
  actor: typeof providerActor;
  conversation: ConversationReference;
  input: Extract<NormalizedPhotonInput, { kind: "message" }>;
} {
  const input: Extract<NormalizedPhotonInput, { kind: "message" }> = {
    event: {
      provider: conversation.provider,
      installationId: conversation.installationId,
      lineId: conversation.lineId,
      eventId: "event-composition",
      occurredAt: "2026-09-14T08:00:00.000Z",
      direction: "inbound",
    },
    kind: "message",
    conversation,
    actor: providerActor,
    message: {
      conversation,
      messageId: "message-composition",
      parts: [{ messageId: "message-composition", partIndex: 0 }],
    },
    content: [{ kind: "text", part: { messageId: "message-composition", partIndex: 0 }, text: "hello" }],
  };
  return { event: input.event, actor: providerActor, conversation, input };
}

test("buildApp composes one existing QM app with encrypted Photon authority", async () => {
  const persistedInstallations = new CiphertextStore();
  const key = deriveConnectorKey("persistent-composition-key", "photon-installation");
  const installationCodec = {
    wrappingKeyId: "installation-key-1",
    encrypt: (plaintext: string) => encryptSecret(plaintext, key),
    decrypt: (ciphertext: string, wrappingKeyId: string) => {
      if (wrappingKeyId !== "installation-key-1") throw new Error("unknown wrapping key");
      return decryptSecret(ciphertext, key);
    },
  };
  let sessionId = "";
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "photon-composition-")) });
  const built = buildApp(config, {
    photon: {
      persistedInstallations,
      installationCodec,
      identities: {
        async resolveActor(_event, actor) {
          return actor.actorId === providerActor.actorId
            ? { ...providerActor, canonicalIdentityId: actorId }
            : undefined;
        },
      },
      conversations: {
        async find(input) {
          return input.conversationId === conversation.conversationId
            ? { conversation, qmSessionId: sessionId, resourceRevision: "revision-composition" }
            : undefined;
        },
      },
      messages: {
        async findByProviderPart() {
          return undefined;
        },
      },
      actions: {
        async read() {
          return undefined;
        },
        async consume() {
          return undefined;
        },
      },
      now: () => Date.parse("2026-09-14T08:00:00.000Z"),
    },
  });
  const session = await built.sessions.getOrCreateByThread(
    "photon:composition",
    "dm",
    personalScope(actorId),
    undefined,
    "photon",
  );
  sessionId = session.id;
  await built.sessions.addParticipant(session.id, actorId);
  const installations = createEncryptedPhotonInstallationStore(persistedInstallations, installationCodec);
  assert.equal(
    await installations.create({
      installation: { installationId: conversation.installationId, projectId: conversation.projectId! },
      status: {
        state: "connected",
        installationId: conversation.installationId,
        projectId: conversation.projectId!,
        lines: [{ lineId: conversation.lineId }],
        management: { accessToken: "private-management-token" },
        runtime: { projectSecret: "private-project-secret" },
      },
      ownerRevision: "owner-composition",
      version: 1,
    }),
    true,
  );
  assert.deepEqual(Object.keys(persistedInstallations.record!).sort(), [
    "ciphertext",
    "installationId",
    "ownerRevision",
    "version",
    "wrappingKeyId",
  ]);
  assert.equal(JSON.stringify(persistedInstallations.record).includes("private-project-secret"), false);

  const current = source();
  const operation: Extract<QmChannelOperationRequest, { name: "turn.start" }> = {
    operationId: "operation-composition",
    name: "turn.start",
    actorId,
    idempotencyKey: "logical-composition",
    input: { source: "photon", request: current.input, redeliveryKey: photonRedeliveryKey(current.event) },
  };
  const checked = await built.photonCore!.check(current, operation);
  assert.equal(checked.authorization.decision, "allowed");
  assert.equal(serverDeps(config, built).photonCore, built.photonCore);
});

test("buildApp omits the Photon core dependency when composition prerequisites are absent", () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "photon-unavailable-")) });
  const built = buildApp(config);
  assert.equal(built.photonCore, undefined);
  assert.equal(serverDeps(config, built).photonCore, undefined);
});
