import assert from "node:assert/strict";
import test from "node:test";

import {
  createPhotonLineOwnerStore,
  type PhotonLineOwnerClaim,
  type PhotonLineOwnerKey,
  type PhotonLineOwnerStore,
} from "../../chassis/src/photon-state/line-owner.ts";
import type { PhotonPresentationOperation } from "../../chassis/src/photon-contract.ts";
import type { PhotonStateDatabase } from "../../chassis/src/photon-state/db.ts";
import type { ProviderLine } from "../src/provider/capabilities.ts";
import { createAdvancedProviderClient, operationReference } from "../src/provider/clients.ts";
import { createConnectionManager, type ProviderConstructors } from "../src/provider/connection.ts";
import { createProviderLineOwnership } from "../src/provider/line-owner.ts";

class FakeLineOwnerStore implements PhotonLineOwnerStore {
  current = new Map<string, PhotonLineOwnerClaim>();
  fence = 0;
  claims = 0;
  renewals = 0;
  releases = 0;
  allowRenewal = true;

  async claim(
    key: PhotonLineOwnerKey,
    ownerId: string,
    _now: string,
    leaseExpiresAt: string,
  ): Promise<PhotonLineOwnerClaim | undefined> {
    this.claims += 1;
    const id = JSON.stringify([key.installationId, key.lineId]);
    if (this.current.has(id)) return undefined;
    const claim = { key, ownerId, fence: ++this.fence, leaseExpiresAt };
    this.current.set(id, claim);
    return claim;
  }

  async renew(
    claim: PhotonLineOwnerClaim,
    _now: string,
    leaseExpiresAt: string,
  ): Promise<PhotonLineOwnerClaim | undefined> {
    this.renewals += 1;
    const id = JSON.stringify([claim.key.installationId, claim.key.lineId]);
    const current = this.current.get(id);
    if (
      !this.allowRenewal ||
      current?.ownerId !== claim.ownerId ||
      current.fence !== claim.fence ||
      current.key.installationId !== claim.key.installationId ||
      current.key.lineId !== claim.key.lineId
    )
      return undefined;
    const renewed = { ...current, leaseExpiresAt };
    this.current.set(id, renewed);
    return renewed;
  }

  async release(claim: PhotonLineOwnerClaim): Promise<boolean> {
    this.releases += 1;
    const id = JSON.stringify([claim.key.installationId, claim.key.lineId]);
    const current = this.current.get(id);
    if (current?.ownerId !== claim.ownerId || current.fence !== claim.fence) return false;
    this.current.delete(id);
    return true;
  }
}

