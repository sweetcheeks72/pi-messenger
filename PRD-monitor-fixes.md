# PRD: Session Monitor — End-to-End Integration & Fix Pass

## Context
The `src/monitor/` module in pi-messenger has 40 source files and 29 test files with 771 passing tests and 1 failing test. However, the module is **completely disconnected** from the actual messenger overlay (`overlay.ts`, `overlay-render.ts`, `overlay-actions.ts`, `index.ts`). None of those files import anything from `src/monitor/`.

This PRD defines all fixes needed to make the session monitor work end-to-end with real code, real tests, no mocks/stubs/TODOs.

## Current test baseline
```
npm test → 56 passed, 1 failed (771 tests pass, 1 fails)
Failing: tests/monitor/types/session-worker.test.ts
  "builds a detail-view-friendly session state from actual pi runtime events"
  Cause: adapter emits { tool: "bash" }, test expects { toolName: "bash" }
```

## Branch: feat/agentic-code-reasoning-improvements
## Repo: /Users/chikochingaya/.pi/agent/git/github.com/nicobailon/pi-messenger

---

## TASK-01: Fix adapter/renderer field name mismatch (the 1 failing test)

**Problem:** `src/monitor/types/session.ts` line 113 emits `{ tool: event.toolName, args: event.args }` but `src/monitor/ui/session-detail.ts` line 154 reads `d["toolName"]`. The test at `tests/monitor/types/session-worker.test.ts:133` expects `toolName`.

Also: line 122 emits `{ text: textItem.text }` for `agent.progress`, but the detail renderer may expect `message`. Check `session-detail.ts` for what field it reads for progress events and align.

**Fix:**
1. In `src/monitor/types/session.ts` line 113, change `{ tool: event.toolName, args: event.args }` to `{ toolName: event.toolName, args: event.args }`
2. In `src/monitor/types/session.ts` line 122, change `{ text: textItem.text }` to `{ message: textItem.text }` IF `session-detail.ts` reads `message` for progress events (verify first)
3. Check `session-detail.ts` for ALL event type renderers and ensure every field name matches what the adapter emits
4. Run `npm test` — all 772 tests must pass, 0 failures

**Files:** `src/monitor/types/session.ts`, `src/monitor/ui/session-detail.ts`
**Test:** `npm test` — 0 failures
**Acceptance:** The 1 failing test passes. No regressions.

---

## TASK-02: Fix overview reason extraction for failed/queued sessions

**Problem:** `src/monitor/ui/render.ts` `getEventReason()` only reads `data.reason`. Real runtime failures use `data.message`, `data.error`, `data.summary`, or `payload.reason`. Replay stores `data: e.payload`. So failed/queued session reasons show blank.

**Fix:**
1. In `src/monitor/ui/render.ts`, update `getEventReason()` to check `data.reason || data.message || data.error || data.summary` (in that priority)
2. Add test cases in `tests/monitor/ui/render.test.ts` for events with `message`, `error`, and `summary` fields
3. Run `npm test` — 0 failures

**Files:** `src/monitor/ui/render.ts`
**Test:** `tests/monitor/ui/render.test.ts` updated + `npm test`
**Acceptance:** Failed/queued session rows show meaningful reason text from various event shapes.

---

## TASK-03: Create MonitorRegistry — single dependency injection point

**Problem:** No registry exists. `tests/monitor/integration/helpers.ts:setupFullPipeline()` manually wires 9 services. The overlay needs a single object to receive.

**Fix:**
1. Create `src/monitor/registry.ts` with a `MonitorRegistry` class
2. It must instantiate and wire: `SessionStore`, `SessionEventEmitter`, `SessionLifecycleManager`, `SessionMetricsAggregator`, `OperatorCommandHandler`, `SessionHealthMonitor`, `SessionReplayer`, `SessionExporter`, `SessionFeedSubscriber`
3. Expose `createMonitorRegistry()` factory and `dispose()` method
4. Export from `src/monitor/index.ts`
5. Write `tests/monitor/registry.test.ts`: create → get services → use lifecycle → dispose → verify cleanup
6. Run `npm test` — 0 failures

**Files:** `src/monitor/registry.ts`, `src/monitor/index.ts`
**Test:** `tests/monitor/registry.test.ts` + `npm test`
**Acceptance:** Single import gives access to all 9 services. dispose() stops health monitor polling.

---

## TASK-04: Wire MonitorRegistry into extension lifecycle (index.ts)

**Problem:** `index.ts` has zero monitor imports. The registry needs to be created on activate and disposed on deactivate.

