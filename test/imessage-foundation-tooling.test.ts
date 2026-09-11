import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const { changedPaths, requireBase, runTestFiles, runTypechecks } = (await import(
  new URL("../scripts/imessage-verify-lane.mjs", import.meta.url).href
)) as {
  changedPaths(root: string, base: string): string[];
  requireBase(root: string, ref: string, expectedCommit?: string): string;
  runTestFiles(root: string, testFiles: string[]): void;
  runTypechecks(root: string, packages: string[]): void;
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

async function createRepository() {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-foundation-"));
  const workspace = resolve(temporary, "workspace");
  const main = resolve(workspace, "main");
  await mkdir(resolve(main, "scripts"), { recursive: true });
  await mkdir(resolve(main, "docs/imessage/integration"), { recursive: true });
  await mkdir(resolve(main, "test"), { recursive: true });
  await copyFile(
    resolve(repositoryRoot, "scripts/imessage-verify-lane.mjs"),
    resolve(main, "scripts/imessage-verify-lane.mjs"),
  );
  await copyFile(
    resolve(repositoryRoot, "scripts/imessage-worktrees.mjs"),
    resolve(main, "scripts/imessage-worktrees.mjs"),
  );
  await writeFile(resolve(main, "scripts/imessage-sources.mjs"), "process.stdout.write('VALID:fixture\\n');\n");
  await writeFile(resolve(main, "test/pass.test.ts"), "import test from 'node:test'; test('pass', () => {});\n");
  await writeFile(resolve(main, ".gitignore"), "node_modules/\n");
  await writeFile(resolve(main, "package-lock.json"), "{}\n");
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Fixture");
  git(main, "config", "user.email", "fixture@example.test");
  git(main, "remote", "add", "origin", "https://github.com/example/qm-imessage.git");
  const ownership = {
    schemaVersion: 2,
    repository: "https://github.com/example/qm-imessage.git",
    originalBaseline: "pending",
    reviewedFoundationCommit: "pending",
    integration: {
      branch: "imessage/integration",
      worktree: "worktrees/wt-integration",
      baseRef: "fixture-base",
      foundationCheckpoint: "docs/imessage/integration/foundation-checkpoint.json",
      testFiles: ["test/pass.test.ts"],
      typecheckPackages: [],
      ownedPaths: ["docs/imessage/integration/**", "docs/imessage/ownership.json", "test/*.test.ts"],
    },
    lanes: {
      "wt-01": {
        wave: "A",
        branch: "imessage/wt-01",
        worktree: "worktrees/wt-01",
        baseRef: "fixture-base",
        ownedPaths: ["lane/one.ts", "docs/imessage/lanes/wt-01.md", "test/pass.test.ts"],
        testFiles: ["test/pass.test.ts"],
      },
    },
  };
  await writeFile(resolve(main, "docs/imessage/ownership.json"), `${JSON.stringify(ownership, null, 2)}\n`);
  git(main, "add", ".");
  git(main, "commit", "-m", "fixture input base");
  const base = git(main, "rev-parse", "HEAD");
  const ownershipPath = resolve(main, "docs/imessage/ownership.json");
  const recorded = JSON.parse(await readFile(ownershipPath, "utf8"));
  recorded.reviewedFoundationCommit = base;
  await writeFile(ownershipPath, `${JSON.stringify(recorded, null, 2)}\n`);
  git(main, "add", ".");
  git(main, "commit", "-m", "fixture foundation");
  const foundation = git(main, "rev-parse", "HEAD");
  git(main, "tag", "fixture-base", foundation);
  return { temporary, workspace, main, base, foundation, ownership: recorded };
}

async function createIntegrationFixture() {
  const fixture = await createRepository();
  const worktree = resolve(fixture.workspace, "worktrees/wt-integration");
  git(fixture.main, "worktree", "add", "-b", "imessage/integration", worktree, fixture.foundation);
  await mkdir(resolve(worktree, "docs/imessage/integration"), { recursive: true });
  await writeFile(resolve(worktree, "docs/imessage/integration/checkpoint.md"), "assembled fixture\n");
  await writeFile(
    resolve(worktree, "docs/imessage/integration/foundation-checkpoint.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        tag: "fixture-base",
        tagTarget: fixture.foundation,
        implementationCommit: fixture.foundation,
      },
      null,
      2,
    )}\n`,
  );
  const ownershipPath = resolve(worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.lanes["wt-01"].baseCommit = fixture.foundation;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await writeFile(
    resolve(worktree, "docs/imessage/integration/fixture.json"),
    `${JSON.stringify(
      { inputBaseCommit: fixture.base, laneContributions: [], testFiles: ["test/pass.test.ts"], typecheckPackages: [] },
      null,
      2,
    )}\n`,
  );
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "fixture integration");
  return { ...fixture, worktree };
}

test("integration verification accepts an assembled candidate and rejects unowned changes", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  git(fixture.main, "branch", "fixture-base", fixture.base);
  const valid = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /VERIFIED:integration/u);
  await writeFile(resolve(fixture.worktree, "unowned.ts"), "export const value = 1;\n");
  const invalid = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /UNOWNED_PATHS:integration:unowned\.ts/u);
});

test("integration verification binds its input base and mandatory verification scope", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const checkpointPath = resolve(fixture.worktree, "docs/imessage/integration/fixture.json");
  const head = git(fixture.worktree, "rev-parse", "HEAD");
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      { inputBaseCommit: head, laneContributions: [], testFiles: ["test/pass.test.ts"], typecheckPackages: [] },
      null,
      2,
    )}\n`,
  );
  const unrecorded = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(unrecorded.stderr, /INPUT_BASE_NOT_RECORDED/u);
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      { inputBaseCommit: fixture.base, laneContributions: [], testFiles: [], typecheckPackages: [] },
      null,
      2,
    )}\n`,
  );
  const missingTests = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(missingTests.stderr, /INTEGRATION_TEST_SCOPE_MISMATCH/u);
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.integration.typecheckPackages = ["."];
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      {
        inputBaseCommit: fixture.base,
        laneContributions: [],
        testFiles: ["test/pass.test.ts"],
        typecheckPackages: [],
      },
      null,
      2,
    )}\n`,
  );
  const missingTypecheck = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(missingTypecheck.stderr, /INTEGRATION_TYPECHECK_SCOPE_MISMATCH/u);
});

