import { createHash } from "node:crypto";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  type Chat,
  type CustomizedMiniAppMessage,
  type Message as AdvancedMessage,
  type Poll,
  type SendOptions,
} from "@photon-ai/advanced-imessage/grpc";
import {
  app,
  attachment,
  contact,
  fromVCard,
  markdown,
  reply,
  richlink,
  text,
  voice,
  type ContentInput,
  type Message,
} from "spectrum-ts";
import { effect } from "spectrum-ts/providers/imessage";
import {
  parsePhotonOperationOutcome,
  parsePhotonPresentationOperation,
  type AttachmentReference,
  type ConfirmedMessagePart,
  type ConversationReference,
  type MessageTargetReference,
  type OutboundAttachmentReference,
  type PhotonAppCardSpec,
  type PhotonOperationOutcome,
  type PhotonOperationReference,
  type PhotonPresentationOperation,
  type PhotonProviderReceipt,
} from "../../../chassis/src/photon-contract.ts";
import type {
  AdvancedIMessageProviderClientPort,
  EventReceiptStorePort,
  PhotonDeliveryDispatch,
  SpectrumProviderClientPort,
} from "../ports.ts";
import { operationRestriction, sameConversation, sameLine } from "./capabilities.ts";
import type { ProviderConnection } from "./connection.ts";
import { narrowSpectrum, narrowSpectrumMessage, narrowSpectrumSpace } from "./compatibility.ts";
import { startProviderIntake } from "./recovery.ts";
import { spectrumPart } from "./subscriptions.ts";

type Operation<Name extends PhotonPresentationOperation["name"]> = Extract<PhotonPresentationOperation, { name: Name }>;
type Success = Extract<PhotonOperationOutcome, { kind: "confirmed-message" | "confirmed-no-message" }>;
type Unconfirmed = Exclude<PhotonOperationOutcome, Success>;
type Materialize = (reference: OutboundAttachmentReference) => Promise<Uint8Array>;

export function operationReference(operation: PhotonPresentationOperation): PhotonOperationReference {
  return {
    operationId: operation.operationId,
    name: operation.name,
    conversation: structuredClone(operation.conversation),
    idempotencyKey: operation.idempotencyKey,
  };
}

function unsupported(
  operation: PhotonPresentationOperation,
  reason: string,
): Extract<Unconfirmed, { kind: "unsupported" }> {
  return { kind: "unsupported", operation: operationReference(operation), capability: operation.name, reason };
}

function ambiguous(
  operation: PhotonPresentationOperation,
  confirmedParts: readonly ConfirmedMessagePart[] = [],
): Extract<Unconfirmed, { kind: "ambiguous" }> {
  return {
    kind: "ambiguous",
    operation: operationReference(operation),
    reconciliationKey: writeKey(operation),
    confirmedParts,
  };
}

function writeKey(operation: PhotonPresentationOperation, indexes?: readonly number[]): string {
  const scope = operation.conversation;
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.provider,
        scope.installationId,
        scope.lineId,
        scope.conversationId,
        operation.idempotencyKey,
        indexes ?? null,
      ]),
    )
    .digest("hex");
}

function runner(connection: ProviderConnection) {
  return async function run<T extends Success>(
    operation: PhotonPresentationOperation,
    send: () => Promise<T>,
    confirmedParts: readonly ConfirmedMessagePart[] = [],
  ): Promise<T | Unconfirmed> {
    try {
      parsePhotonPresentationOperation(operation);
      connection.assertActive();
    } catch {
      return {
        kind: "failed",
        operation: operationReference(operation),
        code: "INVALID_OPERATION_OR_STOPPED_CONNECTION",
        retryable: false,
        confirmedParts,
      };
    }
    const restriction = operationRestriction(connection.line, operation);
    if (restriction) return unsupported(operation, restriction);
    try {
      const result = await send();
      parsePhotonOperationOutcome(result);
      return result;
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof NotFoundError ||
        error instanceof RateLimitError ||
        error instanceof ValidationError
      )
        return {
          kind: "failed",
          operation: operationReference(operation),
          code: error.code,
          retryable: error.retryable,
          confirmedParts,
        };
      return ambiguous(operation, confirmedParts);
    }
  };
}

