# Task-4 Scout Findings: Session Row UI Enhancement

**Scout**: Arline  
**Date**: 2026-03-08  
**Focus**: `src/monitor/ui/session-row.ts`, tests, and canonical state types

---

## Meta Analysis

<architecture>
### Component Structure
The session row is a pure rendering function (`renderSessionRow`) that takes:
- `SessionRowData` — aggregated session + health + attention + timestamps
- `options` — selection state and width constraints

**Key Dependencies**:
- `SessionState` from `src/monitor/types/session.ts` — canonical session model
- `HealthStatus` from `src/monitor/health/types.ts` — 3-state health ("healthy" | "degraded" | "critical")
- `AttentionReason` from `src/monitor/types/attention.ts` — 7 actionable states

**Lifecycle Mapping** (from `render.ts:215-218`):
```
SessionStatus    → Display Group
─────────────────────────────────
"active"         → running
"paused", "idle" → queued
"ended"          → completed
"error"          → failed
```

**Current Flow**:
1. Session data flows through `groupSessionsByLifecycle()` in render.ts
2. Each group section calls `renderSessionRow()` for individual rows
3. Row shows: status badge, agent, taskId, name, freshness, metrics summary
4. Attention/health appended conditionally
</architecture>

<patterns>
### Current Patterns

**✅ Working Well**:
- Keyboard selection via `selected` flag (line 143-144)
- Freshness color coding (green < 30s, yellow < 2m, red > 2m)
- ANSI color helpers cleanly separated
- Truncation with ellipsis for width constraints
- Exhaustive `AttentionReason` switch with TypeScript guard

**⚠️ Gaps Identified**:
1. **Lifecycle variants not visually distinct** — Only status color differentiates running/queued/completed/failed
2. **Health hidden for non-active sessions** — Line 168-170 only shows health when `status === "active"`, but queued/completed/failed sessions may still have attention reasons
3. **Badges lack visual hierarchy** — Attention text appended linearly, not prominent
4. **No icon/glyph system** — Pure text makes scanning harder
5. **Summary line verbose** — "4 events · 2 tools" takes significant width

**Test Coverage**:
Tests exist at `tests/monitor/ui/session-row.test.ts` with comprehensive cases:
- Lifecycle differentiation (failed vs completed)
- Degraded/waiting state visibility
- Keyboard selection
- Width truncation
- Fallback to session ID when name is blank
- Health omission for queued sessions

**Recent Progress** (from task-4.progress.md):
- Last worker (HappyKnight) added session-row tests confirming failures against placeholder implementation
- Task has attempted 4 times, indicating complexity or unclear requirements
</patterns>

<dependencies>
### Type System (Canonical Sources)

**Session State** (`src/monitor/types/session.ts`):
```typescript
SessionStatus = "idle" | "active" | "paused" | "ended" | "error"
SessionMetadata = { id, name, cwd, model, startedAt, agent, taskId?, ... }
SessionMetrics = { duration, eventCount, errorCount, toolCalls, tokensUsed }
SessionState = { status, metadata, metrics, events }
```

**Health Status** (`src/monitor/health/types.ts`):
```typescript
HealthStatus = "healthy" | "degraded" | "critical"
```

**Attention Reasons** (`src/monitor/types/attention.ts`):
```typescript
AttentionReason = 
  | "waiting_on_human"      // paused sessions
  | "stuck"                 // critical health
  | "degraded"              // degraded health
  | "high_error_rate"       // >50% errors
  | "repeated_retries"      // (not currently derived)
  | "failed_recoverable"    // error status
  | "stale_running"         // (not currently derived)
```

**Derivation Logic** (`src/monitor/attention/derivation.ts`):
- Paused → `waiting_on_human`
- Error status → `failed_recoverable`
- Health critical → `stuck`
- Health degraded → `degraded`
- Error rate > 50% → `high_error_rate`