test("ordinary lane verification enforces lane identity and propagates its failing root test", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const lanePath = resolve(fixture.workspace, "worktrees/wt-01");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", lanePath, fixture.foundation);
  await mkdir(resolve(lanePath, "docs/imessage/lanes"), { recursive: true });
  await writeFile(resolve(lanePath, "docs/imessage/lanes/wt-01.md"), "lane fixture\n");
  git(lanePath, "add", ".");
  git(lanePath, "commit", "-m", "fixture valid lane");
  const valid = command(process.execPath, ["scripts/imessage-verify-lane.mjs", "wt-01"], lanePath);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /VERIFIED:wt-01/u);
  await writeFile(
    resolve(lanePath, "test/pass.test.ts"),
    "import test from 'node:test'; test('intentional lane failure', () => { throw new Error('lane-red'); });\n",
  );
  git(lanePath, "add", ".");
  git(lanePath, "commit", "-m", "fixture failing lane test");
  const failing = command(process.execPath, ["scripts/imessage-verify-lane.mjs", "wt-01"], lanePath);
  assert.notEqual(failing.status, 0);
  assert.match(`${failing.stdout}\n${failing.stderr}`, /lane-red|COMMAND_FAILED/u);
});

test("integration verification rejects wrong branch, path, origin, and missing input commits", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  git(fixture.worktree, "switch", "-c", "wrong-branch");
  const wrongBranch = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(wrongBranch.stderr, /BRANCH_MISMATCH/u);
  git(fixture.worktree, "switch", "imessage/integration");
  git(fixture.worktree, "remote", "set-url", "origin", "https://github.com/example/wrong.git");
  const wrongOrigin = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(wrongOrigin.stderr, /ORIGIN_MISMATCH/u);
  git(fixture.worktree, "remote", "set-url", "origin", "https://github.com/example/qm-imessage.git");
  await writeFile(
    resolve(fixture.worktree, "docs/imessage/integration/fixture.json"),
    `${JSON.stringify({ inputBaseCommit: "0".repeat(40), laneContributions: [], testFiles: ["test/pass.test.ts"] })}\n`,
  );
  const missingBase = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(missingBase.stderr, /INPUT_BASE_MISSING/u);
  const tree = git(fixture.worktree, "rev-parse", "HEAD^{tree}");
  const unrelated = git(fixture.worktree, "commit-tree", tree, "-m", "unrelated fixture");
  await writeFile(
    resolve(fixture.worktree, "docs/imessage/integration/fixture.json"),
    `${JSON.stringify({ inputBaseCommit: unrelated, laneContributions: [], testFiles: ["test/pass.test.ts"] })}\n`,
  );
  const nonAncestor = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(nonAncestor.stderr, /INPUT_BASE_NOT_RECORDED|INPUT_BASE_NOT_ANCESTOR/u);
  const outside = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "../outside.json"],
    fixture.worktree,
  );
  assert.match(outside.stderr, /INTEGRATION_CHECKPOINT_OUTSIDE_REPOSITORY/u);
  await writeFile(
    resolve(fixture.worktree, "docs/imessage/integration/fixture.json"),
    `${JSON.stringify({ inputBaseCommit: fixture.base, laneContributions: [], testFiles: ["test/pass.test.ts"] })}\n`,
  );
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.integration.worktree = "worktrees/wrong";
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  const wrongPath = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(wrongPath.stderr, /WORKTREE_PATH_MISMATCH/u);
});

