# Crew Recap Artifacts

> **Module:** pi-messenger Crew  
> **Schema:** `session-recap-v1` (`~/.pi/agent/schemas/session-recap-v1.json`)  
> **Related:** `scope-confirmation.md`, `recap-rendering-modes.md`, `helios-handoff-v1.json`

---

## Overview

At the end of major Crew runs (plan/work waves, reviews, multi-task coordination), Crew produces a standardized recap artifact. This artifact captures what was understood, what was done, evidence produced, risks encountered, and next steps — following the `session-recap-v1` schema.

The recap serves three purposes:
1. **User communication** — structured summary of what happened and what's next
2. **Cross-session continuity** — future sessions can load the recap to understand prior work
3. **Cross-substrate handoff** — enables context transfer between `pi-messenger` and `pi-subagents`

---

## Schema Reference: `session-recap-v1`

The full schema is defined at `~/.pi/agent/schemas/session-recap-v1.json` (JSON Schema draft 2020-12).

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `"session-recap-v1"` | Schema identifier |
| `session_id` | string | Pi session ID or session log path |
| `session_title` | string | Human-readable title (5–200 chars) |
| `scope_goal_statement` | string | What Helios understood the user wanted (10–1000 chars) |
| `understanding_confirmed` | object | Whether and how scope was confirmed (see `scope-confirmation.md`) |
| `actions_taken` | array | Ordered list of actions with outcomes (`completed`/`partial`/`failed`/`skipped`) |
| `key_findings` | array | Important discoveries or conclusions |
| `evidence_artifacts` | array | Typed references (`file`/`commit`/`test`/`url`/`log`/`screenshot`/`deck`/`html`) |
| `risks_blockers` | array | Known risks with severity (`low`/`medium`/`high`/`critical`) and optional mitigation |
| `next_steps` | array | Prioritized next actions (`immediate`/`next-session`/`backlog`) with optional owner |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `session_type` | enum | Category: `architecture`, `planning`, `implementation`, `debugging`, `audit`, `comparison`, `crew-wave`, `protocol-review`, `research`, `other` |
| `comparison_panels` | array | Side-by-side options with labels, content, and recommendation flag |
| `substrate_used` | enum | `direct`, `lite-subagent`, `crew-collaboration`, `full-coordination`, `manual` |
| `duration_minutes` | number | Approximate session duration |
| `created_at` | datetime | ISO 8601 timestamp |

---

## Storage Location

Crew recap artifacts are stored at:

```
.pi/messenger/crew/artifacts/session-recap-<timestamp>.json
```

Where `<timestamp>` is an ISO 8601 timestamp with colons replaced by hyphens for filesystem compatibility:

```
.pi/messenger/crew/artifacts/session-recap-2026-03-08T16-30-00Z.json
```

### Directory Structure

```
.pi/messenger/crew/
├── config.json              # Crew configuration
├── plan.md                  # Active plan
├── tasks/
│   ├── task-1.md            # Task specs
│   ├── task-1.progress.md   # Task progress logs
│   └── ...
└── artifacts/
    ├── session-recap-<timestamp>.json    # Session recaps
    ├── task-N-handoff.md                 # Per-task handoff notes
    └── ...
```

---

## Assembly from Crew State

A session recap is assembled from Crew's internal state at the end of a major run. Here is how each schema field maps to Crew state:

### Field-to-State Mapping

| Schema Field | Crew State Source |
|---|---|
| `session_id` | Current pi session ID |
| `session_title` | Derived from plan title or PRD filename |
| `session_type` | `"crew-wave"` for plan/work runs; `"implementation"` for single-task |
| `scope_goal_statement` | PRD description or plan preamble |
| `understanding_confirmed` | Recorded during scope confirmation (see `scope-confirmation.md`) |
| `actions_taken` | One entry per completed task: `{ action: task.title, outcome: task.status }` |
| `key_findings` | Extracted from task completion summaries and review outcomes |
| `evidence_artifacts` | Aggregated from `task.done` evidence: commits, tests, output files |
| `risks_blockers` | Aggregated from `task.block` reasons and unresolved review issues |
| `next_steps` | Tasks remaining in `todo` or `blocked` state, plus reviewer recommendations |
| `comparison_panels` | From design deck outputs or architecture decision records |
| `substrate_used` | `"crew-collaboration"` for multi-worker runs |
| `duration_minutes` | Elapsed time from first `task.start` to last `task.done` |

