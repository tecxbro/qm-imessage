import { randomUUID } from "node:crypto";

import type {
  NormalizedPhotonInput,
  OutboundAttachmentReference,
  PhotonOperationOutcome,
  PhotonPresentationOperation,
} from "../../chassis/src/photon-contract.ts";
import type { PhotonStateStores } from "../../chassis/src/photon-state.ts";
import type {
  AdvancedIMessageProviderClientPort,
  PhotonDeliveryDispatch,
  PhotonDeliveryProgressPort,
} from "./ports.ts";
import {
  createAdvancedProviderClient,
  createSpectrumProviderClient,
  withPhotonDeliveryRuntimeProgress,
} from "./provider/clients.ts";
import { createConnectionManager, type ProviderConstructors } from "./provider/connection.ts";
import { resolveLineCredential, type LineCredentialAcquirer, type TrustedLineAddress } from "./provider/credentials.ts";
import type { ProviderLine } from "./provider/capabilities.ts";
import { createProviderLineOwnership, type ProviderLineOwnershipOptions } from "./provider/line-owner.ts";
import { createPhotonCoreHttpFactory, type PhotonCoreHttpFactory } from "./http.ts";
import type { PhotonQmClientDeps } from "./qm-client.ts";

type DeliverableOperation = Exclude<PhotonPresentationOperation, { name: "message.text.stream" }>;
type Materialize = (reference: OutboundAttachmentReference) => Promise<Uint8Array>;

export interface PhotonAdapterCompositionDeps {
  stores: PhotonStateStores;
  core: PhotonQmClientDeps;
  acquireCredential: LineCredentialAcquirer;
  trustedAddress: TrustedLineAddress;
  materialize: Materialize;
  constructors?: ProviderConstructors;
  ownership?: ProviderLineOwnershipOptions;
  now?: () => number;
  dispatchLeaseMs?: number;
  dispatchOwnerId?: () => string;
}

export interface PhotonAdapterConnection {
  readonly line: ProviderLine;
  readonly core: PhotonCoreHttpFactory;
  start(onInput: (input: NormalizedPhotonInput) => Promise<void>): Promise<void>;
  dispatch(operation: DeliverableOperation): Promise<PhotonOperationOutcome>;
  stop(): Promise<void>;
}

export type PhotonAdapterConnectionResult =
  { kind: "ready"; connection: PhotonAdapterConnection } | { kind: "unavailable"; code: string };

export interface PhotonAdapterComposition {
  connect(line: ProviderLine): Promise<PhotonAdapterConnectionResult>;
  stop(): Promise<void>;
}

function timestamp(milliseconds: number, label: string): string {
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return new Date(milliseconds).toISOString();
}

function exactClaim(
  left: { ownerId: string; fence: number; leaseExpiresAt: string } | undefined,
  right: { ownerId: string; fence: number; leaseExpiresAt: string },
): boolean {
  return left?.ownerId === right.ownerId && left.fence === right.fence && left.leaseExpiresAt === right.leaseExpiresAt;
}

function exactAttempt(left: PhotonPresentationOperation, right: PhotonPresentationOperation): boolean {
  return (
    left.operationId === right.operationId &&
    left.attemptId === right.attemptId &&
    left.name === right.name &&
    left.idempotencyKey === right.idempotencyKey &&
    left.conversation.provider === right.conversation.provider &&
    left.conversation.installationId === right.conversation.installationId &&
    left.conversation.lineId === right.conversation.lineId &&
    left.conversation.conversationId === right.conversation.conversationId
  );
}

function unsupported(operation: DeliverableOperation, reason: string): PhotonOperationOutcome {
  return {
    kind: "unsupported",
    operation: {
      operationId: operation.operationId,
      name: operation.name,
      conversation: operation.conversation,
      idempotencyKey: operation.idempotencyKey,
    },
    capability: operation.name,
    reason,
  };
}

function deliverAdvanced(
  client: AdvancedIMessageProviderClientPort,
  dispatch: PhotonDeliveryDispatch<DeliverableOperation>,
): Promise<PhotonOperationOutcome> {
  const operation = dispatch.operation;
  switch (operation.name) {
    case "message.text":
      return client.sendText(operation);
    case "message.markdown":
      return client.sendMarkdown(operation);
    case "message.link":
      return client.sendLink(operation);
    case "message.multipart":
      return client.sendMultipart({ ...dispatch, operation });
    case "message.attachment":
      return client.sendAttachment(operation);
    case "message.voice":
      return client.sendVoice(operation);
    case "message.contact":
      return client.shareContact(operation);
    case "message.poll.create":
      return client.createPoll(operation);
    case "message.poll.vote":
      return client.votePoll(operation);
    case "message.poll.unvote":
      return client.unvotePoll(operation);
    case "message.poll.add-option":
      return client.addPollOption(operation);
    case "message.app.send":
      return client.sendAppCard(operation);
    case "message.app.update":
      return client.updateAppCard(operation);
    case "message.react":
      return client.react(operation);
    case "message.edit":
      return operation.input.content.kind === "text"
        ? client.edit({ ...operation, input: { ...operation.input, content: operation.input.content } })
        : Promise.resolve(unsupported(operation, "text-edit-only"));
    case "message.unsend":
      return client.unsend(operation);
    case "conversation.typing":
      return client.setTyping(operation);
    case "conversation.read":
      return client.markRead(operation);
    case "conversation.rename":
      return client.renameConversation(operation);
    case "conversation.avatar.set":
      return client.setConversationAvatar(operation);
    case "conversation.avatar.clear":
      return client.clearConversationAvatar(operation);
    case "conversation.membership.add":
    case "conversation.membership.remove":
      return client.changeMembership(operation);
    case "conversation.membership.leave":
      return client.changeMembership(operation);
  }
}