test("verification and preparation reject symbolic checkpoint files", async (context) => {
  const verification = await createIntegrationFixture();
  context.after(() => rm(verification.temporary, { recursive: true, force: true }));
  const integrationCheckpoint = resolve(verification.worktree, "docs/imessage/integration/fixture.json");
  const outsideIntegrationCheckpoint = resolve(verification.temporary, "fixture.json");
  await rename(integrationCheckpoint, outsideIntegrationCheckpoint);
  await symlink(outsideIntegrationCheckpoint, integrationCheckpoint);
  const verificationResult = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    verification.worktree,
  );
  assert.match(verificationResult.stderr, /INTEGRATION_CHECKPOINT_NOT_REGULAR/u);

  const preparation = await createIntegrationFixture();
  context.after(() => rm(preparation.temporary, { recursive: true, force: true }));
  const foundationCheckpoint = resolve(preparation.worktree, "docs/imessage/integration/foundation-checkpoint.json");
  const outsideFoundationCheckpoint = resolve(preparation.temporary, "foundation-checkpoint.json");
  await rename(foundationCheckpoint, outsideFoundationCheckpoint);
  await symlink(outsideFoundationCheckpoint, foundationCheckpoint);
  git(preparation.worktree, "add", ".");
  git(preparation.worktree, "commit", "-m", "fixture symbolic foundation checkpoint");
  const preparationResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    preparation.worktree,
  );
  assert.match(preparationResult.stderr, /WAVE_CHECKPOINT_INVALID/u);
});

test("integration verification rejects lane-owned content changed after its captured commit", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const lanePath = resolve(fixture.workspace, "worktrees/wt-01");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", lanePath, fixture.foundation);
  await mkdir(resolve(lanePath, "lane"), { recursive: true });
  await writeFile(resolve(lanePath, "lane/one.ts"), "export const laneValue = 1;\n");
  git(lanePath, "add", ".");
  git(lanePath, "commit", "-m", "fixture lane contribution");
  const laneCommit = git(lanePath, "rev-parse", "HEAD");
  git(fixture.worktree, "merge", "--no-edit", laneCommit);
  await writeFile(resolve(fixture.worktree, "lane/one.ts"), "export const laneValue = 2;\n");
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture integration drift");
  await writeFile(
    resolve(fixture.worktree, "docs/imessage/integration/fixture.json"),
    `${JSON.stringify(
      {
        inputBaseCommit: fixture.base,
        laneContributions: [{ laneId: "wt-01", baseCommit: fixture.foundation, commit: laneCommit }],
        testFiles: ["test/pass.test.ts"],
        typecheckPackages: [],
      },
      null,
      2,
    )}\n`,
  );
  const result = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(result.stderr, /LANE_CONTRIBUTION_DRIFT:wt-01:lane\/one\.ts/u);
});

test("integration verification requires the captured lane commit in assembled history", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const lanePath = resolve(fixture.workspace, "worktrees/wt-01");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", lanePath, fixture.foundation);
  await mkdir(resolve(lanePath, "lane"), { recursive: true });
  await writeFile(resolve(lanePath, "lane/one.ts"), "export const laneValue = 1;\n");
  git(lanePath, "add", ".");
  git(lanePath, "commit", "-m", "fixture unassembled lane contribution");
  const laneCommit = git(lanePath, "rev-parse", "HEAD");
  await mkdir(resolve(fixture.worktree, "lane"), { recursive: true });
  await writeFile(resolve(fixture.worktree, "lane/one.ts"), "export const laneValue = 1;\n");
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture copied lane bytes");
  await writeFile(
    resolve(fixture.worktree, "docs/imessage/integration/fixture.json"),
    `${JSON.stringify(
      {
        inputBaseCommit: fixture.base,
        laneContributions: [{ laneId: "wt-01", baseCommit: fixture.foundation, commit: laneCommit }],
        testFiles: ["test/pass.test.ts"],
        typecheckPackages: [],
      },
      null,
      2,
    )}\n`,
  );
  const result = command(
    process.execPath,
    ["scripts/imessage-verify-lane.mjs", "integration", "--checkpoint", "docs/imessage/integration/fixture.json"],
    fixture.worktree,
  );
  assert.match(result.stderr, /LANE_COMMIT_NOT_ASSEMBLED:wt-01/u);
});

test("expected tests must exist, execute, and fail the verification process when red", async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-tests-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(resolve(temporary, "plugins/photon/test"), { recursive: true });
  await writeFile(resolve(temporary, "test-pass.test.ts"), "import test from 'node:test'; test('pass', () => {});\n");
  await writeFile(resolve(temporary, "test-empty.test.ts"), "export {};\n");
  await writeFile(
    resolve(temporary, "test-skipped.test.ts"),
    "import test from 'node:test'; test.skip('skip', () => {});\n",
  );
  await writeFile(
    resolve(temporary, "test-spoofed.test.ts"),
    "import test from 'node:test'; process.stdout.write('ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ cancelled 0\\nℹ skipped 0\\nℹ todo 0\\n'); test.skip('skip', () => {});\n",
  );
  await symlink(resolve(temporary, "test-pass.test.ts"), resolve(temporary, "test-linked.test.ts"));
  await writeFile(
    resolve(temporary, "plugins/photon/test/fail.test.ts"),
    "import test from 'node:test'; test('fail', () => { throw new Error('intentional'); });\n",
  );
  assert.throws(() => runTestFiles(temporary, ["missing.test.ts"]), /EXPECTED_TEST_MISSING/u);
  assert.throws(() => runTestFiles(temporary, ["/dev/null"]), /EXPECTED_TEST_PATH_INVALID/u);
  assert.throws(() => runTestFiles(temporary, ["test-empty.test.ts"]), /EXPECTED_TESTS_UNDISCOVERED/u);
  assert.throws(() => runTestFiles(temporary, ["test-skipped.test.ts"]), /EXPECTED_TESTS_UNDISCOVERED_OR_SKIPPED/u);
  assert.throws(() => runTestFiles(temporary, ["test-spoofed.test.ts"]), /EXPECTED_TESTS_UNDISCOVERED_OR_SKIPPED/u);
  assert.throws(() => runTestFiles(temporary, ["test-linked.test.ts"]), /EXPECTED_TEST_NOT_REGULAR/u);
  assert.throws(
    () => runTestFiles(temporary, ["test-pass.test.ts", "plugins/photon/test/fail.test.ts"]),
    /intentional|COMMAND_FAILED/u,
  );
});

