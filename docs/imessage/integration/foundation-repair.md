# Foundation repair record

## Starting state

The registered repair worktree was clean at `1f3df849a29e03a415c6626c2865c2d1a59b76f9` on `imessage/integration`, tracking `origin/imessage/integration` with zero divergence. The required original baseline `0e3f9b9739f5ac695aa02672860ead64da88105e` was an ancestor. Main, foundation, integration, and WT01-WT06 were registered and clean. The original annotated `qm-imessage-f0` tag resolved to the reviewed commit locally; the remote exposed no matching tag.

The default machine toolchain was Node 23.11.0, below the repository requirement, and the Photon package had no installed dependencies. Reproduction with that environment failed declaration resolution. Repair verification uses Node 24.15.0 and npm 11.10.0 with lockfile-only installs.

## Reproduced defects and corrections

| Defect                                                                        | Correction                                                                                                   | Regression evidence                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Lane numbering and ownership contradicted the original plan                   | Restored all 25 exact assignments and original waves                                                         | Exact map, neighboring denial, integration collision, and review-lane tests                                         |
| All events required message text or attachments, actor, and conversation      | Added discriminated event families and scoped validators                                                     | Read, reaction, poll, lifecycle, and contradiction tests                                                            |
| Event ID was treated as a global receipt key                                  | Added provider, installation, and line scope plus exact receipt sequence                                     | Colliding event-ID and line-scoped checkpoint tests                                                                 |
| Message bindings checked only conversation ID and the first part              | Added full scoped part keys and all-part overlap checks                                                      | Cross-installation and second-part conflict test                                                                    |
| Setup required project identity before login                                  | Made project optional until connected                                                                        | Pre-project state test                                                                                              |
| Dashboard validation could retain unknown credential fields                   | Added strict DTO parsing and constructive projection                                                         | Top-level and nested serialization leak tests                                                                       |
| Operation inputs were unrestricted records                                    | Added exact operation DTOs, pinned effects, runtime field checks, and JSON-safe validation                   | Function, BigInt, cycle, class, non-finite, unknown-field, and malformed payload tests                              |
| A caller-supplied checked object blurred QM authority                         | Split requests from QM-checked operations                                                                    | Port and typecheck evidence                                                                                         |
| Receipt hashes were not recoverable and claims were unfenced                  | Retained envelope/reference payload, capture-only input, fenced claims, and atomic success/rejection cursors | Recoverability, forged-state, stale-claim, unsequenced completion, and contiguous rejection tests                   |
| Stream chunks were modeled as independent delivery operations                 | Added durable ordered stream sessions and one Spectrum `AsyncIterable` send; Advanced is unsupported         | Stream ordering, fencing, finalization, and provider-port typechecks                                                |
| Delivery deduplicated by operation ID and flattened partial/ambiguous results | Scoped logical idempotency, canonical payload comparison, terminal child state, and exact reconciliation     | Retry-ID, property-order, unsupported-child, multipart, and scoped reconciliation tests                             |
| Unsupported and absent message results could be misclassified                 | Kept five outcomes with exact void, Poll, Chat, message, and app-card session confirmation                   | Spectrum and Advanced iMessage return-shape, poll-create, and restart-safe app-card receipt tests                   |
| Action consumption omitted authority dimensions and accepted weak dates       | Required actor, resource, revision, action, session, conversation, canonical time, and single use            | Authority-dimension, replay, and malformed-expiry tests                                                             |
| Lane verifier had no integration model and used shell command strings         | Added captured-SHA lane and integration modes with package-specific test execution                           | Temporary repository/worktree and intentional-failure tests                                                         |
| Worktree preparation tolerated unsafe existing states                         | Added origin, tag, path, registration, branch, head, and cleanliness gates                                   | Occupied, stale, dirty, conflict, missing-base, and wrong-origin tests                                              |
| HTML fallback decoded code before stripping tags                              | Added structured HTML parsing and provenance validation                                                      | Generics, JSX, operators, whitespace, spans, tables, links, missing-main, error-page, and incomplete-document tests |

## Source preservation

No official source snapshot was refetched or rewritten. The source-lock validator now rejects unsafe local paths, off-origin source URLs, off-path resolved URLs, invalid formats or timestamps, invalid hashes, locked-body mismatches, and embedded provenance that contradicts the lock. Future retrieval requires two identical identity-encoded responses with matching declared lengths, confirms the discovery index twice, refuses to drop a previously locked indexed page, propagates integrity failures instead of silently falling back, and stages and validates the entire replacement corpus before publication. Markdown length, heading, and fence checks remain shape checks rather than proof of semantic completeness; discovery preservation and local body hashes provide the stronger committed-corpus evidence.

## Original ownership clarification

`ownership.json` expands every prefix and brace from the supplied original assignment. In particular, `P/test/` means `plugins/photon/test/`; it is not a broad package wildcard. WT05 owns its exact existing-QM compatibility files, WT16 owns its exact admin registration files, and WT22 owns its exact CLI registration files. Shared contracts and canonical iMessage documents are integration-owned only after the repaired freeze.

## Freeze and Wave A handoff

Because `qm-imessage-f0` already existed locally, it remains unchanged. The corrective tag and checkpoint are pending final verification and fresh-context review. After the implementation commit exists, `qm-imessage-f0-r1` will identify it; a separate documentation-only commit will add the immutable `foundation-checkpoint.json` with the exact tag target, tools, commands, and review result. Final worktree preparation results belong in a separate handoff record so the first-added checkpoint blob never changes.

The mandatory original prompt substitution is:

> Replace base tag `qm-imessage-f0` with `qm-imessage-f0-r1`; do not change the lane assignment.

No f1/f2/f3 tag is created and checkpoint 1 is not claimed.
