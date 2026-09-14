import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { matches } = (await import(new URL("../scripts/imessage-verify-lane.mjs", import.meta.url).href)) as {
  matches(path: string, pattern: string): boolean;
};

const specification = `
wt-01|src/api/photon-authorization.ts src/api/photon-core-client.ts src/api/routes/photon.ts plugins/photon/src/qm-client.ts test/photon-core-client.test.ts test/photon-source-auth.test.ts plugins/photon/test/qm-client.test.ts
wt-02|plugins/photon/src/setup/cli-process.ts plugins/photon/src/setup/device-login.ts plugins/photon/src/setup/project.ts plugins/photon/src/setup/assignment.ts plugins/photon/src/setup/installation.ts plugins/photon/test/installation.test.ts plugins/photon/test/cli-process.test.ts
wt-03|plugins/chassis/src/photon-state.ts plugins/chassis/src/photon-state-schema.ts plugins/chassis/src/photon-state-records.ts plugins/photon/src/state.ts test/photon-state-postgres.test.ts plugins/photon/test/state.test.ts
wt-04|plugins/photon/src/provider/connection.ts plugins/photon/src/provider/clients.ts plugins/photon/src/provider/subscriptions.ts plugins/photon/src/provider/recovery.ts plugins/photon/src/provider/capabilities.ts plugins/photon/src/provider/compatibility.ts plugins/photon/test/provider.test.ts plugins/photon/test/provider-compatibility.test.ts
wt-05|src/reach/reach.ts src/api/app-helpers.ts src/api/app-messaging.ts src/api/routes/context.ts src/core/message-revisions.ts src/surfaces/photon-destinations.ts test/photon-destinations.test.ts test/photon-context.test.ts test/photon-revisions.test.ts
wt-06|plugins/web-ui/server/photon-host.ts plugins/web-ui/src/photon/host.ts plugins/web-ui/src/photon/navigation.ts plugins/web-ui/src/photon/context.ts plugins/web-ui/src/photon/host.css plugins/web-ui/test/photon-host.test.ts
wt-07|src/surfaces/photon-identities.ts plugins/photon/src/routing/identity.ts plugins/photon/src/routing/spaces.ts plugins/photon/src/routing/sessions.ts plugins/photon/src/routing/messages.ts test/photon-identities.test.ts plugins/photon/test/routing.test.ts
wt-08|plugins/photon/src/inbound/normalize.ts plugins/photon/src/inbound/receipts.ts plugins/photon/src/inbound/dispatch.ts plugins/photon/src/inbound/context.ts plugins/photon/src/inbound/revisions.ts plugins/photon/test/inbound.test.ts plugins/photon/test/surface-context.test.ts
wt-09|plugins/photon/src/delivery/worker.ts plugins/photon/src/delivery/plan.ts plugins/photon/src/delivery/operations.ts plugins/photon/src/delivery/reconcile.ts plugins/photon/src/delivery/results.ts plugins/photon/test/delivery.test.ts plugins/photon/test/delivery-recovery.test.ts
wt-10|plugins/photon/src/native/text.ts plugins/photon/src/native/replies.ts plugins/photon/src/native/reactions.ts plugins/photon/src/native/mutations.ts plugins/photon/src/native/effects.ts plugins/photon/src/native/text-stream.ts plugins/photon/test/native-text.test.ts
wt-11|plugins/photon/src/media/inbound.ts plugins/photon/src/media/outbound.ts plugins/photon/src/media/voice.ts plugins/photon/src/media/contacts.ts plugins/photon/src/media/links.ts plugins/photon/src/media/validation.ts plugins/photon/test/media.test.ts
wt-12|plugins/photon/src/presence/typing.ts plugins/photon/src/presence/receipts.ts plugins/photon/src/presence/metadata.ts plugins/photon/src/presence/working.ts plugins/photon/test/presence.test.ts
wt-13|plugins/photon/src/polls/native.ts plugins/photon/src/polls/bindings.ts plugins/photon/src/polls/events.ts plugins/photon/src/polls/choices.ts plugins/photon/test/polls.test.ts
wt-14|plugins/photon/src/cards/send.ts plugins/photon/src/cards/sessions.ts plugins/photon/src/cards/update.ts plugins/photon/src/cards/links.ts plugins/photon/src/cards/previews.ts plugins/photon/test/cards.test.ts
wt-15|plugins/photon/src/groups/operations.ts plugins/photon/src/groups/roster.ts plugins/photon/src/groups/events.ts plugins/photon/src/groups/presentation.ts plugins/photon/src/groups/authorization.ts plugins/photon/test/groups.test.ts
wt-16|plugins/admin/public/photon.js plugins/admin/public/index.html plugins/admin/src/photon-routes.ts plugins/admin/src/index.ts plugins/web-ui/src/photon/link-address.ts plugins/admin/test/photon.test.ts plugins/web-ui/test/photon-link-address.test.ts
wt-17|plugins/web-ui/src/photon/views/sessions.ts plugins/web-ui/src/photon/views/run.ts plugins/web-ui/src/photon/views/run-actions.ts plugins/photon/src/presentation/run.ts plugins/web-ui/test/photon-sessions.test.ts plugins/photon/test/run-presentation.test.ts
wt-18|plugins/photon/src/interactions/approvals.ts plugins/photon/src/interactions/approval-reactions.ts plugins/photon/src/interactions/actions.ts plugins/photon/src/interactions/agent-requests.ts plugins/web-ui/src/photon/views/approvals.ts src/surfaces/photon-agent-requests.ts test/photon-approval-parity.test.ts plugins/photon/test/interactions.test.ts
wt-19|plugins/web-ui/src/photon/views/files.ts plugins/web-ui/src/photon/views/memory.ts plugins/web-ui/src/photon/views/skills.ts plugins/web-ui/src/photon/views/contexts.ts plugins/web-ui/test/photon-resources.test.ts
wt-20|plugins/web-ui/src/photon/views/crons.ts plugins/web-ui/src/photon/views/background.ts plugins/web-ui/src/photon/views/inbox.ts plugins/web-ui/src/photon/views/reviews.ts plugins/photon/src/presentation/background.ts plugins/web-ui/test/photon-background-views.test.ts plugins/photon/test/background-presentation.test.ts
wt-21|plugins/web-ui/src/photon/views/applications.ts plugins/web-ui/src/photon/views/runtime-settings.ts plugins/web-ui/src/photon/views/keychain.ts plugins/web-ui/src/photon/views/administration.ts plugins/photon/src/presentation/applications.ts plugins/web-ui/test/photon-settings.test.ts
wt-22|plugins/photon/Dockerfile plugins/photon/.env.example cli/src/commands/photon.ts cli/src/photon-service.ts cli/src/cli.ts cli/src/plugins.ts cli/src/services.ts cli/src/config.ts cli/src/secrets.ts cli/test/photon-service.test.ts plugins/photon/test/packaging.test.ts
wt-23|test/photon-security-regression.test.ts plugins/photon/test/security-adversarial.test.ts plugins/web-ui/test/photon-security-adversarial.test.ts docs/imessage/reviews/security.md
wt-24|plugins/photon/test/recovery-matrix.test.ts plugins/photon/test/concurrency-matrix.test.ts scripts/imessage-chaos.mjs docs/imessage/reviews/reliability.md
wt-25|scripts/imessage-acceptance.mjs plugins/photon/test/parity-coverage.test.ts plugins/web-ui/test/photon-view-parity.test.ts docs/imessage/reviews/product-parity.md
`;