test("exact commit bases are accepted without a shadowing tag", async (context) => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  assert.equal(requireBase(fixture.main, fixture.base, fixture.base), fixture.base);
});

test("typecheck packages reject allowlisted paths that escape through symlinks", async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-typecheck-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, "root");
  const outside = resolve(temporary, "outside");
  await mkdir(resolve(root, "plugins"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(resolve(root, "package.json"), `${JSON.stringify({ scripts: { typecheck: "node -e ''" } })}\n`);
  await symlink(outside, resolve(root, "plugins/photon"));
  assert.doesNotThrow(() => runTypechecks(root, ["."]));
  assert.throws(() => runTypechecks(root, ["plugins/photon"]), /TYPECHECK_PACKAGE_OUTSIDE/u);
  assert.throws(() => runTypechecks(root, ["../outside"]), /TYPECHECK_PACKAGE_INVALID/u);
});

test("changed-path discovery preserves rename endpoints, deletions, and untracked files", async (context) => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  await writeFile(resolve(fixture.main, "old-name.ts"), "export const oldName = true;\n");
  await writeFile(resolve(fixture.main, "delete-me.ts"), "export const deleteMe = true;\n");
  git(fixture.main, "add", ".");
  git(fixture.main, "commit", "-m", "fixture tracked paths");
  const base = git(fixture.main, "rev-parse", "HEAD");
  git(fixture.main, "mv", "old-name.ts", "new-name.ts");
  git(fixture.main, "rm", "delete-me.ts");
  await writeFile(resolve(fixture.main, "untracked.ts"), "export const untracked = true;\n");
  assert.deepEqual(changedPaths(fixture.main, base), ["delete-me.ts", "new-name.ts", "old-name.ts", "untracked.ts"]);
});

test("Wave A preparation creates only the requested lane and rejects occupied paths and missing bases", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], fixture.main).stderr,
    /INTEGRATION_INVOCATION_REQUIRED/u,
  );
  const created = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    fixture.worktree,
  );
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /CREATED:wt-01/u);
  assert.equal(git(resolve(fixture.workspace, "worktrees/wt-01"), "branch", "--show-current"), "imessage/wt-01");

  const occupied = await createIntegrationFixture();
  context.after(() => rm(occupied.temporary, { recursive: true, force: true }));
  await mkdir(resolve(occupied.workspace, "worktrees/wt-01"), { recursive: true });
  const occupiedResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    occupied.worktree,
  );
  assert.match(occupiedResult.stderr, /UNREGISTERED_EXISTING_PATH/u);

  const missing = await createIntegrationFixture();
  context.after(() => rm(missing.temporary, { recursive: true, force: true }));
  git(missing.main, "tag", "-d", "fixture-base");
  const missingResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    missing.worktree,
  );
  assert.match(missingResult.stderr, /BASE_REF_MISSING|WAVE_CHECKPOINT_MISMATCH/u);

  const conflicting = await createIntegrationFixture();
  context.after(() => rm(conflicting.temporary, { recursive: true, force: true }));
  const ownershipPath = resolve(conflicting.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.lanes["wt-01"].baseCommit = "0".repeat(40);
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  git(conflicting.worktree, "add", ".");
  git(conflicting.worktree, "commit", "-m", "fixture conflicting base");
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], conflicting.worktree)
      .stderr,
    /BASE_REF_CONFLICT|WAVE_BASE_CHECKPOINT_MISMATCH/u,
  );

  const moved = await createIntegrationFixture();
  context.after(() => rm(moved.temporary, { recursive: true, force: true }));
  git(moved.main, "tag", "-f", "fixture-base", moved.base);
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], moved.worktree).stderr,
    /WAVE_CHECKPOINT_MISMATCH|BASE_REF_CONFLICT/u,
  );

  const escaped = await createIntegrationFixture();
  context.after(() => rm(escaped.temporary, { recursive: true, force: true }));
  const escapedOwnershipPath = resolve(escaped.worktree, "docs/imessage/ownership.json");
  const escapedOwnership = JSON.parse(await readFile(escapedOwnershipPath, "utf8"));
  escapedOwnership.lanes["wt-01"].worktree = "../outside";
  await writeFile(escapedOwnershipPath, `${JSON.stringify(escapedOwnership, null, 2)}\n`);
  git(escaped.worktree, "add", ".");
  git(escaped.worktree, "commit", "-m", "fixture escaped path");
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], escaped.worktree).stderr,
    /LANE_IDENTITY_INVALID|WORKTREE_PATH_OUTSIDE_WORKSPACE/u,
  );

  const linked = await createIntegrationFixture();
  context.after(() => rm(linked.temporary, { recursive: true, force: true }));
  const outsideLane = resolve(linked.workspace, "outside-wt-01");
  await mkdir(outsideLane, { recursive: true });
  await symlink(outsideLane, resolve(linked.workspace, "worktrees/wt-01"));
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], linked.worktree).stderr,
    /WORKTREE_PATH_SYMLINK_OR_OUTSIDE/u,
  );
});

