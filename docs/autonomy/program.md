# Program: Session autonomous iteration

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `进行中`
- Profile: `Lite`
- Active plan node: `NODE-011`
- Latest evidence: `/tmp/codeck-autonomy-switch-all-final.log` — 1056/1056 pass; `/tmp/codeck-autonomy-switch-browser-final.log` — six provider/viewport journeys pass, zero browser errors
- Current blocker: NODE-009 background cancellation scope requires the user's answer; foreground cancellation and safe background rejection are implemented and tested.
- Next step: Commit, push and deploy the verified foreground/fail-closed implementation, as explicitly requested by the user. Background cancellation remains a separate undecided scope.
- Next checkpoint: Post-restart health, served asset versions, read-only API/WebSocket and unchanged tmux pane/PID identities.
- Next human decision: Whether cancelling the old task also terminates its background commands/experiments (asked asynchronously).
- Owner: `AI`
- Last updated: `2026-09-25`
- Clean state: `Not due`
- Last clean: `2026-09-25 / README, NODE-008..010 and Verification boundary reconciled against /tmp/codeck-autonomy-switch-all-final.log and /tmp/codeck-autonomy-switch-browser-final.log; background scope remains explicit`

## Outcome

- Problem: Remote requires manually asking an Agent to continue after each turn.
- Success: Adjacent ? and circled A controls provide concise non-interrupting progress questions and choice-based goal/budget/preferences setup with explicit approval. Confirmed tasks continue server-side until completion, a finite round limit, or a safe pause; users can redirect without losing spent budget. Unknown delivery hints can be dismissed without replay or false confirmation.
- Non-goals: Workflow engine, dashboard, autonomous permission approval, new dependencies. Git release and deployment are separately authorized by the user's subsequent request.

## Constraints

- Strategic defaults: User AGENTS: read before edits, minimal scoped diffs, failing regression tests, preserve unrelated changes.
- Tactical objective: Lightweight session UI with reliable bounded execution and human takeover.
- Imperative bounds: No implicit authority expansion; no replay of uncertain sends; no continuation after pause or identity change; agent-reported completion is not independent verification.
- Negotiable space: Protocol, module boundaries, persistent state shape, conservative recovery behavior.
- Material assumptions: Foreground cancellation is authorized only after goal confirmation. Background cancellation is not inferred; currently fail closed when background execution remains.
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
| A-010 | A configuration never waits for Agent idle | Busy/background controller and tmux tests, browser journeys | Configuration is sent safely without interrupting old work; no 等空闲 UI; drafts and native questions stay protected |
| A-011 | Confirmed new goal replaces old work | Controller and guarded interruption tests | No cancellation before confirmation; stop then verify before new work; failure, stale identity or pause prevents dispatch |

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
| NODE-008 | `完成` | Separate setup delivery from execution idle requirements | Controller/tmux regressions and browser busy/background cases | /tmp/codeck-autonomy-noidle-red.log; /tmp/codeck-autonomy-switch-all-final.log; /tmp/codeck-autonomy-switch-browser.log | R-005 |
| NODE-009 | `阻塞` | Foreground stop-and-verify implemented; user must choose whether to cancel background commands/experiments too | Ordering, failure, identity, pause and restart regressions; background scope needs user answer | /tmp/codeck-autonomy-switch-red.log; /tmp/codeck-autonomy-stop-red.log; /tmp/codeck-autonomy-switch-all-final.log | R-005 |
| NODE-010 | `完成` | Regression, rendered states, cache versions and documentation | npm test; browser smoke; strict plan validation | /tmp/codeck-autonomy-switch-all-final.log; /tmp/codeck-autonomy-switch-browser-final.log; /data/tmp/codeck-remote-smoke-YVo7oT | R-006 |
| NODE-011 | `进行中` | User-authorized commit, push and local system-service deployment; no live task input | Full test rerun, health/assets/API/WebSocket and pane survival | /tmp/codeck-autonomy-release-tests.log; /tmp/codeck-autonomy-release-panes-before.log | None: deployment verification pending |

## Reflection Log

