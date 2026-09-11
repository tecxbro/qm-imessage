#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownership = JSON.parse(readFileSync(resolve(root, "docs/imessage/ownership.json"), "utf8"));
const expectedOrigin = ownership.repository.replace(/\.git$/u, "");

function run(command, args, cwd = root, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: allowFailure ? "pipe" : "inherit" });
  if (result.status !== 0 && !allowFailure) throw new Error(`COMMAND_FAILED:${command}:${args.join(" ")}`);
  return { status: result.status ?? 1, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}

function git(args, allowFailure = false) {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `COMMAND_FAILED:git:${args.join(" ")}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
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

function changedPaths(base) {
  const commands = [
    ["diff", "--name-only", `${base}..HEAD`],
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  return [...new Set(commands.flatMap((args) => git(args, true).stdout.split("\n").filter(Boolean)))].sort();
}

const laneId = process.argv[2];
const lane = ownership.lanes[laneId];
if (lane === undefined) throw new Error(`UNKNOWN_LANE:${laneId ?? "missing"}`);
const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
const main = common.endsWith("/.git") ? dirname(common) : root;
const workspace = dirname(main);
const expectedPath = resolve(workspace, lane.worktree);
if (realpathSync(root) !== realpathSync(expectedPath))
  throw new Error(`WORKTREE_PATH_MISMATCH:${root}:${expectedPath}`);
const origin = git(["remote", "get-url", "origin"]).stdout.replace(/\.git$/u, "");
if (origin !== expectedOrigin) throw new Error(`ORIGIN_MISMATCH:${origin}`);
const branch = git(["branch", "--show-current"]).stdout;
if (branch !== lane.branch) throw new Error(`BRANCH_MISMATCH:${branch}:${lane.branch}`);
const base = git(["rev-parse", "--verify", `${lane.baseRef}^{commit}`]).stdout;
if (git(["merge-base", "--is-ancestor", base, "HEAD"], true).status !== 0) {
  throw new Error(`IMMUTABLE_BASE_NOT_ANCESTOR:${base}`);
}
const mergeBase = git(["merge-base", base, "HEAD"]).stdout;
if (mergeBase !== base) throw new Error(`IMMUTABLE_BASE_DRIFT:${mergeBase}:${base}`);
const changed = changedPaths(base);
const unowned = changed.filter((path) => !lane.ownedPaths.some((pattern) => matches(path, pattern)));
if (unowned.length > 0) throw new Error(`UNOWNED_PATHS:${unowned.join(",")}`);
for (const required of lane.requiredDocs) {
  if (!existsSync(resolve(root, required))) throw new Error(`REQUIRED_DOCUMENT_MISSING:${required}`);
}
run(process.execPath, ["scripts/imessage-sources.mjs", "validate"]);
for (const command of lane.verify) {
  const result = spawnSync(command, { cwd: root, encoding: "utf8", shell: true, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`LANE_COMMAND_FAILED:${command}`);
}
process.stdout.write(`VERIFIED:${laneId}:${base}:${changed.length}\n`);