test("Wave A preparation rejects coordinated movement of the tag and every editable anchor", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  await mkdir(resolve(fixture.worktree, "lane"), { recursive: true });
  await writeFile(resolve(fixture.worktree, "lane/one.ts"), "export const hidden = true;\n");
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture hidden foundation expansion");
  const movedTarget = git(fixture.worktree, "rev-parse", "HEAD");
  git(fixture.main, "tag", "-f", "fixture-base", movedTarget);
  const checkpointPath = resolve(fixture.worktree, "docs/imessage/integration/foundation-checkpoint.json");
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      { schemaVersion: 1, tag: "fixture-base", tagTarget: movedTarget, implementationCommit: movedTarget },
      null,
      2,
    )}\n`,
  );
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.reviewedFoundationCommit = movedTarget;
  ownership.integration.ownedPaths.push("lane/**");
  ownership.lanes["wt-01"].baseCommit = movedTarget;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture moved checkpoint metadata");
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    fixture.worktree,
  );
  assert.match(result.stderr, /WAVE_CHECKPOINT_MUTATED/u);
});

test("Wave A preparation checks both endpoints of a foundation rename", async (context) => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  await writeFile(resolve(fixture.main, "docs/imessage/unowned-source.ts"), "export const hidden = true;\n");
  git(fixture.main, "add", "-f", "docs/imessage/unowned-source.ts");
  git(fixture.main, "commit", "-m", "fixture reviewed source");
  const reviewed = git(fixture.main, "rev-parse", "HEAD");
  const ownershipPath = resolve(fixture.main, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.reviewedFoundationCommit = reviewed;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  git(fixture.main, "add", ".");
  git(fixture.main, "commit", "-m", "fixture reviewed anchor");
  const worktree = resolve(fixture.workspace, "worktrees/wt-integration");
  git(fixture.main, "worktree", "add", "-b", "imessage/integration", worktree, "HEAD");
  await writeFile(
    resolve(worktree, "docs/imessage/unowned-source.ts"),
    `${git(worktree, "show", "HEAD:docs/imessage/unowned-source.ts")}\n`,
  );
  await mkdir(resolve(worktree, "docs/imessage/integration"), { recursive: true });
  git(worktree, "mv", "docs/imessage/unowned-source.ts", "docs/imessage/integration/renamed.ts");
  git(worktree, "commit", "-m", "fixture hidden rename");
  const target = git(worktree, "rev-parse", "HEAD");
  git(fixture.main, "tag", "-f", "fixture-base", target);
  const currentOwnershipPath = resolve(worktree, "docs/imessage/ownership.json");
  const currentOwnership = JSON.parse(await readFile(currentOwnershipPath, "utf8"));
  currentOwnership.lanes["wt-01"].baseCommit = target;
  await writeFile(currentOwnershipPath, `${JSON.stringify(currentOwnership, null, 2)}\n`);
  await writeFile(
    resolve(worktree, "docs/imessage/integration/foundation-checkpoint.json"),
    `${JSON.stringify(
      { schemaVersion: 1, tag: "fixture-base", tagTarget: target, implementationCommit: target },
      null,
      2,
    )}\n`,
  );
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "fixture immutable checkpoint");
  const result = command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], worktree);
  assert.match(result.stderr, /WAVE_CHECKPOINT_UNOWNED_PATHS:docs\/imessage\/unowned-source\.ts/u);
});

test("Wave A preparation rejects an unrelated checkpoint before creating any lane", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const tree = git(fixture.main, "rev-parse", `${fixture.base}^{tree}`);
  const unrelated = git(fixture.main, "commit-tree", tree, "-m", "unrelated foundation");
  git(fixture.main, "tag", "-f", "fixture-base", unrelated);
  const checkpointPath = resolve(fixture.worktree, "docs/imessage/integration/foundation-checkpoint.json");
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      { schemaVersion: 1, tag: "fixture-base", tagTarget: unrelated, implementationCommit: unrelated },
      null,
      2,
    )}\n`,
  );
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.lanes["wt-01"].baseCommit = unrelated;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture unrelated checkpoint");
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    fixture.worktree,
  );
  assert.match(result.stderr, /WAVE_CHECKPOINT_MUTATED|WAVE_CHECKPOINT_HISTORY_MISMATCH/u);
  assert.equal(await readFile(resolve(fixture.worktree, "lane/one.ts"), "utf8").catch(() => undefined), undefined);
});

