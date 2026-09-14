import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderLine } from "../src/provider/capabilities.ts";
import { createConnectionManager } from "../src/provider/connection.ts";
import {
  createPhotonLineCredentialResolver,
  createSpectrumCloudLineCredentialAcquirer,
  createSpectrumCloudLineCredentialResolver,
  resolveLineCredential,
  type HostPrivateProjectSecretSource,
  type IMessageTokenIssuer,
  type LineCredentialAcquirer,
  type ScopedLineCredential,
} from "../src/provider/credentials.ts";

const now = Date.parse("2026-09-14T12:00:00.000Z");

function line(provider: ProviderLine["reference"]["provider"] = "spectrum-imessage"): ProviderLine {
  return {
    reference: {
      provider,
      installationId: "installation-a",
      projectId: "project-a",
      lineId: "line-a",
    },
    phone: "+14155550100",
    kind: "dedicated",
  };
}

function credential(overrides: Partial<ScopedLineCredential> = {}): ScopedLineCredential {
  return {
    provider: "spectrum-imessage",
    installationId: "installation-a",
    projectId: "project-a",
    lineId: "line-a",
    phone: "+14155550100",
    address: "line-a.imsg.photon.codes:443",
    token: "line-token",
    expiresAt: "2026-09-14T12:10:00.000Z",
    ...overrides,
  };
}

const trustedAddress = ({ address }: { address: string }) => address === "line-a.imsg.photon.codes:443";

function projectSecrets(projectSecret = "project-secret"): HostPrivateProjectSecretSource {
  return async ({ installationId, projectId }) => ({
    kind: "ready",
    credential: { installationId, projectId, projectSecret },
  });
}

function dedicatedIssuer(token = "line-token", expiresIn = 600): IMessageTokenIssuer {
  return {
    issueImessageTokens: async () => ({
      type: "dedicated",
      auth: { "line-a": token },
      numbers: { "line-a": "+14155550100" },
      expiresIn,
    }),
  };
}

test("acquires an exact dedicated Spectrum line through the pinned public token issuer", async () => {
  const secretInputs: unknown[] = [];
  const issuerInputs: unknown[] = [];
  const projectSecretSource: HostPrivateProjectSecretSource = async (input) => {
    secretInputs.push(input);
    return {
      kind: "ready",
      credential: { ...input, projectSecret: "project-secret" },
    };
  };
  const issuer: IMessageTokenIssuer = {
    issueImessageTokens: async (projectId, projectSecret) => {
      issuerInputs.push({ projectId, projectSecret });
      return {
        type: "dedicated",
        auth: { "line-a": "line-token" },
        numbers: { "line-a": "+14155550100" },
        expiresIn: 600,
      };
    },
  };
  const resolver = createSpectrumCloudLineCredentialResolver({
    line: line(),
    projectSecrets: projectSecretSource,
    issuer,
    now: () => now,
  });

  assert.deepEqual(await resolver.resolve(), {
    kind: "ready",
    credential: credential(),
  });
  assert.deepEqual(secretInputs, [{ installationId: "installation-a", projectId: "project-a" }]);
  assert.deepEqual(issuerInputs, [{ projectId: "project-a", projectSecret: "project-secret" }]);
});

