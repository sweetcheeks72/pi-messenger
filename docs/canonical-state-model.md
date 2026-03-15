# Canonical Session Monitor State Model

> **Module:** `src/monitor/canonical/`  
> **Task:** task-1 — canonical state model without UI integration  
> **Compatibility:** Non-breaking; legacy `SessionStatus` / `HealthStatus` types are unchanged.

---

## Overview

The canonical state model provides a **single, authoritative vocabulary** for describing session and operator state across the pi-messenger monitor. All UI views, overview sections, and attention queues derive their data from these canonical types — ensuring consistent semantics regardless of which subsystem produces the underlying data.

```
Legacy runtime data                 Canonical layer              UI / derivations
──────────────────                  ───────────────              ─────────────────
SessionStatus (idle|active|…)  ──►  CanonicalLifecycleState ──►  Running / Queued /
HealthStatus (healthy|…)       ──►  CanonicalHealthState    ──►  Completed / Failed
                                         │                        degraded / stuck /
                                         ▼                        needingAttention
                                  CanonicalMonitorState
```

---

## Canonical States

### `CanonicalLifecycleState`

Represents the lifecycle phase of a single session.

| Value       | Description                                               |
|-------------|-----------------------------------------------------------|
| `queued`    | Session created but not yet started (pending activation)  |
| `starting`  | Session is initialising (spawning process, loading tools) |
| `running`   | Session is actively executing work                        |
| `waiting`   | Session is suspended, awaiting external/human input       |
| `completed` | Session finished normally                                 |
| `failed`    | Session terminated due to an unrecoverable error          |
| `canceled`  | Session was deliberately stopped before completion        |

### `CanonicalHealthState`

Represents the operational health of a session.

| Value      | Description                                                |
|------------|------------------------------------------------------------|
| `active`   | Operating normally with recent activity                    |
| `idle`     | Running but no recent work (normal for queued sessions)    |
| `waiting`  | Suspended and waiting for input (mirrors lifecycle)        |
| `degraded` | Showing signs of staleness — reduced throughput            |
| `stuck`    | No progress detected for an extended period                |
| `offline`  | Session has ended or is unreachable                        |

### `CanonicalMonitorState`

Represents the **overall** state of the monitor across all sessions.

| Value              | Description                                          |
|--------------------|------------------------------------------------------|
| `healthy`          | All sessions running normally                        |
| `attention_needed` | One or more sessions are degraded (but not blocked)  |
| `blocked`          | One or more sessions are stuck                       |
| `recovering`       | All work ended but some sessions failed              |
| `completed`        | All sessions finished without failures               |

---

## Legacy Mapping

### `SessionStatus` → `CanonicalLifecycleState`

| Legacy `SessionStatus` | Canonical lifecycle | Rationale                              |
|------------------------|---------------------|----------------------------------------|
| `idle`                 | `queued`            | Not yet started, pending activation    |
| `active`               | `running`           | Actively executing work                |
| `paused`               | `waiting`           | Suspended, awaiting human input        |
| `ended`                | `completed`         | Finished normally                      |
| `error`                | `failed`            | Terminated due to an error             |

> **Note:** `starting` and `canceled` are canonical-only states with no direct legacy equivalent. They exist to support future richer runtime data.

### `HealthStatus` → `CanonicalHealthState`

| Legacy `HealthStatus` | Canonical health | Rationale                             |
|-----------------------|------------------|---------------------------------------|
| `healthy`             | `active`         | Operating normally                    |
| `degraded`            | `degraded`       | Showing signs of staleness            |
| `critical`            | `stuck`          | No progress for an extended period    |

---

## Normalization API

### `mapSessionLifecycle(status)`

```typescript
import { mapSessionLifecycle } from "./src/monitor/canonical/index.js";

const lifecycle = mapSessionLifecycle("active"); // → "running"
```

### `mapHealthState(health)`

```typescript
import { mapHealthState } from "./src/monitor/canonical/index.js";

const health = mapHealthState("critical"); // → "stuck"
```

### `normalizeSession(session, healthInput?)`

Normalizes a single runtime session. If `healthInput` is omitted, health is
inferred from the lifecycle state.

```typescript
import { normalizeSession } from "./src/monitor/canonical/index.js";

const canonical = normalizeSession(
  { id: "s1", status: "active" },
  { sessionId: "s1", health: "healthy" }
);
// → { id: "s1", lifecycle: "running", health: "active" }
```

### `normalizeSessions(sessions, healthMap?)`

Batch normalization. Accepts an optional `Map<sessionId, RuntimeHealthInput>`.

```typescript
import { normalizeSessions } from "./src/monitor/canonical/index.js";

const canonicals = normalizeSessions(sessions, healthMap);
```

---

## Derivation API

### `deriveSections(sessions)` → `SessionSections`

Groups canonical sessions into Running / Queued / Completed / Failed buckets.

```typescript
import { deriveSections } from "./src/monitor/canonical/index.js";

const { running, queued, completed, failed } = deriveSections(canonicals);
```

**Grouping rules:**

| Section     | Lifecycle states included             |
|-------------|---------------------------------------|
| `running`   | `running`, `starting`                 |
| `queued`    | `queued`                              |
| `completed` | `completed`, `canceled`               |
| `failed`    | `failed`                              |

> `waiting` sessions are intentionally excluded from sections — they appear in the attention view.

### `deriveAttentionView(sessions)` → `AttentionView`

Filters canonical sessions into degraded / stuck / needingAttention views.

```typescript
import { deriveAttentionView } from "./src/monitor/canonical/index.js";

const { degraded, stuck, needingAttention } = deriveAttentionView(canonicals);
```

`needingAttention` is the ordered union: `[...degraded, ...stuck]`.

### `deriveMonitorState(sessions)` → `CanonicalMonitorState`

Derives the overall monitor state with priority:

1. **blocked** — any session is stuck
2. **attention_needed** — any session is degraded (no stuck)
3. **recovering** — all sessions terminal, some failed
4. **completed** — all sessions terminal, none failed
5. **healthy** — default

```typescript
import { deriveMonitorState } from "./src/monitor/canonical/index.js";

const state = deriveMonitorState(canonicals); // → "healthy" | "blocked" | ...
```

---

## File Structure

```
src/monitor/canonical/
├── types.ts       — Zod schemas, type aliases, and interfaces
├── normalizer.ts  — Pure mapping + derivation functions
└── index.ts       — Public barrel export
```

---

## Backward Compatibility

- `SessionStatus` (`idle | active | paused | ended | error`) in `src/monitor/types/session.ts` is **unchanged**.
- `HealthStatus` (`healthy | degraded | critical`) in `src/monitor/health/types.ts` is **unchanged**.
- The canonical module adds new exports via a separate barrel — zero impact on existing consumers.

---

## Adding New Legacy Values

If a new `SessionStatus` value is added upstream:

1. Add it to `RuntimeSessionInput["status"]` in `types.ts`.
2. Add a `case` to `mapSessionLifecycle` in `normalizer.ts`.
3. TypeScript will emit a compile error if the switch is non-exhaustive (the `never` guard).
4. Update the mapping table in this doc.
