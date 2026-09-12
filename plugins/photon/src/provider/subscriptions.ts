import type { LiveEvent, Message as AdvancedMessage } from "@photon-ai/advanced-imessage/grpc";
import type { Message } from "spectrum-ts";
import type {
  ConversationReference,
  JsonObject,
  MessagePartIdentity,
  NormalizedPhotonInput,
  OrderedMessageContent,
  ProviderActorReference,
  ProviderEventIdentity,
} from "../../../chassis/src/photon-contract.ts";
import { sameConversation, type ProviderLine } from "./capabilities.ts";
import { narrowSpectrumMessage, narrowSpectrumSpace } from "./compatibility.ts";

export function plainDto(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function providerSequence(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("PROVIDER_SEQUENCE_UNREPRESENTABLE");
  return String(value);
}

export function normalizeAdvancedEvent(input: LiveEvent, line: ProviderLine): NormalizedPhotonInput {
  const sequence = providerSequence(input.sequence);
  const event: ProviderEventIdentity = {
    provider: line.reference.provider,
    installationId: line.reference.installationId,
    lineId: line.reference.lineId,
    eventId: sequence,
    sequence,
    occurredAt: input.occurredAt.toISOString(),
    direction: input.isFromMe ? "outbound" : "inbound",
  };
  const conversation: ConversationReference = { ...line.reference, conversationId: input.chatGuid };
  const actor: ProviderActorReference | undefined = input.actor
    ? { actorId: input.actor.address, providerAddress: input.actor.address, kind: input.isFromMe ? "agent" : "human" }
    : undefined;
  const base = { event, conversation, ...(actor ? { actor } : {}) };
  const unknown = (reason: string): NormalizedPhotonInput => ({
    ...base,
    kind: "unknown",
    rawType: input.type,
    reason,
    payload: plainDto(input),
  });
  const target =
    "messageGuid" in input
      ? {
          ...conversation,
          messageId: input.messageGuid,
          ...("targetPartIndex" in input && input.targetPartIndex !== undefined
            ? { partIndex: input.targetPartIndex }
            : {}),
        }
      : undefined;
  switch (input.type) {
    case "message.received": {
      const message = input.message;
      if (!message.chatGuids.includes(input.chatGuid)) return unknown("message-chat-scope-mismatch");
      if (
        input.isFromMe ||
        message.isFromMe ||
        message.isSystemMessage ||
        message.isServiceMessage ||
        message.itemType !== "normal" ||
        message.reactionTargetGuid
      )
        return unknown("non-human-message-record");
      const sender = message.sender;
      if (!sender?.address) return unknown("missing-human-sender");
      const content = advancedContent(message, conversation);
      if (!content) return unknown("ordered-message-parts-not-representable");
      if (message.threadOriginatorPart && !/^(0|[1-9]\d*)$/u.test(message.threadOriginatorPart))
        return unknown("reply-part-identity-not-representable");
      const replyGuid = message.replyTargetGuid ?? message.threadOriginatorGuid;
      const replyPart = Number(message.threadOriginatorPart ?? 0);
      if (!Number.isSafeInteger(replyPart)) return unknown("reply-part-identity-not-representable");
      return {
        event,
        conversation,
        kind: "message",
        actor: { actorId: sender.address, providerAddress: sender.address, kind: "human" },
        message: {
          conversation,
          messageId: message.guid,
          parts: content.map((part) =>
            part.kind === "text"
              ? part.part
              : { messageId: part.attachment.messageId, partIndex: part.attachment.partIndex },
          ),
        },
        content,
        ...(replyGuid ? { replyTo: { ...conversation, messageId: replyGuid, partIndex: replyPart } } : {}),
      };
    }
    case "message.edited":
      return {
        ...base,
        kind: "edit",
        target: { ...conversation, messageId: input.messageGuid },
        content: structuredClone(input.content),
      };
    case "message.unsent":
      return { ...base, kind: "unsend", target: { ...conversation, messageId: input.messageGuid } };
    case "message.read":
      return {
        event,
        ...(actor ? { actor } : {}),
        kind: "read",
        target: { kind: "message", message: { ...conversation, messageId: input.messageGuid } },
      };
    case "message.reactionAdded":
    case "message.reactionRemoved":
      if (!actor || !target) return unknown("reaction-actor-missing");
      return {
        ...base,
        kind: "reaction",
        actor,
        target,
        reaction: {
          action: input.type === "message.reactionAdded" ? "add" : "remove",
          value: input.reaction.emoji ?? input.reaction.kind,
        },
      };
    case "chat.markedRead":
      return { event, ...(actor ? { actor } : {}), kind: "read", target: { kind: "conversation", conversation } };
    case "group.changed": {
      const change = input.change;
      switch (change.type) {
        case "displayNameChanged":
          return { ...base, kind: "group", action: "renamed", displayName: change.displayName };
        case "iconChanged":
          return { ...base, kind: "group", action: "avatar-set" };
        case "iconRemoved":
          return { ...base, kind: "group", action: "avatar-cleared" };
        case "participantAdded":
        case "participantRemoved":
        case "participantLeft":
          return {
            ...base,
            kind: "membership",
            action: ({ participantAdded: "added", participantRemoved: "removed", participantLeft: "left" } as const)[
              change.type
            ],
            memberIds: [change.participant.address],
          };
      }
      break;
    }
    case "poll.changed": {
      const delta = input.delta;
      if (delta.type === "created" || delta.type === "optionAdded")
        return {
          ...base,
          kind: "poll",
          pollMessageGuid: input.pollMessageGuid,
          action: delta.type === "created" ? "created" : "option-added",
          title: delta.title,
          options: delta.options.map((option) => ({
            optionIdentifier: option.optionIdentifier,
            text: option.text,
            ...(option.creatorHandle ? { creatorId: option.creatorHandle } : {}),
          })),
        };
      return {
        ...base,
        kind: "poll",
        pollMessageGuid: input.pollMessageGuid,
        action: delta.type === "voted" ? "voted" : "unvoted",
        optionIdentifier: delta.optionIdentifier,
      };
    }
  }
  return unknown("event-family-not-in-frozen-contract");
}

function advancedContent(
  message: AdvancedMessage,
  conversation: ConversationReference,
): OrderedMessageContent[] | undefined {
  const attachments = message.content.attachments.filter((attachment) => !attachment.isHidden && !attachment.isSticker);
  const text = message.content.text ?? "";
  const segments = text.split("\uFFFC");
  if (attachments.length && segments.length !== attachments.length + 1 && text.length) return undefined;
  const content: OrderedMessageContent[] = [];
  function addText(value: string | undefined) {
    if (value)
      content.push({ kind: "text", text: value, part: { messageId: message.guid, partIndex: content.length } });
  }
  for (const [index, attachment] of attachments.entries()) {
    if (segments.length > 1) addText(segments[index]);
    content.push({
      kind: "attachment",
      attachment: {
        ...conversation,
        messageId: message.guid,
        partIndex: content.length,
        attachmentId: attachment.guid,
        providerReference: attachment.guid,
        fileName: attachment.fileName,
        mediaType: attachment.mimeType,
        byteLength: attachment.totalBytes,
      },
    });
  }
  addText(segments.length > 1 ? segments.at(-1) : text);
  if (message.partCount !== undefined && message.partCount !== content.length) return undefined;
  return content.length ? content : undefined;
}

export function spectrumPart(message: Message): MessagePartIdentity {
  const narrowed = narrowSpectrumMessage(message);
  return { messageId: narrowed.id, partIndex: narrowed.partIndex ?? 0 };
}

export function normalizeSpectrumMessage(message: Message, line: ProviderLine): NormalizedPhotonInput {
  if (message.platform !== "imessage") throw new Error("FOREIGN_SPECTRUM_PLATFORM");
  const narrowed = narrowSpectrumMessage(message);
  const space = narrowSpectrumSpace(message.space);
  if (space.phone !== line.phone) throw new Error("FOREIGN_SPECTRUM_LINE");
  const conversation: ConversationReference = { ...line.reference, conversationId: space.id };
  const event: ProviderEventIdentity = {
    provider: line.reference.provider,
    installationId: line.reference.installationId,
    lineId: line.reference.lineId,
    eventId: message.id,
    occurredAt: message.timestamp.toISOString(),
    direction: message.direction,
  };
  const actor: ProviderActorReference | undefined = message.sender
    ? { actorId: message.sender.id, kind: message.direction === "outbound" ? "agent" : "human" }
    : undefined;
  const base = { event, conversation, ...(actor ? { actor } : {}) };
  const unknown = (reason: string): NormalizedPhotonInput => ({
    ...base,
    kind: "unknown",
    rawType: message.content.type,
    reason,
  });
  const target = (value: Message) => {
    const targetSpace = narrowSpectrumSpace(value.space);
    if (
      targetSpace.phone !== line.phone ||
      !sameConversation(conversation, { ...line.reference, conversationId: targetSpace.id })
    )
      throw new Error("FOREIGN_SPECTRUM_TARGET");
    return { ...conversation, ...spectrumPart(value) };
  };
  const content = message.content;
  switch (content.type) {
    case "read":
      return {
        event,
        ...(actor ? { actor } : {}),
        kind: "read",
        target: { kind: "message", message: target(content.target) },
      };
    case "reaction":
      if (!actor) return unknown("reaction-actor-missing");
      return {
        ...base,
        kind: "reaction",
        actor,
        target: target(content.target),
        reaction: { action: "add", value: content.emoji },
      };
    case "rename":
      return { ...base, kind: "group", action: "renamed", displayName: content.displayName };
    case "avatar":
      return { ...base, kind: "group", action: content.action.kind === "clear" ? "avatar-cleared" : "avatar-set" };
    case "addMember":
    case "removeMember":
      return {
        ...base,
        kind: "membership",
        action: content.type === "addMember" ? "added" : "removed",
        memberIds: [...content.members],
      };
    case "leaveSpace":
      return actor
        ? { ...base, kind: "membership", action: "left", memberIds: [actor.actorId] }
        : unknown("leaver-missing");
    case "poll":
    case "poll_option":
      return {
        ...base,
        kind: "unknown",
        rawType: content.type,
        reason: "native-poll-identifiers-not-public",
        payload: plainDto(content),
      };
  }
  if (
    !actor ||
    actor.kind !== "human" ||
    message.direction !== "inbound" ||
    narrowed.isSystemMessage ||
    narrowed.isServiceMessage
  )
    return unknown("non-human-message-record");
  const unwrapped = content.type === "reply" ? content.content : content;
  const items = unwrapped.type === "group" ? unwrapped.items : [message];
  const ordered: OrderedMessageContent[] = [];
  for (const item of items) {
    const itemContent = item === message ? unwrapped : item.content;
    const part = spectrumPart(item);
    if (narrowSpectrumSpace(item.space).phone !== line.phone || item.space.id !== conversation.conversationId)
      return unknown("foreign-group-part");
    if (itemContent.type === "text") ordered.push({ kind: "text", part, text: itemContent.text });
    else if (itemContent.type === "attachment" || itemContent.type === "voice") {
      if (!itemContent.id) return unknown("attachment-identity-missing");
      ordered.push({
        kind: "attachment",
        attachment: {
          ...conversation,
          ...part,
          attachmentId: itemContent.id,
          providerReference: itemContent.id,
          mediaType: itemContent.mimeType,
          ...(itemContent.name ? { fileName: itemContent.name } : {}),
          ...(itemContent.size !== undefined ? { byteLength: itemContent.size } : {}),
        },
      });
    } else return unknown("content-not-in-frozen-message-contract");
  }
  return {
    event,
    conversation,
    kind: "message",
    actor: { ...actor, kind: "human" },
    message: {
      conversation,
      messageId: message.id,
      parts: ordered.map((part) =>
        part.kind === "text"
          ? part.part
          : { messageId: part.attachment.messageId, partIndex: part.attachment.partIndex },
      ),
    },
    content: ordered,
    ...(content.type === "reply" ? { replyTo: target(content.target) } : {}),
  };
}