function messageResult(
  operation: PhotonPresentationOperation,
  result: AdvancedMessage,
  indexes: readonly number[] = [0],
  prior: readonly ConfirmedMessagePart[] = [],
): Extract<Success, { kind: "confirmed-message" }> {
  if (!result?.guid || !result.isFromMe || !result.chatGuids.includes(operation.conversation.conversationId))
    throw new Error("MESSAGE_RECEIPT_MISSING_OR_FOREIGN");
  if (operation.name === "message.edit" && result.guid !== operation.input.target.messageId)
    throw new Error("FOREIGN_EDIT_RESULT");
  if (result.partCount !== undefined && result.partCount !== indexes.length && operation.name !== "message.edit")
    throw new Error("MESSAGE_PART_RECEIPT_MISMATCH");
  const parts = [
    ...prior,
    ...indexes.map((logicalPartIndex, index) => {
      const partIndex = operation.name === "message.edit" ? (operation.input.target.partIndex ?? 0) : index;
      if (result.partCount !== undefined && partIndex >= result.partCount)
        throw new Error("MESSAGE_PART_RECEIPT_MISMATCH");
      return { logicalPartIndex, part: { ...operation.conversation, messageId: result.guid, partIndex } };
    }),
  ].sort((a, b) => a.logicalPartIndex - b.logicalPartIndex);
  return {
    kind: "confirmed-message",
    operation: operationReference(operation),
    message: {
      conversation: operation.conversation,
      messageId: result.guid,
      parts: parts.map(({ part }) => ({ messageId: part.messageId, partIndex: part.partIndex })),
    },
    confirmedParts: parts,
  };
}

function voidResult(operation: PhotonPresentationOperation) {
  return { kind: "confirmed-no-message" as const, operation: operationReference(operation) };
}

function pollReceipt(
  operation: PhotonPresentationOperation,
  poll: Poll,
): Extract<PhotonProviderReceipt, { receiptType: "poll" }> {
  if (
    !poll ||
    poll.chatGuid !== operation.conversation.conversationId ||
    !poll.pollMessageGuid ||
    ("pollMessageGuid" in operation.input && operation.input.pollMessageGuid !== poll.pollMessageGuid)
  )
    throw new Error("FOREIGN_POLL_RECEIPT");
  return {
    receiptType: "poll",
    pollMessageGuid: poll.pollMessageGuid,
    optionIdentifiers: poll.options.map((option) => option.optionIdentifier),
  };
}

function chatResult(operation: PhotonPresentationOperation, chat: Chat) {
  if (!chat || chat.guid !== operation.conversation.conversationId) throw new Error("FOREIGN_CHAT_RECEIPT");
  return {
    ...voidResult(operation),
    providerReceipt: {
      receiptType: "chat" as const,
      chatGuid: chat.guid,
      participantIds: chat.participants.map((participant) => participant.address),
      ...(chat.displayName ? { displayName: chat.displayName } : {}),
    },
  };
}

function validateDispatch(dispatch: PhotonDeliveryDispatch): void {
  const count = dispatch.operation.name === "message.multipart" ? dispatch.operation.input.parts.length : 1;
  const selected = new Set(dispatch.logicalPartIndexes);
  const confirmed = new Set(dispatch.confirmedParts.map((part) => part.logicalPartIndex));
  if (
    !selected.size ||
    selected.size !== dispatch.logicalPartIndexes.length ||
    confirmed.size !== dispatch.confirmedParts.length ||
    selected.size + confirmed.size !== count
  )
    throw new Error("INVALID_DISPATCH_PARTS");
  for (const index of [...selected, ...confirmed])
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || (selected.has(index) && confirmed.has(index)))
      throw new Error("INVALID_DISPATCH_PARTS");
  for (const part of dispatch.confirmedParts)
    if (!sameConversation(part.part, dispatch.operation.conversation)) throw new Error("FOREIGN_CONFIRMED_PART");
}