test("Wave A preparation rejects wrong origin, branch conflicts, dirty worktrees, and stale registrations", async (context) => {
  const wrongOrigin = await createIntegrationFixture();
  context.after(() => rm(wrongOrigin.temporary, { recursive: true, force: true }));
  git(wrongOrigin.main, "remote", "set-url", "origin", "https://github.com/example/wrong.git");
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], wrongOrigin.worktree)
      .stderr,
    /ORIGIN_MISMATCH/u,
  );

  const elsewhere = await createIntegrationFixture();
  context.after(() => rm(elsewhere.temporary, { recursive: true, force: true }));
  git(
    elsewhere.main,
    "worktree",
    "add",
    "-b",
    "imessage/wt-01",
    resolve(elsewhere.workspace, "elsewhere"),
    elsewhere.foundation,
  );
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], elsewhere.worktree).stderr,
    /BRANCH_CHECKED_OUT_ELSEWHERE/u,
  );

  const wrongBranch = await createIntegrationFixture();
  context.after(() => rm(wrongBranch.temporary, { recursive: true, force: true }));
  git(
    wrongBranch.main,
    "worktree",
    "add",
    "-b",
    "wrong-branch",
    resolve(wrongBranch.workspace, "worktrees/wt-01"),
    wrongBranch.foundation,
  );
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], wrongBranch.worktree)
      .stderr,
    /BRANCH_MISMATCH:wt-01/u,
  );

  const dirty = await createIntegrationFixture();
  context.after(() => rm(dirty.temporary, { recursive: true, force: true }));
  const dirtyPath = resolve(dirty.workspace, "worktrees/wt-01");
  git(dirty.main, "worktree", "add", "-b", "imessage/wt-01", dirtyPath, dirty.foundation);
  await writeFile(resolve(dirtyPath, "dirty.txt"), "dirty\n");
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], dirty.worktree).stderr,
    /DIRTY_WORKTREE/u,
  );

  const stale = await createIntegrationFixture();
  context.after(() => rm(stale.temporary, { recursive: true, force: true }));
  const stalePath = resolve(stale.workspace, "worktrees/wt-01");
  git(stale.main, "worktree", "add", "-b", "imessage/wt-01", stalePath, stale.foundation);
  await rm(stalePath, { recursive: true, force: true });
  assert.match(
    command(process.execPath, ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"], stale.worktree).stderr,
    /WORKTREE_REGISTRATION_WITHOUT_PATH/u,
  );
});

test("Wave A preparation safely fast-forwards a clean reviewed-foundation lane", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const lanePath = resolve(fixture.workspace, "worktrees/wt-01");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", lanePath, fixture.base);
  git(fixture.main, "branch", "fixture-base", fixture.base);
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    fixture.worktree,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FAST_FORWARDED:wt-01/u);
  assert.equal(git(lanePath, "rev-parse", "HEAD"), fixture.foundation);
});