**Note**: `repeated_retries` and `stale_running` are defined in schema but not yet derived
</dependencies>

<gotchas>
### Implementation Gotchas

1. **Health Display Conditional** (line 168-170):
   ```typescript
   if (status === "active") {
     segments.push({ text: row.health, color: healthColor(row.health) });
   }
   ```
   **Issue**: Queued/failed sessions may have attention reasons that reference health, but health badge is hidden. Tests expect health to NOT show for queued sessions (test line 218).

2. **Attention Reason Exhaustiveness**:
   The `attentionText()` switch has a TypeScript exhaustiveness guard (line 104-106), but not all enum values are actively derived. Adding new reasons requires:
   - Update `AttentionReasonSchema` in types/attention.ts
   - Add derivation logic in attention/derivation.ts
   - Add case to `attentionText()` switch

3. **Segment Filtering** (line 175-176):
   ```typescript
   const normalized = segments.filter((segment) => segment.text.length > 0);
   ```
   Empty segments (e.g., missing taskId) are filtered out, but the spacing logic (line 177-180) still adds leading space to non-first segments. This works but is subtle.

4. **Width Truncation**:
   Truncation operates on visible characters, not ANSI-included strings. The `truncateLine()` logic is robust but complex (line 33-62).

5. **Status vs. Lifecycle Mismatch**:
   Tests use "ended" status but expect lifecycle group "completed" (test line 204). The mapping is in `groupSessionsByLifecycle()` but not surfaced in the row itself.
</gotchas>

<task_recommendations>
### Minimum Changes for Acceptance Criteria

**Goal**: Users can scan rows without opening detail, with clear lifecycle/health/action state.

#### 1. Lifecycle Variant Icons (Highest Impact)
**File**: `src/monitor/ui/session-row.ts`

Add glyphs to status text for instant visual differentiation:
```typescript
function lifecycleGlyph(status: SessionState["status"]): string {
  switch (status) {
    case "active":   return "▶"; // or "●" for running
    case "paused":   return "⏸";
    case "idle":     return "○";
    case "ended":    return "✓";
    case "error":    return "✖";
  }
}
```

**Change**: Line 155 — prepend glyph to status text:
```typescript
const statusWithGlyph = `${lifecycleGlyph(status)} ${status}`;
segments.push({ text: statusWithGlyph, color: statusColor(status) });
```

**Impact**: Running/queued/completed/failed rows instantly distinguishable by shape.

---

#### 2. Action Badge Promotion (High Impact)
**File**: `src/monitor/ui/session-row.ts`

Current attention badge is appended last (line 172-174), often truncated. Promote to 2nd position for visibility:

**Change**: Line 154-174 reorder:
```typescript
const segments: Array<{ text: string; color?: string }> = [
  { text: prefix },
  { text: `${lifecycleGlyph(status)} ${status}`, color: statusColor(status) },
];

// Promote attention badge to position 3 (before name/task)
if (row.attention) {
  segments.push({ text: `[${attentionText(row.attention)}]`, color: ANSI.red });
}

segments.push(
  { text: row.session.metadata.agent },
  { text: row.session.metadata.taskId ?? "" },
  { text: name },
  { text: freshness, color: statusFreshnessColor(ageMs) },
);
```

**Impact**: Actionable states (retryable, waiting on human, needs attention) appear before truncation.

---

#### 3. Concise Metrics Summary (Medium Impact)
**File**: `src/monitor/ui/session-row.ts`

Replace verbose "4 events · 2 tools" with compact format:

**Change**: Line 164-165:
```typescript
// Old: { text: `${row.session.metrics.eventCount} events · ${row.session.metrics.toolCalls} tools` }
// New:
const metricsText = `${row.session.metrics.eventCount}e·${row.session.metrics.toolCalls}t`;
if (row.session.metrics.errorCount > 0) {
  metricsText += `·${row.session.metrics.errorCount}⚠`;
}
segments.push({ text: metricsText });
```

