# Program: Remote consistency, correctness, and stability

- Overall status: `阻塞`
- Profile: `Lite`
- Active plan node: `NODE-004`
- Latest evidence: `NODE-014 released the Qoder production-path compaction fix as 8542809; 834/834 tests and 6 browser journeys pass. Service PID 1963317, authenticated API/V2, read-only thread open and all 8 tmux sessions pass after restart.`
- Current blocker: `A-004 requires the user's other server, authenticated Claude/Qoder test sessions and physical-phone journeys; none are available to this executor. Owner: user; unblock with an accessible SSH host/test-session names or target-side verification.`
- Next step: `NODE-004: obtain the other server/test sessions for remaining live journeys, including hmap after updating that server. G-007 half-open recovery remains unresolved.`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `Codex`
- Last updated: `2026-09-08`
- Clean state: `Not due`
- Last clean: `2026-09-08: NODE-014 local release evidence reconciled; A-004 and G-007 remain explicitly unverified or unresolved`

## Outcome

- Problem: Remote has repeatedly lost, misordered, or misclassified messages and activity. The original screenshot exposed input/output ordering; IMG_1345 exposed a missed Qoder background-task footer; IMG_1348 showed the terminal-style live echo merging with historical input; IMG_1349 exposed an internal compaction summary rendered as a user message.
- Success: Codex, Claude, and Qoder adapters expose a common data contract; interaction logic uses that contract; UI renders its states consistently. Claims of parity require end-to-end evidence, not just green unit tests.
- Non-goals: Replace native CLIs, interrupt users' existing sessions, change authentication, add project dependencies, or publish without release authorization.

## Constraints