test("Wave A preparation rejects an unrelated base during preflight", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const lanePath = resolve(fixture.workspace, "worktrees/wt-01");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", lanePath, fixture.base);
  const tree = git(fixture.main, "rev-parse", `${fixture.base}^{tree}`);
  const unrelated = git(fixture.main, "commit-tree", tree, "-m", "unrelated foundation");
  git(fixture.main, "tag", "-f", "fixture-base", unrelated);
  const checkpointPath = resolve(fixture.worktree, "docs/imessage/integration/foundation-checkpoint.json");
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      { schemaVersion: 1, tag: "fixture-base", tagTarget: unrelated, implementationCommit: unrelated },
      null,
      2,
    )}\n`,
  );
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.lanes["wt-01"].baseCommit = unrelated;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture unrelated base");
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    fixture.worktree,
  );
  assert.match(result.stderr, /WAVE_CHECKPOINT_MUTATED|WAVE_CHECKPOINT_HISTORY_MISMATCH|NON_FAST_FORWARD_BASE/u);
  assert.equal(git(lanePath, "rev-parse", "HEAD"), fixture.base);
});

test("Wave preparation validates the entire wave before fast-forwarding any lane", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const firstPath = resolve(fixture.workspace, "worktrees/wt-01");
  const secondPath = resolve(fixture.workspace, "worktrees/wt-02");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", firstPath, fixture.base);
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-02", secondPath, fixture.base);
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.reviewedFoundationCommit = fixture.base;
  ownership.lanes["wt-02"] = {
    ...ownership.lanes["wt-01"],
    branch: "imessage/wt-02",
    worktree: "worktrees/wt-02",
  };
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture second lane metadata");
  await writeFile(resolve(secondPath, "dirty.txt"), "dirty\n");
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "A"],
    fixture.worktree,
  );
  assert.match(result.stderr, /DIRTY_WORKTREE:wt-02/u);
  assert.equal(git(firstPath, "rev-parse", "HEAD"), fixture.base);
});

async function createLaterWaveFixture(
  options: {
    movingRef?: boolean;
    drift?: boolean;
    failedScope?: boolean;
    missingLaneDocument?: boolean;
    dependencyDrift?: boolean;
    cleanupFailure?: boolean;
  } = {},
) {
  const fixture = await createIntegrationFixture();
  const waveAPath = resolve(fixture.workspace, "worktrees/wt-01");
  git(fixture.main, "worktree", "add", "-b", "imessage/wt-01", waveAPath, fixture.foundation);
  await mkdir(resolve(waveAPath, "lane"), { recursive: true });
  await writeFile(resolve(waveAPath, "lane/one.ts"), "export const one = true;\n");
  if (!options.missingLaneDocument) {
    await mkdir(resolve(waveAPath, "docs/imessage/lanes"), { recursive: true });
    await writeFile(resolve(waveAPath, "docs/imessage/lanes/wt-01.md"), "Wave A fixture\n");
  }
  git(waveAPath, "add", ".");
  git(waveAPath, "commit", "-m", "fixture Wave A contribution");
  const laneCommit = git(waveAPath, "rev-parse", "HEAD");
  git(fixture.worktree, "merge", "--no-edit", laneCommit);
  if (options.drift) {
    await writeFile(resolve(fixture.worktree, "lane/one.ts"), "export const one = false;\n");
    git(fixture.worktree, "add", ".");
    git(fixture.worktree, "commit", "-m", "fixture overwrites Wave A contribution");
  }
  const ownershipPath = resolve(fixture.worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.integration.ownedPaths.push("docs/imessage/lanes/wt-07.md");
  ownership.lanes["wt-07"] = {
    wave: "B",
    branch: "imessage/wt-07",
    worktree: "worktrees/wt-07",
    baseRef: "fixture-f1",
    ownedPaths: ["docs/imessage/lanes/wt-07.md", "test/pass.test.ts"],
    testFiles: ["test/pass.test.ts"],
    typecheckPackages: [],
  };
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await mkdir(resolve(fixture.worktree, "docs/imessage/lanes"), { recursive: true });
  await writeFile(resolve(fixture.worktree, "docs/imessage/lanes/wt-07.md"), "lane fixture\n");
  if (options.cleanupFailure) {
    await writeFile(
      resolve(fixture.worktree, "test/pass.test.ts"),
      "import { spawnSync } from 'node:child_process'; import test from 'node:test'; test('pass', () => { const result = spawnSync('git', ['worktree', 'lock', process.cwd()]); if (result.status !== 0) throw new Error(result.stderr.toString()); });\n",
    );
  }
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture wave B target");
  const target = git(fixture.worktree, "rev-parse", "HEAD");
  git(fixture.main, "tag", "fixture-f1", target);
  if (options.dependencyDrift) {
    await writeFile(resolve(fixture.worktree, "package-lock.json"), '{"changed":true}\n');
    await mkdir(resolve(fixture.worktree, "node_modules"), { recursive: true });
  }
  if (options.failedScope) {
    await writeFile(
      resolve(fixture.worktree, "test/fail.test.ts"),
      "import test from 'node:test'; test('fail', () => { throw new Error('red'); });\n",
    );
    ownership.integration.testFiles = ["test/fail.test.ts"];
    await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
    git(fixture.worktree, "add", ".");
    git(fixture.worktree, "commit", "-m", "fixture failed checkpoint scope");
    git(fixture.main, "tag", "-f", "fixture-f1", git(fixture.worktree, "rev-parse", "HEAD"));
  }
  const finalTarget = git(fixture.main, "rev-parse", "fixture-f1^{commit}");
  await writeFile(
    resolve(fixture.worktree, "docs/imessage/integration/checkpoint-1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        tag: "fixture-f1",
        tagTarget: finalTarget,
        implementationCommit: finalTarget,
        inputBaseCommit: fixture.foundation,
        laneContributions: [
          {
            laneId: "wt-01",
            baseCommit: fixture.foundation,
            commit: options.movingRef ? "imessage/wt-01" : laneCommit,
          },
        ],
        testFiles: options.failedScope ? ["test/fail.test.ts", "test/pass.test.ts"] : ["test/pass.test.ts"],
        typecheckPackages: [],
      },
      null,
      2,
    )}\n`,
  );
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture wave B checkpoint");
  return { ...fixture, target: finalTarget };
}

test("later waves resolve a non-self-referential immutable external checkpoint", async (context) => {
  const fixture = await createLaterWaveFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const prepared = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    fixture.worktree,
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  const lanePath = resolve(fixture.workspace, "worktrees/wt-07");
  assert.equal(git(lanePath, "rev-parse", "HEAD"), fixture.target);
  const verified = command(process.execPath, ["scripts/imessage-verify-lane.mjs", "wt-07"], lanePath);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /VERIFIED:wt-07/u);
});

