import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeliveryStore, type PhotonDmBacklink } from "../src/delivery/delivery-store.ts";
import { createPhotonDestination, type PhotonDestination } from "../src/surfaces/photon-destinations.ts";
import type { Destination } from "../src/types.ts";

const conversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  maskedAddress: "+1******0100",
  conversationId: "any;-;+15555550101",
};

function photonDm(suffix: string): PhotonDestination {
  return createPhotonDestination({
    conversation: { ...conversation, conversationId: `${conversation.conversationId}-${suffix}` },
    kind: "dm",
    principalIds: ["alice"],
    audienceScopeId: "personal:alice",
    recipientPrincipalId: "alice",
  });
}

function photonGroup(): PhotonDestination {
  return createPhotonDestination({
    conversation: { ...conversation, conversationId: "any;+;group-1" },
    kind: "group",
    principalIds: ["alice", "bob"],
    audienceScopeId: "group:group-1",
    groupId: "group-1",
  });
}

function backlink(destination: PhotonDestination): PhotonDmBacklink {
  return {
    recipientPrincipalId: destination.recipientPrincipalId!,
    conversation: structuredClone(destination.conversation),
  };
}

const malformedPhoton = {
  type: "photon",
  target: conversation.conversationId,
  conversationKind: "dm",
  recipientPrincipalId: "alice",
} as Destination;

describe("Photon delivery backlinks", () => {
  it("records one canonical Photon DM backlink without changing delivery or Slack state", async () => {
    const store = createDeliveryStore();
    const destination = photonDm("canonical");
    const delivery = await store.enqueue({
      destination,
      text: "Photon DM",
      idempotencyKey: "r08-memory-canonical",
    });

    assert.equal(await store.recordPhotonDmBacklink(delivery.id, backlink(destination)), "recorded");
    assert.equal(await store.recordPhotonDmBacklink(delivery.id, backlink(destination)), "duplicate");
    assert.deepEqual(await store.photonDmBacklink(delivery.id), backlink(destination));
    assert.equal(delivery.deliveredAt, null);
    assert.equal(delivery.recipientThreadRef, undefined);

    const returned = await store.photonDmBacklink(delivery.id);
    returned!.conversation.conversationId = "mutated";
    assert.deepEqual(await store.photonDmBacklink(delivery.id), backlink(destination));

    await store.recordRecipientThread(delivery.id, "agent:main:dm:alice", 1_000);
    assert.equal(delivery.deliveredAt, null);
    assert.equal(delivery.recipientThreadRef, undefined);
    assert.deepEqual(await store.listByRecipientThread("agent:main:dm:alice"), []);
  });

  it("rejects wrong recipients, noncanonical records, groups, malformed destinations, and absent deliveries", async () => {
    const store = createDeliveryStore();
    const destination = photonDm("reject");
    const delivery = await store.enqueue({
      destination,
      text: "Photon DM",
      idempotencyKey: "r08-memory-reject",
    });
    const group = await store.enqueue({
      destination: photonGroup(),
      text: "Photon group",
      idempotencyKey: "r08-memory-group",
    });
    const malformed = await store.enqueue({
      destination: malformedPhoton,
      text: "malformed Photon",
      idempotencyKey: "r08-memory-malformed",
    });

    assert.equal(
      await store.recordPhotonDmBacklink(delivery.id, {
        ...backlink(destination),
        recipientPrincipalId: "bob",
      }),
      "conflict",
    );
    assert.equal(
      await store.recordPhotonDmBacklink(delivery.id, {
        ...backlink(destination),
        conversation: { ...destination.conversation, conversationId: "another-conversation" },
      }),
      "conflict",
    );
    assert.equal(
      await store.recordPhotonDmBacklink(delivery.id, { ...backlink(destination), extra: true } as PhotonDmBacklink),
      "conflict",
    );
    assert.equal(await store.recordPhotonDmBacklink(group.id, backlink(destination)), "conflict");
    assert.equal(await store.recordPhotonDmBacklink(malformed.id, backlink(destination)), "conflict");
    assert.equal(await store.recordPhotonDmBacklink("absent", backlink(destination)), "conflict");
    assert.equal(await store.photonDmBacklink(delivery.id), undefined);
  });

  it("fails closed when a delivery no longer has the canonical Photon DM destination", async () => {
    const store = createDeliveryStore();
    const destination = photonDm("mutated");
    const delivery = await store.enqueue({
      destination,
      text: "destination mutation",
      idempotencyKey: "r08-memory-mutated",
    });
    assert.equal(await store.recordPhotonDmBacklink(delivery.id, backlink(destination)), "recorded");

    delivery.destination = photonGroup();

    assert.equal(await store.photonDmBacklink(delivery.id), undefined);
    assert.equal(await store.recordPhotonDmBacklink(delivery.id, backlink(destination)), "conflict");
  });

  it("preserves principal recipient-thread behavior", async () => {
    const store = createDeliveryStore();
    const principal = await store.enqueue({
      destination: { type: "principal", target: "alice" },
      text: "Slack DM",
      idempotencyKey: "r08-memory-principal",
    });

    await store.recordRecipientThread(principal.id, "dm:D-alice", 2_000);

    assert.equal(principal.deliveredAt, 2_000);
    assert.equal(principal.recipientThreadRef, "dm:D-alice");
    assert.deepEqual(
      (await store.listByRecipientThread("dm:D-alice")).map((row) => row.id),
      [principal.id],
    );
    assert.equal(await store.recordPhotonDmBacklink(principal.id, backlink(photonDm("principal"))), "conflict");
  });
});
