import type {
  ConversationReference,
  MessageTargetReference,
  PhotonProviderName,
} from "../../plugins/chassis/src/photon-contract.ts";
import { scopeId, type Destination, type ScopeId } from "../types.ts";

export const PHOTON_DESTINATION_TYPE = "photon";
export type ReachSurface = "slack" | typeof PHOTON_DESTINATION_TYPE;

export interface PhotonDestination extends Destination {
  type: typeof PHOTON_DESTINATION_TYPE;
  conversation: ConversationReference;
  conversationKind: "dm" | "group";
  principalIds: readonly string[];
  recipientPrincipalId?: string;
  groupId?: string;
  providerMessage?: MessageTargetReference;
}

export type PhotonDestinationRequest =
  | { kind: "principal"; principalId: string; authorityId: string }
  | { kind: "group"; principalIds: readonly string[]; authorityId: string };

export type PhotonDestinationResolution =
  | { kind: "one"; destination: PhotonDestination }
  | { kind: "ambiguous"; candidates: readonly PhotonDestination[] }
  | { kind: "none" };

export interface PhotonDestinationResolver {
  resolve(request: PhotonDestinationRequest): Promise<PhotonDestinationResolution>;
  sessionThreadRefs?(conversation: ConversationReference): Promise<readonly string[]>;
}

const PROVIDERS = new Set<PhotonProviderName>(["spectrum-imessage", "advanced-imessage"]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined;
}

function presentString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

export function parsePhotonConversationReference(value: unknown): ConversationReference | undefined {
  const input = record(value);
  if (!input) return undefined;
  if (!hasOnlyKeys(input, ["provider", "installationId", "projectId", "lineId", "maskedAddress", "conversationId"]))
    return undefined;
  if (!PROVIDERS.has(input.provider as PhotonProviderName)) return undefined;
  if (!presentString(input.installationId) || !presentString(input.lineId) || !presentString(input.conversationId)) {
    return undefined;
  }
  if (input.projectId !== undefined && !presentString(input.projectId)) return undefined;
  if (input.maskedAddress !== undefined && !presentString(input.maskedAddress)) return undefined;
  return input as unknown as ConversationReference;
}

export function parsePhotonMessageTargetReference(value: unknown): MessageTargetReference | undefined {
  const input = record(value);
  if (!input) return undefined;
  if (
    !hasOnlyKeys(input, [
      "provider",
      "installationId",
      "projectId",
      "lineId",
      "maskedAddress",
      "conversationId",
      "messageId",
      "partIndex",
    ])
  )
    return undefined;
  const conversation = parsePhotonConversationReference({
    provider: input.provider,
    installationId: input.installationId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    lineId: input.lineId,
    ...(input.maskedAddress !== undefined ? { maskedAddress: input.maskedAddress } : {}),
    conversationId: input.conversationId,
  });
  if (!conversation || !presentString(input.messageId)) return undefined;
  if (input.partIndex !== undefined && (!Number.isSafeInteger(input.partIndex) || (input.partIndex as number) < 0)) {
    return undefined;
  }
  return input as unknown as MessageTargetReference;
}

export function samePhotonConversation(left: ConversationReference, right: ConversationReference): boolean {
  return (
    left.provider === right.provider &&
    left.installationId === right.installationId &&
    left.lineId === right.lineId &&
    left.conversationId === right.conversationId
  );
}

export function samePhotonMessage(left: MessageTargetReference, right: MessageTargetReference): boolean {
  return (
    samePhotonConversation(left, right) && left.messageId === right.messageId && left.partIndex === right.partIndex
  );
}

export function canonicalPrincipalIds(principalIds: readonly string[]): string[] {
  return [...new Set(principalIds.filter((principalId) => principalId.length > 0))].sort();
}

function samePrincipals(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalPrincipalIds(left);
  const b = canonicalPrincipalIds(right);
  return a.length === b.length && a.every((principalId, index) => principalId === b[index]);
}

