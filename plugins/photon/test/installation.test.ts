import assert from "node:assert/strict";
import test from "node:test";

import type { PrivateInstallationStatus } from "../../chassis/src/photon-contract.ts";
import type { InstallationRecord, InstallationStorePort } from "../src/ports.ts";
import type { PhotonAssignmentSetupAction } from "../src/setup/assignment.ts";
import {
  PINNED_PHOTON_CLI_VERSION,
  PhotonCliProcessError,
  type PhotonCliInvocation,
  type PhotonCliProcessResult,
  type PhotonCliRunOptions,
  type PhotonCliRunner,
} from "../src/setup/cli-process.ts";
import { PhotonCliInstallationService, type PhotonInstallationSetupAction } from "../src/setup/installation.ts";

class MemoryInstallationStore implements InstallationStorePort {
  record: InstallationRecord | undefined;
  readonly versions: number[] = [];

  public async read(installationId: string): Promise<InstallationRecord | undefined> {
    return this.record?.installation.installationId === installationId ? this.record : undefined;
  }

  public async create(record: InstallationRecord): Promise<boolean> {
    if (this.record !== undefined) return false;
    this.record = record;
    this.versions.push(record.version);
    return true;
  }

  public async compareAndSet(
    installationId: string,
    expectedVersion: number,
    next: InstallationRecord,
  ): Promise<boolean> {
    if (this.record?.installation.installationId !== installationId || this.record.version !== expectedVersion) {
      return false;
    }
    this.record = next;
    this.versions.push(next.version);
    return true;
  }
}

class FakePhotonCli implements PhotonCliRunner {
  readonly invocations: PhotonCliInvocation[] = [];
  projects: Array<{ id: string; name: string }> = [{ id: "project-a", name: "Alpha" }];
  users: Array<Record<string, unknown>> = [
    {
      id: "recipient-a",
      phoneNumber: "+14155550101",
      assignedPhoneNumber: "+14155550999",
    },
  ];
  lines: Array<Record<string, unknown>> = [{ id: "line-a", phoneNumber: "+14155550888" }];
  secret = "runtime-project-secret";
  loginOutput = [
    "\u001b[2m  Vis",
    "it:\u001b[0m \u001b[36mhttps://app.photon.codes/device?code=ABCD-EFGH\u001b[0m\n",
    "  Co",
    "de: ABCD-EFGH\n",
  ];
  loginFailure: PhotonCliProcessError | undefined;
  managementValid = true;
  holdLogin = false;
  loginRunning = false;
  createCount = 0;
  readonly #loginGate: { promise: Promise<void>; resolve: () => void };

  public constructor() {
    let resolve!: () => void;
    const promise = new Promise<void>((accept) => {
      resolve = accept;
    });
    this.#loginGate = { promise, resolve };
  }

  public configDirectory(installationId: string): string {
    return `/private/photon/${installationId}`;
  }

  public async verifyVersion(_installationId: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) throw new PhotonCliProcessError("cancelled");
    this.invocations.push({ command: "version" });
    return PINNED_PHOTON_CLI_VERSION;
  }

  public async run(
    _installationId: string,
    invocation: PhotonCliInvocation,
    options: PhotonCliRunOptions = {},
  ): Promise<PhotonCliProcessResult> {
    this.invocations.push(invocation);
    if (invocation.command === "login") {
      this.loginRunning = true;
      try {
        for (const chunk of this.loginOutput) options.onOutput?.("stdout", chunk);
        if (this.holdLogin) await this.#waitForLogin(options.signal);
        if (this.loginFailure !== undefined) throw this.loginFailure;
        return { stdout: this.loginOutput.join(""), stderr: "" };
      } finally {
        this.loginRunning = false;
      }
    }
    if (invocation.command === "whoami") {
      if (!this.managementValid) throw new PhotonCliProcessError("not-authenticated");
      return { stdout: "Signed in\n", stderr: "" };
    }
    if (invocation.command === "projects-list") {
      return { stdout: JSON.stringify(this.projects), stderr: "" };
    }
    if (invocation.command === "project-create") {
      this.createCount += 1;
      const created = { id: `project-created-${this.createCount}`, name: invocation.name };
      this.projects.push(created);
      return { stdout: JSON.stringify(created), stderr: "" };
    }
    if (invocation.command === "project-secret") {
      return { stdout: JSON.stringify({ id: invocation.projectId, projectSecret: this.secret }), stderr: "" };
    }
    if (invocation.command === "project-show") {
      return {
        stdout: JSON.stringify(this.projects.find((project) => project.id === invocation.projectId)),
        stderr: "",
      };
    }
    if (invocation.command === "users-list") return { stdout: JSON.stringify(this.users), stderr: "" };
    if (invocation.command === "lines-list") return { stdout: JSON.stringify(this.lines), stderr: "" };
    return { stdout: PINNED_PHOTON_CLI_VERSION, stderr: "" };
  }

  public releaseLogin(): void {
    this.#loginGate.resolve();
  }

  async #waitForLogin(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) throw new PhotonCliProcessError("cancelled");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new PhotonCliProcessError("cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.#loginGate.promise.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}