- Strategic defaults: Follow repository instructions; reproduce failures before fixes; make reviewable, coherent changes and preserve unrelated work.
- Tactical objective: Model first, interaction second, UI third. The user explicitly requires simple, robust, reliable multi-layer design and plan-skill-managed iterations.
- Imperative bounds: No blind message replay or synthetic success; preserve exact provider/thread/pane routing, real transcript order, and ordinary-terminal behavior.
- Negotiable space: Shared helpers, additive protocol metadata, adapter normalization, regression fixtures, and presentation of verified states.
- Material assumptions: Official Codex Remote is a quality reference, not authorization to replace tmux participation with an exclusive app-server writer.
- Active unknowns: Live authenticated Claude/Qoder sessions and the user's other server are not available here. Resolve with isolated fixtures now and actual provider/server journeys before parity claims.
- Escalate when: Reaching parity needs a new transport, process ownership change, additional server access, or destructive migration.

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | Input follows output already visible when sent, across all three providers | Shared model, hub, Codex adapter, and composer regressions | Stable ordering through late response, refresh, reconnect, and repeated sends |
| A-002 | Existing delivery and interaction safety remains intact | Full `node --test`; review send/retry and identity boundaries | No regression in duplicate suppression, draft protection, commands, or history retention |
| A-003 | Model/interaction/UI contracts and provider gaps are explicit | Review adapter outputs and their public consumers | One documented semantic contract; no false parity or hidden provider assumptions |
| A-004 | Official-quality claim has representative live evidence | Mobile browser and authenticated CLI journeys on target servers | Idle/busy/background, commands, failure, reconnect, scroll/latest, attachments, and resume pass; currently not established |
| A-005 | Persisted follow-up ordering survives adapter summaries and receipt replacement | Codex source-order fixture plus equivalent adapter contract cases | Preserve user-original, output-old, user-followup, output-new; full/summary/receipt-replacement regressions now pass |
| A-006 | Qoder's live positive Background task count remains background without a foreground spinner | Screenshot-derived parser-to-session-to-Remote regression; quote/draft/zero/retired-footer controls | Ordinary and Remote receive background, foreground work still wins, completion returns idle, unrelated text cannot set the flag |
| A-007 | Agent live echo remains visually distinct from user input and stable while reading history | VM render contract plus three-provider light-mobile/dark-desktop browser journeys | Live echo uses the final assistant-message surface; Shell/raw command output remains terminal-shaped; queued auto-follow never overrides a newer manual scroll |
| A-008 | Internal SDK compaction summaries never appear as user-authored history | Claude raw conversion plus a production-path Qoder session-store/SDK regression with identical ordinary user text as a negative control | SDK branch reconstruction runs on the complete source; only raw records explicitly marked `isCompactSummary` are omitted afterward; ordinary user text and surrounding assistant output remain visible and ordered |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | Reproduce chronological-order defect and identify shared consumers | Failing model/hub/retry tests | Old code inserts received input before old answer and tools; 4 regressions fail | R-001 |
| NODE-002 | `完成` | Add a shared send-time placement anchor through adapters and interaction logic | A-001, A-002 | 779 tests pass, 0 fail; diff check passes; source/pane checkpoint ordering covered for all providers | R-002, R-003 |
| NODE-003 | `完成` | Audit and document model, interaction, UI consistency and remaining parity gaps | A-003 | Three-layer contract, G-001 through G-006, I-01 through I-05; strict plan validation passes | R-004 |
| NODE-005 | `完成` | I-01: normalize model/adapter contracts, beginning with persisted order | A-005 and I-01 scenarios | `test/agent-backends.test.js`, `test/agent-contract.test.js`: source-order cache including live events/interrupted tools, shared execution/receipt semantics, monotonic receipt and identity isolation pass | R-005, R-009 |
| NODE-006 | `完成` | I-02: shared interaction state machine | I-02 scenarios; depends on NODE-005 | `test/remote-submission.test.js`, `test/remote-delivery-ui.test.js`, `test/remote-delivery.test.js`: all providers settle/reconnect identically; lost responses settle without replay; newer draft/attachments and other sessions preserved | R-006 |
| NODE-007 | `完成` | I-03: typed command/capability results and uniform states | I-03 scenarios; depends on NODE-005 and NODE-006 | `test/remote-command-output.test.js`, `test/remote-command-dialog.test.js`, `test/agent-contract.test.js` and 6 browser journeys: capabilities, errors, selection/dismiss, approval recovery and background states pass | R-007 |
| NODE-008 | `完成` | I-04: history/rendering/mobile consistency | I-04 scenarios; depends on NODE-006 and NODE-007 | `test/remote-history.test.js`, `test/remote-scroll.test.js`, `test/agent-contract.test.js` and 6 browser journeys: non-overlapping tails, gap paging, latest/up, reading position, clipboard, attachments and geometry pass; Codex polling reads 20-turn tail | R-008, R-010, R-011 |
| NODE-004 | `阻塞` | I-05: fault injection and real provider/server/mobile journeys for parity | A-004; depends on NODE-008 | Deterministic faults, browser fixtures, live Codex read-only probes and local restart/session survival pass. Missing authenticated Claude/Qoder, other target server and physical-phone journeys; owner/unblock action above | R-007, R-009, R-010, R-011 |
| NODE-009 | `完成` | User-authorized local deployment, commit and push of the verified fixes | Full suite, browser fixtures, service/API/V2 stream health, existing tmux session survival and remote Git ref | Release 109ad60 pushed to origin/main; 827 tests and 6 browser journeys pass; service PID 1724177, authenticated health/sessions 200, unauthenticated sessions 401, V2 streams and 20-turn read pass; all 8 tmux identities unchanged | None: scoped release, no new implementation |
| NODE-010 | `完成` | Fix screenshot-exposed Qoder background task badge detection; deploy locally on the user's follow-up release request | A-006; focused Qoder/Codex/status tests, full suite and deployment health | `test/qoder-status.test.js`: 2 regressions fail before and pass after; 21 focused and 830 total tests pass. Badge/foreground/completion/negative controls covered. Local service PID 1750986, API/V2 checks and 8-session preservation pass; other-server hmap not re-tested | R-012 |
| NODE-011 | `完成` | Make pane-only Agent echo match final reply rendering and prevent stale auto-follow from overriding an upward scroll | A-007; screenshot-derived VM contract, full suite and 6 real-browser journeys | `test/remote-live-output-ui.test.js` fails before and passes after; 832 tests pass. Codex/Claude/Qoder at 390×844 and 1365×900 pass live-output/latest/manual-scroll/history/failure/command journeys; light-mobile screenshot `/data/tmp/codeck-remote-smoke-RL72Dr/qodercli-390-live-output.png` | R-013 |
| NODE-012 | `完成` | User-authorized local deployment, commit and push of NODE-011 | Full suite, browser fixtures, service/API/V2 stream health and existing tmux session survival | Release `f3d8f6a` pushed to `origin/main`; service restarted at 2026-09-07 22:16:10 CST with PID 1805009 and zero automatic restarts. Authenticated health/sessions, unauthenticated 401, V2 ready/sessions/openThread and all 8 original tmux identities pass | None: scoped release, no new implementation |
| NODE-013 | `完成` | Hide screenshot-exposed SDK compaction summaries and deploy the scoped fix | A-008; failing-then-passing transcript regression, full suite, browser fixtures and deployment health | Release `cb7d6d5` pushed to `origin/main`; 833 tests and 6 browser journeys pass. Service restarted at 2026-09-08 08:19:42 CST with PID 1910802 and zero automatic restarts; authenticated health/sessions and V2 ready/sessions pass, unauthenticated sessions return 401, and all 8 tmux identities remain | None: one metadata guard; no text heuristics, transport, cache or UI changes |
| NODE-014 | `完成` | Close NODE-013's Qoder production-path gap without changing SDK branch reconstruction or ordinary history | A-008 and A-002; real Qoder SDK/session-store regression must fail before and pass after, followed by focused/full tests and release health | Release `8542809` pushed to `origin/main`; production-path regression fails before and passes after, 26 focused and 834 full tests pass, and 6 browser journeys have zero errors. Service PID 1963317, API/V2/read-only thread checks and all 8 tmux identities pass after restart | R-014 |

