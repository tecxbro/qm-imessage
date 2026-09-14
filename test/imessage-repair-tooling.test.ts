import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const { validateRepairProvenance } = (await import(
  new URL("../scripts/imessage-corrections.mjs", import.meta.url).href
)) as {
  validateRepairProvenance(options: {
    root: string;
    main: string;
    target: string;
    checkpoint: Record<string, unknown>;
    ownership: Record<string, any>;
  }): { paths: string[]; requiredTests: string[] };
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(commandName: string, args: string[], cwd: string) {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(cwd: string, ...args: string[]) {
  const result = command("git", args, cwd);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function write(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function commitAll(root: string, message: string) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

type RepairShape = {
  base?: string;
  branch?: string;
  worktree?: string;
  dependsOn?: string[];
  ownedPaths: string[];
};

async function createProvenanceFixture(
  repairOwnership: {
    repairs: Record<string, RepairShape>;
    joins?: Record<string, RepairShape>;
  },
  initialFiles: Record<string, string> = {},
) {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-repairs-"));
  const workspace = resolve(temporary, "workspace");
  const main = resolve(workspace, "main");
  await mkdir(main, { recursive: true });
  git(main, "init", "-b", "imessage/integration");
  git(main, "config", "user.name", "Fixture");
  git(main, "config", "user.email", "fixture@example.test");
  git(main, "remote", "add", "origin", "https://github.com/example/qm-imessage.git");
  await write(resolve(main, ".gitignore"), "worktrees/\n");
  await write(resolve(main, "reviewed.txt"), "reviewed\n");
  for (const [path, value] of Object.entries(initialFiles)) await write(resolve(main, path), value);
  const reviewed = commitAll(main, "reviewed input");
  const dispatchPath = resolve(main, ".git/dispatch.json");
  const ownershipPath = "docs/imessage/repairs/ownership.json";
  const repairDocument = {
    schemaVersion: 1,
    reviewedInput: { branch: "integration-1", commit: reviewed },
    repairBaseResolution: {
      recordPath: "dispatch.json",
      resolveFrom: "git-common-dir",
      schemaVersion: 1,
      field: "repairBaseCommit",
      requiredFields: ["schemaVersion", "reviewedInput", "repairBaseCommit", "repairs"],
    },
    coordinator: { branch: "cp1/coordinator", worktree: "." },
    repairs: repairOwnership.repairs,
    joins: repairOwnership.joins ?? {},
  };
  await write(resolve(main, ownershipPath), `${JSON.stringify(repairDocument, null, 2)}\n`);
  const repairBase = commitAll(main, "repair preparation");
  const dispatchRepairs = Object.fromEntries(
    Object.entries(repairOwnership.repairs).map(([repairId, entry]) => [
      repairId,
      {
        branch: entry.branch,
        worktree: resolve(main, entry.worktree!),
        baseCommit: repairBase,
      },
    ]),
  );
  await write(
    dispatchPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: "https://github.com/example/qm-imessage.git",
        integrationWorktree: main,
        integrationBranch: "cp1/coordinator",
        reviewedInput: reviewed,
        repairBaseCommit: repairBase,
        repairs: dispatchRepairs,
      },
      null,
      2,
    )}\n`,
  );
  const ownership = {
    repository: "https://github.com/example/qm-imessage.git",
    integration: { branch: "imessage/integration", worktree: "main" },
    checkpointRepairs: { reviewedInput: reviewed, ownership: ownershipPath },
  };
  return { temporary, workspace: main, main, reviewed, repairBase, dispatchPath, ownership, repairDocument };
}

async function repairCommit(root: string, branch: string, base: string, files: Record<string, string>) {
  git(root, "checkout", "-b", branch, base);
  for (const [path, value] of Object.entries(files)) await write(resolve(root, path), value);
  return commitAll(root, branch);
}

async function mergeCandidate(root: string, base: string, commits: string[]) {
  git(root, "checkout", "-B", "imessage/integration", base);
  for (const commit of commits) git(root, "merge", "--no-ff", "--no-edit", commit);
  return git(root, "rev-parse", "HEAD");
}

function validate(
  fixture: Awaited<ReturnType<typeof createProvenanceFixture>>,
  target: string,
  repairContributions: Array<{ repairId: string; baseCommit: string; commit: string }>,
) {
  registerRepairWorktrees(fixture.main, fixture.workspace, fixture.repairDocument, repairContributions);
  return validateRepairProvenance({
    root: fixture.main,
    main: fixture.main,
    target,
    checkpoint: { repairContributions },
    ownership: fixture.ownership,
  });
}

function registerRepairWorktrees(
  main: string,
  workspace: string,
  repairOwnership: { repairs: Record<string, RepairShape> },
  contributions: Array<{ repairId: string; commit: string }>,
) {
  mkdirSync(resolve(workspace, "worktrees"), { recursive: true });
  for (const contribution of contributions) {
    const repair = repairOwnership.repairs[contribution.repairId];
    if (repair === undefined) continue;
    const worktree = resolve(workspace, repair.worktree!);
    if (existsSync(worktree)) git(main, "worktree", "remove", "--force", worktree);
    git(main, "branch", "-f", repair.branch!, contribution.commit);
    git(main, "worktree", "add", worktree, repair.branch!);
  }
}

test("repair provenance accepts disjoint siblings and derives their required tests", async (context) => {
  const fixture = await createProvenanceFixture({
    repairs: {
      r01: {
        branch: "cp1/r01",
        worktree: "worktrees/cp1-r01",
        ownedPaths: ["src/one.ts", "test/one.test.ts"],
      },
      r02: {
        branch: "cp1/r02",
        worktree: "worktrees/cp1-r02",
        ownedPaths: ["src/two.ts", "test/two.test.ts"],
      },
    },
  });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const one = await repairCommit(fixture.main, "cp1/r01", fixture.repairBase, {
    "src/one.ts": "export const one = true;\n",
    "test/one.test.ts": "import test from 'node:test'; test('one', () => {});\n",
  });
  const two = await repairCommit(fixture.main, "cp1/r02", fixture.repairBase, {
    "src/two.ts": "export const two = true;\n",
    "test/two.test.ts": "import test from 'node:test'; test('two', () => {});\n",
  });
  const target = await mergeCandidate(fixture.main, fixture.repairBase, [one, two]);
  assert.throws(() => validate(fixture, target, []), /REPAIR_CONTRIBUTIONS_MISSING/u);
  const result = validate(fixture, target, [
    { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
    { repairId: "r02", baseCommit: fixture.repairBase, commit: two },
  ]);
  assert.deepEqual(result.paths, ["src/one.ts", "src/two.ts", "test/one.test.ts", "test/two.test.ts"]);
  assert.deepEqual(result.requiredTests, ["test/one.test.ts", "test/two.test.ts"]);
  assert.throws(
    () => validate(fixture, target, [{ repairId: "r01", baseCommit: fixture.repairBase, commit: one }]),
    /REPAIR_CONTRIBUTIONS_MISSING:src\/two\.ts/u,
  );
  git(fixture.main, "worktree", "remove", "--force", resolve(fixture.workspace, "worktrees/cp1-r01"));
  assert.throws(
    () =>
      validateRepairProvenance({
        root: fixture.main,
        main: fixture.main,
        target,
        checkpoint: {
          repairContributions: [
            { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
            { repairId: "r02", baseCommit: fixture.repairBase, commit: two },
          ],
        },
        ownership: fixture.ownership,
      }),
    /REPAIR_WORKTREE_PATH_INVALID:r01/u,
  );
  await writeFile(resolve(fixture.main, "dirty.txt"), "dirty\n");
  assert.throws(() => validate(fixture, target, []), /REPAIR_CANDIDATE_DIRTY/u);
});

test("repair provenance rejects same-path siblings and accepts an explicit resolving contribution", async (context) => {
  const fixture = await createProvenanceFixture({
    repairs: {
      r01: { branch: "cp1/r01", worktree: "worktrees/cp1-r01", ownedPaths: ["src/shared.ts"] },
      r02: { branch: "cp1/r02", worktree: "worktrees/cp1-r02", ownedPaths: ["src/shared.ts"] },
    },
    joins: {
      resolve: { dependsOn: ["r01", "r02"], ownedPaths: ["src/shared.ts"] },
    },
  });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const one = await repairCommit(fixture.main, "cp1/r01", fixture.repairBase, {
    "src/shared.ts": "export const value = 1;\n",
  });
  const two = await repairCommit(fixture.main, "cp1/r02", fixture.repairBase, {
    "src/shared.ts": "export const value = 2;\n",
  });
  git(fixture.main, "checkout", "-B", "imessage/integration", fixture.repairBase);
  git(fixture.main, "merge", "--no-ff", "--no-edit", one);
  git(fixture.main, "merge", "--no-ff", "-s", "ours", "--no-edit", two);
  const unresolved = git(fixture.main, "rev-parse", "HEAD");
  assert.throws(
    () =>
      validate(fixture, unresolved, [
        { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
        { repairId: "r02", baseCommit: fixture.repairBase, commit: two },
      ]),
    /UNRESOLVED_REPAIR_PATH:src\/shared\.ts/u,
  );
  git(fixture.main, "checkout", "-B", "resolution", fixture.repairBase);
  git(fixture.main, "merge", "--no-ff", "--no-edit", one);
  const conflict = command("git", ["merge", "--no-ff", "--no-edit", two], fixture.main);
  assert.notEqual(conflict.status, 0);
  await write(resolve(fixture.main, "src/shared.ts"), "export const value = 3;\n");
  const resolved = commitAll(fixture.main, "resolve sibling repairs");
  git(fixture.main, "checkout", "-B", "imessage/integration", resolved);
  const accepted = validate(fixture, resolved, [
    { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
    { repairId: "r02", baseCommit: fixture.repairBase, commit: two },
    { repairId: "resolve", baseCommit: fixture.repairBase, commit: resolved },
  ]);
  assert.deepEqual(accepted.paths, ["src/shared.ts"]);
});

test("repair provenance rejects an undeclared same-path dependency", async (context) => {
  const fixture = await createProvenanceFixture({
    repairs: {
      r01: { branch: "cp1/r01", worktree: "worktrees/cp1-r01", ownedPaths: ["src/shared.ts"] },
      r02: { branch: "cp1/r02", worktree: "worktrees/cp1-r02", ownedPaths: ["src/shared.ts"] },
    },
  });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const one = await repairCommit(fixture.main, "cp1/r01", fixture.repairBase, {
    "src/shared.ts": "export const value = 1;\n",
  });
  const two = await repairCommit(fixture.main, "cp1/r02", one, {
    "src/shared.ts": "export const value = 2;\n",
  });
  git(fixture.main, "checkout", "-B", "imessage/integration", two);
  assert.throws(
    () =>
      validate(fixture, two, [
        { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
        { repairId: "r02", baseCommit: fixture.repairBase, commit: two },
      ]),
    /REPAIR_PATH_DEPENDENCY_MISSING:r02:src\/shared\.ts:r01/u,
  );
});

test("repair provenance accepts a declared dependent chain", async (context) => {
  const fixture = await createProvenanceFixture({
    repairs: {
      r01: { branch: "cp1/r01", worktree: "worktrees/cp1-r01", ownedPaths: ["src/one.ts"] },
    },
    joins: {
      followup: { dependsOn: ["r01"], ownedPaths: ["src/two.ts"] },
    },
  });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const one = await repairCommit(fixture.main, "cp1/r01", fixture.repairBase, {
    "src/one.ts": "export const one = true;\n",
  });
  const followup = await repairCommit(fixture.main, "followup", one, {
    "src/two.ts": "export const two = true;\n",
  });
  git(fixture.main, "checkout", "-B", "imessage/integration", followup);
  const result = validate(fixture, followup, [
    { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
    { repairId: "followup", baseCommit: one, commit: followup },
  ]);
  assert.deepEqual(result.paths, ["src/one.ts", "src/two.ts"]);
  const unrecorded = await repairCommit(fixture.main, "unrecorded", one, {
    "src/two.ts": "export const two = 'unrecorded';\n",
  });
  const recorded = await repairCommit(fixture.main, "recorded", unrecorded, {
    "src/two.ts": "export const two = 'recorded';\n",
  });
  git(fixture.main, "checkout", "-B", "imessage/integration", recorded);
  assert.throws(
    () =>
      validate(fixture, recorded, [
        { repairId: "r01", baseCommit: fixture.repairBase, commit: one },
        { repairId: "followup", baseCommit: unrecorded, commit: recorded },
      ]),
    /REPAIR_INTERVENING_BASE_DRIFT:src\/two\.ts/u,
  );
});

test("repair provenance rejects sibling deletion and rename ambiguity", async (context) => {
  const fixture = await createProvenanceFixture(
    {
      repairs: {
        r01: { branch: "cp1/r01", worktree: "worktrees/cp1-r01", ownedPaths: ["src/original.ts"] },
        r02: {
          branch: "cp1/r02",
          worktree: "worktrees/cp1-r02",
          ownedPaths: ["src/original.ts", "src/renamed.ts"],
        },
      },
    },
    { "src/original.ts": "export const original = true;\n" },
  );
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  git(fixture.main, "checkout", "-b", "cp1/r01", fixture.repairBase);
  git(fixture.main, "rm", "src/original.ts");
  const deleted = commitAll(fixture.main, "delete original");
  git(fixture.main, "checkout", "-b", "cp1/r02", fixture.repairBase);
  git(fixture.main, "mv", "src/original.ts", "src/renamed.ts");
  const renamed = commitAll(fixture.main, "rename original");
  git(fixture.main, "checkout", "-B", "imessage/integration", fixture.repairBase);
  git(fixture.main, "merge", "--no-ff", "--no-edit", deleted);
  git(fixture.main, "merge", "--no-ff", "-s", "ours", "--no-edit", renamed);
  const target = git(fixture.main, "rev-parse", "HEAD");
  assert.throws(
    () =>
      validate(fixture, target, [
        { repairId: "r01", baseCommit: fixture.repairBase, commit: deleted },
        { repairId: "r02", baseCommit: fixture.repairBase, commit: renamed },
      ]),
    /UNRESOLVED_REPAIR_PATH:src\/original\.ts/u,
  );
});

test("repair provenance rejects ancestry, ownership, mode, rename ambiguity, moved records, and dirt", async (context) => {
  const fixture = await createProvenanceFixture({
    repairs: {
      r01: { branch: "cp1/r01", worktree: "worktrees/cp1-r01", ownedPaths: ["src/one.ts"] },
      r02: {
        branch: "cp1/r02",
        worktree: "worktrees/cp1-r02",
        ownedPaths: ["src/one.ts", "src/two.ts"],
      },
    },
  });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const unowned = await repairCommit(fixture.main, "cp1/r01", fixture.repairBase, {
    "src/not-owned.ts": "export const no = true;\n",
  });
  git(fixture.main, "checkout", "-B", "imessage/integration", unowned);
  assert.throws(
    () => validate(fixture, unowned, [{ repairId: "r01", baseCommit: fixture.repairBase, commit: unowned }]),
    /REPAIR_UNOWNED_PATHS:r01:src\/not-owned\.ts/u,
  );
  const one = await repairCommit(fixture.main, "valid-r01", fixture.repairBase, {
    "src/one.ts": "export const one = true;\n",
  });
  git(fixture.main, "checkout", "-B", "imessage/integration", one);
  assert.throws(
    () => validate(fixture, one, [{ repairId: "r01", baseCommit: fixture.reviewed, commit: one }]),
    /REPAIR_CONTRIBUTION_ANCESTRY/u,
  );
  await chmod(resolve(fixture.main, "src/one.ts"), 0o755);
  const modeDrift = commitAll(fixture.main, "unrecorded mode drift");
  assert.throws(
    () => validate(fixture, modeDrift, [{ repairId: "r01", baseCommit: fixture.repairBase, commit: one }]),
    /REPAIR_CONTRIBUTION_DRIFT:src\/one\.ts/u,
  );
  const dispatch = JSON.parse(await readFile(fixture.dispatchPath, "utf8"));
  dispatch.repairBaseCommit = fixture.reviewed;
  for (const entry of Object.values(dispatch.repairs) as Array<Record<string, string>>) {
    entry.baseCommit = fixture.reviewed;
  }
  await writeFile(fixture.dispatchPath, `${JSON.stringify(dispatch, null, 2)}\n`);
  assert.throws(
    () => validate(fixture, modeDrift, [{ repairId: "r01", baseCommit: fixture.repairBase, commit: one }]),
    /REPAIR_BASE_RECORD_MOVED/u,
  );
  dispatch.repairBaseCommit = fixture.repairBase;
  for (const entry of Object.values(dispatch.repairs) as Array<Record<string, string>>) {
    entry.baseCommit = fixture.repairBase;
  }
  await writeFile(fixture.dispatchPath, `${JSON.stringify(dispatch, null, 2)}\n`);
  await writeFile(resolve(fixture.main, "dirty.txt"), "dirty\n");
  assert.throws(
    () => validate(fixture, modeDrift, [{ repairId: "r01", baseCommit: fixture.repairBase, commit: one }]),
    /REPAIR_CANDIDATE_DIRTY/u,
  );
});

async function createScriptFixture(options: { omitTest?: boolean } = {}) {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-repair-flow-"));
  const workspace = resolve(temporary, "workspace");
  const main = resolve(workspace, "main");
  await mkdir(main, { recursive: true });
  git(main, "init", "-b", "imessage/integration");
  git(main, "config", "user.name", "Fixture");
  git(main, "config", "user.email", "fixture@example.test");
  git(main, "remote", "add", "origin", "https://github.com/example/qm-imessage.git");
  await write(resolve(main, ".gitignore"), "worktrees/\n");
  for (const path of ["imessage-verify-lane.mjs", "imessage-worktrees.mjs", "imessage-corrections.mjs"]) {
    await write(resolve(main, `scripts/${path}`), await readFile(resolve(repositoryRoot, `scripts/${path}`), "utf8"));
  }
  await write(resolve(main, "scripts/imessage-sources.mjs"), "process.stdout.write('VALID:fixture\\n');\n");
  await write(resolve(main, "test/pass.test.ts"), "import test from 'node:test'; test('pass', () => {});\n");
  await write(resolve(main, "package-lock.json"), "{}\n");
  await write(resolve(main, "lane/one.ts"), "export const one = false;\n");
  const foundation = commitAll(main, "foundation");
  git(main, "tag", "fixture-base", foundation);
  git(main, "checkout", "-b", "imessage/wt-01", foundation);
  await write(resolve(main, "lane/one.ts"), "export const one = true;\n");
  await write(resolve(main, "docs/imessage/lanes/wt-01.md"), "lane one\n");
  const laneCommit = commitAll(main, "lane one");
  git(main, "checkout", "imessage/integration");
  git(main, "merge", "--no-ff", "--no-edit", laneCommit);
  const reviewed = git(main, "rev-parse", "HEAD");
  const dispatchPath = resolve(main, ".git/dispatch.json");
  const repairOwnership = {
    schemaVersion: 1,
    reviewedInput: { branch: "integration-1", commit: reviewed },
    repairBaseResolution: {
      recordPath: "dispatch.json",
      resolveFrom: "git-common-dir",
      schemaVersion: 1,
      field: "repairBaseCommit",
      requiredFields: ["schemaVersion", "reviewedInput", "repairBaseCommit", "repairs"],
    },
    coordinator: { branch: "cp1/coordinator", worktree: "." },
    repairs: {
      r01: {
        base: "repairBaseCommit",
        branch: "cp1/r01",
        worktree: "worktrees/cp1-r01",
        ownedPaths: ["lane/one.ts", "test/repair-one.test.ts"],
      },
      r02: {
        base: "repairBaseCommit",
        branch: "cp1/r02",
        worktree: "worktrees/cp1-r02",
        ownedPaths: ["repair/two.ts", "test/repair-two.test.ts"],
      },
    },
    joins: {},
  };
  const ownership = {
    schemaVersion: 2,
    repository: "https://github.com/example/qm-imessage.git",
    originalBaseline: foundation,
    reviewedFoundationCommit: foundation,
    integration: {
      branch: "imessage/integration",
      worktree: "main",
      baseRef: "fixture-base",
      foundationCheckpoint: "docs/imessage/integration/foundation-checkpoint-r2.json",
      testFiles: ["test/pass.test.ts"],
      typecheckPackages: [],
      ownedPaths: ["docs/imessage/**", "docs/imessage/ownership.json"],
    },
    checkpointRepairs: {
      reviewedInput: reviewed,
      ownership: "docs/imessage/repairs/ownership.json",
    },
    lanes: {
      "wt-01": {
        wave: "A",
        branch: "imessage/wt-01",
        worktree: "worktrees/wt-01",
        baseRef: "fixture-base",
        baseCommit: foundation,
        ownedPaths: ["lane/one.ts", "docs/imessage/lanes/wt-01.md"],
        testFiles: ["test/pass.test.ts"],
        typecheckPackages: [],
      },
      "wt-07": {
        wave: "B",
        branch: "imessage/wt-07",
        worktree: "worktrees/wt-07",
        baseRef: "fixture-f1",
        ownedPaths: ["test/pass.test.ts"],
        testFiles: ["test/pass.test.ts"],
        typecheckPackages: [],
      },
    },
  };
  await write(resolve(main, "docs/imessage/ownership.json"), `${JSON.stringify(ownership, null, 2)}\n`);
  await write(
    resolve(main, "docs/imessage/integration/foundation-checkpoint-r2.json"),
    `${JSON.stringify({ tag: "fixture-base", tagTarget: foundation, implementationCommit: foundation }, null, 2)}\n`,
  );
  await write(resolve(main, "docs/imessage/repairs/ownership.json"), `${JSON.stringify(repairOwnership, null, 2)}\n`);
  const repairBase = commitAll(main, "repair preparation");
  const dispatchRepairs = Object.fromEntries(
    Object.entries(repairOwnership.repairs).map(([repairId, entry]) => [
      repairId,
      { branch: entry.branch, worktree: resolve(main, entry.worktree), baseCommit: repairBase },
    ]),
  );
  await write(
    dispatchPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: ownership.repository,
        integrationWorktree: main,
        integrationBranch: repairOwnership.coordinator.branch,
        reviewedInput: reviewed,
        repairBaseCommit: repairBase,
        repairs: dispatchRepairs,
      },
      null,
      2,
    )}\n`,
  );
  const one = await repairCommit(main, "cp1/r01", repairBase, {
    "lane/one.ts": "export const one = 'repaired';\n",
    "test/repair-one.test.ts": "import test from 'node:test'; test('repair one', () => {});\n",
  });
  const two = await repairCommit(main, "cp1/r02", repairBase, {
    "repair/two.ts": "export const two = true;\n",
    "test/repair-two.test.ts": "import test from 'node:test'; test('repair two', () => {});\n",
  });
  await mergeCandidate(main, repairBase, [one, two]);
  const checkpointInput = {
    inputBaseCommit: foundation,
    laneContributions: [{ laneId: "wt-01", baseCommit: foundation, commit: laneCommit }],
    repairContributions: [
      { repairId: "r01", baseCommit: repairBase, commit: one },
      { repairId: "r02", baseCommit: repairBase, commit: two },
    ],
    testFiles: options.omitTest
      ? ["test/pass.test.ts", "test/repair-one.test.ts"]
      : ["test/pass.test.ts", "test/repair-one.test.ts", "test/repair-two.test.ts"],
    typecheckPackages: [],
  };
  await write(
    resolve(main, "docs/imessage/integration/checkpoint-1-input.json"),
    `${JSON.stringify(checkpointInput, null, 2)}\n`,
  );
  const target = commitAll(main, "capture checkpoint one input");
  registerRepairWorktrees(main, main, repairOwnership, [
    { repairId: "r01", commit: one },
    { repairId: "r02", commit: two },
  ]);
  const integrationVerification = command(
    process.execPath,
    [
      "scripts/imessage-verify-lane.mjs",
      "integration",
      "--checkpoint",
      "docs/imessage/integration/checkpoint-1-input.json",
    ],
    main,
  );
  git(main, "tag", "fixture-f1", target);
  const checkpoint = {
    schemaVersion: 1,
    tag: "fixture-f1",
    tagTarget: target,
    implementationCommit: target,
    ...checkpointInput,
  };
  const checkpointPath = resolve(main, "docs/imessage/integration/checkpoint-1.json");
  await write(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  commitAll(main, "capture checkpoint one");
  return { temporary, workspace, main, target, checkpointPath, integrationVerification };
}

test("integration verification and Wave B preparation accept the same repaired candidate", async (context) => {
  const fixture = await createScriptFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const verified = fixture.integrationVerification;
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /VERIFIED:integration/u);
  const prepared = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    fixture.main,
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(git(resolve(fixture.workspace, "worktrees/wt-07"), "rev-parse", "HEAD"), fixture.target);
});

test("repair-aware scripts reject omitted tests, moved tags, modified checkpoints, and dirty candidates", async (context) => {
  const omitted = await createScriptFixture({ omitTest: true });
  context.after(() => rm(omitted.temporary, { recursive: true, force: true }));
  const omittedResult = omitted.integrationVerification;
  assert.match(omittedResult.stderr, /WAVE_A_TEST_SCOPE_MISMATCH|INTEGRATION_TEST_SCOPE_MISMATCH/u);
  await write(resolve(omitted.main, "dirty.txt"), "dirty\n");
  const dirtyResult = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/checkpoint-1.json"],
    omitted.main,
  );
  assert.match(dirtyResult.stderr, /REPAIR_CANDIDATE_DIRTY/u);

  const moved = await createScriptFixture();
  context.after(() => rm(moved.temporary, { recursive: true, force: true }));
  git(moved.main, "tag", "-f", "fixture-f1", "HEAD");
  const movedResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    moved.main,
  );
  assert.match(movedResult.stderr, /WAVE_CHECKPOINT_MISMATCH/u);

  const modified = await createScriptFixture();
  context.after(() => rm(modified.temporary, { recursive: true, force: true }));
  await writeFile(modified.checkpointPath, `${await readFile(modified.checkpointPath, "utf8")} `);
  commitAll(modified.main, "modify checkpoint");
  const modifiedResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    modified.main,
  );
  assert.match(modifiedResult.stderr, /WAVE_CHECKPOINT_MUTATED/u);
});