function manualTime() {
  let wall = Date.parse("2026-09-14T00:00:00.000Z");
  let monotonic = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  return {
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    setTimer(handler: () => void) {
      const id = ++nextTimer;
      timers.set(id, handler);
      return id;
    },
    clearTimer(timer: unknown) {
      timers.delete(Number(timer));
    },
    advance(milliseconds: number) {
      wall += milliseconds;
      monotonic += milliseconds;
    },
    async fire() {
      const first = timers.entries().next().value as [number, () => void] | undefined;
      assert.ok(first);
      timers.delete(first[0]);
      first[1]();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function line(provider: ProviderLine["reference"]["provider"] = "advanced-imessage"): ProviderLine {
  return {
    reference: { provider, installationId: "installation", lineId: "line", projectId: "project" },
    phone: "+15550000001",
    kind: "dedicated",
  };
}

function multipartOperation(): Extract<PhotonPresentationOperation, { name: "message.multipart" }> {
  return {
    operationId: "operation",
    attemptId: "attempt",
    name: "message.multipart",
    conversation: { ...line().reference, conversationId: "conversation" },
    idempotencyKey: "logical-key",
    input: {
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    },
  };
}

function ownership(store: FakeLineOwnerStore, time = manualTime(), ownerId = "owner") {
  return {
    time,
    value: createProviderLineOwnership(store, {
      leaseTtlMs: 300,
      renewAfterMs: 100,
      ownerId: () => ownerId,
      wallNow: time.wallNow,
      monotonicNow: time.monotonicNow,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    }),
  };
}

function constructors(state: { closed: number; constructed: number }): ProviderConstructors {
  return {
    advanced: () => {
      state.constructed += 1;
      return { close: async () => void (state.closed += 1) } as ReturnType<ProviderConstructors["advanced"]>;
    },
    spectrum: async () => {
      state.constructed += 1;
      return {
        messages: { async *[Symbol.asyncIterator]() {} },
        stop: async () => void (state.closed += 1),
      };
    },
  };
}

test("renewal loss fails closed and invokes loss cleanup", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  let losses = 0;
  const lease = await configured.value.acquire(
    { installationId: "installation", lineId: "line" },
    () => void (losses += 1),
  );
  assert.ok(lease);
  store.allowRenewal = false;
  await configured.time.fire();
  assert.throws(() => lease.assertActive(), /OWNERSHIP_LOST/u);
  assert.equal(losses, 1);
});

test("the durable store rejects empty scope, owner, and unbounded lease windows before querying", async () => {
  let queries = 0;
  const database = {
    async query() {
      queries += 1;
      return { rows: [], rowCount: 0 };
    },
    async transaction() {
      throw new Error("unexpected-transaction");
    },
  } as PhotonStateDatabase;
  const store = createPhotonLineOwnerStore(database);
  await assert.rejects(
    store.claim(
      { installationId: "", lineId: "line" },
      "owner",
      "2026-09-14T00:00:00.000Z",
      "2026-09-14T00:00:01.000Z",
    ),
    /installationId/u,
  );
  await assert.rejects(
    store.claim(
      { installationId: "installation", lineId: "line" },
      "",
      "2026-09-14T00:00:00.000Z",
      "2026-09-14T00:00:01.000Z",
    ),
    /ownerId/u,
  );
  await assert.rejects(
    store.claim(
      { installationId: "installation", lineId: "line" },
      "owner",
      "2026-09-14T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
    ),
    /lease duration/u,
  );
  assert.equal(queries, 0);
});

test("a conservative monotonic deadline can reject a database claim before construction", async () => {
  const store = new FakeLineOwnerStore();
  const time = manualTime();
  const originalClaim = store.claim.bind(store);
  store.claim = async (...args) => {
    time.advance(300);
    return originalClaim(...args);
  };
  const configured = ownership(store, time);
  await assert.rejects(
    configured.value.acquire({ installationId: "installation", lineId: "line" }, () => undefined),
    /OWNERSHIP_LOST/u,
  );
  assert.equal(store.releases, 1);
});

test("slow Spectrum construction renews the durable owner before publishing", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let stopped = 0;
  const manager = createConnectionManager(
    {
      advanced: () => {
        throw new Error("unexpected-advanced");
      },
      spectrum: async () => {
        entered.resolve();
        await finish.promise;
        return {
          messages: { async *[Symbol.asyncIterator]() {} },
          stop: async () => void (stopped += 1),
        };
      },
    },
    configured.value,
  );
  const pending = manager.replace(line("spectrum-imessage"), { address: "address", token: "token" });
  await entered.promise;
  configured.time.advance(100);
  await configured.time.fire();
  assert.equal(store.renewals, 1);
  finish.resolve();
  const connection = await pending;
  connection.assertActive();
  await manager.stop();
  assert.equal(stopped, 1);
  assert.equal(store.releases, 1);
});

test("same-line Spectrum and Advanced managers compete while different lines remain independent", async () => {
  const firstStore = new FakeLineOwnerStore();
  const firstOwner = ownership(firstStore, manualTime(), "owner-a");
  const state = { closed: 0, constructed: 0 };
  const first = createConnectionManager(constructors(state), firstOwner.value);
  const sameLine = createConnectionManager(constructors(state), ownership(firstStore, manualTime(), "owner-b").value);
  const different = createConnectionManager(constructors(state), ownership(firstStore, manualTime(), "owner-c").value);
  try {
    await first.replace(line("advanced-imessage"), { address: "address", token: "token" });
    await assert.rejects(
      sameLine.replace(line("spectrum-imessage"), { address: "address", token: "token" }),
      /LINE_ALREADY_OWNED/u,
    );
    await different.replace(
      {
        ...line("spectrum-imessage"),
        reference: { ...line().reference, provider: "spectrum-imessage", lineId: "other" },
      },
      { address: "address", token: "token" },
    );
    assert.equal(state.constructed, 2);
  } finally {
    await sameLine.stop();
    await first.stop();
    await different.stop();
  }
});

test("lease expiry stops the SDK and rejects later dispatch checks", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  let closed = 0;
  let sends = 0;
  const manager = createConnectionManager(
    {
      advanced: () =>
        ({
          close: async () => void (closed += 1),
          messages: { sendMultipart: async () => void (sends += 1) },
        }) as unknown as ReturnType<ProviderConstructors["advanced"]>,
      spectrum: async () => {
        throw new Error("unexpected-spectrum");
      },
    },
    configured.value,
  );
  const connection = await manager.replace(line(), { address: "address", token: "token" });
  if (connection.kind !== "advanced") throw new Error("wrong-provider");
  const client = createAdvancedProviderClient(connection, async () => new Uint8Array());
  configured.time.advance(300);
  const operation = multipartOperation();
  const result = await client.sendMultipart({
    operation,
    logicalPartIndexes: [0, 1],
    confirmedParts: [],
  });
  assert.deepEqual(result, {
    kind: "failed",
    operation: operationReference(operation),
    code: "INVALID_OPERATION_OR_STOPPED_CONNECTION",
    retryable: false,
    confirmedParts: [],
  });
  assert.equal(sends, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(store.releases, 1);
});

test("renewal failure invalidates an established connection and stops its consumer and SDK", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  const state = { closed: 0, constructed: 0 };
  const manager = createConnectionManager(constructors(state), configured.value);
  const connection = await manager.replace(line(), { address: "address", token: "token" });
  let consumers = 0;
  connection.addConsumer(async () => void (consumers += 1));
  store.allowRenewal = false;
  configured.time.advance(100);
  await configured.time.fire();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => connection.assertActive(), /STOPPED|OWNERSHIP_LOST/u);
  assert.equal(consumers, 1);
  assert.equal(state.closed, 1);
  assert.equal(store.releases, 1);
});

