import {
  PHOTON_PRESENTATION_OPERATIONS,
  type ConversationReference,
  type LineReference,
  type PhotonPresentationOperation,
  type PhotonPresentationOperationName,
} from "../../../chassis/src/photon-contract.ts";

export interface ProviderLine {
  readonly reference: LineReference;
  readonly phone: string;
  readonly kind: "dedicated" | "shared";
}

export const PROVIDER_VERSIONS = { spectrum: "12.8.0", advanced: "2.1.0" } as const;

export const METHOD_MATRIX = PHOTON_PRESENTATION_OPERATIONS.map((name) => ({
  name,
  spectrum: spectrumRestriction(name) ?? "public-method",
  advanced: advancedRestriction(name) ?? "public-method",
  evidence: "installed-declarations" as const,
  device: "unverified" as const,
}));

function spectrumRestriction(name: PhotonPresentationOperationName): string | undefined {
  if (name.startsWith("message.poll.")) return "native-poll-identifiers-not-public";
  if (name === "message.app.update") return "restart-safe-card-target-not-public";
  if (name === "message.edit" || name === "message.unsend") return "restart-safe-outbound-target-not-public";
  return undefined;
}

function advancedRestriction(name: PhotonPresentationOperationName): string | undefined {
  if (name === "message.markdown") return "markdown-renderer-not-public";
  if (name === "message.text.stream") return "streaming-not-public";
  if (name === "message.contact") return "arbitrary-vcard-not-public";
  return undefined;
}

export function sameConversation(a: ConversationReference, b: ConversationReference): boolean {
  return sameLine(a, b) && a.conversationId === b.conversationId;
}

export function sameLine(a: LineReference, b: LineReference): boolean {
  return a.provider === b.provider && a.installationId === b.installationId && a.lineId === b.lineId;
}

export function operationRestriction(line: ProviderLine, operation: PhotonPresentationOperation): string | undefined {
  if (!sameLine(line.reference, operation.conversation)) return "foreign-provider-installation-or-line";
  const provider = line.reference.provider;
  const restriction =
    provider === "spectrum-imessage" ? spectrumRestriction(operation.name) : advancedRestriction(operation.name);
  if (restriction) return restriction;
  if (
    operation.name.startsWith("conversation.") &&
    operation.name !== "conversation.read" &&
    operation.name !== "conversation.typing" &&
    line.kind !== "dedicated"
  )
    return "dedicated-line-required";
  if (provider === "spectrum-imessage" && operation.name === "message.react" && operation.input.action === "remove")
    return "reaction-removal-not-public";
  if (provider === "spectrum-imessage" && "enableLinkPreview" in operation.input)
    return "explicit-link-preview-option-not-public";
  if (provider === "advanced-imessage" && operation.name === "message.edit" && operation.input.content.kind !== "text")
    return "text-edit-only";
  if (provider === "advanced-imessage" && operation.name === "conversation.read" && operation.input.target)
    return "chat-wide-read-only";
  if (
    operation.name === "message.multipart" &&
    provider === "advanced-imessage" &&
    operation.input.parts.some((part) => part.kind === "markdown" || (part.kind === "link" && part.preview))
  )
    return "multipart-format-or-preview-not-public";
  if (provider === "spectrum-imessage" && operation.name === "conversation.read" && !operation.input.target)
    return "message-read-target-required";
  return undefined;
}
