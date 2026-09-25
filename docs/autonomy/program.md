# Program: Session autonomous iteration

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `进行中`
- Profile: `Lite`
- Active plan node: `NODE-015`
- Latest evidence: `/tmp/codeck-normal-all-final2.log` — 1074/1074 pass; `/tmp/codeck-normal-autonomy-browser-final3.log` and `/tmp/codeck-normal-remote-browser-final.log` — six journeys each, zero browser errors
- Current blocker: None
- Next step: Commit/push normal-mode parity, restart codeck.service, verify health/assets/V2 binding and retained tmux pane/PIDs without live Agent input.
- Next checkpoint: Exact release tests and read-only post-deployment checks.
- Next human decision: None
- Owner: `AI`
- Last updated: `2026-09-25`
- Clean state: `Not due`
- Last clean: `2026-09-25 / README, NODE-012/014 and release boundaries reconciled with 1074 tests, normal/Remote browser logs and unchanged service PID; research repair deployed, normal-mode work uncommitted`

## Outcome

- Problem: Remote requires manually asking an Agent to continue after each turn.
- Success: Adjacent ? and circled A controls provide concise non-interrupting progress questions and choice-based goal/budget/preferences setup with explicit approval. Confirmed tasks continue server-side until completion, a finite round limit, or a safe pause; users can redirect without losing spent budget. Unknown delivery hints can be dismissed without replay or false confirmation.
- Non-goals: Workflow engine, dashboard, autonomous permission approval, new dependencies. Git release and deployment are separately authorized by the user's subsequent request.

## Constraints

- Strategic defaults: User AGENTS: read before edits, minimal scoped diffs, failing regression tests, preserve unrelated changes.
- Tactical objective: Lightweight session UI with reliable bounded execution and human takeover.
- Imperative bounds: No implicit authority expansion; no replay of uncertain sends; no continuation after pause or identity change; agent-reported completion is not independent verification.
- Negotiable space: Protocol, module boundaries, persistent state shape, conservative recovery behavior.
- Material assumptions: User explicitly authorized stopping the current session's old foreground and background tasks after goal confirmation. Other sessions, arbitrary detached processes and implicit replay remain out of scope; unsupported cancellation fails closed.
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
| A-012 | Normal mode and Remote expose the same ?/A behavior | Shared-protocol tests and browser flows | Non-interrupting progress, goal/budget/preferences choices, explicit approval, shared rounds/status, pause/resume; stale session/disconnect cannot send; drafts preserved |
| A-013 | Lost setup choices recover and confirmed research replacement stops background work | Controller/Hub regressions, guarded native-command tests, browser fixture | Valid latest ask/ready recovers without a send; current-session Codex background work is stopped only after approval; no work until verified stopped |

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
| NODE-009 | `完成` | Foreground stop-and-verify delivered; user resolved background scope, Codex implementation verified in NODE-013 | Explicit user choice and cancellation regressions | User: 一并停止，再启动新目标; /tmp/codeck-research-repair-targeted-final.log | R-008 |
| NODE-010 | `完成` | Regression, rendered states, cache versions and documentation | npm test; browser smoke; strict plan validation | /tmp/codeck-autonomy-switch-all-final.log; /tmp/codeck-autonomy-switch-browser-final.log; /data/tmp/codeck-remote-smoke-YVo7oT | R-006 |
| NODE-011 | `完成` | Commit e189e92 pushed to origin/main and deployed locally; no live task input | Full test rerun, health/assets/API/WebSocket and pane survival | /tmp/codeck-autonomy-release-tests.log; /tmp/codeck-autonomy-release-health.log; /tmp/codeck-autonomy-release-panes-before.log | None: 1056 tests and live health pass; all 10 pane/PID identities retained |
| NODE-012 | `完成` | Normal-mode compact ?/A and goal-choice modal share server state; guard binding, recovery, directions and drafts | 1074 tests; six normal + six Remote browser journeys; theme regression | /tmp/codeck-normal-all-final2.log; /tmp/codeck-normal-autonomy-browser-final3.log; /tmp/codeck-normal-remote-browser-final.log; /tmp/codeck-normal-theme-browser.log | R-009 |
| NODE-013 | `完成` | Recover lost ask choices; after approval stop current Codex foreground/Goal/background work before dispatch | 183 targeted + 1069 full tests; 6 browser journeys; restart artifact recovery | /tmp/codeck-research-repair-red.log; /tmp/codeck-research-animation-red.log; /tmp/codeck-research-stop-boundary-red.log; /tmp/codeck-research-repair-targeted-final.log; /tmp/codeck-research-repair-all-final.log; /tmp/codeck-research-repair-browser-final.log | R-007 |
| NODE-014 | `完成` | Commit d05ac23 pushed and deployed; normal-mode WIP preserved separately | 1067 release tests; health/assets/API/read-only V2 stream; unchanged tmux pane/PIDs | /tmp/codeck-research-release-tests.log; /tmp/codeck-research-release-health.log | None: release passed; live runs changed during verification, so no claim that they remained paused; no control/input sent |
| NODE-015 | `进行中` | User-authorized commit, push and deployment of normal-mode parity | Full tests; served assets, authenticated API/V2 binding capability; preserved tmux pane/PIDs | Pending release checks | None: release verification pending |

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
| R-007 | NODE-013 research setup/cancellation | IMG_1579.png; live transcript/read-only state; /tmp/codeck-research-repair-red.log; /tmp/codeck-research-animation-red.log; /tmp/codeck-research-stop-boundary-red.log | Recovery excluded ask choices; fixture stop callbacks hid composer repaint and stale registered-terminal cases | Keep nonce/final-answer validation, current-session identity and no replay/automatic approval | Recover questions too; run browser confirmation through the actual stop adapter with simulated terminal I/O; distinguish actual busy markers from command-input repaint |
| R-008 | NODE-009 cancellation authority | User explicitly chose 一并停止，再启动新目标; /tmp/codeck-research-repair-targeted-final.log | Earlier foreground-only behavior intentionally rejected background work; the user has now authorized its cancellation | Scope stays the confirmed current session; no arbitrary process-tree kills or other-session changes | Use supported native stop controls after confirmation and verify completion; unsupported providers still fail closed |
| R-009 | NODE-012 normal-mode parity | /tmp/codeck-normal-labels-red.log; /tmp/codeck-normal-history-red.log; /tmp/codeck-normal-retry-red.log; /tmp/codeck-normal-switch-red.log; /tmp/codeck-normal-notice-red.log | Clicking through a fixture missed object-valued option labels; old binding fallback/history subscriptions and retained failed receipts caused unsafe or stuck controls; paused reason hid action errors | Shared controller/presentation, explicit approval, session generation guards, no raw-input fallback | Test actual option labels and sent answers, binding cleanup, definite-error retry, local wait cancellation, and visible failure feedback; ordinary controls do not retain a history stream |