function expectedOwnership() {
  return Object.fromEntries(
    specification
      .trim()
      .split("\n")
      .map((line) => {
        const [lane, paths] = line.split("|");
        assert.ok(lane !== undefined && paths !== undefined);
        return [lane, [...paths.split(" "), `docs/imessage/lanes/${lane}.md`].sort()];
      }),
  );
}

function expectedWave(laneNumber: number) {
  if (laneNumber <= 6) return "A";
  if (laneNumber <= 15) return "B";
  if (laneNumber <= 22) return "C";
  return "D";
}

test("all 25 original lane assignments are exact and use their original waves", async () => {
  const ownership = JSON.parse(await readFile(new URL("../docs/imessage/ownership.json", import.meta.url), "utf8"));
  const expected = expectedOwnership();
  assert.equal(Object.keys(expected).length, 25);
  for (const [laneId, paths] of Object.entries<string[]>(expected)) {
    assert.deepEqual([...ownership.lanes[laneId].ownedPaths].sort(), paths, laneId);
    const laneNumber = Number(laneId.slice(3));
    const wave = expectedWave(laneNumber);
    assert.equal(ownership.lanes[laneId].wave, wave, laneId);
    assert.equal(ownership.lanes[laneId].branch, `imessage/${laneId}`, laneId);
    assert.equal(ownership.lanes[laneId].worktree, `worktrees/${laneId}`, laneId);
  }
});