function ownerPort(revision = "owner-revision-1") {
  return { read: async () => revision };
}

function service(
  store: MemoryInstallationStore,
  cli: FakePhotonCli,
  options: { revision?: string; now?: () => Date } = {},
) {
  return new PhotonCliInstallationService({
    installationId: "installation-a",
    store,
    ownerRevision: ownerPort(options.revision),
    cli,
    loginTimeoutMs: 1_800_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

const createShared: PhotonInstallationSetupAction = {
  project: { kind: "create-project", name: "QM iMessage" },
  assignment: { kind: "shared-recipient", address: "+14155550101" },
};

function durableRecord(
  status: PrivateInstallationStatus,
  options: { projectId?: string; revision?: string; version?: number } = {},
): InstallationRecord {
  return {
    installation: {
      installationId: "installation-a",
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    },
    status,
    ownerRevision: options.revision ?? "owner-revision-1",
    version: options.version ?? 4,
  };
}

test("concurrent starts share one active login, project, and assignment", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  cli.holdLogin = true;
  const installation = service(store, cli);
  const first = installation.start(createShared);
  const second = installation.start(createShared);
  assert.strictEqual(first, second);
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(firstStatus.state, "awaiting-authorization");
  assert.deepEqual(secondStatus, firstStatus);
  assert.equal(cli.createCount, 0);
  cli.releaseLogin();
  const connected = await installation.waitForCompletion();
  assert.deepEqual(connected, {
    state: "connected",
    installationId: "installation-a",
    projectId: "project-created-1",
    lines: [{ lineId: "recipient-a", maskedAddress: "+1•••0999" }],
  });
  assert.equal(cli.createCount, 1);
  assert.equal(cli.invocations.filter((invocation) => invocation.command === "users-list").length, 1);
  assert.deepEqual(store.versions, [1, 2, 3, 4, 5, 6, 7]);
});

test("durable setup state serializes concurrent starts across service instances", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  cli.holdLogin = true;
  const first = service(store, cli);
  const second = service(store, cli);
  const authorization = await first.start(createShared);
  assert.equal(authorization.state, "awaiting-authorization");
  assert.deepEqual(await second.start(createShared), authorization);
  assert.equal(cli.invocations.filter((invocation) => invocation.command === "login").length, 1);
  cli.releaseLogin();
  assert.equal((await first.waitForCompletion()).state, "connected");
  assert.equal((await second.status()).state, "connected");
  assert.equal(cli.createCount, 1);
});

test("public statuses exclude CLI credentials, project secrets, and raw output", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  cli.secret = "DO-NOT-EXPOSE-RUNTIME-SECRET";
  const installation = service(store, cli);
  await installation.start(createShared);
  const status = await installation.waitForCompletion();
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /DO-NOT-EXPOSE|credentialPath|\/private\/photon|Visit:/u);
  assert.match(JSON.stringify(store.record), /DO-NOT-EXPOSE-RUNTIME-SECRET/u);
});

test("shared-pool assignment uses the exact provider user ID without inventing a line ID", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  cli.users = [{ id: "recipient-a", phoneNumber: "+14155550101" }];
  const installation = service(store, cli);
  await installation.start(createShared);
  assert.deepEqual(await installation.waitForCompletion(), {
    state: "connected",
    installationId: "installation-a",
    projectId: "project-created-1",
    lines: [{ lineId: "recipient-a" }],
  });
});

test("multiple projects are selected only by exact ID", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  cli.projects = [
    { id: "project-a", name: "Same" },
    { id: "project-b", name: "Same" },
  ];
  cli.lines = [
    { id: "line-a", phoneNumber: "+14155550111" },
    { id: "line-b", displayPhoneNumber: "+14155550222" },
  ];
  const installation = service(store, cli);
  await installation.start({
    project: { kind: "select-project", projectId: "project-b" },
    assignment: { kind: "select-line", lineId: "line-b" },
  });
  const connected = await installation.waitForCompletion();
  assert.equal(connected.state, "connected");
  if (connected.state !== "connected") return;
  assert.equal(connected.projectId, "project-b");
  assert.deepEqual(connected.lines, [{ lineId: "line-b", maskedAddress: "+1•••0222" }]);
  assert.equal(cli.createCount, 0);
  assert.ok(
    cli.invocations.some(
      (invocation) => invocation.command === "project-secret" && invocation.projectId === "project-b",
    ),
  );
});