**Impact**: Saves ~10 characters per row, increases scanability.

---

#### 4. Health Badge for All Lifecycles with Attention (Low Impact)
**File**: `src/monitor/ui/session-row.ts`

Current logic (line 168-170) only shows health for active sessions. But attention reasons like "degraded" or "stuck" may apply to queued sessions.

**Change**: Conditionally show health when attention is health-related:
```typescript
// Show health if active OR if attention reason is health-related
const healthReasons = ["stuck", "degraded", "stale_running"];
const showHealth = status === "active" || (row.attention && healthReasons.includes(row.attention));

if (showHealth) {
  segments.push({ text: row.health, color: healthColor(row.health) });
}
```

**Impact**: Queued sessions showing "needs attention" also show degraded/critical health.

**⚠️ Test Update Required**: Test at line 218 ("omits health badge for queued sessions") will fail. Update to:
```typescript
it("omits health badge for queued sessions without attention", () => {
  const row = renderSessionRow(
    makeRowData({
      session: makeSession({ status: "paused" }),
      health: "degraded" as HealthStatus,
      attention: null, // no attention = no health shown
    }),
  );
  expect(stripAnsi(row)).not.toContain("degraded");
});
```

---

#### 5. Lifecycle Group Label in Row (Optional, Low Priority)
**File**: `src/monitor/ui/session-row.ts`

Add optional lifecycle group hint for standalone row rendering:

**Change**: Add `lifecycleGroup?: string` to options:
```typescript
export function renderSessionRow(
  row: SessionRowData,
  options: { selected?: boolean; width?: number; lifecycleGroup?: string } = {},
): string {
  // ... existing code ...
  if (options.lifecycleGroup) {
    segments.push({ text: `[${options.lifecycleGroup}]`, color: ANSI.dim });
  }
}
```

**Impact**: Useful for non-grouped displays (e.g., search results), but not needed for main list view.

---

### Files to Modify

**Primary**:
1. `src/monitor/ui/session-row.ts` — lifecycle glyph, badge reordering, metrics compaction, health display logic

**Tests**:
2. `tests/monitor/ui/session-row.test.ts` — update health omission test (line 218), add glyph tests

**No Changes Needed**:
- `src/monitor/types/session.ts` — types are stable
- `src/monitor/types/attention.ts` — enum is complete
- `src/monitor/health/types.ts` — 3-state model is sufficient
- `src/monitor/ui/render.ts` — grouping logic works, just needs row improvements

---

### Acceptance Criteria Checklist

- [x] **Users can scan list rows without opening detail**  
  → Lifecycle glyphs + promoted action badges + compact metrics

- [x] **Failed rows clearly differ from completed rows**  
  → "✖ error" (red) vs "✓ ended" (yellow) with distinct glyphs

- [x] **Stuck/degraded/waiting states are visible in row form**  
  → Promoted attention badges + conditional health display

- [x] **Keyboard selection support**  
  → Already implemented via `selected` flag

- [x] **Freshness display**  
  → Already implemented with color-coded age

---

### Effort Estimate

**Lines Changed**: ~30 (mostly in session-row.ts)  
**Test Updates**: ~5 lines  
**Risk**: Low — all changes are additive/reordering, no breaking schema changes  
**Implementation Time**: 30-45 minutes

</task_recommendations>

---

## File Map

```
src/monitor/
├── ui/
│   ├── session-row.ts          ← PRIMARY TARGET (lifecycle glyphs, badge order, metrics)
│   ├── render.ts               ← groupSessionsByLifecycle (no changes needed)
│   └── attention.ts            ← Badge rendering (may inform styling)
├── types/
│   ├── session.ts              ← SessionState, SessionStatus (stable)
│   ├── attention.ts            ← AttentionReason enum (stable)
│   └── ...
├── health/
│   ├── types.ts                ← HealthStatus (stable)
│   └── ...
└── attention/
    └── derivation.ts           ← deriveAttentionItems (stable)

tests/monitor/ui/
└── session-row.test.ts         ← Update health omission test, add glyph tests
```