## Abstraction Gate

- Abstraction impact: modify.
- Concrete pressure / current consumers: Frontend optimistic messages, hub receipt restoration, and Codex summary/full merges independently choose positions and can disagree.
- Existing pattern / direct alternative: Extend the existing delivery baseline; duplicating insertion rules in each provider would retain the demonstrated drift.
- Boundary / owned invariant: A pending input has a captured last-observed item anchor, preserved across retry and reconciliation; newer output must not move it ahead of old output.
- Explicit non-responsibilities: CLI input transport, receipt evidence, execution completion, and transcript persistence remain adapter/backend concerns.
- Expected variation: CLI transports and evidence sources vary; placement semantics do not.
- Concept count / indirection: Replace three competing positioning rules with one shared insertion rule; add one optional field to the existing baseline, not a new state owner.
- Coupling / interface impact: Additive client/server metadata; older clients remain accepted with a conservative tail fallback.
- Contract verification: The same chronological scenarios run for all providers, with backend and composer wiring checks.
- Rollback / deletion trigger: Revert the coherent ordering change if consumer tests fail; replace the anchor only when authoritative cross-provider event sequence IDs exist.

## Reference evidence

- [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server): remote TUI connects to app-server; item/turn events provide structured lifecycle data; steering adds input to an active turn. These are protocol references, not proof of Codeck's quality or of official UI behavior under every failure.
- Local baseline: `c3baaca`; screenshot `/home/x/.codeck/uploads/remote/1788773545304-34d871a7-IMG_1341.jpeg`.

