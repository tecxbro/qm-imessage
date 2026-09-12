# iMessage lane workflow

## Immutable bases

WT00 started from `0e3f9b9739f5ac695aa02672860ead64da88105e`. The original annotated tag `qm-imessage-f0` resolves to `1f3df849a29e03a415c6626c2865c2d1a59b76f9` locally and is never moved. No matching remote tag was present at repair inspection time.

The first corrective foundation is frozen at `73e094143916642cae33fa3cf6aeb6344200b66c` under the annotated tag `qm-imessage-f0-r1`. Its immutable historical record remains `docs/imessage/integration/foundation-checkpoint.json`; neither the tag nor that checkpoint moves.

WT01-WT06 start from `qm-imessage-f0-r2`. The original lane assignments remain unchanged. `docs/imessage/integration/foundation-checkpoint-r2.json` is the separate successor checkpoint and records the real tagged commit only after the verified candidate is committed and tagged. Every original WT01-WT06 prompt must make this one-line substitution:

> Replace the prior base tag with `qm-imessage-f0-r2`; do not change the lane assignment.

Wave A uses that successor tag. Integration preserves the original sequence: verified Wave A produces `qm-imessage-f1`, Wave B uses f1 and produces f2, Wave C uses f2 and produces f3, and Wave D uses f3. The active external checkpoint files are `foundation-checkpoint-r2.json`, `checkpoint-1.json`, `checkpoint-2.json`, and `checkpoint-3.json`. The first commit that adds each file is its immutable checkpoint blob; neither that blob nor its tag may move. Historical f0/r1 records remain untouched. Later status and handoff evidence belongs in a separate follow-up record.

## Original waves and ownership

- Wave A: WT01-WT06.
- Wave B: WT07-WT15.
- Wave C: WT16-WT22.
- Wave D: WT23-WT25.

`ownership.json` is the exact lane matrix. Each lane owns its listed production and test files plus `docs/imessage/lanes/wt-NN.md`. The original `P/test/` abbreviation is expanded to `plugins/photon/test/`. Feature lanes do not edit shared contracts, canonical iMessage documents, root/package registration, or integration composition. WT05 retains its listed core compatibility files, WT16 retains its listed admin registration files, and WT22 retains its listed CLI registration files.

After the repair freeze, `plugins/chassis/src/photon-contract.ts`, `plugins/photon/src/ports.ts`, `plugins/web-ui/src/photon/contracts.ts`, canonical iMessage documents, and the integration registration paths in `ownership.json` are integration-owned. A lane records a required shared change in its lane document.

WT23-WT25 are independent security, reliability, and product-parity test/review lanes. They do not own production implementation.

## Preparing worktrees

Run `node scripts/imessage-worktrees.mjs prepare --wave A` from the repaired integration checkout only after `qm-imessage-f0-r2` exists, `foundation-checkpoint-r2.json` records its target, and every Wave A `baseRef` selects that tag. The tool derives the common main checkout and workspace from Git registration. The same command accepts waves B, C, or D but this repair prepares no later wave.

The tool must run from the registered clean integration checkout. It validates the origin, requested wave, canonical lane branch and contained worktree path, base tag, the matching external checkpoint's immutable first-add blob and tag target, every prior wave's recorded lane set and contribution commits, registration, and cleanliness before any mutation. Lane `baseCommit` may redundantly record an already frozen external target but is never a self-referential prerequisite for creating that target. It creates a missing clean lane from the exact external target. An existing clean Wave A lane can be fast-forwarded with `--ff-only` only when its head is the reviewed original foundation or one of the exact `foundationUpgradeFromCommits`; any other differing head is blocked. Dirty, divergent, missing-directory, unregistered, occupied, wrong-branch, wrong-origin, missing-tag, conflicting-tag, moved-tag, mutated-checkpoint, outside-workspace, or elsewhere-checked-out cases fail with a precise diagnostic. Nothing is reset, rebased, deleted, relocated, or repurposed.

## Lane verification

Run `node scripts/imessage-verify-lane.mjs wt-NN` inside the lane worktree. Lane mode validates the exact repository, registered path, branch, immutable base against the external post-freeze checkpoint when necessary, owned changes including rename/delete endpoints and untracked files, source lock, lane document, every expected test file, nonzero test discovery in the correct package, and configured package typechecks. Git failures and zero expected tests are failures.

Missing future tests do not block WT00 because the repair checkpoint names only the implemented foundation tests. A lane cannot pass completed verification until every test in its restored assignment exists and runs.

## Integration verification

Run:

```bash
node scripts/imessage-verify-lane.mjs integration --checkpoint docs/imessage/integration/checkpoint-N.json
```

The checkpoint records an immutable input commit, captured lane base and commit SHAs, the assembled test files, and affected package typechecks. Integration mode accepts only a foundation input recorded in ownership or the post-freeze checkpoint, requires every captured lane commit in assembled history, derives mandatory tests and typechecks from ownership, verifies each contribution against its own base and ownership, and checks remaining composition changes against integration ownership. It never checks an assembled diff against one feature lane's allowlist and never merges a moving branch name.

The corrective pass uses `docs/imessage/integration/foundation-repair-input.json` with the reviewed foundation commit as its immutable candidate input and no lane contributions. That candidate record is not a declaration that an untagged commit is frozen. After the candidate passes its gates, `foundation-checkpoint-r2.json` records the actual `qm-imessage-f0-r2` target. Integration checkpoint 1 happens only after WT01-WT06 finish and are assembled.

## Evidence levels

1. Built and typechecked.
2. Focused tests passed in the lane.
3. Independently reviewed in fresh context.
4. Integrated into the exact candidate.
5. Activated or installed in the target runtime.
6. Accepted by the provider.
7. Delivered or read according to provider evidence.
8. Observed on a physical device, including interaction and rendering.

No lower level implies a higher one. Foundation fixtures do not prove PostgreSQL recovery, CLI login, provider compatibility, delivery, read state, or device behavior.