Record consequential findings here; routine verification stays in the Plan table.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 result/recovery races | /tmp/codeck-autonomy-edge-red.log; /tmp/codeck-autonomy-race-red.log; test/autonomy.test.js | A later progress answer could hide completion; stale read failure could pause a new direction; persistent history errors could hang | Nonce + user anchor + final assistant evidence; generation guards; conservative restart | Retain final result across read-only progress turns; guard rejected promises too; bound history failures |
| R-002 | NODE-002 non-interrupting progress and safe input | /tmp/codeck-progress-red.log; /tmp/codeck-autonomy-claude-red.log; test/tmux.test.js | Existing send forced Escape on Codex queued messages; Claude blank first line did not prove empty composer | Reuse verified pane, input serialization and native queues | ? skips forced queue release; guarded sends inspect full composer and cancel before Enter |
| R-003 | NODE-005 screenshot IMG_1567 | Live read-only codeck snapshot and isolated recovery/Hub probe (2026-09-25) | Short receipt differs from accepted longer input; restoration drops queued placement and appends it at latest | Exact text/nonce evidence must not be weakened into prefix success | Restore using known anchor; provide explicit persisted dismissal distinct from confirmation, never resend |
| R-004 | NODE-007 prompt compatibility | /tmp/codeck-cached-progress-red.log; /tmp/codeck-cached-progress-green.log | Replacing the prompt alone makes an already-open page's old ? look like a manual direction change | Exact recognition avoids treating arbitrary messages as read-only progress | Recognize the deployed previous prompt in both Hub dispatch and autonomous result parsing; cache-bust both page entries |
| R-005 | NODE-008, NODE-009 setup and task switching | Live research snapshot; /tmp/codeck-autonomy-noidle-red.log; /tmp/codeck-autonomy-stop-red.log | Idle gates blocked configuration; Escape alone does not prove cancellation | Guarded non-interrupting input and exact pane identity | Config bypasses idle gates but preserves draft/modal guards; explicit approval precedes cancellation, verified cancellation precedes work |
| R-006 | NODE-010 cancellation feedback | /tmp/codeck-autonomy-switch-feedback-red.log; /tmp/codeck-autonomy-switch-browser-final.log | Pausing was visible but its reason was only in hover text, inaccessible on mobile | Reuse the existing live-message area; avoid adding panels | Show the current session's pause reason, preserve it across the action response, and test failure followed by explicit retry |

## Verification boundary

- README's revised flow is exercised with actual UI/controller plus simulated Agent responses: click A, select/customize answers, defer/reopen without losing choices, explicitly approve the plan, observe rounds, reload, pause, redirect with spent budget retained, complete. Three providers at 390/1365 pixels; light/dark screenshots inspected. Unknown receipt dismissal survives a simulated server reset and browser reload without resend; separate V2 Hub tests cover synchronized-frame propagation to another client.
- Initial implementation was released as f6227a4 on the user's separate request (1020 tests; API/assets/V2 stream; all 10 tmux identities retained). After follow-up acceptance, the user separately requested commit, push and deployment. Real long-running CLI protocol compliance remains unverified; malformed results pause safely.
- Deadline and rounds prevent future dispatch, not kill an in-flight command. Money/token limits are advisory; completion is Agent-reported evidence, not independent goal validation.
- Follow-up acceptance A-007 through A-009 completed 2026-09-25. A-010/A-011 reopened on research's background-only setup stall. Implementation verification must not restart services, interrupt real research work or inject live CLI input. Agent-generated choice/proposal compliance in real long-running sessions remains outside the isolated fixture verification.
- Current foreground stop adapter sends one Escape only to the verified pane, then checks the identity and running state up to 20 times with 250 ms delays. Background execution, timeout, stale identity or cancellation fail closed; no new round is sent. This is not provider-native Goal cancellation or a guarantee of stopping detached/background resources. The latter scope still requires a user decision and provider-specific implementation, not removal of the safety check.
- A-010 and the foreground/fail-closed portion of A-011 pass 1056 automated tests and six real-browser fixture journeys at 390/1365 pixels for Codex/Claude/Qoder. Actual UI/controller plus simulated Agent/stop responses cover busy/background configuration, explicit approval, switching, failed stop with visible feedback, explicit retry, restart without replay, pause and redirection. Mobile and desktop confirmation/switching screenshots inspected; no new panel or layout change. Implementation verification did not cancel live tasks or restart services; real provider cancellation behavior remains unverified. The user subsequently authorized commit, push and deployment; NODE-011 tracks that release separately from undecided background cancellation.