test("restart resumes the stored project without creating another", async () => {
  const store = new MemoryInstallationStore();
  store.record = durableRecord(
    {
      state: "provisioning",
      installationId: "installation-a",
      management: { credentialPath: "/private/photon/installation-a" },
      runtime: { projectSecret: "runtime-project-secret" },
    },
    { projectId: "project-b" },
  );
  const cli = new FakePhotonCli();
  cli.projects = [
    { id: "project-a", name: "Alpha" },
    { id: "project-b", name: "Beta" },
  ];
  cli.lines = [{ id: "line-b", phoneNumber: "+14155550222" }];
  const restarted = service(store, cli);
  const status = await restarted.resume({ kind: "select-line", lineId: "line-b" });
  assert.equal(status.state, "connected");
  if (status.state !== "connected") return;
  assert.equal(status.projectId, "project-b");
  assert.equal(cli.createCount, 0);
  assert.equal(cli.invocations.filter((invocation) => invocation.command === "login").length, 0);
});

test("restart reports required reauthorization instead of reattaching an exited login", async () => {
  const store = new MemoryInstallationStore();
  store.record = durableRecord({
    state: "awaiting-authorization",
    installationId: "installation-a",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://app.photon.codes/device?code=ABCD-EFGH",
    expiresAt: "2026-09-12T20:00:00.000Z",
    managementOrigin: "https://app.photon.codes",
    management: { credentialPath: "/private/photon/installation-a" },
  });
  const restarted = service(store, new FakePhotonCli(), { now: () => new Date("2026-09-12T10:00:00.000Z") });
  assert.deepEqual(await restarted.resume(), {
    state: "failed",
    installationId: "installation-a",
    safeCode: "PHOTON_REAUTHORIZATION_REQUIRED",
  });
});

test("restart with a stored project and expired management login never creates", async () => {
  const store = new MemoryInstallationStore();
  store.record = durableRecord(
    {
      state: "provisioning",
      installationId: "installation-a",
      management: { credentialPath: "/private/photon/installation-a" },
    },
    { projectId: "project-b" },
  );
  const cli = new FakePhotonCli();
  cli.managementValid = false;
  const restarted = service(store, cli);
  assert.deepEqual(await restarted.resume({ kind: "select-line", lineId: "line-b" }), {
    state: "failed",
    installationId: "installation-a",
    safeCode: "PHOTON_REAUTHORIZATION_REQUIRED",
  });
  assert.equal(cli.createCount, 0);
});

test("management expiry is distinct from connected runtime credential health", async () => {
  const store = new MemoryInstallationStore();
  store.record = durableRecord(
    {
      state: "connected",
      installationId: "installation-a",
      projectId: "project-a",
      lines: [{ lineId: "line-a", maskedAddress: "+1•••0888" }],
      management: { credentialPath: "/private/photon/installation-a" },
      runtime: { projectSecret: "runtime-project-secret" },
    },
    { projectId: "project-a" },
  );
  const cli = new FakePhotonCli();
  cli.managementValid = false;
  const installation = service(store, cli);
  assert.equal((await installation.status()).state, "connected");
  assert.equal(await installation.managementLoginStatus(), "reauthorization-required");
  assert.equal((await installation.status()).state, "connected");
});

test("missing runtime credential reports credential repair without running a CLI mutation", async () => {
  const store = new MemoryInstallationStore();
  store.record = durableRecord(
    {
      state: "connected",
      installationId: "installation-a",
      projectId: "project-a",
      lines: [{ lineId: "line-a" }],
      management: { credentialPath: "/private/photon/installation-a" },
    },
    { projectId: "project-a" },
  );
  const cli = new FakePhotonCli();
  const installation = service(store, cli);
  assert.deepEqual(await installation.resume(), {
    state: "needs-credential-repair",
    installationId: "installation-a",
  });
  assert.deepEqual(cli.invocations, []);
});

test("missing and ambiguous assignments fail closed", async (t) => {
  for (const fixture of [
    { users: [] as Array<Record<string, unknown>>, code: "PHOTON_ASSIGNMENT_MISSING" },
    {
      users: [
        {
          id: "recipient-a",
          phoneNumber: "+14155550101",
          assignedPhoneNumber: "+14155550999",
        },
        {
          id: "recipient-b",
          phoneNumber: "+14155550101",
          assignedPhoneNumber: "+14155550888",
        },
      ],
      code: "PHOTON_ASSIGNMENT_AMBIGUOUS",
    },
  ]) {
    await t.test(fixture.code, async () => {
      const store = new MemoryInstallationStore();
      const cli = new FakePhotonCli();
      cli.users = fixture.users;
      const installation = service(store, cli);
      await installation.start(createShared);
      assert.deepEqual(await installation.waitForCompletion(), {
        state: "failed",
        installationId: "installation-a",
        safeCode: fixture.code,
      });
    });
  }
});