**Fix:**
1. In `index.ts`, import `createMonitorRegistry` from `./src/monitor/registry`
2. On extension `activate()`, create the registry and store it
3. On `deactivate()`, call `registry.dispose()`
4. Pass the registry to the overlay constructor (extend the constructor signature with an optional `MonitorRegistry` parameter)
5. If registry is undefined, overlay operates without monitor features (backwards compatible)
6. Run `npm test` — 0 failures

**Files:** `index.ts`, `overlay.ts`
**Test:** `npm test` + manual verification that extension loads without error
**Acceptance:** Registry is created/disposed with extension lifecycle. Overlay receives it.

**Depends on:** TASK-03

---

## TASK-05: Build CrewMonitorBridge — connect crew workers to monitor sessions

**Problem:** No bridge exists between `crew/live-progress.ts` worker state and the monitor system. Worker spawns/deaths don't create/end monitor sessions.

**Fix:**
1. Create `src/monitor/bridge.ts` with `CrewMonitorBridge` class
2. It subscribes to `onLiveWorkersChanged()` from `crew/live-progress.ts`
3. Maps: worker added → `lifecycle.start()`, worker removed → `lifecycle.end()`, tool change → emit `tool.call` event
4. Maintains `taskId → sessionId` mapping
5. Expose `dispose()` to unsubscribe
6. Write `tests/monitor/bridge.test.ts`: mock live-progress data → verify session start/end/tool events emitted with correct counts
7. Run `npm test` — 0 failures

**Files:** `src/monitor/bridge.ts`
**Test:** `tests/monitor/bridge.test.ts` + `npm test`
**Acceptance:** Spawning a worker creates a monitor session. Worker removal ends it. Tool changes emit events.

**Depends on:** TASK-03

---

## TASK-06: Wire bridge into overlay + auto-create/end sessions on worker spawn

**Problem:** Even with the bridge and registry, they need to be instantiated and connected inside the overlay when crew work starts.

**Fix:**
1. In `overlay.ts`, when registry is provided, instantiate `CrewMonitorBridge` in constructor
2. On worker spawn (from `spawnSingleWorker` result), call bridge to register the worker
3. On worker removal, call bridge to deregister
4. Store bridge reference and dispose it in overlay dispose()
5. Run `npm test` — 0 failures

**Files:** `overlay.ts`
**Test:** `npm test`
**Acceptance:** Starting crew work creates monitor sessions visible via registry. Ending workers ends sessions.

**Depends on:** TASK-04, TASK-05

---

## TASK-07: Add session monitor view to overlay navigation

**Problem:** `overlay.ts` and `overlay-render.ts` have no monitor tab/view. Users can't see monitor data.

**Fix:**
1. Add a `monitor` view state to `CrewViewState` in `overlay-actions.ts`
2. Add a keybinding (e.g., `m` for "monitor") that switches to monitor view
3. In `overlay-render.ts`, add `renderMonitorView()` that uses `renderGroupedOverview()` from `src/monitor/ui/render.ts` with real session data from the registry
4. In the status bar footer, show the monitor keybinding hint
5. Add keyboard navigation within monitor view: up/down to select sessions, Enter to open detail, Escape to go back
6. Write or extend overlay render tests to verify monitor view renders session rows
7. Run `npm test` — 0 failures

**Files:** `overlay.ts`, `overlay-render.ts`, `overlay-actions.ts`
**Test:** Updated overlay tests + `npm test`
**Acceptance:** User can press `m` to see grouped session overview, navigate sessions, open detail view.

**Depends on:** TASK-06

---

## TASK-08: Wire attention queue into overlay

**Problem:** `AttentionQueuePanel` exists in `src/monitor/ui/attention.ts` but is never mounted in the overlay.

**Fix:**
1. In the monitor view, show the attention queue above the session list when items exist
2. Use `deriveAttentionItems()` from `src/monitor/attention/derivation.ts` with real registry data
3. Wire `onSelect` callback to navigate to the session detail view
4. Run `npm test` — 0 failures

**Files:** `overlay-render.ts`, `overlay.ts`
**Test:** `npm test`
**Acceptance:** Sessions needing attention appear at top of monitor view with actionable labels.

**Depends on:** TASK-07

---

## TASK-09: Wire health alerts to feed notifications

**Problem:** `SessionHealthMonitor.onAlert()` exists but nothing subscribes to it in the overlay.

**Fix:**
1. In `overlay.ts`, when registry is provided, subscribe to `registry.health.onAlert()`
2. On each `HealthAlert`, log a feed event via `logFeedEvent()` with appropriate type
3. Show a transient notification via `setNotification()`
4. Clean up subscription in overlay dispose()
5. Run `npm test` — 0 failures

