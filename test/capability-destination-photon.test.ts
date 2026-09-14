import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveCapabilityDestination } from "../src/api/capability-destination.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import {
  createPhotonDestination,
  isPhotonDestination,
  type PhotonDestination,
} from "../src/surfaces/photon-destinations.ts";
import type { CandidateDestination, Destination } from "../src/types.ts";

const dmConversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  maskedAddress: "+1******0100",
  conversationId: "any;-;+15555550101",
};

const groupConversation = {
  provider: "advanced-imessage" as const,
  installationId: "installation-2",
  lineId: "line-2",
  conversationId: "any;+;group-1",
};

const dm = createPhotonDestination({
  conversation: dmConversation,
  kind: "dm",
  principalIds: ["alice"],
  audienceScopeId: "personal:alice",
  recipientPrincipalId: "alice",
  providerMessage: { ...dmConversation, messageId: "message-1", partIndex: 2 },
});

const group = createPhotonDestination({
  conversation: groupConversation,
  kind: "group",
  principalIds: ["alice", "bob"],
  audienceScopeId: "group:group-1",
  groupId: "group-1",
});

function candidate(destination: PhotonDestination, key: string): CandidateDestination {
  return { ...destination, key, label: key };
}

function capability(input: Partial<CapabilityClaims>): CapabilityClaims {
  return {
    actorId: "alice",
    scopeId: "personal:alice",
    exp: Date.now() + 60_000,
    ...input,
  };
}