## Reflection Log

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 | Screenshot and hub failing sequence: user, new input, old answer, old tool | Queued input was assumed to belong ahead of every output in its turn; existing tests encoded that assumption | Stable IDs and receipt baselines already exist | Capture send-time position; use provider-shared semantic tests rather than treating previous behavior as the oracle |
| R-002 | NODE-002 | New Codex full/summary and cross-provider hub/model/composer regressions fail before the fix and pass afterward | A Qoder-only change would leave the same ordering policy duplicated in other consumers; two legacy Claude tests treated old output as future output | Preserve provider-specific send/receipt evidence and exact routing | Share the placement invariant at the model boundary, with additive metadata and unchanged CLI transport |
| R-003 | NODE-002 | Three provider tests for `input follows its captured terminal activity checkpoint` failed after the initial pass | The send path may add a pre-send pane checkpoint after capturing the source-item baseline | The checkpoint has an exact command-scoped ID and must remain before that input | Prefer this command's local checkpoint when present; never use another command's checkpoint as ordering evidence |
| R-004 | NODE-003 | Read-only Codex adapter fixture: source [user-original, output-old, user-followup, output-new], summary result [user-original, user-followup, output-old, output-new] | Correct receipt placement does not establish whole-lifecycle ordering; persisted summary projection remains a separate defect | Keep first fix scoped and retain the newly discovered counterexample | Begin I-01 with persisted source-order tests and validate pending-to-persisted transitions before claiming chronological parity |
| R-005 | NODE-005 | Persisted source-order cases failed before the adapter change; three-provider contracts exposed received-to-unknown downgrade | A users-only cache loses source positions; a lagging snapshot is not evidence that an observed receipt disappeared | Retain source IDs in the existing cache, without duplicating tool payloads; keep delivery separate from execution | Supplement missing summary users by source neighbors; preserve known receipts within exact thread/provider scope |
| R-006 | NODE-006 | Lost-response settlement and newer-draft/attachment cases failed before the interaction change | Only unconfirmed RPC results had enough attempt metadata to settle; attachment cleanup incorrectly depended on unchanged text | Keep one original command ID and prohibit blind replay; match exact provider/thread/tmux scope | Capture scope/draft/attachment IDs before sending; settle on real evidence after the request gate; clear only sent attachments independently of newer text |
| R-007 | NODE-007, NODE-004 | Command error-to-model-menu and failed-approval retry tests fail before fixes and pass afterward | A command name does not prove native interaction support; an absent selection result is not success; transient approval failure left buttons disabled | Preserve raw command output and native adapter mechanics | Normalize real capabilities/results; show success only on explicit completion; restore retry controls on transient failures |
| R-008 | NODE-008 | Cross-provider non-overlapping-tail, pagination-progress and scroll event regressions pass | No overlap was treated as history deletion; paging gaps prepended out of order; background events forced latest | Keep stable item/turn keys and explicit latest action | Retain loaded history outside truncated windows, insert pages at their source anchor and preserve the reader's position |
| R-009 | NODE-005, NODE-004 | Live item-event source-order and interrupted-tool interleaving regressions fail before final adapter fixes and pass afterward | Full/summary fixtures alone missed a live-event cache path; interrupted hydration grouped tools after messages | Store source IDs in the existing cache; do not retain full tool logs | Exercise observation, projection and reopen independently; source order must survive every cache entrance |
| R-010 | NODE-008, NODE-004 | Live full-history diagnostic hit its overall 45-second deadline; 20-turn read-only probes complete, and requested-limit regression passes | Polling hydrated up to 80 turns before discarding all but 20 | Preserve explicit older-history paging and the default full-read path | Request the polling window at the backend; report cold/warm probe evidence without claiming a controlled speedup |
| R-011 | NODE-008, NODE-004 | New gap-below-viewport test failed with scrollTop 110 instead of 10; fixed test and all 6 browser gap journeys pass | Total added height is not the visible displacement when a reconnect gap is filled in the middle | Retain request generation guards, stable turn IDs and ordinary prefix compensation | Anchor scroll compensation to the currently visible turn, including replacement DOM nodes |
| R-012 | NODE-010 | IMG_1345 shows `1 Background task` with no wait spinner; local Qoder 1.1.45 builds this footer from pending/running tasks; screenshot regressions fail before and pass after the detector fix | Earlier wait-label tests and synthetic background sessions did not cover the actual footer-to-status producer | Preserve independent foreground/background states, provider isolation and input transport | Test real status producers end to end into the shared model; recognize a positive count only in the current footer, with stale/quoted/draft/zero negative controls |
| R-013 | NODE-011 | IMG_1348 plus the new render contract and browser race: the live pane used a grey terminal card, and its queued next-frame auto-follow moved the viewport after a manual upward scroll | Prior browser coverage checked final structured messages and settled scroll positions, but not the pane-only presentation or user input arriving between render and its queued follow callback | Preserve one assistant-message surface for structured and pane-only Agent replies; preserve terminal surfaces for Shell, raw commands and checkpoints | Every transient/final UI pair must share a presentation contract, and deferred automatic scrolling must be cancelled by newer user scroll intent |
| R-014 | NODE-014 | Qoder's real `getSessionMessages` output omits `isCompactSummary` even though the raw JSONL record carries it; the NODE-013 converter fixture bypassed that normalization boundary | A shared converter test cannot prove provider metadata survives its adapter; passing browser fixtures without a compaction source also cannot establish the behavior | Keep the complete raw graph as SDK input and preserve UUID identity through normalization | For provider-specific metadata, exercise the actual adapter/SDK boundary and restore only explicit raw facts after authoritative branch reconstruction |