test("later-wave checkpoints reject moving contribution refs and overwritten lane paths", async (context) => {
  const moving = await createLaterWaveFixture({ movingRef: true });
  context.after(() => rm(moving.temporary, { recursive: true, force: true }));
  const movingResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    moving.worktree,
  );
  assert.match(movingResult.stderr, /WAVE_LANE_COMMIT_NOT_SHA/u);

  const drift = await createLaterWaveFixture({ drift: true });
  context.after(() => rm(drift.temporary, { recursive: true, force: true }));
  const driftResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    drift.worktree,
  );
  assert.match(driftResult.stderr, /WAVE_LANE_CONTRIBUTION_DRIFT/u);
});

test("later-wave preparation runs the prior gate against the tagged target", async (context) => {
  const fixture = await createLaterWaveFixture({ failedScope: true });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  await writeFile(
    resolve(fixture.worktree, "test/fail.test.ts"),
    "import test from 'node:test'; test('pass now', () => {});\n",
  );
  git(fixture.worktree, "add", ".");
  git(fixture.worktree, "commit", "-m", "fixture post-tag green test");
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    fixture.worktree,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /red|COMMAND_FAILED/u);
});

test("later-wave checkpoints require lane documents and matching dependency locks", async (context) => {
  const missingDocument = await createLaterWaveFixture({ missingLaneDocument: true });
  context.after(() => rm(missingDocument.temporary, { recursive: true, force: true }));
  const missingResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    missingDocument.worktree,
  );
  assert.match(missingResult.stderr, /WAVE_A_LANE_DOCUMENT_NOT_REGULAR/u);

  const dependencyDrift = await createLaterWaveFixture({ dependencyDrift: true });
  context.after(() => rm(dependencyDrift.temporary, { recursive: true, force: true }));
  const driftResult = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    dependencyDrift.worktree,
  );
  assert.match(driftResult.stderr, /WAVE_A_DEPENDENCY_LOCK_MISMATCH:package-lock\.json/u);
});

test("checkpoint verification fails closed when its temporary worktree cannot be unregistered", async (context) => {
  const fixture = await createLaterWaveFixture({ cleanupFailure: true });
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const result = command(
    process.execPath,
    ["scripts/imessage-worktrees.mjs", "prepare", "--wave", "B"],
    fixture.worktree,
  );
  assert.match(result.stderr, /WAVE_A_TEMP_WORKTREE_CLEANUP_FAILED/u);
  const registered = git(fixture.main, "worktree", "list", "--porcelain")
    .split("\n")
    .find((line) => line.startsWith("worktree ") && line.includes("qm-imessage-checkpoint-"));
  assert.ok(registered);
  const temporaryWorktree = registered.slice("worktree ".length);
  git(fixture.main, "worktree", "unlock", temporaryWorktree);
  git(fixture.main, "worktree", "remove", "--force", temporaryWorktree);
});

test("WT00 verification uses the pinned original commit without a wave checkpoint", async (context) => {
  const fixture = await createIntegrationFixture();
  context.after(() => rm(fixture.temporary, { recursive: true, force: true }));
  const worktree = resolve(fixture.workspace, "worktrees/wt-00-foundation");
  git(fixture.main, "worktree", "add", "-b", "imessage/foundation", worktree, fixture.foundation);
  const ownershipPath = resolve(worktree, "docs/imessage/ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.originalBaseline = fixture.base;
  ownership.lanes["wt-00"] = {
    wave: "foundation",
    branch: "imessage/foundation",
    worktree: "worktrees/wt-00-foundation",
    baseRef: fixture.base,
    ownedPaths: ["docs/imessage/**", "package.json"],
    testFiles: ["test/pass.test.ts"],
    typecheckPackages: ["."],
  };
  await mkdir(resolve(worktree, "docs/imessage/lanes"), { recursive: true });
  await writeFile(resolve(worktree, "docs/imessage/lanes/wt-00.md"), "foundation fixture\n");
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await writeFile(
    resolve(worktree, "package.json"),
    `${JSON.stringify({ scripts: { typecheck: "node -e \"process.stdout.write('WT00_TYPECHECK_EXECUTED')\"" } })}\n`,
  );
  const verify = () => command(process.execPath, ["scripts/imessage-verify-lane.mjs", "wt-00"], worktree);
  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, new RegExp(`VERIFIED:wt-00:${fixture.base}:`));
  assert.match(valid.stdout, /VALID:fixture/u);
  assert.match(valid.stdout, /pass 1/u);
  assert.match(valid.stdout, /WT00_TYPECHECK_EXECUTED/u);
  ownership.lanes["wt-00"].baseRef = fixture.foundation;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  const wrongBase = verify();
  assert.notEqual(wrongBase.status, 0);
  assert.match(wrongBase.stderr, /IMMUTABLE_BASE_TARGET_MISMATCH/u);
  ownership.lanes["wt-00"].baseRef = fixture.base;
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await writeFile(resolve(worktree, "unowned.ts"), "export const value = 1;\n");
  assert.match(verify().stderr, /UNOWNED_PATHS:wt-00:unowned.ts/u);
});