export function createPhotonAdapterComposition(deps: PhotonAdapterCompositionDeps): PhotonAdapterComposition {
  const dispatchLeaseMs = deps.dispatchLeaseMs ?? 30_000;
  if (!Number.isSafeInteger(dispatchLeaseMs) || dispatchLeaseMs <= 0) {
    throw new TypeError("dispatchLeaseMs is invalid");
  }
  const wallNow = deps.now ?? Date.now;
  const ownerId = deps.dispatchOwnerId ?? randomUUID;
  const ownership = createProviderLineOwnership(deps.stores.lineOwners, {
    ...deps.ownership,
    wallNow,
  });
  const manager = createConnectionManager(deps.constructors, ownership);
  const core = createPhotonCoreHttpFactory(deps.core);

  return {
    async connect(line) {
      const credential = await resolveLineCredential({
        line,
        acquire: deps.acquireCredential,
        trustedAddress: deps.trustedAddress,
        now: wallNow,
      });
      if (credential.kind !== "ready") return credential;
      const providerConnection = await manager.replace(line, {
        address: credential.credential.address,
        token: credential.credential.token,
      });
      const advanced =
        providerConnection.kind === "advanced"
          ? createAdvancedProviderClient(providerConnection, deps.materialize)
          : undefined;
      const spectrum =
        providerConnection.kind === "spectrum"
          ? createSpectrumProviderClient(providerConnection, deps.stores.receipts, deps.materialize)
          : undefined;
      const progress: PhotonDeliveryProgressPort = {
        async assertCanContinue(operation, claim, logicalPartIndex, now) {
          providerConnection.assertActive();
          const current = await deps.stores.deliveries.read(operation);
          const part = current?.parts.find((candidate) => candidate.partIndex === logicalPartIndex);
          if (
            current?.state !== "dispatched" ||
            !exactAttempt(current.operation, operation) ||
            !exactClaim(current.dispatchClaim, claim) ||
            Date.parse(claim.leaseExpiresAt) <= Date.parse(now) ||
            part?.state !== "dispatched" ||
            part.dispatchFence !== claim.fence
          ) {
            throw new Error("PHOTON_DISPATCH_AUTHORITY_LOST");
          }
        },
        async recordConfirmedPart(operation, claim, logicalPartIndex, part, now) {
          providerConnection.assertActive();
          const recorded = await deps.stores.deliveries.recordConfirmedPart(
            operation,
            claim,
            logicalPartIndex,
            part,
            now,
          );
          if (recorded === undefined) throw new Error("PHOTON_DURABLE_PART_CHECKPOINT_FAILED");
        },
      };

      return {
        kind: "ready",
        connection: {
          line,
          core,
          start(onInput) {
            if (!spectrum) return Promise.reject(new Error("PHOTON_INBOUND_UNAVAILABLE"));
            return spectrum.start(onInput);
          },
          async dispatch(operation) {
            const reserved = await deps.stores.deliveries.reserve(operation);
            if (reserved === "conflict") throw new Error("PHOTON_DELIVERY_CONFLICT");
            let current = await deps.stores.deliveries.read(operation);
            if (!current) throw new Error("PHOTON_DELIVERY_STATE_MISSING");
            if (current.outcome) return current.outcome;
            if (current.state === "failed") {
              current = await deps.stores.deliveries.retry(operation, current.version);
              if (!current) throw new Error("PHOTON_DELIVERY_RETRY_REJECTED");
            }
            if (current.state !== "reserved" || !exactAttempt(current.operation, operation)) {
              throw new Error("PHOTON_DELIVERY_NOT_DISPATCHABLE");
            }
            const startedAt = wallNow();
            const claimed = await deps.stores.deliveries.acquireDispatch(
              operation,
              current.version,
              ownerId(),
              timestamp(startedAt, "dispatchNow"),
              timestamp(startedAt + dispatchLeaseMs, "dispatchLeaseExpiresAt"),
            );
            if (!claimed?.dispatchClaim) throw new Error("PHOTON_DELIVERY_CLAIM_REJECTED");
            const dispatch: PhotonDeliveryDispatch<DeliverableOperation> = {
              operation,
              logicalPartIndexes: claimed.parts
                .filter((part) => part.state !== "confirmed")
                .map((part) => part.partIndex),
              confirmedParts: claimed.parts.flatMap((part) =>
                part.state === "confirmed" && part.providerPart
                  ? [{ logicalPartIndex: part.partIndex, part: part.providerPart }]
                  : [],
              ),
            };
            const runtimeDispatch = withPhotonDeliveryRuntimeProgress(dispatch, {
              port: progress,
              claim: claimed.dispatchClaim,
              now: () => timestamp(wallNow(), "dispatchNow"),
            });
            const outcome = spectrum
              ? await spectrum.deliver(runtimeDispatch)
              : await deliverAdvanced(advanced!, runtimeDispatch);
            const completed = await deps.stores.deliveries.complete(
              operation,
              claimed.dispatchClaim,
              outcome,
              timestamp(wallNow(), "dispatchNow"),
            );
            if (!completed) throw new Error("PHOTON_DELIVERY_COMPLETION_AMBIGUOUS");
            return outcome;
          },
          stop() {
            return manager.stop();
          },
        },
      };
    },
    stop() {
      return manager.stop();
    },
  };
}