## Three-layer target contract

This contract guides the implemented shared semantics. It does not imply identical native CLI capabilities or completion of A-004.

| Layer | Owns | Must not own |
|---|---|---|
| Provider adapters + normalized model | Exact session identity; stable thread/turn/item IDs and source order; delivery evidence; execution state; typed command results; capabilities and structured errors | Presentation text, browser drafts, viewport rules, or inferred success unsupported by evidence |
| Shared interaction logic | Send/steer/stop actions; command lifecycle; duplicate suppression; draft/attachment settlement; snapshot/event reconciliation and reconnection | Provider-specific terminal parsing, raw log formats, or competing copies of execution state |
| UI | Render normalized items/states; compose input; dialogs; copy/paste; scrolling and mobile layout; visible recovery actions | Infer ready from silence, infer receipt from a blank terminal, or reorder messages by role/provider |

### Model invariants

- Identity is scoped by provider, thread, tmux session and validated pane; IDs from another scope cannot settle delivery or replace history.
- Conversation order follows stable source item IDs and event order. Pending Remote input additionally carries its captured placement anchor. Arrival time, user/assistant grouping, and CLI busy flags are not ordering rules.
- Delivery and execution are different axes. Transport acceptance, CLI receipt, and persisted transcript confirmation need distinct evidence; none means the task has finished. Unknown delivery retains recovery guidance and never triggers automatic full-text replay.
- Execution distinguishes foreground work, background work, waiting for user action, idle, and failure. Missing/stale observations remain unknown; they are not idle.
- Commands produce typed outcomes: dialog, selection, inline result, unsupported capability, or error. Command results are not ordinary model replies.
- Attachments and draft contents belong to their send attempt and selected session. A late result cannot clear a newer draft or another session's attachments.
- Snapshots/events carry scoped cursors/revisions; duplicate and stale events cannot regress observed content or confirmation. A refresh is not evidence that missing history was deleted.
- Backend-specific evidence stays in adapters. Capabilities explicitly describe genuine differences; the UI consumes capability/result semantics rather than matching provider names or error strings.

### Evidence-backed gaps to resolve

