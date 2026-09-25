# Program: Session autonomous iteration

> Single-file current-state plan for direct, independently verifiable work.

- Overall status: `完成`
- Profile: `Lite`
- Active plan node: `None`
- Latest evidence: `/tmp/codeck-autonomy-all-final.log` — 1020/1020 pass; `/tmp/codeck-autonomy-browser-final.log` — six provider/viewport journeys pass, zero browser errors
- Current blocker: `None`
- Next step: `None`
- Next checkpoint: `None`
- Next human decision: `None`
- Owner: `AI`
- Last updated: `2026-09-25`
- Clean state: `Not due`
- Last clean: `2026-09-25 / README and Verification boundary reconciled against /tmp/codeck-autonomy-all-final.log and /tmp/codeck-autonomy-browser-final.log`

## Outcome

- Problem: Remote requires manually asking an Agent to continue after each turn.
- Success: A compact circled A control starts conversational goal/budget/preferences setup; confirmed tasks continue server-side until completion, a finite round limit, or a safe pause. Users can interrupt and redirect without losing spent budget. The separate ? asks for concrete decomposed goals, evidence/gaps and next steps without forcing interruption, continuation or mode changes.
- Non-goals: Workflow engine, dashboard, autonomous permission approval, new dependencies, deployment or git release.

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

## Plan

| Node | Status | Action | Verification | Evidence | Reflection |
|---|---|---|---|---|---|
| NODE-001 | `完成` | Protocol, persistence and bounded controller with tests | node --test test/autonomy.test.js | /tmp/codeck-autonomy-all-final.log; test/autonomy.test.js | R-001 |
| NODE-002 | `完成` | Wire authenticated Agent API, guarded tmux writes and human takeover | AgentHub/tmux/terminal/server integration tests | /tmp/codeck-autonomy-all-final.log; /tmp/codeck-autonomy-server.log | R-002 |
| NODE-003 | `完成` | Remote symbol, status and conversational controls | UI unit/browser checks | /data/tmp/codeck-remote-smoke-feeERG; test/remote-submission.test.js | None: existing UI primitives fit; mobile/desktop rendered states pass |
| NODE-004 | `完成` | Full regression, rendered verification and documentation | npm test; browser smoke; plan validation | /tmp/codeck-autonomy-all-final.log; /tmp/codeck-autonomy-browser-final.log; /data/tmp/codeck-remote-smoke-y32LM3 | None: final keyboard and isolated server journeys pass |

## Reflection Log

Record consequential findings here; routine verification stays in the Plan table.

| ID | Scope | Evidence | Wrong / changed | Right / preserve | Next rule |
|---|---|---|---|---|---|
| R-001 | NODE-001 result/recovery races | /tmp/codeck-autonomy-edge-red.log; /tmp/codeck-autonomy-race-red.log; test/autonomy.test.js | A later progress answer could hide completion; stale read failure could pause a new direction; persistent history errors could hang | Nonce + user anchor + final assistant evidence; generation guards; conservative restart | Retain final result across read-only progress turns; guard rejected promises too; bound history failures |
| R-002 | NODE-002 non-interrupting progress and safe input | /tmp/codeck-progress-red.log; /tmp/codeck-autonomy-claude-red.log; test/tmux.test.js | Existing send forced Escape on Codex queued messages; Claude blank first line did not prove empty composer | Reuse verified pane, input serialization and native queues | ? skips forced queue release; guarded sends inspect full composer and cancel before Enter |

## Verification boundary

- README's new flow is exercised with actual UI/controller plus simulated Agent responses: click A, answer setup, confirm, observe rounds, reload, pause, redirect while retaining budget, complete. Three providers at 390/1365 pixels; light/dark screenshots inspected. Real isolated HTTPS/owner WebSocket bootstrap verifies persisted running state restores paused without replay.
- No messages were sent to live user CLIs, no service restart, no commit/push/deployment. Agent reasoning/protocol compliance in real CLI sessions remains unverified. Missing/malformed results pause safely.
- Deadline and rounds prevent future dispatch, not kill an in-flight command. Money/token limits are advisory; completion is Agent-reported evidence, not independent goal validation.
- Completed 2026-09-25: keyboard pause, reload continuity, normal/Remote progress separation, and running/paused/completed visual states verified. No implementation work or owner decision remains in this scope.
