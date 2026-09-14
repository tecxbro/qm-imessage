import type { CatchUpEvent, LiveEvent } from "@photon-ai/advanced-imessage/grpc";
import type { NormalizedPhotonInput } from "../../../chassis/src/photon-contract.ts";
import type {
  EventReceipt,
  EventReceiptStorePort,
  ProviderEventKey,
  ReceiptRecoveryCursor,
  RecoverableEventReceiptStorePort,
} from "../ports.ts";
import type { ProviderConnection } from "./connection.ts";
import { normalizeAdvancedEvent, normalizeSpectrumMessage, providerSequence } from "./subscriptions.ts";

export interface RecoveryLimits {
  maxEvents: number;
  maxBytes: number;
  catchupTimeoutMs: number;
  shutdownTimeoutMs?: number;
}

export const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = {
  maxEvents: 4096,
  maxBytes: 16 * 1024 * 1024,
  catchupTimeoutMs: 30_000,
};

function receiptIdentity(key: ProviderEventKey): string {
  return JSON.stringify([key.provider, key.installationId, key.lineId ?? "", key.eventId]);
}

function hasLiveClaim(receipt: EventReceipt | undefined): boolean {
  return (
    receipt?.state === "processing" &&
    receipt.claim !== undefined &&
    Date.parse(receipt.claim.leaseExpiresAt) > Date.now()
  );
}

export function eventKey(input: NormalizedPhotonInput) {
  const event = input.event;
  return {
    provider: event.provider,
    installationId: event.installationId,
    eventId: event.eventId,
    ...(event.lineId !== undefined ? { lineId: event.lineId } : {}),
  };
}

async function capture(store: EventReceiptStorePort, input: NormalizedPhotonInput): Promise<void> {
  const result = await store.capture({
    key: eventKey(input),
    ...(input.event.sequence !== undefined ? { sequence: input.event.sequence } : {}),
    capturedAt: new Date().toISOString(),
    state: "captured",
    payload: { kind: "envelope", envelope: input },
  });
  if (result === "conflict") throw new Error("PROVIDER_EVENT_IDENTITY_CONFLICT");
}