### Assembly Example

```typescript
// Pseudocode: assembling recap from Crew state
const recap = {
  schema_version: "session-recap-v1",
  session_id: currentSessionId,
  session_title: plan.title,
  session_type: "crew-wave",
  scope_goal_statement: plan.preamble,
  understanding_confirmed: {
    confirmed: scopeWasConfirmed,
    method: confirmationMethod,  // "interview" | "inline-message" | "skipped"
    details: confirmationDetails
  },
  actions_taken: completedTasks.map(t => ({
    action: t.title,
    outcome: t.status === "done" ? "completed" : "partial",
    details: t.summary
  })),
  key_findings: reviews.flatMap(r => r.findings),
  evidence_artifacts: completedTasks.flatMap(t => [
    ...t.evidence.commits.map(c => ({ type: "commit", reference: c })),
    ...t.evidence.tests.map(t => ({ type: "test", reference: t }))
  ]),
  risks_blockers: blockedTasks.map(t => ({
    description: t.blockReason,
    severity: "medium"
  })),
  next_steps: todoTasks.map(t => ({
    step: t.title,
    priority: "next-session",
    owner: "helios"
  })),
  substrate_used: "crew-collaboration",
  duration_minutes: elapsedMinutes,
  created_at: new Date().toISOString()
};
```

---

## Context Packet Format for Cross-Substrate Handoffs

When work transitions between substrates (`pi-messenger` ↔ `pi-subagents`), a **context packet** provides continuity. The context packet maps to both `helios-handoff-v1` (task-level) and `session-recap-v1` (session-level) schemas.

### Context Packet Structure

```json
{
  "context_packet_version": "1.0",
  "source_substrate": "crew-collaboration",
  "target_substrate": "lite-subagent",
  "created_at": "2026-03-08T16:30:00Z",

  "session_recap_ref": ".pi/messenger/crew/artifacts/session-recap-2026-03-08T16-30-00Z.json",

  "scope": {
    "goal_statement": "Refactor auth middleware into shared utility",
    "understanding_confirmed": true,
    "confirmation_method": "interview"
  },

  "completed_work": [
    {
      "task_id": "task-1",
      "title": "Extract JWT validation",
      "summary": "Created shared jwt-validator.ts with token refresh",
      "evidence": {
        "commits": ["abc1234"],
        "tests": ["npm test -- --grep jwt — 12 passed"]
      }
    }
  ],

  "remaining_work": [
    {
      "title": "Migrate legacy routes to new validator",
      "priority": "immediate",
      "context": "4 routes in src/legacy/ still use direct token checks"
    }
  ],

  "risks": [
    {
      "description": "Legacy routes may have undocumented auth bypass behavior",
      "severity": "medium"
    }
  ],

  "handoff_artifacts": [
    {
      "type": "file",
      "reference": "src/auth/jwt-validator.ts",
      "description": "New shared JWT validation utility"
    }
  ]
}
```

### Mapping to Schema Fields

| Context Packet Field | `session-recap-v1` Field | `helios-handoff-v1` Field |
|---|---|---|
| `scope.goal_statement` | `scope_goal_statement` | `summary` |
| `scope.understanding_confirmed` | `understanding_confirmed.confirmed` | — |
| `scope.confirmation_method` | `understanding_confirmed.method` | — |
| `completed_work[].task_id` | — | `task_id` |
| `completed_work[].summary` | `actions_taken[].action` | `summary` |
| `completed_work[].evidence` | `evidence_artifacts[]` | `evidence` |
| `remaining_work[]` | `next_steps[]` | — |
| `risks[]` | `risks_blockers[]` | — |
| `handoff_artifacts[]` | `evidence_artifacts[]` | `modified_files` |
| `source_substrate` | `substrate_used` | `substrate` |

### When to Generate a Context Packet

- Crew wave completes and remaining work will continue in `pi-subagents` (or vice versa)
- A long-running session is being resumed in a new session
- Work is being handed off between Helios instances or to a human reviewer
- Review identifies that additional work should use a different substrate

---

## Recap-Friendly Feed Data

Crew maintains internal state that is available for recap generation. This section documents what data is available and how to read it.