## Verification boundary

- README's revised flow is exercised with actual UI/controller plus simulated Agent responses: click A, select/customize answers, defer/reopen without losing choices, explicitly approve the plan, observe rounds, reload, pause, redirect with spent budget retained, complete. Three providers at 390/1365 pixels; light/dark screenshots inspected. Unknown receipt dismissal survives a simulated server reset and browser reload without resend; separate V2 Hub tests cover synchronized-frame propagation to another client.
- Initial implementation was released as f6227a4 on the user's separate request (1020 tests; API/assets/V2 stream; all 10 tmux identities retained). After follow-up acceptance, the user separately requested commit, push and deployment. Real long-running CLI protocol compliance remains unverified; malformed results pause safely.
- Deadline and rounds prevent future dispatch, not kill an in-flight command. Money/token limits are advisory; completion is Agent-reported evidence, not independent goal validation.
- Follow-up acceptance A-007 through A-009 completed 2026-09-25. A-010/A-011 reopened on research's background-only setup stall. Implementation verification must not restart services, interrupt real research work or inject live CLI input. Agent-generated choice/proposal compliance in real long-running sessions remains outside the isolated fixture verification.
- Foreground interruption remains scoped to the verified pane. NODE-013 adds Codex replacement checks up to 40 times with 250 ms delays per phase, allowing process-cache expiry and the six-second repaint heuristic. It clears a visible native Goal and invokes /stop for registered/current-session background terminals. Native confirmation dialogs, lingering or unmanaged detached processes, timeout, identity change and pause still stop dispatch rather than trigger a blind retry or process-tree kill.
- A-010 and the foreground/fail-closed portion of A-011 pass 1056 automated tests and six real-browser fixture journeys at 390/1365 pixels for Codex/Claude/Qoder. Actual UI/controller plus simulated Agent/stop responses cover busy/background configuration, explicit approval, switching, failed stop with visible feedback, explicit retry, restart without replay, pause and redirection. Mobile and desktop confirmation/switching screenshots inspected; no new panel or layout change. Implementation verification did not cancel live tasks or restart services; real provider cancellation behavior remains unverified. The user subsequently authorized commit, push and deployment; NODE-011 tracks that release separately from undecided background cancellation.
- Release e189e92 is pushed and deployed: system codeck.service restarted at 2026-09-25 13:37:40 CST, health/API/assets/read-only V2 stream passed, all 10 tmux pane/PID identities retained. Report/research autonomous state restored paused without replay. The subsequent normal-mode parity request is NODE-012; its new changes require separate release verification.
- NODE-013 completed 2026-09-25: 1069 tests and six 390/1365 browser fixture journeys pass. Screenshots inspected in /data/tmp/codeck-remote-smoke-696EXA; final rerun artifacts /data/tmp/codeck-remote-smoke-oRRNXY. Recovery interruption probe reconstructs an ask dialog from persisted controller state plus an acknowledged CLI transcript after losing the result, without another send or execution. Browser tests use the real controller and Codex stop adapter with simulated terminal I/O, not a live cancellation. Codex native commands were checked against official command documentation; actual research cancellation remains unexercised. Claude/Qoder background cancellation is not implemented. Subsequent authorized release d05ac23 passed NODE-014: 1067 release-only tests, health/assets/API/V2 stream, 10 retained pane/PIDs. Verification observed live report/research advancing; it sent no control/input and does not claim they remained paused.
- NODE-012 completed 2026-09-25: actual terminal page, AgentHub and controller with simulated Agent replies; no live task input. Six provider/viewport journeys cover readable choices/custom answers, explicit confirmation, rounds, pause/reload, direction changes, retry, stale forms, reconnect, native-question protection and drafts. Read-only/shell/old-backend controls stay hidden. Screenshots inspected at /data/tmp/codeck-terminal-autonomy-GqHsRy and /data/tmp/codeck-terminal-autonomy-puoi1P; desktop/mobile and light/dark styles verified. Physical Safari and live long-running CLI responses are not verified. The new ordinary-mode A is hidden against an older backend using a capability flag. Local composer directions use the shared controller; direct keystrokes still pause autonomous continuation through the existing server path. This implementation has not been committed, pushed or deployed; service MainPID remains 1133732.
