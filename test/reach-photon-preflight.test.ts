import { installGlobalFakeSprites } from "./support/fake-sprites.ts";

const fakeSprites = installGlobalFakeSprites();
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type AppDeps } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import {
  createPhotonDestination,
  isPhotonDestination,
  type PhotonDestinationResolver,
  type PhotonDestinationRequest,
} from "../src/surfaces/photon-destinations.ts";
import type { Destination } from "../src/types.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "reach-photon-preflight-secret".repeat(3);
const currentConversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  conversationId: "any;-;+15555550100",
};
const bobConversation = {
  ...currentConversation,
  conversationId: "any;-;+15555550101",
};
const groupConversation = {
  ...currentConversation,
  conversationId: "any;+;group-1",
};
const foreignConversation = {
  ...currentConversation,
  installationId: "installation-2",
  lineId: "line-2",
  conversationId: "any;-;+15555550999",
};

type ResolverMode = "allow" | "deny" | "contradictory";

describe("Photon reach preflight", () => {
  let built: BuiltApp;
  let server: Server;
  let base: string;
  let resolverMode: ResolverMode = "allow";
  let resolverRequests: PhotonDestinationRequest[] = [];
  let sandboxProvisions = 0;
  let blobTransfers = 0;

  const currentDestination = createPhotonDestination({
    conversation: currentConversation,
    kind: "dm",
    principalIds: ["alice"],
    audienceScopeId: "personal:alice",
    recipientPrincipalId: "alice",
  });

  const resolver: PhotonDestinationResolver = {
    async resolve(request) {
      resolverRequests.push(request);
      if (resolverMode === "deny") return { kind: "none" };
      if (resolverMode === "contradictory") {
        return {
          kind: "one",
          destination: createPhotonDestination({
            conversation: foreignConversation,
            kind: "dm",
            principalIds: ["carol"],
            audienceScopeId: "personal:carol",
            recipientPrincipalId: "carol",
          }),
        };
      }
      if (request.kind === "principal" && request.principalId === "bob") {
        return {
          kind: "one",
          destination: createPhotonDestination({
            conversation: bobConversation,
            kind: "dm",
            principalIds: ["bob"],
            audienceScopeId: "personal:bob",
            recipientPrincipalId: "bob",
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

  const capability = (destination: Destination = currentDestination) =>
    mintCapabilityToken(
      {
        actorId: "alice",
        scopeId: "personal:alice",
        destination,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  const post = async (body: unknown, destination?: Destination) =>
    fetch(`${base}/v1/reach`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await capability(destination) },
      body: JSON.stringify(body),
    });

  const seedFile = async (path: string, data: string) => {
    const handle = await built.sandbox.provision([{ scopeId: "personal:alice", mountPath: "", mode: "rw" }]);
    await built.sandbox.writeFile(handle, path, data);
    await built.sandbox.teardown(handle, { keepWarm: true });
  };

  const resetObservations = () => {
    resolverMode = "allow";
    resolverRequests = [];
    sandboxProvisions = 0;
    blobTransfers = 0;
  };

  const deliveryCounts = async () =>
    Object.fromEntries(
      await Promise.all(
        ["photon", "slack", "group", "principal"].map(async (surface) => [
          surface,
          (await built.deliveries.pending(surface)).length,
        ]),
      ),
    );

  before(async () => {
    void fakeSprites;
    built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "reach-photon-preflight-")), signingSecret: SECRET }),
    );
    await built.app.upsertDirectory([
      { principalId: "alice", displayName: "Alice", type: "internal" },
      { principalId: "bob", displayName: "Bob", type: "internal" },
      { principalId: "carol", displayName: "Carol", type: "internal" },
    ]);
    await built.app.upsertGroups([
      { groupId: "G-slack", principalId: "alice" },
      { groupId: "G-slack", principalId: "bob" },
      { groupId: "G-slack", principalId: "carol" },
    ]);
    const app = createApp({ ...built, photonDestinations: resolver } as unknown as AppDeps);
    const sandbox = new Proxy(built.sandbox, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "provision") {
          return async (...args: Parameters<typeof target.provision>) => {
            sandboxProvisions += 1;
            return target.provision(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const blobTransfer = new Proxy(built.blobTransfer, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "put") {
          return async (...args: Parameters<typeof target.put>) => {
            blobTransfers += 1;
            return target.put(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    server = createServer(app, {
      signingSecret: SECRET,
      sandbox,
      blobTransfer,
      files: built.files,
      environments: built.environments,
      auditLog: built.auditLog,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await seedFile("out/report.txt", "hello from Photon\n");
    resetObservations();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  });

  it("uses the Photon resolver for both attachment preflight and final named-recipient resolution", async () => {
    resetObservations();
    const response = await post({ recipient: "Bob", text: "report", files: ["out/report.txt"] });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { deliveryId: string };
    assert.equal(resolverRequests.length, 2);
    assert.deepEqual(resolverRequests[0], { kind: "principal", principalId: "bob", authorityId: "alice" });
    assert.deepEqual(resolverRequests[1], resolverRequests[0]);
    assert.equal(sandboxProvisions, 1);
    assert.equal(blobTransfers, 1);
    const delivery = (await built.deliveries.pending("photon")).find((candidate) => candidate.id === body.deliveryId);
    assert.ok(delivery);
    assert.equal(isPhotonDestination(delivery.destination), true);
    assert.deepEqual(
      isPhotonDestination(delivery.destination) ? delivery.destination.conversation : null,
      bobConversation,
    );
  });

  it("uses the Photon resolver for both attachment preflight and final named-group resolution", async () => {
    resetObservations();
    const response = await post({ participants: ["Bob", "Carol"], text: "report", files: ["out/report.txt"] });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { deliveryId: string };
    assert.equal(resolverRequests.length, 2);
    assert.deepEqual(resolverRequests[0], {
      kind: "group",
      principalIds: ["alice", "bob", "carol"],
      authorityId: "alice",
    });
    assert.deepEqual(resolverRequests[1], resolverRequests[0]);
    const delivery = (await built.deliveries.pending("photon")).find((candidate) => candidate.id === body.deliveryId);
    assert.ok(delivery);
    assert.equal(sandboxProvisions, 1);
    assert.equal(blobTransfers, 1);
    assert.equal(delivery.attachments?.length, 1);
    assert.ok(delivery.attachments?.[0]?.blobId);
    assert.ok(delivery.attachments?.[0]?.artifactId);
    assert.deepEqual(
      isPhotonDestination(delivery.destination) ? delivery.destination.conversation : null,
      groupConversation,
    );
  });

  it("denies missing and contradictory Photon targets before sandbox or blob work", async () => {
    for (const mode of ["deny", "contradictory"] as const) {
      resetObservations();
      resolverMode = mode;
      const response = await post({ recipient: "Bob", text: "report", files: ["out/report.txt"] });
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { error: string }).error, "photon_destination_not_found");
      assert.equal(sandboxProvisions, 0);
      assert.equal(blobTransfers, 0);
      assert.equal(resolverRequests.length, 1);
    }
  });

  it("denies missing and contradictory Photon groups without Slack group opening or attachment work", async () => {
    for (const mode of ["deny", "contradictory"] as const) {
      resetObservations();
      resolverMode = mode;
      const before = await deliveryCounts();
      const response = await post({
        participants: ["Bob", "Carol"],
        text: "report",
        files: ["out/report.txt"],
      });
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { error: string }).error, "photon_destination_not_found");
      assert.equal(sandboxProvisions, 0);
      assert.equal(blobTransfers, 0);
      assert.equal(resolverRequests.length, 1);
      assert.deepEqual(await deliveryCounts(), before);
    }
  });

  it("denies malformed and cross-conversation capability destinations before sandbox or blob work", async () => {
    const malformed = { type: "photon", target: currentConversation.conversationId } as Destination;
    const crossConversation = {
      ...currentDestination,
      providerMessage: { ...foreignConversation, messageId: "foreign-message" },
    } as Destination;
    for (const destination of [malformed, crossConversation]) {
      resetObservations();
      const response = await post({ recipient: "Bob", text: "report", files: ["out/report.txt"] }, destination);
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { error: string }).error, "forbidden");
      assert.equal(sandboxProvisions, 0);
      assert.equal(blobTransfers, 0);
      assert.equal(resolverRequests.length, 0);
    }
  });

  it("allows only the scoped current-chat Photon reaction path", async () => {
    resetObservations();
    const response = await post({ react: { ts: "message-1", emoji: "heart" } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { deliveryId: string };
    assert.equal(resolverRequests.length, 0);
    const delivery = (await built.deliveries.pending("photon")).find((candidate) => candidate.id === body.deliveryId);
    assert.ok(delivery);
    assert.deepEqual(isPhotonDestination(delivery.destination) ? delivery.destination.providerMessage : null, {
      ...currentConversation,
      messageId: "message-1",
    });

    const slack = await post(
      { react: { ts: "1723497600.123456", emoji: "eyes" } },
      { type: "slack", target: "C-general", audienceScopeId: "channel:C-general" },
    );
    assert.equal(slack.status, 400);
  });

  it("denies an invalid current Photon destination on the targetless reaction path", async () => {
    const malformed = { type: "photon", target: currentConversation.conversationId } as Destination;
    const crossConversation = {
      ...currentDestination,
      providerMessage: { ...foreignConversation, messageId: "foreign-message" },
    } as Destination;
    for (const destination of [malformed, crossConversation]) {
      resetObservations();
      const before = await deliveryCounts();
      const response = await post({ react: { ts: "message-1", emoji: "heart" } }, destination);
      assert.equal(response.status, 403);
      assert.equal(sandboxProvisions, 0);
      assert.equal(blobTransfers, 0);
      assert.equal(resolverRequests.length, 0);
      assert.deepEqual(await deliveryCounts(), before);
    }
  });

  it("preserves Slack group attachment resolution and staging", async () => {
    resetObservations();
    const response = await post(
      { participants: ["Bob", "Carol"], text: "report", files: ["out/report.txt"] },
      { type: "slack", target: "D-alice", audienceScopeId: "personal:alice" },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { deliveryId: string };
    assert.equal(resolverRequests.length, 0);
    assert.equal(sandboxProvisions, 1);
    assert.equal(blobTransfers, 1);
    const delivery = (await built.deliveries.pending("group")).find((candidate) => candidate.id === body.deliveryId);
    assert.ok(delivery);
    assert.equal(delivery.destination.type, "group");
    assert.equal(delivery.destination.target, "G-slack");
    assert.equal(delivery.attachments?.length, 1);
  });

  it("rejects Photon use of Slack threadTs before attachment staging", async () => {
    resetObservations();
    const response = await post({
      recipient: "Bob",
      text: "report",
      threadTs: "1723497600.123456",
      files: ["out/report.txt"],
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { message: string }).message, /Slack reference/);
    assert.equal(sandboxProvisions, 0);
    assert.equal(blobTransfers, 0);
    assert.equal(resolverRequests.length, 0);
  });
});
