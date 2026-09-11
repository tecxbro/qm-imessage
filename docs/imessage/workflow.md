# iMessage lane workflow

## Immutable bases

WT00 is based on `0e3f9b9739f5ac695aa02672860ead64da88105e` and produces immutable tag `qm-imessage-f0`. Wave A uses only that tag. Integration produces `qm-imessage-f1`, `qm-imessage-f2`, and `qm-imessage-f3` after the preceding wave has been independently reviewed, integrated, and verified. Waves B, C, and D use those tags respectively. Existing tags are never moved.

`scripts/imessage-worktrees.mjs prepare --wave <A|B|C|D>` creates only the lanes in the requested wave. It refuses an unregistered existing path, a wrong branch, a wrong repository, a missing base tag, a branch already registered elsewhere, or a worktree whose base is not an ancestor.

## Ownership

`ownership.json` is the canonical lane matrix. A feature lane changes only its owned paths. Shared registration files, root package files, current QM routes, canonical architecture/parity/inventory documents, and web server composition are reserved for the integration worktree after F0. A lane reports a needed shared change in its lane document; it does not take ownership by editing the shared file.

## Lane gate

Each lane starts by verifying the registered absolute path, origin, branch, clean or understood dirty state, immutable base, pinned declarations, and owned paths. Before handoff it runs `scripts/imessage-verify-lane.mjs wt-NN`. The verifier checks identity, base ancestry, changed-path ownership, the locked official source hashes, required documentation, and the lane's focused commands.

Implementation evidence is separated into these levels:

1. Built and typechecked.
2. Focused tests passed in the lane.
3. Independently reviewed in fresh context.
4. Integrated into the exact candidate.
5. Activated or installed in the target runtime.
6. Accepted by the provider.
7. Delivered or read according to provider evidence.
8. Observed on a physical device, including interaction and rendering where applicable.

No lower level implies a higher one. Fixtures and mocks cannot establish provider or device evidence.

## Integration gates

The integration owner applies one lane at a time, resolves shared registration centrally, runs the lane verifier against the assembled commit, and records conflicts without weakening the frozen contracts or tests. The integration worktree is created from F0 and remains the only owner of shared registration changes.

An F1, F2, or F3 tag is created only after affected tests, root typecheck, lint, formatting, source validation, plugin tests, and an independent fresh-context review pass. A final release additionally requires assembled restart/concurrency recovery and the explicitly authorized protected live checks. The workflow never sends live messages, changes billing, rotates credentials, pushes, or merges `main` unless a separate instruction authorizes that action.