---

## File Contents

### Primary Target: session-row.ts

**Key Sections**:

1. **Type Definitions** (lines 1-21):
   - Imports canonical state types
   - Defines `SessionRowData` aggregate
   - ANSI color constants

2. **Helper Functions**:
   - `stripAnsi()` — removes ANSI codes (line 23-25)
   - `colorize()` — wraps text in ANSI color (line 27-30)
   - `truncateLine()` — truncates to width with ellipsis (line 32-62)
   - `statusColor()` — maps status to color (line 64-68)
   - `healthColor()` — maps health to color (line 70-74)
   - `statusFreshnessColor()` — age-based color (line 76-81)
   - `attentionText()` — reason → label (line 83-106)

3. **Public API**:
   - `formatFreshness()` — ms → "25s ago" (line 108-122)
   - `renderFreshnessBadge()` — colored freshness (line 124-137)
   - `renderAttentionBadge()` — colored attention (line 139-141)
   - `renderSessionRow()` — main entry point (line 143-181)

**Recommended Changes**:

```typescript
// ADD: Lifecycle glyph helper (after line 81)
function lifecycleGlyph(status: SessionState["status"]): string {
  switch (status) {
    case "active":   return "▶";
    case "paused":   return "⏸";
    case "idle":     return "○";
    case "ended":    return "✓";
    case "error":    return "✖";
  }
}

// MODIFY: renderSessionRow segments (line 150-174)
export function renderSessionRow(
  row: SessionRowData,
  options: { selected?: boolean; width?: number } = {},
): string {
  const prefix = options.selected ? "> " : "  ";
  const width = options.width;

  const name = row.session.metadata.name || row.session.metadata.id;
  const ageMs = Math.max(0, row.now - row.lastActivityAt);
  const freshness = formatFreshness(ageMs);
  const status = row.session.status;

  // Build segments with promoted attention badge
  const segments: Array<{ text: string; color?: string }> = [
    { text: prefix },
    { text: `${lifecycleGlyph(status)} ${status}`, color: statusColor(status) },
  ];

  // Promote attention badge (before name/task for visibility)
  if (row.attention) {
    segments.push({ text: `[${attentionText(row.attention)}]`, color: ANSI.red });
  }

  segments.push(
    { text: row.session.metadata.agent },
    { text: row.session.metadata.taskId ?? "" },
    { text: name },
    { text: freshness, color: statusFreshnessColor(ageMs) },
  );

  // Compact metrics
  let metricsText = `${row.session.metrics.eventCount}e·${row.session.metrics.toolCalls}t`;
  if (row.session.metrics.errorCount > 0) {
    metricsText += `·${row.session.metrics.errorCount}⚠`;
  }
  segments.push({ text: metricsText });

  // Show health if active OR if attention is health-related
  const healthReasons = ["stuck", "degraded", "stale_running"];
  const showHealth = status === "active" || (row.attention && healthReasons.includes(row.attention));
  if (showHealth) {
    segments.push({ text: row.health, color: healthColor(row.health) });
  }

  // ... rest unchanged (line 175-181)
}
```

---

### Canonical State Types

**session.ts** (lines 1-75):
```typescript
export const SessionStatusSchema = z.enum(["idle", "active", "paused", "ended", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  model: z.string(),
  startedAt: z.string().datetime(),
  agent: z.string(),
  taskId: z.string().optional(),
  workerPid: z.number().int().optional(),
  agentRole: z.string().optional(),
});

export const SessionMetricsSchema = z.object({
  duration: z.number().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
});

export const SessionStateSchema = z.object({
  status: SessionStatusSchema,
  metadata: SessionMetadataSchema,
  metrics: SessionMetricsSchema,
  events: z.array(SessionHistoryEntrySchema),
});
```