### Available Crew State for Recap

| Data | Access Method | What It Contains |
|---|---|---|
| **Task list** | `pi_messenger({ action: "task.list" })` | All tasks with status, assignee, dependencies |
| **Task detail** | `pi_messenger({ action: "task.show", id: "task-N" })` | Full spec, progress log, evidence, summary |
| **Activity feed** | `pi_messenger({ action: "feed", limit: 50 })` | Chronological events: starts, completions, blocks, messages |
| **Agent list** | `pi_messenger({ action: "list" })` | Active agents, reservations, status |
| **Task progress** | `read(".pi/messenger/crew/tasks/task-N.progress.md")` | Timestamped progress entries per task |
| **Handoff notes** | `read(".pi/messenger/crew/artifacts/task-N-handoff.md")` | Per-task handoff with files modified, tests, risks |
| **Plan** | `read(".pi/messenger/crew/plan.md")` | Full task decomposition with dependencies |

### Example: Reading State for Recap Generation

#### 1. Get completed tasks with evidence

```typescript
// List all tasks to find completed ones
const taskList = await pi_messenger({ action: "task.list" });
// Returns task IDs, titles, statuses, assignees

// For each completed task, get full details
const taskDetail = await pi_messenger({ action: "task.show", id: "task-3" });
// Returns: spec, progress log, completion summary, evidence (commits, tests)
```

#### 2. Get activity feed for timeline

```typescript
// Get recent activity (completions, blocks, messages, reviews)
const feed = await pi_messenger({ action: "feed", limit: 50 });
// Returns chronological entries like:
//   "16:03 SageBear completed task-3 — Created session-recap-v1.json schema..."
//   "16:07 TrueCastle completed task-4 — Created 3 deliverables..."
//   "16:20 crew blocked task-1 — Max attempts (3) reached"
```

#### 3. Read per-task handoff artifacts

```typescript
// Handoff notes contain structured completion details
const handoff = await read(".pi/messenger/crew/artifacts/task-3-handoff.md");
// Contains: What Was Done, Files Modified, Tests Added, Unresolved Risks, Evidence
```

#### 4. Read task progress for detailed timeline

```typescript
// Progress logs have timestamped entries from workers
const progress = await read(".pi/messenger/crew/tasks/task-3.progress.md");
// Contains entries like:
//   [2026-03-08T20:02:15Z] RED: wrote failing test for schema validation
//   [2026-03-08T20:03:00Z] GREEN: schema passes all validation tests
```

### Mapping Feed Data to Recap Fields

| Recap Field | Feed Data Source |
|---|---|
| `actions_taken` | `task.list` → filter status `done` → map to actions |
| `evidence_artifacts` | `task.show` per completed task → extract evidence |
| `risks_blockers` | `task.list` → filter status `blocked` → extract reasons; plus handoff `Unresolved Risks` |
| `next_steps` | `task.list` → filter status `todo` → map to next steps |
| `key_findings` | `feed` → extract completion summaries; handoff notes → extract findings |
| `duration_minutes` | First `task.start` timestamp to last `task.done` timestamp from feed |
| `comparison_panels` | Design deck outputs referenced in evidence artifacts |

---

## Rendering

Once a recap artifact is assembled, it is rendered using one of the modes defined in `~/.pi/agent/docs/recap-rendering-modes.md`:

- **Light Recap (Markdown)** — for simple sessions (≤3 actions, <5 minutes)
- **Visual Recap (HTML)** — for architecture, planning, multi-agent sessions
- **Design Deck Recap** — for sessions with unresolved comparison decisions

Template references:
- HTML template: `~/.pi/agent/templates/recap-visual.html`
- Markdown template: `~/.pi/agent/templates/recap-markdown.md`

---

## Anti-Patterns

- ❌ Ending a major Crew wave with no recap artifact
- ❌ Producing a recap that lacks evidence (commits, tests) when tasks completed with evidence
- ❌ Generating a recap without checking `understanding_confirmed` — this field reveals whether scope confirmation was done
- ❌ Storing recaps outside the standard location (`.pi/messenger/crew/artifacts/`)
- ❌ Using free-form prose instead of the structured `session-recap-v1` schema
- ❌ Skipping the context packet when work transitions between substrates