| Gap | Current evidence | Consequence / next investigation |
|---|---|---|
| G-001 | Resolved in I-02: receipt settlement, restart, same-text protection and same-scope reopen share model rules | Qoder input logs remain adapter-specific evidence, not a special browser lifecycle |
| G-002 | I-03 adds shared `threadExecutionState`: waiting-user, foreground, background, unavailable, failure, idle, unknown precedence; UI uses normalized observations | Equivalent inputs have identical states; actual CLI status detection still requires the missing live-provider journeys |
| G-003 | I-02 tests reconnect, lost response and epoch restart without replay; process-local receipt cache remains intentional | Fresh transcript/receipt evidence settles uncertainty. No durable exactly-once promise across service restart and no speculative persistence layer |
| G-004 | I-05 now has reproducible real-browser fixtures plus contract/VM fault tests and live read-only Codex probes | Authenticated Claude/Qoder and target-server/phone journeys remain the A-004 blocker; simulated providers are not live evidence |
| G-005 | I-03 normalizes command output and actual backend capabilities; old-server raw-output fallback remains | Codex native model choices remain supported; unsupported native interactions retain readable output, not fake actionable buttons |
| G-006 | Resolved in I-01: full and summary projection preserve authoritative item order and supplement missing users by source IDs | Pending-to-persisted replacement, completed-turn reopen and summaries omitting follow-up users are covered |
| G-007 | Protocol explanation exposed an existing half-open-connection gap: no active heartbeat; isolated request-timeout probe returns after 60 seconds but leaves socket OPEN and connected=true | Not fixed by this release. Add a separately scoped liveness/recovery change; do not equate ordinary reconnect tests with mobile network-blackhole recovery |

## Planned iterations

Each iteration is an independently reviewable slice; the Plan table owns its status. The user's explicit deployment requests authorize NODE-009 and the NODE-010 follow-up on this server with the reported evidence limits; they do not waive A-004 for an official-quality claim or authorize rollout to other servers.

| Iteration | Scope and dependencies | Acceptance / decisive scenarios | Exit / rollback |
|---|---|---|---|
| I-01 | Unified model contract and adapter contract fixtures; depends on NODE-003; start with G-006 | Preserve source order before/after persistence, then same normalized outcomes for idle, working, background, waiting-user, failure, receipt, persisted confirmation; source-specific evidence retained | No transport/auth/session-ownership changes. Revert the adapter projection if transcript/history/identity regresses |
| I-02 | Shared interaction state machine using I-01; retire duplicated receipt/draft rules | Send response before/after event; input while working; lost response; retry; reconnect; service restart; same text twice; newer draft/attachments; session switch | Exactly-once within existing supported receipt scope; never claim durable exactly-once across restart without evidence. Revert coherent interaction slice on duplication or draft loss |
| I-03 | Typed command/capability results and uniform UI states using I-01/I-02 | `/model`, `/status`, `/usage`, selection/dismiss, supported/unsupported, busy/error; identical wording/actions for equivalent facts | Keep provider mechanics in adapters and plain terminal available; rollback command/UI mapping separately |
| I-04 | History/rendering/mobile consistency using stable model and interaction behavior | Tail/latest then scroll up, pagination, background refresh, reconnect, copy/latest output, attachments, keyboard/viewport; no missing/duplicate items or unsolicited scroll jump | Preserve stable DOM keys and bounded history; compare before/after latency on the same fixture before any performance claim |
| I-05 | Fault injection, real-provider journeys, observability and release gate | Combine slow/partial/failed/reordered/replayed events with foreground/background CLI states; target-server and phone verification | No parity claim or broad rollout until required journeys pass; retain a known-good revision and verify sessions survive restart |

### Simplicity and reliability review for every iteration

1. Identify the single owner and lifecycle of each new fact/state. Reject a second mutable owner or a flag that only compensates for missing model semantics.
2. Reuse the current modules and dependencies. Introduce a shared function only for a concrete invariant with real consumers; do not build a generic event framework or database preemptively.
3. Specify the strongest plausible failure before coding: delay, reordering, interruption, partial write, missing source evidence, or restart.
4. Reproduce the failure first, then exercise the shared contract for all supported adapters and the affected UI journey.
5. Review identity/auth boundaries, bounded caches/listeners/timers, error visibility, and rollback impact. Emit diagnostic IDs/states, not prompt text, tokens, or attachment contents by default.
6. Report separately: code verified, browser fixture verified, live provider verified, target server verified. Preserve unmet evidence in this plan instead of converting it into a success claim.