test("rejects every credential scope mismatch", async (context) => {
  const cases: Array<[string, ScopedLineCredential]> = [
    ["provider", credential({ provider: "advanced-imessage" })],
    ["installation", credential({ installationId: "installation-b" })],
    ["project", credential({ projectId: "project-b" })],
    ["line", credential({ lineId: "line-b" })],
    ["phone", credential({ phone: "+14155550101" })],
    ["address", credential({ address: "untrusted.example:443" })],
  ];
  for (const [name, candidate] of cases) {
    await context.test(name, async () => {
      const result = await resolveLineCredential({
        line: line(),
        acquire: async () => ({ kind: "ready", credential: candidate }),
        trustedAddress,
        now: () => now,
      });
      assert.deepEqual(result, { kind: "unavailable", code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH" });
      assert.doesNotMatch(JSON.stringify(result), /line-token/u);
    });
  }
});

test("rejects missing fields, noncanonical expiry, near expiry, and invalid clocks", async (context) => {
  const cases: Array<[string, ScopedLineCredential, string]> = [
    ["empty address", credential({ address: "" }), "PHOTON_CREDENTIAL_INVALID"],
    ["empty token", credential({ token: "" }), "PHOTON_CREDENTIAL_INVALID"],
    ["noncanonical expiry", credential({ expiresAt: "2026-09-14T12:10:00Z" }), "PHOTON_CREDENTIAL_INVALID"],
    [
      "expiry at margin",
      credential({ expiresAt: "2026-09-14T12:05:00.000Z" }),
      "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY",
    ],
    ["expired", credential({ expiresAt: "2026-09-14T11:59:59.999Z" }), "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY"],
  ];
  for (const [name, candidate, code] of cases) {
    await context.test(name, async () => {
      assert.deepEqual(
        await resolveLineCredential({
          line: line(),
          acquire: async () => ({ kind: "ready", credential: candidate }),
          trustedAddress,
          now: () => now,
        }),
        { kind: "unavailable", code },
      );
    });
  }
  let acquired = false;
  assert.deepEqual(
    await resolveLineCredential({
      line: line(),
      acquire: async () => {
        acquired = true;
        return { kind: "ready", credential: credential() };
      },
      trustedAddress,
      now: () => Number.POSITIVE_INFINITY,
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_TIME_INVALID" },
  );
  assert.equal(acquired, false);
  await assert.rejects(
    resolveLineCredential({
      line: line(),
      acquire: async () => ({ kind: "ready", credential: credential() }),
      trustedAddress,
      now: () => now,
      renewalMarginMs: -1,
    }),
    /renewal margin is invalid/u,
  );

  let clockReads = 0;
  assert.deepEqual(
    await resolveLineCredential({
      line: line(),
      acquire: async () => ({ kind: "ready", credential: credential() }),
      trustedAddress,
      now: () => [now, now + 360_000][clockReads++]!,
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY" },
  );
});

test("fails closed for shared credentials, Advanced mode, and wrong project scope", async () => {
  const shared = createSpectrumCloudLineCredentialAcquirer({
    projectSecrets: projectSecrets(),
    issuer: {
      issueImessageTokens: async () => ({ type: "shared", token: "shared-token", expiresIn: 600 }),
    },
  });
  assert.deepEqual(await shared({ line: line(), acquiredAt: new Date(now).toISOString() }), {
    kind: "unavailable",
    code: "PHOTON_CREDENTIAL_LINE_SCOPE_UNAVAILABLE",
  });

  const sharedLine: ProviderLine = { ...line(), kind: "shared" };
  assert.deepEqual(await shared({ line: sharedLine, acquiredAt: new Date(now).toISOString() }), {
    kind: "unavailable",
    code: "PHOTON_CREDENTIAL_LINE_SCOPE_UNAVAILABLE",
  });

  let issuerCalled = false;
  const advanced = createSpectrumCloudLineCredentialAcquirer({
    projectSecrets: projectSecrets(),
    issuer: {
      issueImessageTokens: async () => {
        issuerCalled = true;
        return { type: "shared", token: "shared-token", expiresIn: 600 };
      },
    },
  });
  assert.deepEqual(await advanced({ line: line("advanced-imessage"), acquiredAt: new Date(now).toISOString() }), {
    kind: "unavailable",
    code: "PHOTON_CREDENTIAL_ACQUISITION_UNSUPPORTED",
  });
  assert.equal(issuerCalled, false);

  const wrongProject = createSpectrumCloudLineCredentialAcquirer({
    projectSecrets: async () => ({
      kind: "ready",
      credential: {
        installationId: "installation-a",
        projectId: "project-b",
        projectSecret: "project-secret",
      },
    }),
    issuer: dedicatedIssuer(),
  });
  assert.deepEqual(await wrongProject({ line: line(), acquiredAt: new Date(now).toISOString() }), {
    kind: "unavailable",
    code: "PHOTON_PROJECT_CREDENTIAL_SCOPE_MISMATCH",
  });

  const projectSecret = "must-not-become-a-line-token";
  const missingLineToken = createSpectrumCloudLineCredentialAcquirer({
    projectSecrets: projectSecrets(projectSecret),
    issuer: {
      issueImessageTokens: async () => ({
        type: "dedicated",
        auth: {},
        numbers: { "line-a": "+14155550100" },
        expiresIn: 600,
      }),
    },
  });
  const missingLineResult = await missingLineToken({ line: line(), acquiredAt: new Date(now).toISOString() });
  assert.deepEqual(missingLineResult, {
    kind: "unavailable",
    code: "PHOTON_CREDENTIAL_LINE_NOT_FOUND",
  });
  assert.doesNotMatch(JSON.stringify(missingLineResult), new RegExp(projectSecret, "u"));
});

test("rejects malformed provider responses, unknown lines, wrong phones, and invalid TTLs", async (context) => {
  const inheritedAuth = Object.create({ "line-a": "line-token" }) as Record<string, string>;
  const inheritedNumbers = Object.create({ "line-a": "+14155550100" }) as Record<string, string>;
  const cases: Array<[string, unknown, string]> = [
    ["null response", null, "PHOTON_CREDENTIAL_RESPONSE_INVALID"],
    ["unknown response", { type: "unknown" }, "PHOTON_CREDENTIAL_RESPONSE_INVALID"],
    ["missing maps", { type: "dedicated", expiresIn: 600 }, "PHOTON_CREDENTIAL_RESPONSE_INVALID"],
    [
      "inherited line maps",
      { type: "dedicated", auth: inheritedAuth, numbers: inheritedNumbers, expiresIn: 600 },
      "PHOTON_CREDENTIAL_RESPONSE_INVALID",
    ],
    ["missing line", { type: "dedicated", auth: {}, numbers: {}, expiresIn: 600 }, "PHOTON_CREDENTIAL_LINE_NOT_FOUND"],
    [
      "wrong phone",
      {
        type: "dedicated",
        auth: { "line-a": "line-token" },
        numbers: { "line-a": "+14155550101" },
        expiresIn: 600,
      },
      "PHOTON_CREDENTIAL_SCOPE_MISMATCH",
    ],
    [
      "nonnumeric TTL",
      {
        type: "dedicated",
        auth: { "line-a": "line-token" },
        numbers: { "line-a": "+14155550100" },
        expiresIn: "600",
      },
      "PHOTON_CREDENTIAL_EXPIRY_INVALID",
    ],
    [
      "overflowing TTL",
      {
        type: "dedicated",
        auth: { "line-a": "line-token" },
        numbers: { "line-a": "+14155550100" },
        expiresIn: Number.MAX_VALUE,
      },
      "PHOTON_CREDENTIAL_EXPIRY_INVALID",
    ],
    [
      "sub-millisecond TTL",
      {
        type: "dedicated",
        auth: { "line-a": "line-token" },
        numbers: { "line-a": "+14155550100" },
        expiresIn: Number.MIN_VALUE,
      },
      "PHOTON_CREDENTIAL_EXPIRY_INVALID",
    ],
    [
      "fractional TTL",
      {
        type: "dedicated",
        auth: { "line-a": "line-token" },
        numbers: { "line-a": "+14155550100" },
        expiresIn: 1.5,
      },
      "PHOTON_CREDENTIAL_EXPIRY_INVALID",
    ],
  ];
  for (const [name, response, code] of cases) {
    await context.test(name, async () => {
      const acquire = createSpectrumCloudLineCredentialAcquirer({
        projectSecrets: projectSecrets(),
        issuer: { issueImessageTokens: async () => response },
      });
      assert.deepEqual(await acquire({ line: line(), acquiredAt: new Date(now).toISOString() }), {
        kind: "unavailable",
        code,
      });
    });
  }

  const malformedProjectSource = createSpectrumCloudLineCredentialAcquirer({
    projectSecrets: (async () => null) as unknown as HostPrivateProjectSecretSource,
    issuer: dedicatedIssuer(),
  });
  assert.deepEqual(await malformedProjectSource({ line: line(), acquiredAt: new Date(now).toISOString() }), {
    kind: "unavailable",
    code: "PHOTON_PROJECT_CREDENTIAL_UNAVAILABLE",
  });

  const inheritedProjectCredential = createSpectrumCloudLineCredentialAcquirer({
    projectSecrets: async () => ({
      kind: "ready",
      credential: Object.create({
        installationId: "installation-a",
        projectId: "project-a",
        projectSecret: "project-secret",
      }) as { installationId: string; projectId: string; projectSecret: string },
    }),
    issuer: dedicatedIssuer(),
  });
  assert.deepEqual(await inheritedProjectCredential({ line: line(), acquiredAt: new Date(now).toISOString() }), {
    kind: "unavailable",
    code: "PHOTON_PROJECT_CREDENTIAL_INVALID",
  });
});

test("refresh failure returns no stale credential or secret-bearing error", async () => {
  let calls = 0;
  const secret = "never-serialize-this-project-secret";
  const resolver = createSpectrumCloudLineCredentialResolver({
    line: line(),
    projectSecrets: projectSecrets(secret),
    issuer: {
      issueImessageTokens: async () => {
        calls += 1;
        if (calls > 1) throw new Error(`provider rejected ${secret}`);
        return {
          type: "dedicated",
          auth: { "line-a": "first-line-token" },
          numbers: { "line-a": "+14155550100" },
          expiresIn: 600,
        };
      },
    },
    now: () => now,
  });

  const first = await resolver.resolve();
  assert.equal(first.kind, "ready");
  const second = await resolver.resolve();
  assert.deepEqual(second, { kind: "unavailable", code: "PHOTON_CREDENTIAL_REFRESH_FAILED" });
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(second), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(second), /first-line-token/u);

  const thrown = await resolveLineCredential({
    line: line(),
    acquire: async () => {
      throw new Error("line-token leaked");
    },
    trustedAddress,
    now: () => now,
  });
  assert.deepEqual(thrown, { kind: "unavailable", code: "PHOTON_CREDENTIAL_ACQUISITION_FAILED" });
  assert.doesNotMatch(JSON.stringify(thrown), /line-token/u);

  assert.deepEqual(
    await resolveLineCredential({
      line: line(),
      acquire: async () => ({ kind: "unavailable", code: "PHOTON_NEVER_SERIALIZE_THIS_PROJECT_SECRET" }),
      trustedAddress,
      now: () => now,
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_ACQUISITION_FAILED" },
  );

  const unexpected = (async () => ({
    kind: "unexpected",
    credential: credential(),
  })) as unknown as LineCredentialAcquirer;
  assert.deepEqual(await resolveLineCredential({ line: line(), acquire: unexpected, trustedAddress, now: () => now }), {
    kind: "unavailable",
    code: "PHOTON_CREDENTIAL_RESPONSE_INVALID",
  });
});

test("implements the frozen resolver projection and classifies near expiry", async () => {
  const resolver = createPhotonLineCredentialResolver({
    line: line(),
    projectSecrets: projectSecrets(),
    issuer: dedicatedIssuer(),
    now: () => now,
  });
  assert.deepEqual(
    await resolver.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      now: new Date(now).toISOString(),
    }),
    {
      kind: "available",
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      bearerToken: "line-token",
      expiresAt: "2026-09-14T12:10:00.000Z",
      provenance: "persisted-line-assignment",
      renewal: "external",
    },
  );
  assert.deepEqual(
    await resolver.resolve({
      installationId: "installation-b",
      lineId: "line-a",
      mode: "spectrum",
      now: new Date(now).toISOString(),
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH" },
  );
  assert.deepEqual(
    await resolver.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "advanced",
      now: new Date(now).toISOString(),
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH" },
  );
  assert.deepEqual(
    await resolver.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      now: "2026-09-14T12:00:00Z",
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_TIME_INVALID" },
  );

  const expiring = createPhotonLineCredentialResolver({
    line: line(),
    projectSecrets: projectSecrets(),
    issuer: dedicatedIssuer("line-token", 300),
    now: () => now,
  });
  assert.deepEqual(
    await expiring.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      now: new Date(now).toISOString(),
    }),
    { kind: "expired", code: "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY" },
  );

  const delayed = createPhotonLineCredentialResolver({
    line: line(),
    projectSecrets: projectSecrets(),
    issuer: dedicatedIssuer(),
    now: () => now + 360_000,
  });
  assert.deepEqual(
    await delayed.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      now: new Date(now).toISOString(),
    }),
    { kind: "expired", code: "PHOTON_CREDENTIAL_EXPIRED_OR_NEAR_EXPIRY" },
  );

  const advanced = createPhotonLineCredentialResolver({
    line: line("advanced-imessage"),
    projectSecrets: projectSecrets(),
    issuer: dedicatedIssuer(),
    now: () => now,
  });
  assert.deepEqual(
    await advanced.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "advanced",
      now: new Date(now).toISOString(),
    }),
    { kind: "unavailable", code: "PHOTON_CREDENTIAL_ACQUISITION_UNSUPPORTED" },
  );
});

test("rejects request scope before reading private credentials or issuing tokens", async (context) => {
  let projectSecretReads = 0;
  let issuerCalls = 0;
  const resolver = createPhotonLineCredentialResolver({
    line: line(),
    projectSecrets: async (input) => {
      projectSecretReads += 1;
      return { kind: "ready", credential: { ...input, projectSecret: "project-secret" } };
    },
    issuer: {
      issueImessageTokens: async () => {
        issuerCalls += 1;
        return dedicatedIssuer().issueImessageTokens("project-a", "project-secret");
      },
    },
    now: () => now,
  });
  const cases = [
    {
      name: "installation",
      input: {
        installationId: "installation-b",
        lineId: "line-a",
        mode: "spectrum" as const,
        now: new Date(now).toISOString(),
      },
      code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH",
    },
    {
      name: "line",
      input: {
        installationId: "installation-a",
        lineId: "line-b",
        mode: "spectrum" as const,
        now: new Date(now).toISOString(),
      },
      code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH",
    },
    {
      name: "mode",
      input: {
        installationId: "installation-a",
        lineId: "line-a",
        mode: "advanced" as const,
        now: new Date(now).toISOString(),
      },
      code: "PHOTON_CREDENTIAL_SCOPE_MISMATCH",
    },
    {
      name: "time",
      input: {
        installationId: "installation-a",
        lineId: "line-a",
        mode: "spectrum" as const,
        now: "2026-09-14T12:00:00Z",
      },
      code: "PHOTON_CREDENTIAL_TIME_INVALID",
    },
  ];
  for (const value of cases) {
    await context.test(value.name, async () => {
      assert.deepEqual(await resolver.resolve(value.input), { kind: "unavailable", code: value.code });
      assert.equal(projectSecretReads, 0);
      assert.equal(issuerCalls, 0);
    });
  }
});

test("snapshots line scope before asynchronous credential acquisition", async () => {
  const mutableLine = line();
  const resolver = createPhotonLineCredentialResolver({
    line: mutableLine,
    projectSecrets: projectSecrets(),
    issuer: {
      issueImessageTokens: async () => {
        (mutableLine.reference as { lineId: string }).lineId = "line-b";
        return {
          type: "dedicated",
          auth: { "line-a": "line-token" },
          numbers: { "line-a": "+14155550100" },
          expiresIn: 600,
        };
      },
    },
    now: () => now,
  });

  assert.deepEqual(
    await resolver.resolve({
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      now: new Date(now).toISOString(),
    }),
    {
      kind: "available",
      installationId: "installation-a",
      lineId: "line-a",
      mode: "spectrum",
      bearerToken: "line-token",
      expiresAt: "2026-09-14T12:10:00.000Z",
      provenance: "persisted-line-assignment",
      renewal: "external",
    },
  );
  assert.equal(mutableLine.reference.lineId, "line-b");
});

test("credential replacement stops prior intake before constructing the refreshed connection", async () => {
  const events: string[] = [];
  let token = "line-token-1";
  let refreshFails = false;
  const resolver = createSpectrumCloudLineCredentialResolver({
    line: line(),
    projectSecrets: projectSecrets(),
    issuer: {
      issueImessageTokens: async () => {
        if (refreshFails) throw new Error("refresh failed");
        return {
          type: "dedicated",
          auth: { "line-a": token },
          numbers: { "line-a": "+14155550100" },
          expiresIn: 600,
        };
      },
    },
    now: () => now,
  });
  const manager = createConnectionManager({
    advanced: () => {
      throw new Error("unexpected Advanced construction");
    },
    spectrum: async ({ token: connectionToken }) => {
      events.push(`construct:${connectionToken}`);
      return {
        messages: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: true as const, value: undefined }),
            };
          },
        },
        stop: async () => {
          events.push(`stop:${connectionToken}`);
        },
      };
    },
  });

  const firstResolution = await resolver.resolve();
  assert.equal(firstResolution.kind, "ready");
  if (firstResolution.kind !== "ready") throw new Error("credential unavailable");
  const first = await manager.replace(line(), firstResolution.credential);
  first.addConsumer(async () => {
    events.push("stop:intake");
  });
  assert.throws(() => first.addConsumer(async () => undefined), /PROVIDER_INTAKE_ALREADY_OWNED/u);

  refreshFails = true;
  assert.deepEqual(await resolver.resolve(), { kind: "unavailable", code: "PHOTON_CREDENTIAL_REFRESH_FAILED" });
  assert.doesNotThrow(() => first.assertActive());
  assert.deepEqual(events, ["construct:line-token-1"]);

  refreshFails = false;
  token = "line-token-2";
  const secondResolution = await resolver.resolve();
  assert.equal(secondResolution.kind, "ready");
  if (secondResolution.kind !== "ready") throw new Error("credential unavailable");
  const second = await manager.replace(line(), secondResolution.credential);
  assert.deepEqual(events, ["construct:line-token-1", "stop:intake", "stop:line-token-1", "construct:line-token-2"]);
  assert.throws(() => first.assertActive(), /PROVIDER_CONNECTION_STOPPED/u);

  await manager.stop();
  assert.throws(() => second.assertActive(), /PROVIDER_CONNECTION_STOPPED/u);
  assert.deepEqual(events.at(-1), "stop:line-token-2");
});
