# Program: Session autonomous iteration

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `完成`
- Profile: `Lite`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-autonomy-refinement-all-final.log` — 1028/1028 pass; `/tmp/codeck-autonomy-refinement-browser.log` — six provider/viewport journeys pass, zero browser errors
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-09-25`
- Clean state: `Not due`
- Last clean: `2026-09-25 / README and Verification boundary reconciled against /tmp/codeck-autonomy-refinement-all-final.log and /tmp/codeck-autonomy-refinement-browser.log`

## Outcome

- Problem: Remote requires manually asking an Agent to continue after each turn.
- Success: Adjacent ? and circled A controls provide concise non-interrupting progress questions and choice-based goal/budget/preferences setup with explicit approval. Confirmed tasks continue server-side until completion, a finite round limit, or a safe pause; users can redirect without losing spent budget. Unknown delivery hints can be dismissed without replay or false confirmation.
- Non-goals: Workflow engine, dashboard, autonomous permission approval, new dependencies. Git release and deployment are separately authorized by the user's subsequent request.

## Constraints

- Strategic defaults: User AGENTS: read before edits, minimal scoped diffs, failing regression tests, preserve unrelated changes.
- Tactical objective: Lightweight session UI with reliable bounded execution and human takeover.
- Imperative bounds: No implicit authority expansion; no replay of uncertain sends; no continuation after pause or identity change; agent-reported completion is not independent verification.
- Negotiable space: Protocol, module boundaries, persistent state shape, conservative recovery behavior.
- Material assumptions: None unless an inferred preference could change the plan.
- Active unknowns: Native CLIs lack a shared task-result tool. Use nonce-bound final assistant records with a confirmed outbound message anchor; malformed/missing records pause rather than guess. Fee/token budgets are advisory without metering; round/deadline limits are controller-enforced.
- Escalate when: A preference conflicts or evidence reveals a better option that requires changing a bound.

## Acceptance

| ID | Condition | Verification | Pass condition |
|---|---|---|---|
| A-001 | Configuration asks for goal, acceptance, budget and preferences; cannot self-authorize | Controller/protocol unit tests | Explicit human confirmation required, malformed/stale/tool records rejected |
| A-002 | Bounded server-side continuation independent of browser | Controller fake-clock + backend integration tests | Each round dispatched at most once; completion/limit/wait/block tested |
| A-003 | Human takeover and restart safety | Race, cancellation, persisted-state tests | Pause invalidates queued writes; no restart replay; spent budget retained |
| A-004 | Minimal accessible Remote control | Browser smoke at 390/1365 + screenshots | Symbol, round/state, start/pause/adjust, no overflow or console errors |
| A-005 | Existing behavior preserved | npm test | All tests pass |
| A-006 | ? does not change pace or autonomous mode | Prompt + Hub + tmux queue tests | No forced Escape, draft clearing, autonomous start, pause or budget reset |
| A-007 | Edited-text unknown receipts do not remain stuck at latest | Exact-match negative control, restored anchor and dismissal/reconnect tests | No fuzzy confirmation or replay; explicit dismissal survives client reload and server reconnect |
| A-008 | A setup/goal confirmation uses choices | Controller/API + mobile/desktop browser flow | Agent-suggested choices/custom answer; explicit plan approval; stale/cancel/reconnect safe |
| A-009 | Compact ? and adjacent controls | Prompt length and browser geometry | Prompt <= 120 Chinese characters; both controls retain 44px targets with no distributed gap |

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | Protocol, persistence and bounded controller with tests | node --test test/autonomy.test.js | /tmp/codeck-autonomy-all-final.log; test/autonomy.test.js | R-001 |
| NODE-002 | `完成` | Wire authenticated Agent API, guarded tmux writes and human takeover | AgentHub/tmux/terminal/server integration tests | /tmp/codeck-autonomy-all-final.log; /tmp/codeck-autonomy-server.log | R-002 |
| NODE-003 | `完成` | Remote symbol, status and conversational controls | UI unit/browser checks | /data/tmp/codeck-remote-smoke-feeERG; test/remote-submission.test.js | None: existing UI primitives fit; mobile/desktop rendered states pass |
| NODE-004 | `完成` | Full regression, rendered verification and documentation | npm test; browser smoke; plan validation | /tmp/codeck-autonomy-all-final.log; /tmp/codeck-autonomy-browser-final.log; /data/tmp/codeck-remote-smoke-y32LM3 | None: final keyboard and isolated server journeys pass |
| NODE-005 | `完成` | Retire unknown receipt UI explicitly without claiming delivery; restore original anchor | Receipt/controller/browser regressions | /tmp/codeck-receipt-red.log; /tmp/codeck-autonomy-refinement-all-final.log; /tmp/codeck-autonomy-refinement-browser.log | R-003 |
| NODE-006 | `完成` | A choice-based questions and final goal approval, bound to exact configuration nonce | Controller/Hub tests and browser journeys | /tmp/codeck-autonomy-choices-red.log; /tmp/codeck-autonomy-refinement-all-final.log; /data/tmp/codeck-remote-smoke-G6WtWS | None: existing modal and nonce-bound protocol support the revised flow |
| NODE-007 | `完成` | Concise progress prompt, adjacent controls, full verification and README | npm test; browser smoke; strict plan check | /tmp/codeck-autonomy-refinement-all-final.log; /tmp/codeck-autonomy-refinement-browser.log | R-004 |