## Verification evidence

- Full suite: `node --test --test-reporter=spec` — 827 passed, 0 failed/skipped on 2026-09-07; includes ordinary-terminal, identity, transport, history, adapter, delivery and command regressions. Syntax and `git diff --check` pass.
- Browser: `scripts/remote-browser-smoke.mjs` serves actual HTML/CSS/JS against isolated API/WebSocket fixtures; 3 providers × 390×844 / 1365×900 Chromium viewports, dark/light themes. All 6 journeys pass, 0 page errors; screenshots: `/data/tmp/codeck-remote-smoke-e0ZuuN`. Replay instructions are in README. This run also covers below-viewport reconnect gaps, model errors, approval, native model capability differences, attachments, clipboard, lost response and epoch change without a duplicate write. A 420px-high viewport approximates keyboard geometry, not real iOS keyboard behavior.
- Browser event-to-observed-render samples: mobile 61/57/58ms, desktop 89/106/104ms for Codex/Claude/Qoder. These include automation polling and two animation frames; they are not pure render cost, a controlled before/after benchmark, or a production SLO.
- Live read-only Codex: local CLI 0.153.2; source-order comparison preserved 170 shared item IDs in research. Full-history diagnostic reached its overall 45-second deadline during report; it was not a passing full-history benchmark. Exact 20-turn polling probes (cold/warm): report 877/8ms, research 157/6ms, codeck 337/60ms. No text or slash commands were sent into user CLI sessions.
- Local runtime inventory: 8 tmux sessions remain, API reports 7 Codex and 1 shell; no authenticated Claude/Qoder session is available here. Installed Claude 2.1.258 / Qoder 1.1.45 binaries alone do not establish live-provider correctness.
- Release verification: reran all 827 tests and 6 browser journeys (screenshots `/data/tmp/codeck-remote-smoke-BuwB6y`). Restarted `codeck.service` at 2026-09-07 18:30:25 CST, PID 1724177, active/running with zero automatic restarts. Authenticated `/api/health` and `/api/sessions` return 200; unauthenticated sessions returns 401. Owner V2 handshake, session snapshot, read-only open of codeck (20 turns), and thread snapshot pass. All 8 tmux session IDs/names/creation times are unchanged; tmux server remains outside the service control group. No message was sent into a user's CLI.
- Post-release screenshot fix (NODE-010): `test/qoder-status.test.js` reconstructs IMG_1345's footer and drives screen detection → session status → Remote model. Singular/plural, ANSI, normal/YOLO, wrapped summary and draft variants remain background; foreground wins, and zero/completed/quoted/draft/retired badges do not activate it. 21 focused and 830 full tests pass; syntax/diff checks pass. Live hmap on the other server has not been re-tested.
- NODE-010 deployment: reran all 830 tests, syntax/diff/strict-plan checks, then restarted `codeck.service` at 2026-09-07 19:08:12 CST (PID 1750986, active/running, zero automatic restarts). Authenticated health/sessions return 200; unauthenticated sessions returns 401. Owner V2 handshake, session snapshot, read-only codeck open (20 turns) and thread snapshot pass. All 8 tmux session IDs/names/creation times are unchanged. No CLI input was sent; the other server was not deployed.
- Post-release presentation fix (NODE-011): `test/remote-live-output-ui.test.js` fixes the transient/final render contract for Agent pane fallback while retaining Shell terminal output. All 832 tests pass. Six Chromium journeys cover Codex/Claude/Qoder at 390×844 and 1365×900, including live-output/latest/manual-scroll races with zero page errors; artifacts `/data/tmp/codeck-remote-smoke-RL72Dr`. The screenshot-derived light-mobile Qoder frame shows distinct user bubbles and a borderless assistant-style live reply.
- NODE-012 deployment: release `f3d8f6a` is pushed to `origin/main`. Restarted `codeck.service` at 2026-09-07 22:16:10 CST (PID 1805009, active/running, zero automatic restarts). Authenticated health and 8-session API return 200, unauthenticated sessions returns 401. Owner V2 handshake, session snapshot and read-only codeck open (20 turns, truncated tail) pass. All 8 tmux names, IDs and creation times are unchanged. No CLI input was sent; the other server was not deployed.
- NODE-013 compaction visibility fix: the regression fails before and passes after the metadata guard; all 833 tests pass. Six Chromium journeys cover Codex/Claude/Qoder at 390×844 and 1365×900 with zero page errors; artifacts `/data/tmp/codeck-remote-smoke-iy5YlJ`. Release `cb7d6d5` is pushed to `origin/main`; `codeck.service` restarted at 2026-09-08 08:19:42 CST with PID 1910802 and zero automatic restarts. Authenticated health and 8-session API return 200, unauthenticated sessions returns 401, owner V2 ready/session snapshot passes, and all 8 tmux identities remain unchanged. No CLI input was sent; the other server was not deployed.
- NODE-014 pre-fix evidence: a synthetic raw Qoder transcript passed through the installed SDK returns the compaction summary as a normal `user` message while removing `isCompactSummary`. This is the escaped production-path failure class; the existing 833-test result remains valid for its covered cases but does not satisfy A-008 for Qoder.
- NODE-014 implementation evidence: the same transcript now reaches the shared converter with its UUID-scoped raw marker restored after SDK branch reconstruction. The regression preserves the preceding/following assistant output and an ordinary user message with identical text. The two focused files pass 26 tests, the full suite passes 834, and six browser journeys pass with zero page errors; artifacts `/data/tmp/codeck-remote-smoke-WMaFL5`.
- NODE-014 deployment: release `8542809` is pushed to `origin/main`. `codeck.service` restarted at 2026-09-08 12:13:20 CST with PID 1963317 and zero automatic restarts. Authenticated health and 8-session API return 200, unauthenticated sessions returns 401, owner V2 ready/session snapshot and a 20-turn read-only `codeck` open pass. All 8 tmux IDs, names and creation times are unchanged. No CLI input was sent; the other server was not deployed.

