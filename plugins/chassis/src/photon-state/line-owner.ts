import { PHOTON_STATE_SCHEMA } from "../photon-state-schema.ts";

import type { PhotonStateDatabase } from "./db.ts";
import { canonicalTimestamp, nonempty, resultCount } from "./shared.ts";

const MAX_FENCE = Number.MAX_SAFE_INTEGER;
const MAX_LEASE_DURATION_MS = 86_400_000;

export interface PhotonLineOwnerKey {
  installationId: string;
  lineId: string;
}

export interface PhotonLineOwnerClaim {
  key: PhotonLineOwnerKey;
  ownerId: string;
  fence: number;
  leaseExpiresAt: string;
}

export interface PhotonLineOwnerStore {
  claim(
    key: PhotonLineOwnerKey,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<PhotonLineOwnerClaim | undefined>;
  renew(claim: PhotonLineOwnerClaim, now: string, leaseExpiresAt: string): Promise<PhotonLineOwnerClaim | undefined>;
  release(claim: PhotonLineOwnerClaim, now: string): Promise<boolean>;
}

interface LineOwnerRow {
  [key: string]: unknown;
  installation_id: string;
  line_id: string;
  owner_id: string;
  fence: string | number;
  expires_at: string | Date;
}

function leaseDuration(now: string, leaseExpiresAt: string): number {
  const nowMilliseconds = canonicalTimestamp(now, "now");
  const expiryMilliseconds = canonicalTimestamp(leaseExpiresAt, "leaseExpiresAt");
  const duration = expiryMilliseconds - nowMilliseconds;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_LEASE_DURATION_MS)
    throw new TypeError("line owner lease duration is invalid");
  return duration;
}

function validateKey(key: PhotonLineOwnerKey): void {
  nonempty(key.installationId, "installationId");
  nonempty(key.lineId, "lineId");
}

function validateClaim(claim: PhotonLineOwnerClaim): void {
  validateKey(claim.key);
  nonempty(claim.ownerId, "ownerId");
  if (!Number.isSafeInteger(claim.fence) || claim.fence <= 0 || claim.fence > MAX_FENCE)
    throw new TypeError("line owner fence is invalid");
  canonicalTimestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
}

function claimFromRow(row: LineOwnerRow | undefined): PhotonLineOwnerClaim | undefined {
  if (row === undefined) return undefined;
  const fence = Number(row.fence);
  if (!Number.isSafeInteger(fence) || fence <= 0 || fence > MAX_FENCE)
    throw new TypeError("line owner fence is invalid");
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) throw new TypeError("line owner expiry is invalid");
  return {
    key: { installationId: row.installation_id, lineId: row.line_id },
    ownerId: row.owner_id,
    fence,
    leaseExpiresAt: expiresAt.toISOString(),
  };
}

export function createPhotonLineOwnerStore(database: PhotonStateDatabase): PhotonLineOwnerStore {
  return {
    async claim(key, ownerId, now, leaseExpiresAt) {
      validateKey(key);
      nonempty(ownerId, "ownerId");
      const duration = leaseDuration(now, leaseExpiresAt);
      const result = await database.query<LineOwnerRow>(
        `WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
              acquired AS (
                INSERT INTO ${PHOTON_STATE_SCHEMA}.line_owners AS owned(
                  installation_id, line_id, owner_id, fence, expires_at
                )
                SELECT $1, $2, $3, 1, at + $4::double precision * interval '1 millisecond'
                  FROM lease_clock
                ON CONFLICT (installation_id, line_id) DO UPDATE
                  SET owner_id = EXCLUDED.owner_id,
                      fence = owned.fence + 1,
                      expires_at = EXCLUDED.expires_at
                  WHERE owned.expires_at <= (SELECT at FROM lease_clock)
                    AND owned.fence < ${MAX_FENCE}
                RETURNING installation_id, line_id, owner_id, fence, expires_at
              )
         SELECT installation_id, line_id, owner_id, fence, expires_at
           FROM acquired
          WHERE expires_at > clock_timestamp()`,
        [key.installationId, key.lineId, ownerId, duration],
      );
      return claimFromRow(result.rows[0]);
    },
    async renew(claim, now, leaseExpiresAt) {
      validateClaim(claim);
      const duration = leaseDuration(now, leaseExpiresAt);
      return database.transaction(async (transaction) => {
        await transaction.query(
          `SELECT 1
             FROM ${PHOTON_STATE_SCHEMA}.line_owners
            WHERE installation_id = $1
              AND line_id = $2
              FOR UPDATE`,
          [claim.key.installationId, claim.key.lineId],
        );
        const result = await transaction.query<LineOwnerRow>(
          `WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
                renewed AS (
                  UPDATE ${PHOTON_STATE_SCHEMA}.line_owners AS owned
                     SET expires_at = lease_clock.at + $5::double precision * interval '1 millisecond'
                    FROM lease_clock
                   WHERE owned.installation_id = $1
                     AND owned.line_id = $2
                     AND owned.owner_id = $3
                     AND owned.fence = $4
                     AND owned.expires_at > lease_clock.at
                  RETURNING owned.installation_id, owned.line_id, owned.owner_id, owned.fence, owned.expires_at
                )
           SELECT installation_id, line_id, owner_id, fence, expires_at
             FROM renewed
            WHERE expires_at > clock_timestamp()`,
          [claim.key.installationId, claim.key.lineId, claim.ownerId, claim.fence, duration],
        );
        return claimFromRow(result.rows[0]);
      });
    },
    async release(claim, now) {
      validateClaim(claim);
      canonicalTimestamp(now, "now");
      const result = await database.query(
        `WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE ${PHOTON_STATE_SCHEMA}.line_owners AS owned
            SET expires_at = LEAST(owned.expires_at, lease_clock.at)
           FROM lease_clock
          WHERE owned.installation_id = $1
            AND owned.line_id = $2
            AND owned.owner_id = $3
            AND owned.fence = $4
        RETURNING owned.installation_id`,
        [claim.key.installationId, claim.key.lineId, claim.ownerId, claim.fence],
      );
      return resultCount(result) === 1;
    },
  };
}