test("malformed login output fails without exposing the raw stream", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  cli.loginOutput = ["raw-private-cli-output token=secret"];
  const installation = service(store, cli);
  const status = await installation.start(createShared);
  assert.deepEqual(status, {
    state: "failed",
    installationId: "installation-a",
    safeCode: "PHOTON_AUTHORIZATION_MALFORMED",
  });
  assert.doesNotMatch(JSON.stringify(status), /raw-private|secret/u);
});

test("denial, expiry, and timeout never report connected", async (t) => {
  const cases = [
    { failure: "authorization-denied" as const, code: "PHOTON_AUTHORIZATION_DENIED" },
    { failure: "authorization-expired" as const, code: "PHOTON_AUTHORIZATION_EXPIRED" },
    { failure: "timeout" as const, code: "PHOTON_SETUP_TIMEOUT" },
  ];
  for (const fixture of cases) {
    await t.test(fixture.failure, async () => {
      const store = new MemoryInstallationStore();
      const cli = new FakePhotonCli();
      cli.loginOutput = [];
      cli.loginFailure = new PhotonCliProcessError(fixture.failure);
      const installation = service(store, cli);
      const status = await installation.start(createShared);
      assert.deepEqual(status, {
        state: "failed",
        installationId: "installation-a",
        safeCode: fixture.code,
      });
      assert.notEqual(status.state, "connected");
    });
  }
});

test("cancellation fails safely and close preserves a resumable checkpoint", async () => {
  const cancelledStore = new MemoryInstallationStore();
  const cancelledCli = new FakePhotonCli();
  cancelledCli.holdLogin = true;
  const cancelled = service(cancelledStore, cancelledCli);
  assert.equal((await cancelled.start(createShared)).state, "awaiting-authorization");
  assert.deepEqual(await cancelled.cancel(), {
    state: "failed",
    installationId: "installation-a",
    safeCode: "PHOTON_SETUP_CANCELLED",
  });

  const closedStore = new MemoryInstallationStore();
  const closedCli = new FakePhotonCli();
  closedCli.holdLogin = true;
  const closed = service(closedStore, closedCli);
  assert.equal((await closed.start(createShared)).state, "awaiting-authorization");
  await closed.close();
  assert.equal(closedCli.loginRunning, false);
  assert.equal((await closed.status()).state, "awaiting-authorization");
});

test("owner revision changes never report connected", async () => {
  let revision = "owner-revision-1";
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  const installation = new PhotonCliInstallationService({
    installationId: "installation-a",
    store,
    ownerRevision: { read: async () => revision },
    cli,
  });
  cli.holdLogin = true;
  await installation.start(createShared);
  revision = "owner-revision-2";
  cli.releaseLogin();
  assert.deepEqual(await installation.waitForCompletion(), {
    state: "needs-owner-rebind",
    installationId: "installation-a",
  });
});

test("no setup path invokes secret regeneration, billing, purchase, or line creation", async () => {
  const store = new MemoryInstallationStore();
  const cli = new FakePhotonCli();
  const installation = service(store, cli);
  await installation.start(createShared);
  await installation.waitForCompletion();
  const commands = cli.invocations.map((invocation) => invocation.command);
  assert.deepEqual(commands, ["version", "login", "project-create", "project-secret", "users-list"]);
  assert.doesNotMatch(JSON.stringify(commands), /regenerate|billing|purchase|lines-add/u);
});

test("resume requires the assignment while preserving the durable project", async () => {
  const store = new MemoryInstallationStore();
  store.record = durableRecord(
    {
      state: "provisioning",
      installationId: "installation-a",
      management: { credentialPath: "/private/photon/installation-a" },
      runtime: { projectSecret: "runtime-project-secret" },
    },
    { projectId: "project-a" },
  );
  const cli = new FakePhotonCli();
  const installation = service(store, cli);
  assert.deepEqual(await installation.resume(), {
    state: "failed",
    installationId: "installation-a",
    safeCode: "PHOTON_ASSIGNMENT_REQUIRED",
  });
  assert.equal(cli.createCount, 0);
});

test("selected line assignment type remains explicit", () => {
  const assignment = { kind: "select-line", lineId: "line-a" } satisfies PhotonAssignmentSetupAction;
  assert.deepEqual(assignment, { kind: "select-line", lineId: "line-a" });
});