test("each owned feature path is denied to its neighboring lane", async () => {
  const ownership = JSON.parse(await readFile(new URL("../docs/imessage/ownership.json", import.meta.url), "utf8"));
  const laneIds = Object.keys(expectedOwnership());
  laneIds.forEach((laneId, index) => {
    const neighbor = laneIds[(index + 1) % laneIds.length];
    assert.ok(neighbor !== undefined);
    for (const path of ownership.lanes[laneId].ownedPaths) {
      if (path === `docs/imessage/lanes/${laneId}.md`) continue;
      assert.equal(
        ownership.lanes[neighbor].ownedPaths.some((pattern: string) => matches(path, pattern)),
        false,
        `${laneId}:${neighbor}:${path}`,
      );
    }
  });
});

test("feature ownership overlaps integration only for reviewed shared adaptations", async () => {
  const ownership = JSON.parse(await readFile(new URL("../docs/imessage/ownership.json", import.meta.url), "utf8"));
  const reviewedOverlaps = new Set([
    ...Array.from({ length: 6 }, (_, index) => `docs/imessage/lanes/wt-0${index + 1}.md`),
    "plugins/chassis/src/photon-state-records.ts",
    "plugins/chassis/src/photon-state-schema.ts",
    "plugins/chassis/src/photon-state.ts",
    "plugins/photon/src/state.ts",
    "plugins/photon/test/state.test.ts",
    "test/photon-state-postgres.test.ts",
  ]);
  for (const laneId of Object.keys(expectedOwnership())) {
    for (const path of ownership.lanes[laneId].ownedPaths) {
      assert.equal(
        ownership.integration.ownedPaths.some((pattern: string) => matches(path, pattern)),
        reviewedOverlaps.has(path),
        `${laneId}:${path}`,
      );
    }
  }
});

test("shared contracts are integration-owned and review lanes own no production implementation", async () => {
  const ownership = JSON.parse(await readFile(new URL("../docs/imessage/ownership.json", import.meta.url), "utf8"));
  for (const path of [
    "plugins/chassis/src/photon-contract.ts",
    "plugins/photon/src/ports.ts",
    "plugins/web-ui/src/photon/contracts.ts",
    "docs/imessage/contracts.md",
    "docs/deploy-directory.md",
    "cli/README.md",
    "plugins/web-ui/README.md",
    "plugins/admin/README.md",
  ]) {
    assert.equal(
      ownership.integration.ownedPaths.some((pattern: string) => matches(path, pattern)),
      true,
      path,
    );
  }
  for (const laneId of ["wt-23", "wt-24", "wt-25"]) {
    assert.equal(
      ownership.lanes[laneId].ownedPaths.some((path: string) =>
        /^(src|plugins\/(chassis|photon|web-ui)\/src|plugins\/admin\/src)\//u.test(path),
      ),
      false,
      laneId,
    );
  }
});

test("checkpoint repair preparation preserves the original lane ownership", async () => {
  const ownership = JSON.parse(await readFile(new URL("../docs/imessage/ownership.json", import.meta.url), "utf8"));
  assert.deepEqual(ownership.checkpointRepairs, {
    reviewedInput: "4b1ce5a8326979cb8cf59eb966df4906a901dd38",
    contract: "docs/imessage/repairs/contract.md",
    ownership: "docs/imessage/repairs/ownership.json",
    sharedStateModules: ["plugins/chassis/src/photon-state/db.ts", "plugins/chassis/src/photon-state/shared.ts"],
    focusedStateModules: {
      r02: "plugins/chassis/src/photon-state/bindings.ts",
      r03: "plugins/chassis/src/photon-state/receipts.ts",
      r04: "plugins/chassis/src/photon-state/deliveries.ts",
    },
    postgresHarness: "test/helpers/cp1-postgres.ts",
  });
});

