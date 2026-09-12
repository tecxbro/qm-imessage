import type { CatchUpEvent, LiveEvent } from "@photon-ai/advanced-imessage/grpc";
import type { NormalizedPhotonInput } from "../../../chassis/src/photon-contract.ts";
import type { EventReceiptStorePort } from "../ports.ts";
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
  store: EventReceiptStorePort,
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
  async function handoff(input: NormalizedPhotonInput) {
    if (stopped) return;
    connection.assertActive();
    const receipt = await store.read(eventKey(input));
    if (receipt?.state === "checkpointed" || receipt?.state === "rejected") return;
    if (!stopped) await onInput(input);
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
      completion.resolve({ mode: "live-only" });
    } else {
      const checkpoint = await store.readContiguousCheckpoint(connection.line.reference);
      connection.assertActive();
      if (stopped) throw new Error("PROVIDER_INTAKE_STOPPED");
      const since = checkpoint === undefined ? undefined : Number(checkpoint.sequence);
      if (since !== undefined && providerSequence(since) !== checkpoint?.sequence)
        throw new Error("PROVIDER_CURSOR_UNREPRESENTABLE");
      const pending = new Map<string, NormalizedPhotonInput>();
      let bytes = 0;
      let recovering = true;
      async function accept(event: LiveEvent) {
        const input = normalizeAdvancedEvent(event, connection.line);
        await capture(store, input);
        if (recovering) {
          if (!pending.has(input.event.eventId)) {
            bytes += Buffer.byteLength(JSON.stringify(input));
            if (pending.size >= limits.maxEvents || bytes > limits.maxBytes)
              throw new Error("PROVIDER_RECOVERY_BOUND_EXCEEDED");
            pending.set(input.event.eventId, input);
          }
        } else await handoff(input);
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
            await enqueue(async () => {
              const ordered = [...pending.values()].sort((a, b) => Number(a.event.sequence) - Number(b.event.sequence));
              for (const input of ordered) await handoff(input);
              pending.clear();
              recovering = false;
            });
            completed = true;
            if (timer) clearTimeout(timer);
            if (!stopped) completion.resolve({ mode: "catchup", headSequence });
            break;
          }
          if (!stopped && !completed) throw new Error("PROVIDER_CATCHUP_INCOMPLETE");
        })().catch(fail),
      );
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
