import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeliveryStore, supportsRecipientThread } from "../src/delivery/delivery-store.ts";
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

const malformedPhoton = {
  type: "photon",
  target: conversation.conversationId,
  conversationKind: "dm",
  recipientPrincipalId: "alice",
} as Destination;

describe("Photon delivery recipient-thread backlinks", () => {
  it("accepts principals and validated Photon DMs while rejecting groups and malformed destinations", () => {
    assert.equal(supportsRecipientThread({ type: "principal", target: "alice" }), true);
    assert.equal(supportsRecipientThread(photonDm("predicate")), true);
    assert.equal(supportsRecipientThread(photonGroup()), false);
    assert.equal(supportsRecipientThread(malformedPhoton), false);
    assert.equal(supportsRecipientThread(null as unknown as Destination), false);
  });

  it("keeps principal and Photon DM recording, duplicate handling, filtering, and ordering in parity", async () => {
    const store = createDeliveryStore();
    const principal = await store.enqueue({
      destination: { type: "principal", target: "alice" },
      text: "principal",
      idempotencyKey: "r08-memory-principal",
    });
    const firstDm = await store.enqueue({
      destination: photonDm("first"),
      text: "first Photon DM",
      idempotencyKey: "r08-memory-dm-first",
    });
    const secondDm = await store.enqueue({
      destination: photonDm("second"),
      text: "second Photon DM",
      idempotencyKey: "r08-memory-dm-second",
    });
    const group = await store.enqueue({
      destination: photonGroup(),
      text: "Photon group",
      idempotencyKey: "r08-memory-group",
    });
    const malformed = await store.enqueue({
      destination: malformedPhoton,
      text: "malformed Photon candidate",
      idempotencyKey: "r08-memory-malformed",
    });

    principal.createdAt = 100;
    firstDm.createdAt = 200;
    secondDm.createdAt = 300;
    group.createdAt = 400;
    malformed.createdAt = 500;

    await store.recordRecipientThread(principal.id, "agent:main:dm:alice", 1_000);
    await store.recordRecipientThread(firstDm.id, "agent:main:dm:alice", 2_000);
    await store.recordRecipientThread(firstDm.id, "agent:main:dm:alice", 3_000);
    await store.recordRecipientThread(secondDm.id, "agent:main:dm:alice", 4_000);
    await store.recordRecipientThread(group.id, "agent:main:dm:alice", 5_000);
    await store.recordRecipientThread(malformed.id, "agent:main:dm:alice", 6_000);
    malformed.recipientThreadRef = "agent:main:dm:alice";

    assert.equal(firstDm.deliveredAt, 2_000);
    assert.equal(group.deliveredAt, null);
    assert.equal(group.recipientThreadRef, undefined);
    assert.equal(malformed.deliveredAt, null);
    assert.deepEqual(
      (await store.listByRecipientThread("agent:main:dm:alice", { limit: 2 })).map((delivery) => delivery.id),
      [firstDm.id, secondDm.id],
    );
  });

  it("rejects a Photon destination that is no longer a validated DM when recording begins", async () => {
    const store = createDeliveryStore();
    const delivery = await store.enqueue({
      destination: photonDm("mutated"),
      text: "mutated destination",
      idempotencyKey: "r08-memory-mutated",
    });
    delivery.destination = photonGroup();

    await store.recordRecipientThread(delivery.id, "agent:main:dm:alice", 1_000);

    assert.equal(delivery.deliveredAt, null);
    assert.equal(delivery.recipientThreadRef, undefined);
  });
});
