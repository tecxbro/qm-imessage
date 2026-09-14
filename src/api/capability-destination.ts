import type { CandidateDestination, Destination } from "../types.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  createPhotonDestination,
  isPhotonDestination,
  PHOTON_DESTINATION_TYPE,
} from "../surfaces/photon-destinations.ts";

type Projection = { ok: true; destination: Destination | undefined } | { ok: false };

function projectPhoton(value: Destination): Projection {
  if (!isPhotonDestination(value) || value.audienceScopeId === undefined) return { ok: false };
  if (value.onBehalfOf !== undefined && (typeof value.onBehalfOf !== "string" || value.onBehalfOf.length === 0)) {
    return { ok: false };
  }
  try {
    return {
      ok: true,
      destination: createPhotonDestination({
        conversation: value.conversation,
        kind: value.conversationKind,
        principalIds: value.principalIds,
        audienceScopeId: value.audienceScopeId,
        ...(value.recipientPrincipalId === undefined ? {} : { recipientPrincipalId: value.recipientPrincipalId }),
        ...(value.groupId === undefined ? {} : { groupId: value.groupId }),
        ...(value.onBehalfOf === undefined ? {} : { onBehalfOf: value.onBehalfOf }),
        ...(value.providerMessage === undefined ? {} : { providerMessage: value.providerMessage }),
      }),
    };
  } catch {
    return { ok: false };
  }
}

function stripCandidate(value: CandidateDestination): Projection {
  if (value.type === PHOTON_DESTINATION_TYPE) return projectPhoton(value);
  return {
    ok: true,
    destination: {
      type: value.type,
      target: value.target,
      ...(value.audienceScopeId ? { audienceScopeId: value.audienceScopeId } : {}),
    },
  };
}

function findCandidate(
  candidates: CandidateDestination[] | undefined,
  key: string | undefined,
): CandidateDestination | undefined {
  if (typeof key !== "string" || !Array.isArray(candidates)) return undefined;
  const values: readonly unknown[] = candidates;
  return values.find(
    (value): value is CandidateDestination =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "key" in value &&
      typeof value.key === "string" &&
      value.key === key,
  );
}

export function resolveCapabilityDestination(cap: CapabilityClaims, destinationKey: string | undefined): Projection {
  if (destinationKey !== undefined) {
    const chosen = findCandidate(cap.destinations, destinationKey);
    return chosen === undefined ? { ok: false } : stripCandidate(chosen);
  }
  const fallback = findCandidate(cap.destinations, cap.defaultDestinationKey);
  if (fallback !== undefined) return stripCandidate(fallback);
  if (cap.destination?.type === PHOTON_DESTINATION_TYPE) return projectPhoton(cap.destination);
  return { ok: true, destination: cap.destination };
}