export function createAdvancedProviderClient(
  connection: Extract<ProviderConnection, { kind: "advanced" }>,
  materialize: Materialize,
): AdvancedIMessageProviderClientPort {
  const sdk = connection.sdk;
  const run = runner(connection);
  const options = (operation: PhotonPresentationOperation): SendOptions => ({
    clientMessageId: writeKey(operation),
    ...("replyTo" in operation.input && operation.input.replyTo
      ? { replyTo: { guid: operation.input.replyTo.messageId, partIndex: operation.input.replyTo.partIndex } }
      : {}),
    ...("effect" in operation.input && operation.input.effect ? { effect: operation.input.effect } : {}),
  });
  async function prepare(operation: PhotonPresentationOperation) {
    const chat = await sdk.chats.get(operation.conversation.conversationId);
    if (chat.guid !== operation.conversation.conversationId) throw new Error("FOREIGN_CHAT");
    if (
      operation.name.startsWith("conversation.") &&
      operation.name !== "conversation.read" &&
      operation.name !== "conversation.typing" &&
      !chat.isGroup
    )
      throw new ValidationError("Group required", { code: "operationNotSupported", retryable: false, grpcCode: 3 });
    let targetReference: MessageTargetReference | undefined;
    if ("target" in operation.input) targetReference = operation.input.target;
    if ("replyTo" in operation.input) targetReference = operation.input.replyTo;
    if (targetReference) {
      const target = await sdk.messages.get(targetReference.messageId);
      if (target.guid !== targetReference.messageId || !target.chatGuids.includes(chat.guid))
        throw new Error("FOREIGN_TARGET_MESSAGE");
      if (
        targetReference.partIndex !== undefined &&
        target.partCount !== undefined &&
        targetReference.partIndex >= target.partCount
      )
        throw new Error("TARGET_PART_NOT_FOUND");
      if ((operation.name === "message.edit" || operation.name === "message.unsend") && !target.isFromMe)
        throw new Error("TARGET_NOT_FROM_THIS_ACCOUNT");
    }
    connection.assertActive();
  }
  async function getPoll(conversation: ConversationReference, pollMessageGuid: string) {
    connection.assertActive();
    if (!sameLine(conversation, connection.line.reference)) throw new Error("FOREIGN_POLL_LINE");
    const result = await sdk.polls.get(pollMessageGuid);
    if (result.chatGuid !== conversation.conversationId || result.pollMessageGuid !== pollMessageGuid)
      throw new Error("FOREIGN_POLL_STATE");
    return structuredClone(result);
  }
  async function card(app: PhotonAppCardSpec): Promise<CustomizedMiniAppMessage> {
    if (app.provider !== "advanced-imessage") throw new Error("FOREIGN_CARD_PROVIDER");
    const { cardId: _cardId, provider: _provider, layout, ...spec } = app;
    const { image, ...layoutText } = layout;
    return { ...spec, layout: { ...layoutText, ...(image ? { image: await materialize(image) } : {}) } };
  }
  function cardResult(
    operation: PhotonPresentationOperation,
    result: Awaited<ReturnType<typeof sdk.messages.sendCustomizedMiniApp>>,
  ) {
    const session = result?.miniAppCardSession;
    if (!session || session.chatGuid !== operation.conversation.conversationId || session.messageGuid !== result.guid)
      throw new Error("FOREIGN_OR_MISSING_CARD_SESSION");
    if (
      operation.name === "message.app.update" &&
      (session.sessionId !== operation.input.handle.session.sessionId ||
        session.targetMessageGuid !== operation.input.handle.session.targetMessageGuid)
    )
      throw new Error("CARD_SESSION_CHANGED");
    return {
      ...messageResult(operation, result),
      providerReceipt: { receiptType: "app-card" as const, session: structuredClone(session) },
    };
  }
  async function pollMutation(
    operation: Operation<"message.poll.vote" | "message.poll.unvote" | "message.poll.add-option">,
  ) {
    await getPoll(operation.conversation, operation.input.pollMessageGuid);
    connection.assertActive();
    const opts = { clientMessageId: writeKey(operation) };
    let result: Poll;
    if (operation.name === "message.poll.vote")
      result = await sdk.polls.vote(operation.input.pollMessageGuid, operation.input.optionIdentifier, opts);
    else if (operation.name === "message.poll.unvote")
      result = await sdk.polls.unvote(operation.input.pollMessageGuid, opts);
    else result = await sdk.polls.addOption(operation.input.pollMessageGuid, operation.input.text, opts);
    return { ...voidResult(operation), providerReceipt: pollReceipt(operation, result) };
  }
  function changeMembership(
    operation: Operation<"conversation.membership.add" | "conversation.membership.remove">,
  ): ReturnType<AdvancedIMessageProviderClientPort["renameConversation"]>;
  function changeMembership(
    operation: Operation<"conversation.membership.leave">,
  ): ReturnType<AdvancedIMessageProviderClientPort["unsend"]>;
  function changeMembership(
    operation: Operation<
      "conversation.membership.add" | "conversation.membership.remove" | "conversation.membership.leave"
    >,
  ) {
    return run(operation, async () => {
      await prepare(operation);
      if (operation.name === "conversation.membership.leave") {
        await sdk.groups.leave(operation.conversation.conversationId, { clientMessageId: writeKey(operation) });
        return voidResult(operation);
      }
      const result =
        operation.name === "conversation.membership.add"
          ? await sdk.groups.addParticipants(
              operation.conversation.conversationId,
              [...operation.input.participantIds],
              { clientMessageId: writeKey(operation) },
            )
          : await sdk.groups.removeParticipants(
              operation.conversation.conversationId,
              [...operation.input.participantIds],
              { clientMessageId: writeKey(operation) },
            );
      return chatResult(operation, result);
    });
  }
  return {
    sendText: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return messageResult(
          operation,
          await sdk.messages.sendText(operation.conversation.conversationId, operation.input.text, {
            ...options(operation),
            ...(operation.input.enableLinkPreview !== undefined
              ? { enableLinkPreview: operation.input.enableLinkPreview }
              : {}),
          }),
        );
      }),
    sendMarkdown: async (operation) => unsupported(operation, "markdown-renderer-not-public"),
    sendLink: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return messageResult(
          operation,
          await sdk.messages.sendText(operation.conversation.conversationId, operation.input.url, {
            ...options(operation),
            enableLinkPreview: operation.input.preview,
          }),
        );
      }),
    sendMultipart: (dispatch) =>
      run(
        dispatch.operation,
        async () => {
          validateDispatch(dispatch);
          const operation = dispatch.operation;
          const parts = dispatch.logicalPartIndexes.map((index, bubbleIndex) => {
            const part = operation.input.parts[index];
            if (!part) throw new Error("MISSING_PART");
            if (part.kind === "attachment") return { attachmentGuid: part.attachment.providerReference, bubbleIndex };
            if (part.kind === "text") return { text: part.text, bubbleIndex };
            if (part.kind === "link") return { text: part.url, bubbleIndex };
            throw new Error("UNSUPPORTED_PART");
          });
          await prepare(operation);
          const result = await sdk.messages.sendMultipart(operation.conversation.conversationId, parts, {
            ...options(operation),
            clientMessageId: writeKey(operation, dispatch.logicalPartIndexes),
          });
          return messageResult(operation, result, dispatch.logicalPartIndexes, dispatch.confirmedParts);
        },
        dispatch.confirmedParts,
      ),
    sendAttachment: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return messageResult(
          operation,
          await sdk.messages.sendAttachment(
            operation.conversation.conversationId,
            operation.input.attachment.providerReference,
            options(operation),
          ),
        );
      }),
    sendVoice: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return messageResult(
          operation,
          await sdk.messages.sendAttachment(
            operation.conversation.conversationId,
            operation.input.attachment.providerReference,
            { ...options(operation), isAudioMessage: true },
          ),
        );
      }),
    shareContact: async (operation) => unsupported(operation, "arbitrary-vcard-not-public"),
    getPoll,
    createPoll: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        const poll = await sdk.polls.create(
          operation.conversation.conversationId,
          operation.input.title,
          [...operation.input.options],
          { clientMessageId: writeKey(operation) },
        );
        const receipt = pollReceipt(operation, poll);
        const part = { ...operation.conversation, messageId: receipt.pollMessageGuid, partIndex: 0 };
        return {
          kind: "confirmed-message",
          operation: operationReference(operation),
          message: {
            conversation: operation.conversation,
            messageId: receipt.pollMessageGuid,
            parts: [{ messageId: receipt.pollMessageGuid, partIndex: 0 }],
          },
          confirmedParts: [{ logicalPartIndex: 0, part }],
          providerReceipt: receipt,
        };
      }),
    votePoll: (operation) => run(operation, () => pollMutation(operation)),
    unvotePoll: (operation) => run(operation, () => pollMutation(operation)),
    addPollOption: (operation) => run(operation, () => pollMutation(operation)),
    sendAppCard: (operation) =>
      run(operation, async () => {
        const content = await card(operation.input.app);
        await prepare(operation);
        return cardResult(
          operation,
          await sdk.messages.sendCustomizedMiniApp(operation.conversation.conversationId, content, {
            clientMessageId: writeKey(operation),
          }),
        );
      }),
    updateAppCard: (operation) =>
      run(operation, async () => {
        const content = await card(operation.input.app);
        await prepare(operation);
        return cardResult(
          operation,
          await sdk.messages.updateCustomizedMiniApp(operation.input.handle.session, content, {
            clientMessageId: writeKey(operation),
          }),
        );
      }),
    react: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return messageResult(
          operation,
          await sdk.messages.setReaction(
            operation.conversation.conversationId,
            operation.input.target.messageId,
            operation.input.reaction,
            operation.input.action === "add",
            {
              clientMessageId: writeKey(operation),
              ...(operation.input.target.partIndex !== undefined
                ? { partIndex: operation.input.target.partIndex }
                : {}),
            },
          ),
        );
      }),
    edit: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return messageResult(
          operation,
          await sdk.messages.edit(
            operation.conversation.conversationId,
            operation.input.target.messageId,
            operation.input.content.text,
            {
              clientMessageId: writeKey(operation),
              ...(operation.input.target.partIndex !== undefined
                ? { partIndex: operation.input.target.partIndex }
                : {}),
            },
          ),
        );
      }),
    unsend: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        await sdk.messages.unsend(operation.conversation.conversationId, operation.input.target.messageId, {
          clientMessageId: writeKey(operation),
          ...(operation.input.target.partIndex !== undefined ? { partIndex: operation.input.target.partIndex } : {}),
        });
        return voidResult(operation);
      }),
    setTyping: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        await sdk.chats.setTyping(operation.conversation.conversationId, operation.input.active);
        return voidResult(operation);
      }),
    markRead: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        await sdk.chats.markRead(operation.conversation.conversationId);
        return voidResult(operation);
      }),
    renameConversation: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        return chatResult(
          operation,
          await sdk.groups.setDisplayName(operation.conversation.conversationId, operation.input.title, {
            clientMessageId: writeKey(operation),
          }),
        );
      }),
    setConversationAvatar: (operation) =>
      run(operation, async () => {
        const bytes = await materialize(operation.input.attachment);
        await prepare(operation);
        await sdk.groups.setIcon(operation.conversation.conversationId, bytes, {
          clientMessageId: writeKey(operation),
        });
        return voidResult(operation);
      }),
    clearConversationAvatar: (operation) =>
      run(operation, async () => {
        await prepare(operation);
        await sdk.groups.removeIcon(operation.conversation.conversationId, { clientMessageId: writeKey(operation) });
        return voidResult(operation);
      }),
    changeMembership,
  };
}