test("checkpoint repair ownership is exclusive, complete, and based by dispatch record", async () => {
  const ownership = JSON.parse(
    await readFile(new URL("../docs/imessage/repairs/ownership.json", import.meta.url), "utf8"),
  );
  const repairIds = Array.from({ length: 14 }, (_, index) => `r${String(index + 1).padStart(2, "0")}`);
  assert.deepEqual(Object.keys(ownership.repairs), repairIds);
  assert.deepEqual(Object.keys(ownership.joins), ["r15", "r16"]);
  assert.deepEqual(ownership.repairBaseResolution, {
    record: "post-commit coordinator dispatch",
    recordPath: "cp1-repair-dispatch.json",
    resolveFrom: "git-common-dir",
    schemaVersion: 1,
    field: "repairBaseCommit",
    format: "40 lowercase hexadecimal characters",
    requiredForEveryRepair: true,
    requiredFields: ["schemaVersion", "reviewedInput", "repairBaseCommit", "repairs"],
  });
  assert.equal(ownership.schemaVersion, 1);
  assert.deepEqual(ownership.reviewedInput, {
    branch: "integration-1",
    commit: "4b1ce5a8326979cb8cf59eb966df4906a901dd38",
  });

  const branches = repairIds.map((repairId) => ownership.repairs[repairId].branch);
  const worktrees = repairIds.map((repairId) => ownership.repairs[repairId].worktree);
  assert.equal(new Set(branches).size, repairIds.length);
  assert.equal(new Set(worktrees).size, repairIds.length);

  for (const repairId of repairIds) {
    const repair = ownership.repairs[repairId];
    assert.equal(repair.base, "repairBaseCommit", repairId);
    assert.equal(repair.branch, `cp1/${repairId}`, repairId);
    assert.equal(repair.worktree, `worktrees/cp1-${repairId}`, repairId);
    assert.equal(repair.ownedPaths.includes(`docs/imessage/repairs/${repairId}.md`), true, repairId);
  }

  const tasks = Object.entries<{ ownedPaths: string[]; dependsOn?: string[] }>({
    ...ownership.repairs,
    ...ownership.joins,
  });
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const [leftId, left] = tasks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const [rightId, right] = tasks[rightIndex]!;
      for (const leftPath of left.ownedPaths) {
        assert.equal(
          right.ownedPaths.some((rightPath) => matches(leftPath, rightPath) || matches(rightPath, leftPath)),
          false,
          `${leftId}:${rightId}:${leftPath}`,
        );
      }
    }
    for (const leftPath of left.ownedPaths) {
      assert.equal(
        ownership.coordinator.ownedPaths.some(
          (coordinatorPath: string) => matches(leftPath, coordinatorPath) || matches(coordinatorPath, leftPath),
        ),
        false,
        `coordinator:${leftId}:${leftPath}`,
      );
    }
    for (const dependency of left.dependsOn ?? []) {
      assert.equal(
        tasks.some(([taskId]) => taskId === dependency),
        true,
        `${leftId}:${dependency}`,
      );
      assert.notEqual(dependency, leftId);
    }
  }

  const pending = new Set(tasks.map(([taskId]) => taskId));
  const complete = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending].filter((taskId) => {
      const task = tasks.find(([candidate]) => candidate === taskId)![1];
      return (task.dependsOn ?? []).every((dependency) => complete.has(dependency));
    });
    assert.ok(ready.length > 0, "repair dependency graph contains a cycle");
    for (const taskId of ready) {
      pending.delete(taskId);
      complete.add(taskId);
    }
  }

  assert.deepEqual(ownership.joins.r15.dependsOn, repairIds);
  assert.equal(ownership.joins.r16.dependsOn.at(-1), "r15");
  assert.deepEqual(ownership.coordinator.migrationReservations, {
    "photon/state/0002": ["coordinator"],
  });
  const manifestContract = {
    schemaVersion: ownership.schemaVersion,
    reviewedInput: ownership.reviewedInput,
    coordinator: ownership.coordinator,
    repairs: ownership.repairs,
    joins: ownership.joins,
  };
  assert.equal(
    createHash("sha256").update(JSON.stringify(manifestContract)).digest("hex"),
    "910dd26a2fdcfb8be9b0d0cb7162d19feb21df8b5f763262c22789863c16ad7c",
  );
});