## Reflection Log

Record consequential findings here; routine verification stays in the Plan table.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 result/recovery races | /tmp/codeck-autonomy-edge-red.log; /tmp/codeck-autonomy-race-red.log; test/autonomy.test.js | A later progress answer could hide completion; stale read failure could pause a new direction; persistent history errors could hang | Nonce + user anchor + final assistant evidence; generation guards; conservative restart | Retain final result across read-only progress turns; guard rejected promises too; bound history failures |
| R-002 | NODE-002 non-interrupting progress and safe input | /tmp/codeck-progress-red.log; /tmp/codeck-autonomy-claude-red.log; test/tmux.test.js | Existing send forced Escape on Codex queued messages; Claude blank first line did not prove empty composer | Reuse verified pane, input serialization and native queues | ? skips forced queue release; guarded sends inspect full composer and cancel before Enter |
| R-003 | NODE-005 screenshot IMG_1567 | Live read-only codeck snapshot and isolated recovery/Hub probe (2026-09-25) | Short receipt differs from accepted longer input; restoration drops queued placement and appends it at latest | Exact text/nonce evidence must not be weakened into prefix success | Restore using known anchor; provide explicit persisted dismissal distinct from confirmation, never resend |
| R-004 | NODE-007 prompt compatibility | /tmp/codeck-cached-progress-red.log; /tmp/codeck-cached-progress-green.log | Replacing the prompt alone makes an already-open page's old ? look like a manual direction change | Exact recognition avoids treating arbitrary messages as read-only progress | Recognize the deployed previous prompt in both Hub dispatch and autonomous result parsing; cache-bust both page entries |

## Verification boundary

- README's revised flow is exercised with actual UI/controller plus simulated Agent responses: click A, select/customize answers, defer/reopen without losing choices, explicitly approve the plan, observe rounds, reload, pause, redirect with spent budget retained, complete. Three providers at 390/1365 pixels; light/dark screenshots inspected. Unknown receipt dismissal survives a simulated server reset and browser reload without resend; separate V2 Hub tests cover synchronized-frame propagation to another client.
- Initial implementation was released as f6227a4 on the user's separate request (1020 tests; API/assets/V2 stream; all 10 tmux identities retained). After follow-up acceptance, the user separately requested commit, push and deployment. Real long-running CLI protocol compliance remains unverified; malformed results pause safely.
- Deadline and rounds prevent future dispatch, not kill an in-flight command. Money/token limits are advisory; completion is Agent-reported evidence, not independent goal validation.
- Follow-up acceptance A-007 through A-009 completed 2026-09-25. No active implementation work or human decision remains; implementation verification did not restart services or inject live CLI input. Agent-generated choice/proposal compliance in real long-running sessions remains outside the isolated fixture verification.
