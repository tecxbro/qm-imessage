import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function git(root, args, allowFailure = false) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function exactCommit(root, value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${label}_NOT_SHA:${value}`);
  const resolved = git(root, ["rev-parse", "--verify", `${value}^{commit}`], true);
  if (resolved.status !== 0 || resolved.stdout !== value) throw new Error(`${label}_TARGET_MISMATCH:${value}`);
  return value;
}

function nameStatusPaths(value) {
  const fields = value.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) throw new Error("INVALID_REPAIR_GIT_NAME_STATUS");
    paths.push(path);
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index + 1];
      if (destination === undefined) throw new Error("INVALID_REPAIR_GIT_RENAME_STATUS");
      paths.push(destination);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function changedPaths(root, base, commit) {
  return nameStatusPaths(git(root, ["diff", "--find-renames", "--name-status", "-z", `${base}..${commit}`]).stdout);
}

function matches(path, pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else source += character.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u").test(path);
}

function isAncestor(root, ancestor, descendant) {
  return git(root, ["merge-base", "--is-ancestor", ancestor, descendant], true).status === 0;
}

function requireSamePath(root, left, right, path, label) {
  if (git(root, ["diff", "--quiet", left, right, "--", path], true).status !== 0) {
    throw new Error(`${label}:${path}`);
  }
}

function requireRegularFile(path, label) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error(`${label}_NOT_REGULAR:${path}`);
  }
}

function repositoryPaths(main) {
  const common = git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  const repositoryMain = common.endsWith("/.git") ? dirname(common) : main;
  return {
    gitCommonDir: realpathSync(common),
    main: realpathSync(repositoryMain),
    workspace: realpathSync(repositoryMain),
  };
}

function registeredWorktrees(main) {
  const entries = [];
  let current;
  for (const line of git(main, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: normalizedPath(line.slice(9)) };
      entries.push(current);
    } else if (line.startsWith("HEAD ") && current !== undefined) current.head = line.slice(5);
    else if (line.startsWith("branch ") && current !== undefined) {
      current.branch = line.slice(7).replace(/^refs\/heads\//u, "");
    }
  }
  return entries;
}

function normalizedPath(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

function readRepairOwnership(root, main, ownership, target) {
  const ownershipPath = ownership.checkpointRepairs?.ownership;
  if (
    typeof ownershipPath !== "string" ||
    isAbsolute(ownershipPath) ||
    relative(root, resolve(root, ownershipPath)).startsWith("..")
  ) {
    throw new Error(`REPAIR_OWNERSHIP_PATH_INVALID:${ownershipPath}`);
  }
  const absolute = resolve(root, ownershipPath);
  requireRegularFile(absolute, "REPAIR_OWNERSHIP");
  if (!realpathSync(absolute).startsWith(`${realpathSync(root)}/`)) {
    throw new Error(`REPAIR_OWNERSHIP_OUTSIDE:${ownershipPath}`);
  }
  const repairOwnership = JSON.parse(readFileSync(absolute, "utf8"));
  const resolution = repairOwnership.repairBaseResolution;
  const recordPath = resolution?.recordPath;
  const paths = repositoryPaths(main);
  if (
    resolution?.resolveFrom !== "git-common-dir" ||
    typeof recordPath !== "string" ||
    recordPath.length === 0 ||
    isAbsolute(recordPath) ||
    relative(paths.gitCommonDir, resolve(paths.gitCommonDir, recordPath)).startsWith("..")
  ) {
    throw new Error(`REPAIR_BASE_RECORD_PATH_INVALID:${recordPath}`);
  }
  const absoluteRecordPath = resolve(paths.gitCommonDir, recordPath);
  requireRegularFile(absoluteRecordPath, "REPAIR_BASE_RECORD");
  if (!realpathSync(absoluteRecordPath).startsWith(`${paths.gitCommonDir}/`)) {
    throw new Error(`REPAIR_BASE_RECORD_OUTSIDE:${recordPath}`);
  }
  const dispatch = JSON.parse(readFileSync(absoluteRecordPath, "utf8"));
  for (const field of resolution.requiredFields ?? []) {
    if (!Object.hasOwn(dispatch, field)) throw new Error(`REPAIR_BASE_RECORD_FIELD_MISSING:${field}`);
  }
  if (dispatch.schemaVersion !== resolution.schemaVersion) {
    throw new Error(`REPAIR_BASE_RECORD_SCHEMA_MISMATCH:${dispatch.schemaVersion}`);
  }
  const repairBase = exactCommit(main, dispatch[resolution.field], "REPAIR_BASE");
  const reviewedInput = exactCommit(main, repairOwnership.reviewedInput?.commit, "REPAIR_REVIEWED_INPUT");
  if (
    dispatch.reviewedInput !== reviewedInput ||
    ownership.checkpointRepairs?.reviewedInput !== reviewedInput ||
    !isAncestor(main, reviewedInput, repairBase)
  ) {
    throw new Error(`REPAIR_BASE_RECORD_INPUT_MISMATCH:${dispatch.reviewedInput}`);
  }
  const coordinator = repairOwnership.coordinator;
  if (
    dispatch.repository?.replace(/\.git$/u, "") !== ownership.repository.replace(/\.git$/u, "") ||
    typeof coordinator?.branch !== "string" ||
    typeof coordinator?.worktree !== "string" ||
    dispatch.integrationBranch !== coordinator.branch ||
    normalizedPath(dispatch.integrationWorktree ?? "") !==
      normalizedPath(resolve(paths.workspace, coordinator.worktree))
  ) {
    throw new Error("REPAIR_BASE_RECORD_REPOSITORY_MISMATCH");
  }
  const configuredIds = Object.keys(repairOwnership.repairs ?? {}).sort();
  const dispatchedIds = Object.keys(dispatch.repairs ?? {}).sort();
  if (JSON.stringify(configuredIds) !== JSON.stringify(dispatchedIds)) {
    throw new Error(`REPAIR_BASE_RECORD_SET_MISMATCH:${dispatchedIds.join(",")}`);
  }
  for (const repairId of configuredIds) {
    const configured = repairOwnership.repairs[repairId];
    const captured = dispatch.repairs[repairId];
    if (
      captured?.baseCommit !== repairBase ||
      captured?.branch !== configured.branch ||
      normalizedPath(captured?.worktree ?? "") !== normalizedPath(resolve(paths.workspace, configured.worktree))
    ) {
      throw new Error(`REPAIR_BASE_RECORD_REPAIR_MISMATCH:${repairId}`);
    }
  }
  if (!isAncestor(main, repairBase, target)) {
    if (isAncestor(main, target, repairBase)) return { active: false, dispatch, repairBase, repairOwnership, paths };
    throw new Error(`REPAIR_BASE_NOT_ANCESTOR:${repairBase}`);
  }
  const introductions = git(main, ["log", "--reverse", "--format=%H", "--diff-filter=A", target, "--", ownershipPath])
    .stdout.split("\n")
    .filter(Boolean);
  if (introductions[0] !== repairBase) {
    throw new Error(`REPAIR_BASE_RECORD_MOVED:${repairBase}:${introductions[0] ?? "missing"}`);
  }
  requireSamePath(main, repairBase, target, ownershipPath, "REPAIR_OWNERSHIP_MUTATED");
  if (
    git(root, ["diff", "--quiet", target, "--", ownershipPath], true).status !== 0 ||
    git(root, ["diff", "--cached", "--quiet", target, "--", ownershipPath], true).status !== 0
  ) {
    throw new Error(`REPAIR_OWNERSHIP_MUTATED:${ownershipPath}`);
  }
  return { active: true, dispatch, repairBase, repairOwnership, paths };
}

function requiredTestsFor(entry) {
  return entry.ownedPaths.filter((path) => !path.includes("*") && path.endsWith(".test.ts"));
}

export function validateRepairProvenance({ root, main, target, checkpoint, ownership }) {
  const declared = checkpoint.repairContributions;
  if (declared !== undefined && !Array.isArray(declared)) throw new Error("REPAIR_CONTRIBUTIONS_INVALID");
  if (ownership.checkpointRepairs?.ownership === undefined) {
    if ((declared ?? []).length > 0) throw new Error("REPAIR_PROFILE_MISSING");
    return {
      contributions: [],
      paths: [],
      requiredTests: [],
      finalRepairForPath: () => undefined,
      requireOriginalPath: () => {},
    };
  }
  const targetCommit = exactCommit(main, target, "REPAIR_TARGET");
  const profile = readRepairOwnership(root, main, ownership, targetCommit);
  if (!profile.active) {
    if ((declared ?? []).length > 0) throw new Error(`REPAIR_BASE_NOT_ANCESTOR:${profile.repairBase}`);
    return {
      contributions: [],
      paths: [],
      requiredTests: [],
      finalRepairForPath: () => undefined,
      requireOriginalPath: () => {},
    };
  }
  if (git(root, ["status", "--porcelain=v1"]).stdout.length > 0) throw new Error(`REPAIR_CANDIDATE_DIRTY:${root}`);
  const { dispatch, repairBase, repairOwnership, paths: repository } = profile;
  const allOwnership = { ...repairOwnership.repairs, ...repairOwnership.joins };
  const worktrees = registeredWorktrees(main);
  const ids = new Set();
  const commits = new Set();
  const contributions = [];
  for (const contribution of declared ?? []) {
    const { repairId } = contribution ?? {};
    const repair = allOwnership[repairId];
    if (typeof repairId !== "string" || repair === undefined)
      throw new Error(`REPAIR_CONTRIBUTION_UNKNOWN:${repairId}`);
    if (ids.has(repairId)) throw new Error(`REPAIR_CONTRIBUTION_DUPLICATE:${repairId}`);
    const baseCommit = exactCommit(main, contribution.baseCommit, `REPAIR_BASE_${repairId}`);
    const commit = exactCommit(main, contribution.commit, `REPAIR_COMMIT_${repairId}`);
    if (commits.has(commit)) throw new Error(`REPAIR_COMMIT_DUPLICATE:${commit}`);
    if (
      commit === baseCommit ||
      !isAncestor(main, repairBase, baseCommit) ||
      !isAncestor(main, baseCommit, commit) ||
      !isAncestor(main, commit, targetCommit)
    ) {
      throw new Error(`REPAIR_CONTRIBUTION_ANCESTRY:${repairId}`);
    }
    if (repairOwnership.repairs?.[repairId] !== undefined && baseCommit !== repairBase) {
      throw new Error(`REPAIR_CONTRIBUTION_BASE_MISMATCH:${repairId}:${baseCommit}:${repairBase}`);
    }
    if (repairOwnership.repairs?.[repairId] !== undefined) {
      const expectedPath = normalizedPath(resolve(repository.workspace, repair.worktree));
      if (
        !existsSync(expectedPath) ||
        lstatSync(expectedPath).isSymbolicLink() ||
        !realpathSync(expectedPath).startsWith(`${realpathSync(repository.workspace)}/`) ||
        resolve(dirname(expectedPath)) !== resolve(repository.workspace, "worktrees")
      ) {
        throw new Error(`REPAIR_WORKTREE_PATH_INVALID:${repairId}:${expectedPath}`);
      }
      const registered = worktrees.find((entry) => entry.path === expectedPath);
      const origin = git(expectedPath, ["remote", "get-url", "origin"]).stdout.replace(/\.git$/u, "");
      if (
        registered?.branch !== repair.branch ||
        registered.head !== commit ||
        origin !== ownership.repository.replace(/\.git$/u, "")
      ) {
        throw new Error(`REPAIR_WORKTREE_IDENTITY_MISMATCH:${repairId}:${expectedPath}`);
      }
      if (git(expectedPath, ["status", "--porcelain=v1"]).stdout.length > 0) {
        throw new Error(`REPAIR_WORKTREE_DIRTY:${repairId}:${expectedPath}`);
      }
      if (normalizedPath(dispatch.repairs[repairId].worktree) !== expectedPath) {
        throw new Error(`REPAIR_WORKTREE_CAPTURE_MISMATCH:${repairId}:${expectedPath}`);
      }
    }
    const paths = changedPaths(main, baseCommit, commit);
    if (paths.length === 0) throw new Error(`REPAIR_CONTRIBUTION_EMPTY:${repairId}`);
    const unowned = paths.filter((path) => !repair.ownedPaths.some((pattern) => matches(path, pattern)));
    if (unowned.length > 0) throw new Error(`REPAIR_UNOWNED_PATHS:${repairId}:${unowned.join(",")}`);
    ids.add(repairId);
    commits.add(commit);
    contributions.push({ repairId, baseCommit, commit, changedPaths: paths, ownership: repair });
  }
  for (const contribution of contributions) {
    for (const dependencyId of contribution.ownership.dependsOn ?? []) {
      const dependency = contributions.find((candidate) => candidate.repairId === dependencyId);
      if (dependency === undefined || !isAncestor(main, dependency.commit, contribution.commit)) {
        throw new Error(`REPAIR_DEPENDENCY_MISSING:${contribution.repairId}:${dependencyId}`);
      }
    }
  }
  const dependsOn = (contribution, dependencyId) => {
    const pending = [...(contribution.ownership.dependsOn ?? [])];
    const visited = new Set();
    while (pending.length > 0) {
      const declaredId = pending.pop();
      if (declaredId === dependencyId) return true;
      if (visited.has(declaredId)) continue;
      visited.add(declaredId);
      const declared = contributions.find((candidate) => candidate.repairId === declaredId);
      if (declared !== undefined) pending.push(...(declared.ownership.dependsOn ?? []));
    }
    return false;
  };
  const paths = [...new Set(contributions.flatMap((contribution) => contribution.changedPaths))].sort();
  const unrecorded = changedPaths(main, repairBase, targetCommit).filter(
    (path) =>
      !paths.includes(path) &&
      Object.values(allOwnership).some((entry) => entry.ownedPaths.some((pattern) => matches(path, pattern))),
  );
  if (unrecorded.length > 0) throw new Error(`REPAIR_CONTRIBUTIONS_MISSING:${unrecorded.join(",")}`);
  const finalRepairForPath = (path) => {
    const touching = contributions.filter((contribution) => contribution.changedPaths.includes(path));
    if (touching.length === 0) return undefined;
    const tips = touching.filter(
      (contribution) =>
        !touching.some(
          (other) => other.commit !== contribution.commit && isAncestor(main, contribution.commit, other.commit),
        ),
    );
    if (tips.length !== 1) throw new Error(`UNRESOLVED_REPAIR_PATH:${path}`);
    return tips[0];
  };
  for (const path of paths) {
    const touching = contributions.filter((contribution) => contribution.changedPaths.includes(path));
    for (const contribution of touching) {
      const undeclared = touching.filter(
        (other) =>
          other.commit !== contribution.commit &&
          isAncestor(main, other.commit, contribution.commit) &&
          !dependsOn(contribution, other.repairId),
      );
      if (undeclared.length > 0) {
        throw new Error(
          `REPAIR_PATH_DEPENDENCY_MISSING:${contribution.repairId}:${path}:${undeclared
            .map((entry) => entry.repairId)
            .sort()
            .join(",")}`,
        );
      }
    }
    const final = finalRepairForPath(path);
    requireSamePath(main, final.commit, targetCommit, path, "REPAIR_CONTRIBUTION_DRIFT");
    for (const contribution of touching) {
      const prior = touching.filter(
        (other) => other.commit !== contribution.commit && isAncestor(main, other.commit, contribution.baseCommit),
      );
      const priorTips = prior.filter(
        (candidate) =>
          !prior.some((other) => other.commit !== candidate.commit && isAncestor(main, candidate.commit, other.commit)),
      );
      if (priorTips.length > 1) throw new Error(`REPAIR_BASE_PATH_AMBIGUOUS:${contribution.repairId}:${path}`);
      if (priorTips.length === 0) {
        requireSamePath(main, repairBase, contribution.baseCommit, path, "REPAIR_INTERVENING_BASE_DRIFT");
      } else {
        requireSamePath(main, priorTips[0].commit, contribution.baseCommit, path, "REPAIR_INTERVENING_BASE_DRIFT");
      }
    }
  }
  const requireOriginalPath = (path, originalCommit, label) => {
    const touching = contributions.filter((contribution) => contribution.changedPaths.includes(path));
    for (const contribution of touching) {
      const hasPrior = touching.some(
        (other) => other.commit !== contribution.commit && isAncestor(main, other.commit, contribution.baseCommit),
      );
      if (!hasPrior) {
        requireSamePath(main, originalCommit, contribution.baseCommit, path, `${label}_REPAIR_BASE_DRIFT`);
      }
    }
  };
  const requiredTests = [...new Set(contributions.flatMap((entry) => requiredTestsFor(entry.ownership)))].sort();
  return { contributions, paths, requiredTests, finalRepairForPath, requireOriginalPath };
}