function spectrumResult(
  operation: PhotonPresentationOperation,
  phone: string,
  messages: readonly (Message | undefined)[],
  indexes: readonly number[] = [0],
  prior: readonly ConfirmedMessagePart[] = [],
): Extract<Success, { kind: "confirmed-message" }> {
  const returned = messages.flatMap((message) => {
    if (message?.content.type === "group") return message.content.items;
    if (message?.content.type === "reply" && message.content.content.type === "group")
      return message.content.content.items;
    return [message];
  });
  if (returned.length !== indexes.length || returned.some((message) => !message?.id))
    throw new Error("MESSAGE_RECEIPT_MISSING");
  const parts: ConfirmedMessagePart[] = [...prior];
  for (const [offset, message] of returned.entries()) {
    if (
      !message ||
      message.platform !== "imessage" ||
      message.direction !== "outbound" ||
      message.space.id !== operation.conversation.conversationId ||
      narrowSpectrumSpace(message.space).phone !== phone
    )
      throw new Error("FOREIGN_MESSAGE_RECEIPT");
    const logicalPartIndex = indexes[offset];
    if (logicalPartIndex === undefined) throw new Error("UNEXPECTED_MESSAGE_PART");
    parts.push({ logicalPartIndex, part: { ...operation.conversation, ...spectrumPart(message) } });
  }
  parts.sort((a, b) => a.logicalPartIndex - b.logicalPartIndex);
  const first = messages[0];
  if (!first) throw new Error("MESSAGE_RECEIPT_MISSING");
  let providerReceipt: Extract<PhotonProviderReceipt, { receiptType: "app-card" }> | undefined;
  if (operation.name === "message.app.send") {
    const session = narrowSpectrumMessage(first).miniAppCardSession;
    if (!session || session.chatGuid !== operation.conversation.conversationId || session.messageGuid !== first.id)
      throw new Error("MISSING_OR_FOREIGN_CARD_SESSION");
    providerReceipt = { receiptType: "app-card", session: structuredClone(session) };
  }
  return {
    kind: "confirmed-message",
    operation: operationReference(operation),
    message: {
      conversation: operation.conversation,
      messageId: first.id,
      parts: parts.map(({ part }) => ({ messageId: part.messageId, partIndex: part.partIndex })),
    },
    confirmedParts: parts,
    ...(providerReceipt ? { providerReceipt } : {}),
  };
}