## Current verification boundary

- NODE-009 deployed and pushed source revision `109ad60`; NODE-010 subsequently updates the server-side Qoder status producer on this server. No other-server rollout is claimed.
- NODE-010 is deployed with the user's explicit release authorization. Only the Qoder screen-status producer plus tests/this plan changed; input transport, receipt handling, stream protocol and UI source are unchanged.
- NODE-011 is deployed on this server through release `f3d8f6a`. It changes only Remote presentation and scroll-intent arbitration; adapter data, transport, delivery, command and ordinary-terminal paths are unchanged.
- NODE-013 is deployed on this server through release `cb7d6d5`. Its guard works for Claude's raw transcript path and already-normalized inputs, but Qoder's SDK strips the marker before that guard; NODE-014 reopens A-008 for that provider.
- NODE-014 is deployed on this server through release `8542809`. Qoder's complete raw graph still reaches the SDK first; only afterward is the UUID-scoped `isCompactSummary` fact restored for the shared guard. Normal history, SDK branch semantics, transport and UI are unchanged. The other server remains unverified and undeployed.
- I-01 through I-04 and local I-05 checks, including authorized local restart/session survival, are verified within the evidence above. A-004 remains blocked, not accepted: obtain the other server/test sessions and run real send/busy/background/commands/failure/reconnect/scroll/attachments/resume journeys on a phone.
- No parity claim, durable exactly-once guarantee or performance speedup is established by the fixture test counts.
- Tool-item completion may update an existing item in place. That is not a new conversation item and is not split into an artificial message solely for chronology.
- Older clients/receipts lacking the placement anchor remain accepted and fall back after existing items; their exact original send-time position cannot be reconstructed reliably.
- No broad architecture migration, model ownership change or project dependency was introduced. Playwright/Chromium were prepared in an isolated temporary directory solely for the browser verifier.