export async function startProviderIntake(
  connection: ProviderConnection,
  store: RecoverableEventReceiptStorePort,
  onInput: (input: NormalizedPhotonInput) => Promise<void>,
  limits: RecoveryLimits = DEFAULT_RECOVERY_LIMITS,
) {
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_RECOVERY_LIMIT");
  connection.assertActive();
  let stopped = false;
  let draining: Promise<void> | undefined;
  let serial = Promise.resolve();
  const streams: { close(): Promise<void> }[] = [];
  const tasks: Promise<void>[] = [];
  const completion = Promise.withResolvers<{ mode: "live-only" | "catchup"; headSequence?: string }>();
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => undefined);
  void completion.promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recoveryHandoffs = new Set<string>();
  let durableRecoveryComplete = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    completion.reject(new Error("PROVIDER_INTAKE_STOPPED"));
    draining ??= (async () => {
      await Promise.all(streams.map((stream) => stream.close()));
      if (connection.kind === "spectrum") await connection.sdk.stop();
      await Promise.allSettled(tasks);
      await serial.catch(() => undefined);
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error("PROVIDER_INTAKE_DRAIN_TIMEOUT")),
        limits.shutdownTimeoutMs ?? 30_000,
      );
    });
    return Promise.race([draining, timeout]).finally(() => {
      if (deadline) clearTimeout(deadline);
    });
  };
  const release = connection.addConsumer(stop);
  function fail(error: unknown) {
    stopped = true;
    if (timer) clearTimeout(timer);
    failure.reject(error);
    completion.reject(error);
    for (const stream of streams) void stream.close().catch(() => undefined);
  }
  function enqueue(action: () => Promise<void>) {
    const next = serial.then(async () => {
      if (stopped) return;
      connection.assertActive();
      await action();
    });
    serial = next;
    return next;
  }
  async function handoff(input: NormalizedPhotonInput, recovered = false) {
    if (stopped) return;
    connection.assertActive();
    const key = eventKey(input);
    const identity = receiptIdentity(key);
    if (recoveryHandoffs.has(identity)) return;
    const receipt = await store.read(key);
    if (receipt?.state === "checkpointed" || receipt?.state === "rejected") return;
    if (hasLiveClaim(receipt)) return;
    if (!stopped) {
      if (recovered || !durableRecoveryComplete) {
        if (recoveryHandoffs.size >= limits.maxEvents) throw new Error("PROVIDER_RECOVERY_BOUND_EXCEEDED");
        recoveryHandoffs.add(identity);
      }
      await onInput(input);
    }
  }
  async function recoverDurableReceipts() {
    const seen = new Set<string>();
    const recovered: NormalizedPhotonInput[] = [];
    let bytes = 0;
    let addedInSweep: number;
    do {
      addedInSweep = 0;
      let after: ReceiptRecoveryCursor | undefined;
      const now = new Date().toISOString();
      do {
        if (stopped) return recovered;
        const page = await store.discoverRecoverable({
          ...connection.line.reference,
          now,
          limit: Math.min(128, limits.maxEvents),
          ...(after === undefined ? {} : { after }),
        });
        for (const receipt of page.receipts) {
          if (stopped) return recovered;
          if (
            receipt.key.provider !== connection.line.reference.provider ||
            receipt.key.installationId !== connection.line.reference.installationId ||
            receipt.key.lineId !== connection.line.reference.lineId
          )
            throw new Error("PROVIDER_RECOVERY_SCOPE_MISMATCH");
          const identity = receiptIdentity(receipt.key);
          if (seen.has(identity)) continue;
          if (seen.size >= limits.maxEvents) throw new Error("PROVIDER_RECOVERY_BOUND_EXCEEDED");
          seen.add(identity);
          addedInSweep += 1;
          if (receipt.payload.kind === "reference") {
            const current = await store.read(receipt.key);
            if (current?.state === "checkpointed" || current?.state === "rejected" || hasLiveClaim(current)) continue;
            throw new Error("PROVIDER_RECOVERY_REFERENCE_UNRESOLVED");
          }
          const envelope = receipt.payload.envelope;
          bytes += Buffer.byteLength(JSON.stringify(envelope));
          if (bytes > limits.maxBytes) throw new Error("PROVIDER_RECOVERY_BOUND_EXCEEDED");
          recovered.push(envelope);
        }
        if (after !== undefined && page.next?.capturedAt === after.capturedAt && page.next.eventId === after.eventId)
          throw new Error("PROVIDER_RECOVERY_CURSOR_STALLED");
        after = page.next;
      } while (after !== undefined);
    } while (addedInSweep > 0);
    recovered.sort((left, right) => {
      if (left.event.sequence === undefined) return right.event.sequence === undefined ? 0 : 1;
      if (right.event.sequence === undefined) return -1;
      return Number(left.event.sequence) - Number(right.event.sequence);
    });
    return recovered;
  }
  try {
    if (connection.kind === "spectrum") {
      const task = (async () => {
        for await (const [, message] of connection.sdk.messages) {
          if (stopped) break;
          await enqueue(async () => {
            const input = normalizeSpectrumMessage(message, connection.line);
            await capture(store, input);
            await handoff(input);
          });
        }
        if (!stopped) throw new Error("PROVIDER_LIVE_STREAM_ENDED");
      })().catch(fail);
      tasks.push(task);
      const recovered = await recoverDurableReceipts();
      for (const input of recovered) await enqueue(() => handoff(input, true));
      durableRecoveryComplete = true;
      if (stopped) throw new Error("PROVIDER_INTAKE_STOPPED");
      completion.resolve({ mode: "live-only" });
    } else {
      const checkpoint = await store.readContiguousCheckpoint(connection.line.reference);
      connection.assertActive();
      if (stopped) throw new Error("PROVIDER_INTAKE_STOPPED");
      const since = checkpoint === undefined ? undefined : Number(checkpoint.sequence);
      if (since !== undefined && providerSequence(since) !== checkpoint?.sequence)
        throw new Error("PROVIDER_CURSOR_UNREPRESENTABLE");
      const pending = new Map<string, NormalizedPhotonInput>();
      const durableRecovery = Promise.withResolvers<readonly NormalizedPhotonInput[]>();
      void durableRecovery.promise.catch(() => undefined);
      let bytes = 0;
      let recovering = true;
      function stage(input: NormalizedPhotonInput) {
        if (pending.has(input.event.eventId)) return;
        if (input.event.sequence === undefined) throw new Error("PROVIDER_RECOVERY_SEQUENCE_MISSING");
        bytes += Buffer.byteLength(JSON.stringify(input));
        if (pending.size >= limits.maxEvents || bytes > limits.maxBytes)
          throw new Error("PROVIDER_RECOVERY_BOUND_EXCEEDED");
        pending.set(input.event.eventId, input);
      }
      async function accept(event: LiveEvent) {
        const input = normalizeAdvancedEvent(event, connection.line);
        await capture(store, input);
        if (recovering) stage(input);
        else await handoff(input);
      }
      const sdk = connection.sdk;
      const live = [
        sdk.messages.subscribeEvents(),
        sdk.chats.subscribeEvents(),
        sdk.groups.subscribeEvents(),
        sdk.polls.subscribeEvents(),
      ];
      streams.push(...live);
      for (const stream of live) {
        tasks.push(
          (async () => {
            for await (const event of stream) {
              if (stopped) break;
              await enqueue(() => accept(event));
            }
            if (!stopped) throw new Error("PROVIDER_LIVE_STREAM_ENDED");
          })().catch(fail),
        );
      }
      const catchup = sdk.events.catchUp(since);
      streams.push(catchup);
      timer = setTimeout(() => fail(new Error("PROVIDER_CATCHUP_TIMEOUT")), limits.catchupTimeoutMs);
      tasks.push(
        (async () => {
          let completed = false;
          for await (const event of catchup as AsyncIterable<CatchUpEvent>) {
            if (stopped) break;
            if (event.type !== "catchup.complete") {
              await enqueue(() => accept(event));
              continue;
            }
            const headSequence = providerSequence(event.headSequence);
            if (since !== undefined && event.headSequence < since) throw new Error("PROVIDER_CURSOR_REGRESSED");
            if (timer) clearTimeout(timer);
            const recovered = await durableRecovery.promise;
            await enqueue(async () => {
              for (const input of recovered) stage(input);
              const ordered = [...pending.values()].sort((a, b) => Number(a.event.sequence) - Number(b.event.sequence));
              for (const input of ordered) await handoff(input, true);
              pending.clear();
              recovering = false;
            });
            completed = true;
            if (!stopped) completion.resolve({ mode: "catchup", headSequence });
            break;
          }
          if (!stopped && !completed) throw new Error("PROVIDER_CATCHUP_INCOMPLETE");
        })().catch(fail),
      );
      try {
        durableRecovery.resolve(await recoverDurableReceipts());
        durableRecoveryComplete = true;
      } catch (error) {
        durableRecovery.reject(error);
        throw error;
      }
      if (stopped) throw new Error("PROVIDER_INTAKE_STOPPED");
    }
  } catch (error) {
    fail(error);
    await stop();
    release();
    throw error;
  }
  return {
    completion: completion.promise,
    failure: failure.promise,
    async stop() {
      await stop();
      release();
    },
  };
}
