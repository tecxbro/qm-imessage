import { randomUUID } from "node:crypto";

import type {
  PhotonLineOwnerClaim,
  PhotonLineOwnerKey,
  PhotonLineOwnerStore,
} from "../../../chassis/src/photon-state/line-owner.ts";

const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_LEASE_TTL_MS = 86_400_000;

export interface ProviderLineOwnerLease {
  readonly claim: PhotonLineOwnerClaim;
  assertActive(): void;
  release(): Promise<boolean>;
}

export interface ProviderLineOwnership {
  acquire(key: PhotonLineOwnerKey, onLoss: () => void | Promise<void>): Promise<ProviderLineOwnerLease | undefined>;
}

export interface ProviderLineOwnershipOptions {
  leaseTtlMs?: number;
  renewAfterMs?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
  ownerId?: () => string;
  setTimer?: (handler: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

function validDuration(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function timestamp(milliseconds: number, label: string): string {
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} is invalid`);
  return new Date(milliseconds).toISOString();
}

function assertExpectedClaim(
  claim: PhotonLineOwnerClaim,
  key: PhotonLineOwnerKey,
  ownerId: string,
  fence?: number,
): void {
  if (
    claim.key.installationId !== key.installationId ||
    claim.key.lineId !== key.lineId ||
    claim.ownerId !== ownerId ||
    !Number.isSafeInteger(claim.fence) ||
    claim.fence <= 0 ||
    (fence !== undefined && claim.fence !== fence) ||
    new Date(claim.leaseExpiresAt).toISOString() !== claim.leaseExpiresAt
  )
    throw new Error("PROVIDER_LINE_OWNER_INVALID_CLAIM");
}

export function createProviderLineOwnership(
  store: PhotonLineOwnerStore,
  options: ProviderLineOwnershipOptions = {},
): ProviderLineOwnership {
  const leaseTtlMs = validDuration(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, "leaseTtlMs", MAX_LEASE_TTL_MS);
  const renewAfterMs = validDuration(
    options.renewAfterMs ?? Math.max(1, Math.floor(leaseTtlMs / 3)),
    "renewAfterMs",
    leaseTtlMs - 1,
  );
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const ownerId = options.ownerId ?? randomUUID;
  const setTimer = options.setTimer ?? ((handler: () => void, delay: number) => setTimeout(handler, delay));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  return {
    async acquire(key, onLoss) {
      if (!key.installationId.trim() || !key.lineId.trim()) throw new TypeError("line owner key is invalid");
      const acquiredOwnerId = ownerId();
      if (!acquiredOwnerId.trim()) throw new TypeError("ownerId is invalid");
      const requestStartedAt = monotonicNow();
      const requestedAt = wallNow();
      const acquiredClaim = await store.claim(
        key,
        acquiredOwnerId,
        timestamp(requestedAt, "wallNow"),
        timestamp(requestedAt + leaseTtlMs, "leaseExpiresAt"),
      );
      if (acquiredClaim === undefined) return undefined;
      assertExpectedClaim(acquiredClaim, key, acquiredOwnerId);
      let claim: PhotonLineOwnerClaim = acquiredClaim;

      let active = true;
      let released: boolean | undefined;
      let releaseInFlight: Promise<boolean> | undefined;
      let renewalInFlight: Promise<void> | undefined;
      let deadline = requestStartedAt + leaseTtlMs;
      let timer: unknown;

      const cleanUpAfterLoss = () => {
        if (released !== undefined) return;
        void Promise.resolve()
          .then(onLoss)
          .catch(() => {
            if (released !== undefined) return;
            timer = setTimer(() => {
              timer = undefined;
              cleanUpAfterLoss();
            }, renewAfterMs);
          });
      };

      const notifyLoss = () => {
        if (!active) return;
        active = false;
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        queueMicrotask(cleanUpAfterLoss);
      };

      const renew = async () => {
        if (!active) return;
        const renewalStartedAt = monotonicNow();
        if (renewalStartedAt >= deadline) {
          notifyLoss();
          return;
        }
        const renewedAt = wallNow();
        try {
          const renewed = await store.renew(
            claim,
            timestamp(renewedAt, "wallNow"),
            timestamp(renewedAt + leaseTtlMs, "leaseExpiresAt"),
          );
          if (!active) return;
          if (renewed === undefined || monotonicNow() >= deadline) {
            notifyLoss();
            return;
          }
          assertExpectedClaim(renewed, key, acquiredOwnerId, claim.fence);
          claim = renewed;
          deadline = renewalStartedAt + leaseTtlMs;
          schedule();
        } catch {
          notifyLoss();
        }
      };

      const schedule = () => {
        if (!active) return;
        timer = setTimer(() => {
          timer = undefined;
          renewalInFlight = renew().finally(() => {
            renewalInFlight = undefined;
          });
        }, renewAfterMs);
      };

      const lease: ProviderLineOwnerLease = {
        get claim() {
          return claim;
        },
        assertActive() {
          if (active && monotonicNow() >= deadline) notifyLoss();
          if (!active) throw new Error("PROVIDER_LINE_OWNERSHIP_LOST");
        },
        async release() {
          if (released !== undefined) return released;
          if (releaseInFlight !== undefined) return releaseInFlight;
          active = false;
          if (timer !== undefined) clearTimer(timer);
          timer = undefined;
          releaseInFlight = (async () => {
            await renewalInFlight;
            released = await store.release(claim, timestamp(wallNow(), "wallNow"));
            return released;
          })();
          try {
            return await releaseInFlight;
          } finally {
            releaseInFlight = undefined;
          }
        },
      };

      if (monotonicNow() >= deadline) {
        await lease.release();
        throw new Error("PROVIDER_LINE_OWNERSHIP_LOST");
      }
      schedule();
      return lease;
    },
  };
}
