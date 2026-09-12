import { Spectrum, type Attachment, type Message, type Space } from "spectrum-ts";
import { imessage, type IMessageMessage } from "spectrum-ts/providers/imessage";
import { createClient, type AdvancedIMessage, type ClientOptions } from "@photon-ai/advanced-imessage/grpc";

export type AdvancedClient = AdvancedIMessage;
export interface SpectrumApp {
  readonly messages: AsyncIterable<[Space, Message]>;
  stop(): Promise<void>;
}

export type SpectrumSpace = Space & { phone: string; type: "dm" | "group" };
export type SpectrumMessage = Message & Omit<IMessageMessage, "space" | "sender" | "direction">;

export interface SpectrumIMessage {
  space: {
    get(id: string, params: { phone: string }): Promise<SpectrumSpace>;
    create(users: string[], params: { phone: string }): Promise<SpectrumSpace>;
  };
  getMessage(space: SpectrumSpace, id: string): Promise<SpectrumMessage | undefined>;
  getAttachment(guid: string, phone: string): Promise<Attachment | undefined>;
}

export async function constructSpectrum(client: {
  address: string;
  token: string;
  phone: string;
}): Promise<SpectrumApp> {
  const provider: unknown = Reflect.apply(imessage.config, imessage, [{ clients: [client] }]);
  const app: unknown = await Reflect.apply(Spectrum, undefined, [
    { providers: [provider], telemetry: false, options: { flattenGroups: false, logLevel: "silent" } },
  ]);
  if (
    !app ||
    typeof app !== "object" ||
    !("stop" in app) ||
    typeof app.stop !== "function" ||
    !("messages" in app) ||
    !app.messages ||
    typeof app.messages !== "object" ||
    !(Symbol.asyncIterator in app.messages)
  )
    throw new Error("SPECTRUM_RUNTIME_INCOMPATIBLE");
  return app as SpectrumApp;
}

export function narrowSpectrum(app: SpectrumApp): SpectrumIMessage {
  const narrowed: unknown = Reflect.apply(imessage, undefined, [app]);
  if (
    !narrowed ||
    typeof narrowed !== "object" ||
    !("space" in narrowed) ||
    !narrowed.space ||
    typeof narrowed.space !== "object" ||
    !("get" in narrowed.space) ||
    typeof narrowed.space.get !== "function" ||
    !("create" in narrowed.space) ||
    typeof narrowed.space.create !== "function" ||
    !("getMessage" in narrowed) ||
    typeof narrowed.getMessage !== "function" ||
    !("getAttachment" in narrowed) ||
    typeof narrowed.getAttachment !== "function"
  )
    throw new Error("SPECTRUM_NARROWING_INCOMPATIBLE");
  return narrowed as SpectrumIMessage;
}

export function narrowSpectrumSpace(space: Space): SpectrumSpace {
  const narrowed: unknown = Reflect.apply(imessage, undefined, [space]);
  if (
    !narrowed ||
    typeof narrowed !== "object" ||
    !("phone" in narrowed) ||
    typeof narrowed.phone !== "string" ||
    !("type" in narrowed) ||
    (narrowed.type !== "dm" && narrowed.type !== "group")
  )
    throw new Error("SPECTRUM_SPACE_INCOMPATIBLE");
  return narrowed as SpectrumSpace;
}

export function narrowSpectrumMessage(message: Message): SpectrumMessage {
  const narrowed: unknown = Reflect.apply(imessage, undefined, [message]);
  if (
    !narrowed ||
    typeof narrowed !== "object" ||
    !("id" in narrowed) ||
    typeof narrowed.id !== "string" ||
    ("partIndex" in narrowed &&
      narrowed.partIndex !== undefined &&
      (!Number.isSafeInteger(narrowed.partIndex) || Number(narrowed.partIndex) < 0))
  )
    throw new Error("SPECTRUM_MESSAGE_INCOMPATIBLE");
  return narrowed as SpectrumMessage;
}

export function constructAdvanced(options: Pick<ClientOptions, "address" | "token">): AdvancedClient {
  return createClient({ ...options, tls: true, retry: false, autoIdempotency: false, timeout: 30_000 });
}

export const PUBLIC_DECLARATION_CHECKS = {
  advancedTextOptions: {
    clientMessageId: "logical-write",
    replyTo: { guid: "target", partIndex: 1 },
  } satisfies NonNullable<Parameters<AdvancedClient["messages"]["sendText"]>[2]>,
  advancedReactionOptions: { clientMessageId: "logical-write", partIndex: 1 } satisfies NonNullable<
    Parameters<AdvancedClient["messages"]["setReaction"]>[4]
  >,
  advancedCatchUpCursor: 1 satisfies NonNullable<Parameters<AdvancedClient["events"]["catchUp"]>[0]>,
  spectrumDeclarationCompatible: false,
  spectrumHasPublicClient: false,
};