describe("Photon capability destination projection", () => {
  it("preserves a validated Photon DM selected explicitly", () => {
    const resolved = resolveCapabilityDestination(
      capability({ destinations: [candidate(dm, "dm")], defaultDestinationKey: "dm" }),
      "dm",
    );

    assert.deepEqual(resolved, { ok: true, destination: dm });
    assert.equal(resolved.ok && isPhotonDestination(resolved.destination), true);
  });

  it("preserves a validated Photon group selected by default", () => {
    const resolved = resolveCapabilityDestination(
      capability({ destinations: [candidate(dm, "dm"), candidate(group, "group")], defaultDestinationKey: "group" }),
      undefined,
    );

    assert.deepEqual(resolved, { ok: true, destination: group });
  });

  it("revalidates and preserves a direct Photon fallback", () => {
    const resolved = resolveCapabilityDestination(capability({ destination: dm }), undefined);

    assert.deepEqual(resolved, { ok: true, destination: dm });
  });

  it("rejects an absent explicit key", () => {
    const resolved = resolveCapabilityDestination(capability({ destinations: [candidate(dm, "dm")] }), "missing");
    const malformed = capability({ destinations: [null] as unknown as CandidateDestination[] });
    const malformedCollection = capability({ destinations: {} as CandidateDestination[] });

    assert.deepEqual(resolved, { ok: false });
    assert.deepEqual(resolveCapabilityDestination(malformed, "missing"), { ok: false });
    assert.deepEqual(resolveCapabilityDestination(malformed, undefined), { ok: true, destination: undefined });
    assert.deepEqual(resolveCapabilityDestination(malformedCollection, "missing"), { ok: false });
    assert.deepEqual(resolveCapabilityDestination(malformedCollection, undefined), {
      ok: true,
      destination: undefined,
    });
  });

  it("rejects a foreign provider-message reference", () => {
    const foreign = {
      ...dm,
      providerMessage: {
        ...dmConversation,
        conversationId: "any;-;+15555550199",
        messageId: "message-1",
      },
    } as unknown as PhotonDestination;

    assert.deepEqual(
      resolveCapabilityDestination(capability({ destinations: [candidate(foreign, "foreign")] }), "foreign"),
      { ok: false },
    );
    assert.deepEqual(resolveCapabilityDestination(capability({ destination: foreign }), undefined), { ok: false });
  });

  it("rejects invalid principals and audience scope", () => {
    const invalidPrincipals = { ...dm, principalIds: ["alice", "bob"] } as PhotonDestination;
    const invalidScope = { ...group, audienceScopeId: "personal:alice" } as PhotonDestination;

    assert.deepEqual(
      resolveCapabilityDestination(
        capability({ destinations: [candidate(invalidPrincipals, "invalid-principals")] }),
        "invalid-principals",
      ),
      { ok: false },
    );
    assert.deepEqual(
      resolveCapabilityDestination(
        capability({ destinations: [candidate(invalidScope, "invalid-scope")] }),
        "invalid-scope",
      ),
      { ok: false },
    );
  });

  it("rejects missing line identity in a candidate and direct fallback", () => {
    const missingLine = {
      ...dm,
      conversation: { ...dmConversation, lineId: undefined },
    } as unknown as PhotonDestination;

    assert.deepEqual(
      resolveCapabilityDestination(
        capability({ destinations: [candidate(missingLine, "missing-line")] }),
        "missing-line",
      ),
      { ok: false },
    );
    assert.deepEqual(
      resolveCapabilityDestination(
        capability({ destinations: [candidate(missingLine, "missing-line")], defaultDestinationKey: "missing-line" }),
        undefined,
      ),
      { ok: false },
    );
    assert.deepEqual(
      resolveCapabilityDestination(capability({ destination: missingLine as unknown as Destination }), undefined),
      { ok: false },
    );
  });

  it("reconstructs Photon destinations from the frozen allowlist", () => {
    const extended = {
      ...candidate(dm, "extended"),
      onBehalfOf: "mallory",
      react: { messageTs: "forged", emoji: "heart" },
      approval: "forged",
      actor: "mallory",
      execution: "forged",
      unknown: "discarded",
    } as CandidateDestination;
    const resolved = resolveCapabilityDestination(capability({ destinations: [extended] }), "extended");
    const expected = { ...dm, onBehalfOf: "mallory" };

    assert.deepEqual(resolved, { ok: true, destination: expected });
    assert.equal(resolved.ok && "key" in (resolved.destination ?? {}), false);
    assert.equal(resolved.ok && "unknown" in (resolved.destination ?? {}), false);
    assert.equal(resolved.ok && resolved.destination?.onBehalfOf, "mallory");
  });

  it("rejects a malformed Photon on-behalf-of identity", () => {
    const malformed = {
      ...candidate(dm, "malformed-on-behalf-of"),
      onBehalfOf: { actorId: "alice" },
    } as unknown as CandidateDestination;

    assert.deepEqual(
      resolveCapabilityDestination(capability({ destinations: [malformed] }), "malformed-on-behalf-of"),
      { ok: false },
    );
  });

  it("keeps representative Slack projections byte-for-byte unchanged", () => {
    const selected = {
      key: "thread",
      label: "this thread",
      type: "slack",
      target: "C1:1700000000.000001",
      audienceScopeId: "channel:C1",
      onBehalfOf: "ignored",
    } satisfies CandidateDestination;
    const expectedSelected = {
      ok: true,
      destination: {
        type: "slack",
        target: "C1:1700000000.000001",
        audienceScopeId: "channel:C1",
      },
    };
    const direct = {
      type: "slack",
      target: "D1",
      audienceScopeId: "personal:alice",
      onBehalfOf: "alice",
    } satisfies Destination;

    assert.equal(
      JSON.stringify(resolveCapabilityDestination(capability({ destinations: [selected] }), "thread")),
      JSON.stringify(expectedSelected),
    );
    assert.equal(
      JSON.stringify(
        resolveCapabilityDestination(
          capability({ destinations: [selected], defaultDestinationKey: "thread" }),
          undefined,
        ),
      ),
      JSON.stringify(expectedSelected),
    );
    assert.equal(
      JSON.stringify(resolveCapabilityDestination(capability({ destination: direct }), undefined)),
      JSON.stringify({ ok: true, destination: direct }),
    );
  });
});
