import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppHelpers } from "../src/api/app-helpers.ts";
import type { App, AppDeps } from "../src/api/app-types.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { resolveReachTarget, withDelete, withEdit, withReact, type ReachDirectory } from "../src/reach/reach.ts";
import {
  createPhotonDestination,
  isPhotonDestination,
  parsePhotonConversationReference,
  type PhotonDestinationResolver,
} from "../src/surfaces/photon-destinations.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const aliceConversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  maskedAddress: "+1******0100",
  conversationId: "any;-;+15555550101",
};

const groupConversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  maskedAddress: "+1******0100",
  conversationId: "any;+;group-1",
};

function resolver(): PhotonDestinationResolver {
  return {
    async resolve(request) {
      if (request.kind === "principal" && request.principalId === "alice") {
        return {
          kind: "one",
          destination: createPhotonDestination({
            conversation: aliceConversation,
            kind: "dm",
            principalIds: ["alice"],
            audienceScopeId: "personal:alice",
            recipientPrincipalId: "alice",
          }),
        };
      }
      if (request.kind === "group" && request.principalIds.join(",") === "alice,bob,carol") {
        return {
          kind: "one",
          destination: createPhotonDestination({
            conversation: groupConversation,
            kind: "group",
            principalIds: request.principalIds,
            audienceScopeId: "group:photon-group-1",
            groupId: "photon-group-1",
          }),
        };
      }
      return { kind: "none" };
    },
  };
}

function reachDirectory(photonDestinations?: PhotonDestinationResolver): ReachDirectory {
  const members = ["alice", "bob", "carol"].map((principalId) => ({
    principalId,
    displayName: principalId[0]!.toUpperCase() + principalId.slice(1),
    type: "internal" as const,
  }));
  return {
    async resolveRecipient(query) {
      const member = members.find(
        (candidate) =>
          candidate.principalId === query.toLowerCase() || candidate.displayName.toLowerCase() === query.toLowerCase(),
      );
      return member ? { kind: "one", member } : { kind: "none" };
    },
    async resolveChannel(query) {
      return query === "eng" ? { kind: "one", channel: { channelId: "C-eng", name: "eng" } } : { kind: "none" };
    },
    async channelMember() {
      return true;
    },
    async resolveGroup() {
      return { kind: "none" };
    },
    async groupMember() {
      return false;
    },
    async directoryMember(principalId) {
      return members.find((candidate) => candidate.principalId === principalId) ?? null;
    },
    ...(photonDestinations ? { resolvePhotonDestination: (request) => photonDestinations.resolve(request) } : {}),
  };
}