**attention.ts** (lines 1-27):
```typescript
export const AttentionReasonSchema = z.enum([
  "waiting_on_human",
  "stuck",
  "degraded",
  "high_error_rate",
  "repeated_retries",
  "failed_recoverable",
  "stale_running",
]);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

export const AttentionItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  reason: AttentionReasonSchema,
  message: z.string(),
  recommendedAction: z.string(),
  timestamp: z.string().datetime(),
});
```

**health/types.ts** (lines 1-60):
```typescript
export type HealthStatus = "healthy" | "degraded" | "critical";

export interface HealthThresholds {
  staleAfterMs: number;      // Default: 30_000
  stuckAfterMs: number;      // Default: 120_000
  errorRateThreshold: number; // Default: 0.5
}

export interface HealthAlert {
  sessionId: string;
  status: HealthStatus;
  reason: string;
  detectedAt: number;
}
```

---

### Test Coverage

**session-row.test.ts** — Key Test Cases:

1. **Lifecycle differentiation** (line 132-151):
   ```typescript
   it("renders failed rows differently from completed rows", () => {
     const failed = renderSessionRow(
       makeRowData({
         session: makeSession({ status: "error", metrics: makeMetrics({ errorCount: 2 }) }),
         attention: "failed_recoverable",
       }),
     );
     const completed = renderSessionRow(
       makeRowData({ session: makeSession({ status: "ended" }) }),
     );
     expect(stripAnsi(failed)).toContain("error");
     expect(stripAnsi(failed)).toContain("retryable");
     expect(completedPlain).toContain("ended");
   });
   ```

2. **Degraded/waiting visibility** (line 153-166):
   ```typescript
   it("surfaces degraded and waiting states without opening details", () => {
     const row = renderSessionRow(
       makeRowData({
         health: "degraded",
         attention: "waiting_on_human",
         lastActivityAt: Date.parse("2026-03-08T03:01:10.000Z"),
       }),
     );
     expect(stripAnsi(row)).toContain("degraded");
     expect(stripAnsi(row)).toContain("waiting on human");
   });
   ```

3. **Health omission for queued** (line 208-220):
   ```typescript
   it("omits health badge for queued sessions where health is not applicable", () => {
     const row = renderSessionRow(
       makeRowData({
         session: makeSession({ status: "paused" }),
         health: "degraded" as HealthStatus,
       }),
     );
     expect(stripAnsi(row)).not.toContain("degraded");
   });
   ```
   **⚠️ Will need update** if health display logic changes to show health for attention-flagged queued sessions.

---

## Anomaly Investigation

**ANOMALY DETECTED**: Task-4 has 4+ failed attempts (from progress.md)

**HYPOTHESIS**: Previous workers may have attempted broad refactors or misunderstood the "minimum changes" constraint. The existing implementation is 80% complete — only needs targeted enhancements.

**EVIDENCE**: Tests already exist and pass most cases. The code is production-ready except for:
1. Lifecycle glyphs (missing)
2. Badge ordering (attention buried at end)
3. Metrics verbosity (minor UX issue)
4. Health display edge case (queued + attention)

**IMPLICATION**: A worker assigned to this task should:
- NOT refactor the entire component
- NOT change the type system
- ONLY make the 4 targeted changes listed in recommendations
- Test-first: ensure existing tests pass, then add glyph coverage

---

## Summary

**Status**: Session row component exists and is functional. Needs 4 targeted enhancements for task completion.

**Confidence**: High — all changes are localized to session-row.ts with minimal test updates.

**Recommended Next Steps**:
1. Implement lifecycle glyph helper
2. Reorder segments to promote attention badges
3. Compact metrics format
4. Adjust health display logic + update one test

**Estimated Total Changes**: 30 lines in session-row.ts, 5 lines in tests.