test("lane typechecks cover every owned TypeScript package and real CI registration", async () => {
  const ownership = JSON.parse(await readFile(new URL("../docs/imessage/ownership.json", import.meta.url), "utf8"));
  assert.equal(ownership.integration.ownedPaths.includes(".github/workflows/cicd.yml"), true);
  assert.equal(ownership.integration.ownedPaths.includes(".github/workflows/ci.yml"), false);
  for (const laneId of Object.keys(expectedOwnership())) {
    const lane = ownership.lanes[laneId];
    assert.ok(Array.isArray(lane.typecheckPackages) && lane.typecheckPackages.length > 0, laneId);
    const requirements = [
      ["plugins/photon/", "plugins/photon"],
      ["plugins/web-ui/", "plugins/web-ui"],
      ["plugins/admin/", "plugins/admin"],
      ["cli/", "cli"],
    ] as const;
    for (const [prefix, packagePath] of requirements) {
      if (lane.ownedPaths.some((path: string) => path.endsWith(".ts") && path.startsWith(prefix))) {
        assert.equal(lane.typecheckPackages.includes(packagePath), true, `${laneId}:${packagePath}`);
      }
    }
  }
});

test("inventory evidence uses exact route literals and original representation lanes", async () => {
  const parity = JSON.parse(await readFile(new URL("../docs/imessage/parity.json", import.meta.url), "utf8"));
  const operation = (method: string, path: string) =>
    parity.operations.find((entry: { existingRoute: string }) => entry.existingRoute === `${method} ${path}`);
  assert.match(operation("POST", "/v1/keychain/drops").existingHandler, /src\/api\/routes\/secret-drop\.ts/u);
  assert.match(operation("POST", "/v1/admin/skill-packs").existingHandler, /src\/api\/routes\/skill-packs\.ts/u);
  assert.match(operation("POST", "/v1/files/upload").existingHandler, /src\/api\/routes\/surface\.ts/u);
  assert.equal(operation("GET", "/v1/sessions/:id/approvals").responsibleLane, "wt-18");
  assert.equal(operation("GET", "/v1/sessions/:id/background").responsibleLane, "wt-20");
  assert.equal(operation("GET", "/v1/runtime-config").responsibleLane, "wt-21");
  assert.equal(operation("PUT", "/v1/runtime-config").responsibleLane, "wt-21");
  assert.equal(operation("POST", "/v1/reach").responsibleLane, "wt-05");
  assert.deepEqual(operation("GET", "/healthz").infrastructureDependencies, []);
  assert.equal(operation("GET", "/v1/admin/whoami").existingView, null);
  assert.equal(operation("GET", "/healthz").existingView, null);
  assert.equal(operation("POST", "/v1/surface-context").responsibleLane, "wt-08");
  assert.equal(operation("POST", "/v1/surface-file").responsibleLane, "wt-08");
  assert.equal(
    operation("GET", "/healthz").existingRegressionTests.some((path: string) =>
      path.startsWith("test/imessage-foundation-"),
    ),
    false,
  );
  assert.ok(operation("GET", "/v1/runtime-config").plannedIMessageAcceptanceTests.length > 0);
  const unmapped = parity.operations.filter(
    (entry: { responsibleLane: string | null }) => entry.responsibleLane === null,
  );
  assert.ok(unmapped.length > 0);
  assert.ok(
    unmapped.every((entry: { responsibilityEvidence: string }) =>
      /No original lane mapping/u.test(entry.responsibilityEvidence),
    ),
  );
});