test("ownership-loss cleanup retries after a transient shutdown failure", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  const state = { closed: 0, constructed: 0 };
  const manager = createConnectionManager(constructors(state), configured.value);
  const connection = await manager.replace(line(), { address: "address", token: "token" });
  let attempts = 0;
  connection.addConsumer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient-consumer-stop-failure");
  });
  store.allowRenewal = false;
  configured.time.advance(100);
  await configured.time.fire();
  assert.equal(attempts, 1);
  assert.equal(store.releases, 0);
  await configured.time.fire();
  assert.equal(attempts, 2);
  assert.equal(store.releases, 1);
});

test("ownership loss during slow construction closes the unpublished SDK", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let stopped = 0;
  const manager = createConnectionManager(
    {
      advanced: () => {
        throw new Error("unexpected-advanced");
      },
      spectrum: async () => {
        entered.resolve();
        await finish.promise;
        return {
          messages: { async *[Symbol.asyncIterator]() {} },
          stop: async () => void (stopped += 1),
        };
      },
    },
    configured.value,
  );
  const pending = manager.replace(line("spectrum-imessage"), { address: "address", token: "token" });
  await entered.promise;
  store.allowRenewal = false;
  configured.time.advance(100);
  await configured.time.fire();
  finish.resolve();
  await assert.rejects(pending, /OWNERSHIP_LOST/u);
  assert.equal(stopped, 1);
  assert.equal(store.releases, 1);
});

test("shutdown failure retains ownership until cleanup succeeds", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  const state = { closed: 0, constructed: 0 };
  const manager = createConnectionManager(constructors(state), configured.value);
  const connection = await manager.replace(line(), { address: "address", token: "token" });
  let attempts = 0;
  connection.addConsumer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("consumer-stop-failed");
  });
  await assert.rejects(manager.stop(), /consumer-stop-failed/u);
  assert.equal(store.releases, 0);
  await manager.stop();
  assert.equal(store.releases, 1);
});

test("SDK shutdown failure retains ownership until close succeeds", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  let closes = 0;
  const manager = createConnectionManager(
    {
      advanced: () =>
        ({
          close: async () => {
            closes += 1;
            if (closes === 1) throw new Error("sdk-close-failed");
          },
        }) as ReturnType<ProviderConstructors["advanced"]>,
      spectrum: async () => {
        throw new Error("unexpected-spectrum");
      },
    },
    configured.value,
  );
  await manager.replace(line(), { address: "address", token: "token" });
  await assert.rejects(manager.stop(), /sdk-close-failed/u);
  assert.equal(store.releases, 0);
  await manager.stop();
  assert.equal(closes, 2);
  assert.equal(store.releases, 1);
});

test("construction failure releases only the acquired generation", async () => {
  const store = new FakeLineOwnerStore();
  const configured = ownership(store);
  const manager = createConnectionManager(
    {
      advanced: () => {
        throw new Error("construction-failed");
      },
      spectrum: async () => {
        throw new Error("unexpected-spectrum");
      },
    },
    configured.value,
  );
  await assert.rejects(manager.replace(line(), { address: "address", token: "token" }), /construction-failed/u);
  assert.equal(store.releases, 1);
  assert.equal(store.current.size, 0);
});

test("a connection manager without a durable owner fails before SDK construction", async () => {
  const state = { closed: 0, constructed: 0 };
  const manager = createConnectionManager(constructors(state));
  await assert.rejects(manager.replace(line(), { address: "address", token: "token" }), /LINE_OWNER_MISSING/u);
  assert.equal(state.constructed, 0);
});