**Files:** `overlay.ts`, possibly `feed.ts` if new event type needed
**Test:** `npm test`
**Acceptance:** Stuck/degraded sessions trigger feed events and visible notifications.

**Depends on:** TASK-06

---

## TASK-10: Add operator action keybindings in monitor detail view

**Problem:** Only basic `pause/resume/end/inspect/escalate` exist in the command handler. The overlay has no keybindings to trigger them.

**Fix:**
1. In monitor detail view, add keybindings: `p` (pause/resume toggle), `e` (end session), `i` (inspect/diagnostics)
2. Route through `OperatorCommandHandler` from the registry
3. Show available actions in the detail view footer based on current session state
4. Add confirmation for destructive actions (end)
5. Run `npm test` — 0 failures

**Files:** `overlay.ts`, `overlay-actions.ts`
**Test:** `npm test`
**Acceptance:** User can pause/resume/end/inspect sessions from the detail view.

**Depends on:** TASK-07

---

## TASK-11: Add session export and replay commands

**Problem:** `SessionExporter` and `SessionReplayer` exist but have no UI surface.

**Fix:**
1. Add keybinding `x` in monitor detail view to export session (JSON to `.pi/messenger/exports/`)
2. Add replay view accessible from completed session detail — shows reconstructed state timeline
3. Use `registry.exporter.exportSession()` and `registry.replayer.replay()`
4. Show success/failure notification after export
5. Run `npm test` — 0 failures

**Files:** `overlay.ts`, `overlay-render.ts`
**Test:** `npm test`
**Acceptance:** User can export and replay completed sessions.

**Depends on:** TASK-07

---

## TASK-12: Add configurable health thresholds from crew config

**Problem:** Health thresholds (staleAfterMs, stuckAfterMs, errorRateThreshold, pollIntervalMs) are hardcoded defaults.

**Fix:**
1. Read health config from crew config (`.pi/messenger/crew/config.json` under `health` key)
2. Apply via `registry.health.setThresholds()` on registry creation
3. Document the config keys in the skill SKILL.md
4. Write a test that creates a registry with custom thresholds and verifies they're applied
5. Run `npm test` — 0 failures

**Files:** `src/monitor/registry.ts`, `index.ts`
**Test:** `tests/monitor/registry.test.ts` updated + `npm test`
**Acceptance:** Users can configure health thresholds in crew config.

**Depends on:** TASK-03

---

## TASK-13: End-to-end integration test — real pipeline, no mocks

**Problem:** `tests/monitor/integration/full-pipeline.test.ts` is synthetic/in-memory. Need a test that proves the full wiring works.

**Fix:**
1. Write `tests/monitor/integration/e2e-wiring.test.ts`
2. Test: create registry → create bridge → simulate worker add/remove via live-progress API → verify monitor sessions created/ended → verify health alerts fire → verify export produces valid JSON → verify attention queue derives items → verify detail view renders events
3. No vi.mock of local modules. Use real instances of all services.
4. Run `npm test` — 0 failures

**Files:** `tests/monitor/integration/e2e-wiring.test.ts`
**Test:** `npm test` — 0 failures, specifically this new test passes
**Acceptance:** Full pipeline from worker spawn to export works without mocks.

**Depends on:** TASK-03, TASK-05

---

## TASK-14: Clean up namespace placeholder tasks and delete stale test artifacts

**Problem:** Tasks 15-17 are placeholders with `*Spec pending*`. They clutter the task list.

**Fix:**
1. Delete `.pi/messenger/crew/tasks/task-15.json`, `task-15.md`, `task-16.json`, `task-16.md`, `task-17.json`, `task-17.md`
2. Verify generic namespace tests still pass (`tests/crew/namespace-bleed.test.ts`, `tests/crew/work-namespace.test.ts`, `tests/crew/review-namespace.test.ts`)
3. Delete `/Users/chikochingaya/.pi/agent/git/github.com/nicobailon/pi-messenger/context.md` (scout artifact from this audit)
4. Run `npm test` — 0 failures

**Files:** `.pi/messenger/crew/tasks/task-15*`, `task-16*`, `task-17*`, `context.md`
**Test:** `npm test`
**Acceptance:** No placeholder tasks remain. All namespace tests pass.

---

## Final acceptance criteria
After ALL tasks complete:
```bash
npm test   # 0 failures, all tests pass
npx tsc --noEmit   # 0 type errors
```
Plus manual verification:
- overlay.ts imports from src/monitor/
- Monitor view is accessible via keybinding
- Sessions are created when workers spawn
- Health alerts appear in feed
- Export/replay work from detail view