export function createSpectrumProviderClient(
  connection: Extract<ProviderConnection, { kind: "spectrum" }>,
  store: EventReceiptStorePort,
  materialize: Materialize,
): SpectrumProviderClientPort {
  const sdk = narrowSpectrum(connection.sdk);
  const run = runner(connection);
  let intake: Awaited<ReturnType<typeof startProviderIntake>> | undefined;
  let starting: Promise<void> | undefined;
  let intakeFailure: unknown;
  async function getSpace(conversation: ConversationReference) {
    connection.assertActive();
    if (!sameLine(conversation, connection.line.reference)) throw new Error("FOREIGN_SPECTRUM_LINE");
    const space = await sdk.space.get(conversation.conversationId, { phone: connection.line.phone });
    if (space.id !== conversation.conversationId || space.phone !== connection.line.phone)
      throw new Error("FOREIGN_SPECTRUM_SPACE");
    return space;
  }
  async function targetMessage(target: MessageTargetReference) {
    const space = await getSpace(target);
    const message = await sdk.getMessage(space, target.messageId);
    if (
      !message ||
      message.id !== target.messageId ||
      message.space.id !== target.conversationId ||
      narrowSpectrumSpace(message.space).phone !== connection.line.phone ||
      (target.partIndex !== undefined && spectrumPart(message).partIndex !== target.partIndex)
    )
      throw new Error("MISSING_OR_FOREIGN_MESSAGE_TARGET");
    return message;
  }
  async function decorate(operation: PhotonPresentationOperation, content: ContentInput) {
    let result = content;
    if ("replyTo" in operation.input && operation.input.replyTo)
      result = reply(result, await targetMessage(operation.input.replyTo));
    if ("effect" in operation.input && operation.input.effect) result = effect(result, operation.input.effect);
    return result;
  }
  async function file(reference: OutboundAttachmentReference, audio = false): Promise<ContentInput> {
    const bytes = Buffer.from(await materialize(reference));
    const options = {
      ...(reference.fileName ? { name: reference.fileName } : {}),
      ...(reference.mediaType ? { mimeType: reference.mediaType } : {}),
    };
    return audio ? voice(bytes, options) : attachment(bytes, options);
  }
  async function contentFor(operation: PhotonPresentationOperation): Promise<ContentInput> {
    switch (operation.name) {
      case "message.text":
        return text(operation.input.text);
      case "message.markdown":
        return markdown(operation.input.markdown);
      case "message.link":
        return operation.input.preview ? richlink(operation.input.url) : text(operation.input.url);
      case "message.attachment":
        return file(operation.input.attachment);
      case "message.voice":
        return file(operation.input.attachment, true);
      case "message.contact":
        return contact(fromVCard(operation.input.vcard));
      case "message.app.send":
        return app(
          operation.input.app.url,
          operation.input.app.live === undefined ? {} : { live: operation.input.app.live },
        );
      default:
        throw new Error("UNSUPPORTED_SPECTRUM_CONTENT");
    }
  }
  async function deliver(
    dispatch: Parameters<SpectrumProviderClientPort["deliver"]>[0],
  ): Promise<PhotonOperationOutcome> {
    const operation = dispatch.operation;
    const confirmedParts = [...dispatch.confirmedParts];
    return run(
      operation,
      async () => {
        if (intakeFailure) throw new Error("PROVIDER_INTAKE_FAILED");
        const space = await getSpace(operation.conversation);
        if (
          operation.name.startsWith("conversation.") &&
          operation.name !== "conversation.typing" &&
          operation.name !== "conversation.read" &&
          space.type !== "group"
        )
          throw new ValidationError("Group required", { code: "operationNotSupported", retryable: false, grpcCode: 3 });
        if (operation.name === "message.multipart") {
          validateDispatch(dispatch);
          const content = await Promise.all(
            dispatch.logicalPartIndexes.map(async (index) => {
              const part = operation.input.parts[index];
              if (!part) throw new Error("MISSING_PART");
              let value: ContentInput;
              if (part.kind === "text") value = text(part.text);
              else if (part.kind === "markdown") value = markdown(part.markdown);
              else if (part.kind === "link") value = part.preview ? richlink(part.url) : text(part.url);
              else value = await file(part.attachment);
              return decorate(operation, value);
            }),
          );
          const messages: Message[] = [];
          for (const [offset, part] of content.entries()) {
            const logicalPartIndex = dispatch.logicalPartIndexes[offset];
            if (logicalPartIndex === undefined) throw new Error("MISSING_DISPATCH_INDEX");
            connection.assertActive();
            const message = await space.send(part);
            const confirmed = spectrumResult(operation, connection.line.phone, [message], [logicalPartIndex]);
            confirmedParts.push(...confirmed.confirmedParts);
            if (message) messages.push(message);
          }
          return spectrumResult(
            operation,
            connection.line.phone,
            messages,
            dispatch.logicalPartIndexes,
            dispatch.confirmedParts,
          );
        }
        if (operation.name === "message.react") {
          const target = await targetMessage(operation.input.target);
          const reaction = operation.input.reaction;
          const emoji =
            reaction.kind === "emoji"
              ? reaction.emoji
              : { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" }[reaction.kind];
          connection.assertActive();
          return spectrumResult(operation, connection.line.phone, [await target.react(emoji)]);
        }
        if (operation.name.startsWith("conversation.")) {
          const name = operation.name;
          if (name === "conversation.read") {
            if (!operation.input.target) throw new Error("READ_TARGET_REQUIRED");
            const target = await targetMessage(operation.input.target);
            connection.assertActive();
            await target.read();
          } else if (name === "conversation.avatar.set") {
            const bytes = Buffer.from(await materialize(operation.input.attachment));
            if (!operation.input.attachment.mediaType) throw new Error("AVATAR_MEDIA_TYPE_REQUIRED");
            connection.assertActive();
            await space.avatar(bytes, { mimeType: operation.input.attachment.mediaType });
          } else {
            connection.assertActive();
            switch (operation.name) {
              case "conversation.typing":
                await (operation.input.active ? space.startTyping() : space.stopTyping());
                break;
              case "conversation.rename":
                await space.rename(operation.input.title);
                break;
              case "conversation.avatar.clear":
                await space.avatar("clear");
                break;
              case "conversation.membership.add":
                await space.add([...operation.input.participantIds]);
                break;
              case "conversation.membership.remove":
                await space.remove([...operation.input.participantIds]);
                break;
              case "conversation.membership.leave":
                await space.leave();
                break;
              default:
                throw new Error("UNSUPPORTED_CONVERSATION_OPERATION");
            }
          }
          return voidResult(operation);
        }
        validateDispatch(dispatch);
        const content = await decorate(operation, await contentFor(operation));
        connection.assertActive();
        return spectrumResult(operation, connection.line.phone, [await space.send(content)]);
      },
      confirmedParts,
    );
  }
  return {
    start(onInput) {
      starting ??= (async () => {
        intake = await startProviderIntake(connection, store, onInput);
        void intake.failure.catch((error: unknown) => {
          intakeFailure = error;
        });
        await intake.completion;
      })();
      return starting;
    },
    async stop() {
      await connection.stop();
      await starting?.catch(() => undefined);
    },
    async resolveConversation(line, participantIds) {
      connection.assertActive();
      if (
        !sameLine(line, connection.line.reference) ||
        !participantIds.length ||
        participantIds.some((id) => !id.trim())
      )
        throw new Error("INVALID_CONVERSATION_SCOPE");
      if (participantIds.length > 1 && connection.line.kind !== "dedicated") throw new Error("DEDICATED_LINE_REQUIRED");
      const space = await sdk.space.create([...participantIds], { phone: connection.line.phone });
      if (space.phone !== connection.line.phone) throw new Error("FOREIGN_RESOLVED_LINE");
      return { ...line, conversationId: space.id };
    },
    deliver,
    streamText(operation, chunks) {
      return run(operation, async () => {
        const space = await getSpace(operation.conversation);
        const content = await decorate(
          operation,
          operation.input.format === "markdown" ? markdown(chunks) : text(chunks),
        );
        connection.assertActive();
        return spectrumResult(operation, connection.line.phone, [await space.send(content)]);
      });
    },
    async fetchAttachment(reference: AttachmentReference) {
      const target = await targetMessage(reference);
      const narrowed = narrowSpectrumMessage(target);
      if (!narrowed.attachmentMetadata?.some((item) => item.guid === reference.attachmentId))
        throw new Error("ATTACHMENT_NOT_IN_SCOPED_MESSAGE");
      const result = await sdk.getAttachment(reference.attachmentId, connection.line.phone);
      if (!result || result.id !== reference.attachmentId) throw new Error("ATTACHMENT_NOT_FOUND");
      return result.read();
    },
  };
}

export async function observeAdvancedMessage(
  connection: Extract<ProviderConnection, { kind: "advanced" }>,
  target: MessageTargetReference,
) {
  connection.assertActive();
  if (!sameLine(target, connection.line.reference)) throw new Error("FOREIGN_OBSERVATION_LINE");
  const message = await connection.sdk.messages.get(target.messageId);
  if (!message || message.guid !== target.messageId || !message.chatGuids.includes(target.conversationId))
    throw new Error("FOREIGN_OBSERVATION_CHAT_OR_MESSAGE");
  return {
    kind: "inconclusive" as const,
    reason: "public-message-record-does-not-correlate-logical-operation",
    target: structuredClone(target),
    observation: {
      messageId: message.guid,
      isFromMe: message.isFromMe,
      isSent: message.isSent,
      isDelivered: message.isDelivered,
      ...(message.dateRead ? { readAt: message.dateRead.toISOString() } : {}),
      ...(message.dateEdited ? { editedAt: message.dateEdited.toISOString() } : {}),
      ...(message.dateRetracted ? { retractedAt: message.dateRetracted.toISOString() } : {}),
    },
  };
}
