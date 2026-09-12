import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  messageRevision,
  recordMessageRevisions,
  renderMessageRevision,
  type MessageRevisionPayload,
} from "../src/core/message-revisions.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

const scope = "personal:alice" as ScopeId;
const conversation = {
  provider: "advanced-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  conversationId: "any;-;+15555550101",
};
const providerMessage = { ...conversation, messageId: "message-1" };

async function seed(sessions: SessionStore, threadRef: string, payload: Record<string, unknown>) {
  const session = await sessions.getOrCreateByThread(threadRef, "dm", scope, undefined, "photon");
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  await sessions.append(lease!, { type: "user", payload, scopeLabel: scope });
  await sessions.releaseLease(lease!);
  return session;
}

function revisions(entries: readonly SessionEntry[]): MessageRevisionPayload[] {
  return entries.flatMap((entry) => {
    const revision = messageRevision(entry);
    return revision ? [revision] : [];
  });
}

describe("Photon message revisions", () => {
  it("leaves ordinary Slack revision behavior unchanged", async () => {
    const sessions = createMemorySessionStore();
    const session = await seed(sessions, "dm:D1", { text: "before", ts: "100.1", name: "Alice" });
    await recordMessageRevisions(sessions, [{ container: "D1", ts: "100.1", editedAt: Date.now(), text: "after" }], {
      attempts: 1,
      retryMs: 0,
    });
    assert.deepEqual(revisions(await sessions.getEntries(session.id)), [
      { kind: "message_revision", action: "edited", ts: "100.1", text: "after", name: "Alice" },
    ]);
  });

  it("records a supported iMessage edit with its full provider identity and unchanged revision rendering", async () => {
    const sessions = createMemorySessionStore();
    const threadRef = "photon-session-1";
    const session = await seed(sessions, threadRef, {
      text: "before",
      ts: providerMessage.messageId,
      providerMessage,
      name: "Alice",
    });
    const event = {
      container: "not-authority",
      ts: providerMessage.messageId,
      editedAt: Date.now(),
      text: "after",
      providerMessage,
    } as IngestEvent;
    await recordMessageRevisions(
      sessions,
      [event],
      { attempts: 1, retryMs: 0 },
      {
        surface: "photon",
        resolveThreadRefs: async (reference) =>
          reference.conversationId === conversation.conversationId ? [threadRef] : [],
      },
    );

    const recorded = revisions(await sessions.getEntries(session.id));
    assert.deepEqual(recorded, [
      {
        kind: "message_revision",
        action: "edited",
        ts: "message-1",
        text: "after",
        name: "Alice",
        providerMessage,
      },
    ]);
    assert.equal(
      renderMessageRevision(recorded[0]!),
      '<message-edited id="message-1" author="Alice">after</message-edited>',
    );
  });

  it("denies a foreign Photon revision even when its raw container collides with a registered thread", async () => {
    const sessions = createMemorySessionStore();
    const threadRef = "photon-session-1";
    const session = await seed(sessions, threadRef, {
      text: "before",
      ts: providerMessage.messageId,
      providerMessage,
      name: "Alice",
    });
    const foreignMessage = { ...providerMessage, installationId: "installation-2" };
    const event = {
      container: threadRef,
      ts: foreignMessage.messageId,
      deleted: true,
      providerMessage: foreignMessage,
    } as IngestEvent;
    await recordMessageRevisions(
      sessions,
      [event],
      { attempts: 1, retryMs: 0 },
      {
        surface: "photon",
        resolveThreadRefs: async () => [threadRef],
      },
    );
    assert.deepEqual(revisions(await sessions.getEntries(session.id)), []);
  });

  it("does not match a Photon revision to a legacy entry by message id alone", async () => {
    const sessions = createMemorySessionStore();
    const threadRef = "photon-session-legacy";
    const session = await seed(sessions, threadRef, {
      text: "before",
      ts: providerMessage.messageId,
      name: "Alice",
    });
    const event = {
      container: threadRef,
      ts: providerMessage.messageId,
      editedAt: Date.now(),
      text: "after",
      providerMessage,
    } as IngestEvent;
    await recordMessageRevisions(
      sessions,
      [event],
      { attempts: 1, retryMs: 0 },
      { surface: "photon", resolveThreadRefs: async () => [threadRef] },
    );
    assert.deepEqual(revisions(await sessions.getEntries(session.id)), []);
  });
});