export function createPhotonDestination(input: {
  conversation: ConversationReference;
  kind: "dm" | "group";
  principalIds: readonly string[];
  audienceScopeId: ScopeId;
  recipientPrincipalId?: string;
  groupId?: string;
  onBehalfOf?: string;
  providerMessage?: MessageTargetReference;
}): PhotonDestination {
  const conversation = parsePhotonConversationReference(input.conversation);
  if (!conversation) throw new TypeError("invalid Photon conversation reference");
  const principalIds = canonicalPrincipalIds(input.principalIds);
  if (!principalIds.length) throw new TypeError("a Photon destination requires canonical principals");
  if (input.kind === "dm") {
    if (
      !input.recipientPrincipalId ||
      principalIds.length !== 1 ||
      principalIds[0] !== input.recipientPrincipalId ||
      input.groupId
    ) {
      throw new TypeError("a Photon DM requires its canonical recipient and no group id");
    }
    if (input.audienceScopeId !== scopeId("personal", input.recipientPrincipalId)) {
      throw new TypeError("a Photon DM must retain the recipient personal scope");
    }
  } else {
    if (!input.groupId || input.recipientPrincipalId || principalIds.length < 2) {
      throw new TypeError("a Photon group requires its canonical group id and no DM recipient");
    }
    if (input.audienceScopeId !== scopeId("group", input.groupId)) {
      throw new TypeError("a Photon group must retain its canonical group scope");
    }
  }
  const providerMessage =
    input.providerMessage === undefined ? undefined : parsePhotonMessageTargetReference(input.providerMessage);
  if (input.providerMessage !== undefined && !providerMessage) {
    throw new TypeError("invalid Photon message reference");
  }
  if (providerMessage && !samePhotonConversation(providerMessage, conversation)) {
    throw new TypeError("the Photon message belongs to a different conversation");
  }
  return {
    type: PHOTON_DESTINATION_TYPE,
    target: conversation.conversationId,
    audienceScopeId: input.audienceScopeId,
    conversation,
    conversationKind: input.kind,
    principalIds,
    ...(input.recipientPrincipalId ? { recipientPrincipalId: input.recipientPrincipalId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
    ...(providerMessage ? { providerMessage } : {}),
  };
}

export function isPhotonDestination(value: unknown): value is PhotonDestination {
  const input = record(value);
  if (!input || input.type !== PHOTON_DESTINATION_TYPE) return false;
  const conversation = parsePhotonConversationReference(input.conversation);
  if (!conversation || input.target !== conversation.conversationId) return false;
  if (input.conversationKind !== "dm" && input.conversationKind !== "group") return false;
  if (!Array.isArray(input.principalIds) || !input.principalIds.every(presentString)) return false;
  const principalIds = input.principalIds as string[];
  const canonicalIds = canonicalPrincipalIds(principalIds);
  if (
    principalIds.length !== canonicalIds.length ||
    principalIds.some((principalId, index) => principalId !== canonicalIds[index])
  ) {
    return false;
  }
  if (!presentString(input.audienceScopeId)) return false;
  if (input.conversationKind === "dm") {
    if (!presentString(input.recipientPrincipalId) || input.groupId !== undefined || principalIds.length !== 1)
      return false;
    if (principalIds[0] !== input.recipientPrincipalId) return false;
    if (input.audienceScopeId !== scopeId("personal", input.recipientPrincipalId)) return false;
  } else {
    if (!presentString(input.groupId) || input.recipientPrincipalId !== undefined || principalIds.length < 2)
      return false;
    if (input.audienceScopeId !== scopeId("group", input.groupId)) return false;
  }
  if (input.providerMessage !== undefined) {
    const message = parsePhotonMessageTargetReference(input.providerMessage);
    if (!message || !samePhotonConversation(message, conversation)) return false;
  }
  return true;
}

export function photonDestinationMatches(destination: PhotonDestination, request: PhotonDestinationRequest): boolean {
  if (request.kind === "principal") {
    return destination.conversationKind === "dm" && destination.recipientPrincipalId === request.principalId;
  }
  return destination.conversationKind === "group" && samePrincipals(destination.principalIds, request.principalIds);
}

export function photonDestinationCandidate(destination: PhotonDestination): Record<string, string> {
  return {
    provider: destination.conversation.provider,
    installationId: destination.conversation.installationId,
    lineId: destination.conversation.lineId,
    conversationId: destination.conversation.conversationId,
  };
}

export function withPhotonMessage(destination: Destination, messageId: string): Destination {
  if (!isPhotonDestination(destination) || !messageId) return destination;
  const scoped: PhotonDestination = {
    ...destination,
    providerMessage: { ...destination.conversation, messageId },
  };
  return scoped;
}