describe("Photon reach destinations", () => {
  it("accepts only exact plain structured conversation references", () => {
    assert.deepEqual(parsePhotonConversationReference(aliceConversation), aliceConversation);
    assert.equal(parsePhotonConversationReference({ ...aliceConversation, unknown: true }), undefined);
    assert.equal(parsePhotonConversationReference(Object.assign(new Date(), aliceConversation)), undefined);
  });

  it("keeps ordinary Slack resolution as the default for a mixed-surface person", async () => {
    const dir = reachDirectory(resolver());
    const ordinary = await resolveReachTarget(dir, { recipient: "Alice" }, "carol");
    assert.equal(ordinary.ok, true);
    assert.deepEqual(ordinary.ok ? ordinary.destination : null, {
      type: "principal",
      target: "alice",
      audienceScopeId: "personal:alice",
      onBehalfOf: "carol",
    });

    const photon = await resolveReachTarget(dir, { surface: "photon", recipient: "Alice" }, "carol");
    assert.equal(photon.ok, true);
    assert.equal(photon.ok && photon.destination.type, "photon");
    assert.equal(photon.ok && isPhotonDestination(photon.destination), true);
    assert.deepEqual(
      photon.ok && isPhotonDestination(photon.destination) ? photon.destination.conversation : null,
      aliceConversation,
    );
  });

  it("does not let a Photon resolver claim an ordinary Slack channel or generic group delivery", async () => {
    const dir = reachDirectory(resolver());
    const channel = await resolveReachTarget(dir, { channel: "eng" }, "carol");
    assert.equal(channel.ok, true);
    assert.equal(channel.ok && channel.destination.type, "slack");

    const unsupported = await resolveReachTarget(dir, { surface: "photon", channel: "eng" }, "carol");
    assert.equal(unsupported.ok, false);
    assert.equal(!unsupported.ok && unsupported.error, "surface_not_supported");
  });

  it("keeps an ambiguous Photon resolver result fail-closed", async () => {
    const oneCandidate = resolver();
    const ambiguous: PhotonDestinationResolver = {
      async resolve(request) {
        const resolved = await oneCandidate.resolve(request);
        return resolved.kind === "one" ? { kind: "ambiguous", candidates: [resolved.destination] } : resolved;
      },
    };
    const resolved = await resolveReachTarget(
      reachDirectory(ambiguous),
      { surface: "photon", recipient: "Alice" },
      "carol",
    );
    assert.equal(resolved.ok, false);
    assert.equal(!resolved.ok && resolved.error, "ambiguous_photon_destination");
  });

  it("registers only the resolved Photon group and preserves unrelated directory records", async () => {
    const directory = createDirectoryStore();
    await directory.replace([
      { principalId: "alice", displayName: "Alice", type: "internal" },
      { principalId: "bob", displayName: "Bob", type: "internal" },
      { principalId: "carol", displayName: "Carol", type: "internal" },
      { principalId: "dana", displayName: "Dana", type: "internal" },
    ]);
    await directory.replaceGroups(
      [
        { groupId: "G-slack", principalId: "carol" },
        { groupId: "G-slack", principalId: "dana" },
      ],
      1,
      ["G-slack"],
      ["G-slack"],
    );
    const dir: ReachDirectory = {
      resolveRecipient: (query) => directory.resolve(query),
      resolveChannel: (query) => directory.resolveChannel(query),
      channelMember: (channelId, principalId) => directory.channelMember(channelId, principalId),
      resolveGroup: (participants) => directory.resolveGroupByParticipants(participants),
      groupMember: (groupId, principalId) => directory.groupMember(groupId, principalId),
      directoryMember: (principalId) => directory.get(principalId),
      registerGroup: (groupId, participants) => directory.upsertGroup(groupId, participants),
      resolvePhotonDestination: (request) => resolver().resolve(request),
    };

    const resolved = await resolveReachTarget(dir, { surface: "photon", participants: ["alice", "bob"] }, "carol");
    assert.equal(resolved.ok, true);
    assert.deepEqual(
      (await directory.list()).map((member) => member.principalId),
      ["alice", "bob", "carol", "dana"],
    );
    assert.deepEqual((await directory.listGroupsFor("dana")).sort(), ["G-slack"]);
    assert.deepEqual((await directory.listGroupsFor("alice")).sort(), ["photon-group-1"]);
  });

  it("connects the app helper boundary to the injected scoped resolver", async () => {
    const directory = createDirectoryStore();
    await directory.replace([
      { principalId: "alice", displayName: "Alice", type: "internal" },
      { principalId: "carol", displayName: "Carol", type: "internal" },
    ]);
    const deps = { directory, photonDestinations: resolver() } as unknown as AppDeps;
    const helpers = createAppHelpers(deps, {} as App);
    const resolved = await helpers.resolveReachTargetFor({ surface: "photon", recipient: "alice" }, "carol");
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ok && resolved.destination.type, "photon");
  });

  it("scopes existing reaction, deletion, and edit operations to the Photon conversation", () => {
    const destination = createPhotonDestination({
      conversation: aliceConversation,
      kind: "dm",
      principalIds: ["alice"],
      audienceScopeId: "personal:alice",
      recipientPrincipalId: "alice",
    });
    const reacted = withReact(destination, { messageTs: "message-1", emoji: "heart" });
    const deleted = withDelete(destination, { messageTs: "message-2" });
    const edited = withEdit(destination, "message-3");
    assert.deepEqual(isPhotonDestination(reacted) && reacted.providerMessage, {
      ...aliceConversation,
      messageId: "message-1",
    });
    assert.deepEqual(isPhotonDestination(deleted) && deleted.providerMessage, {
      ...aliceConversation,
      messageId: "message-2",
    });
    assert.deepEqual(isPhotonDestination(edited) && edited.providerMessage, {
      ...aliceConversation,
      messageId: "message-3",
    });
  });

  it("creates Photon principal delivery sessions without changing the ordinary destination contract", async () => {
    const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "photon-delivery-")) }));
    try {
      const destination = createPhotonDestination({
        conversation: aliceConversation,
        kind: "dm",
        principalIds: ["alice"],
        audienceScopeId: "personal:alice",
        recipientPrincipalId: "alice",
      });
      await built.app.enqueueDelivery({ destination, text: "hello", idempotencyKey: "photon-delivery-1" });
      const delivery = (await built.deliveries.pending("photon"))[0]!;
      await built.app.recordPrincipalDelivery(delivery.id, "photon-thread-1");
      const session = await built.sessions.getByThread("photon-thread-1");
      assert.equal(session?.scopeId, "personal:alice");
      assert.equal(session?.surface, "photon");

      const action = await built.app.reachNow({
        senderId: "alice",
        senderScope: "personal:alice",
        react: { messageTs: "message-4", emoji: "heart" },
        currentDestination: destination,
      });
      assert.equal(action.ok, true);
      assert.deepEqual(
        action.ok && isPhotonDestination(action.delivery.destination)
          ? action.delivery.destination.providerMessage
          : null,
        { ...aliceConversation, messageId: "message-4" },
      );
    } finally {
      await built.runtime.stop();
    }
  });
});
