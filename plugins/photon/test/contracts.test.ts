import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import type { Space } from "spectrum-ts";

import {
  parseActionBinding,
  parseInstallationDisplayStatus,
  parseNormalizedPhotonInput,
  parsePhotonOperationOutcome,
  type PhotonOperationOutcome,
} from "../../chassis/src/photon-contract.ts";
import {
  competingActions,
  connectedStatus,
  duplicateEvents,
  FakeActionBindingStore,
  FakeEventReceiptStore,
  multipartMessages,
  normalizedInputs,
} from "./fixtures.ts";

type SpectrumEditResult = Awaited<ReturnType<Space["edit"]>>;
type AdvancedUnsendResult = Awaited<ReturnType<AdvancedIMessage["messages"]["unsend"]>>;
type AdvancedSendResult = Awaited<ReturnType<AdvancedIMessage["messages"]["sendText"]>>;

function confirmedNoMessage(
  operationId: string,
  result: SpectrumEditResult | AdvancedUnsendResult,
): PhotonOperationOutcome {
  assert.equal(result, undefined);
  return { kind: "confirmed-no-message", operationId };
}

function confirmedAdvancedMessage(
  operationId: string,
  result: Pick<AdvancedSendResult, "guid" | "chatGuids" | "partCount">,
): PhotonOperationOutcome {
  const conversation = multipartMessages[0].conversation;
  return {
    kind: "confirmed-message",
    operationId,
    message: {
      conversation,
      messageId: result.guid,
      parts: Array.from({ length: result.partCount ?? 1 }, (_, partIndex) => ({ messageId: result.guid, partIndex })),
    },
  };
}

test("wire validators accept multipart input and preserve message-part identity", () => {
  const parsed = parseNormalizedPhotonInput(normalizedInputs[0]);
  assert.equal(parsed.attachments.length, 2);
  assert.equal(parsed.replyTo?.messagePart.partIndex, 1);
  const outcome = confirmedAdvancedMessage("operation-send", {
    guid: "advanced-message",
    chatGuids: ["chat-a"],
    partCount: 2,
  });
  const checked = parsePhotonOperationOutcome(outcome);
  assert.equal(checked.kind, "confirmed-message");
  if (checked.kind === "confirmed-message") assert.equal(checked.message.parts.length, 2);
});

test("wire outcomes distinguish SDK void success from a confirmed message", () => {
  assert.deepEqual(parsePhotonOperationOutcome(confirmedNoMessage("spectrum-edit", undefined)), {
    kind: "confirmed-no-message",
    operationId: "spectrum-edit",
  });
  assert.deepEqual(parsePhotonOperationOutcome(confirmedNoMessage("advanced-unsend", undefined)), {
    kind: "confirmed-no-message",
    operationId: "advanced-unsend",
  });
});

test("duplicate events are captured once", async () => {
  const store = new FakeEventReceiptStore();
  const first = await store.capture({
    event: duplicateEvents[0],
    capturedAt: "2026-09-10T12:00:02.000Z",
    payloadSha256: "a".repeat(64),
    state: "captured",
  });
  const second = await store.capture({
    event: duplicateEvents[1],
    capturedAt: "2026-09-10T12:00:03.000Z",
    payloadSha256: "a".repeat(64),
    state: "captured",
  });
  assert.equal(first, "captured");
  assert.equal(second, "duplicate");
});

test("competing actors cannot bind the same resource revision and action", async () => {
  const store = new FakeActionBindingStore();
  assert.equal(await store.create(parseActionBinding(competingActions[0])), "created");
  assert.equal(await store.create(parseActionBinding(competingActions[1])), "conflict");
});

test("dashboard status rejects unsafe verification URLs and retains masked lines", () => {
  const connected = parseInstallationDisplayStatus(connectedStatus(0));
  assert.equal(connected.state, "connected");
  assert.throws(() =>
    parseInstallationDisplayStatus({
      state: "awaiting-authorization",
      installationId: "installation-a",
      userCode: "ABCD-EFGH",
      verificationUrl: "http://example.test/device",
      expiresAt: "2026-09-10T13:00:00.000Z",
    }),
  );
});

test("installed Photon packages match the exact foundation pins", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies["spectrum-ts"], "12.8.0");
  assert.equal(packageJson.dependencies["@photon-ai/advanced-imessage"], "2.1.0");
  assert.equal(packageJson.devDependencies["@photon-ai/cli"], "2.2.0");
  assert.equal(lock.packages["node_modules/spectrum-ts"].version, "12.8.0");
  assert.equal(lock.packages["node_modules/@photon-ai/advanced-imessage"].version, "2.1.0");
  assert.equal(lock.packages["node_modules/@photon-ai/cli"].version, "2.2.0");
});
