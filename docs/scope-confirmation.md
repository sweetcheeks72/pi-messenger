# Scope Confirmation Workflow

> **Module:** pi-messenger Crew  
> **Related:** `session-recap-v1` schema, `recap-rendering-modes.md`, helios-prime scope-confirmation doctrine

---

## Overview

Scope confirmation is a pre-execution step where Helios confirms its understanding of the user's intent before committing to `plan` or `work`. This is distinct from GSD-lite preflight (which selects execution lane/substrate) — scope confirmation verifies that Helios understood **what** the user wants, not **how** to execute it.

**Key distinction:**
- **GSD-lite preflight** → "Which lane/substrate should I use?" (operational routing)
- **Scope confirmation** → "Did I understand the scope, goals, success criteria, tradeoffs, and non-goals correctly?" (intent verification)

Scope confirmation is not an "I'm confused" signal. It is a "let me verify I understood correctly" signal, used proactively on consequential work.

---

## When Scope Confirmation Is Required

### Consequential Task Triggers

Scope confirmation should precede `plan` or `work` when the task meets any of these criteria:

| Trigger | Examples |
|---------|----------|
| **Ambiguous scope** | "review this plan and make it implementable", "continue this work" |
| **Multi-path strategy** | Architecture decisions, "which approach is best" |
| **Batch operations** | Bug-batch, multi-feature requests |
| **Tradeoff-heavy work** | Requests where success criteria depend on unstated preferences |
| **Unbounded scope** | "turn these screenshots into plans", open-ended transformation |
| **Cross-repo / multi-agent** | Work spanning multiple repositories or requiring coordination |
| **High consequence** | Destructive operations, schema migrations, public API changes |

### Non-Triggers (Skip Confirmation)

| Scenario | Why |
|----------|-----|
| Exact operational command with low ambiguity | "run `npm test`", "read this file" — scope is already fixed |
| Single-file fix with explicit target and outcome | "fix the typo on line 42 of config.ts" — no interpretation needed |
| Direct tool invocation | "search for X in the codebase" — command is the scope |
| Follow-up in an active confirmed scope | Scope was already confirmed earlier in the session |

---

## Confirmation Methods

Scope confirmation can use any of these methods, listed from most to least structured:

### 1. Structured Interview (`interview` tool)

Best for complex, multi-dimensional scope where the user needs to make choices.

```typescript
// Example: before planning a multi-task crew wave
interview({
  questions: JSON.stringify({
    title: "Scope Confirmation",
    description: "Confirm my understanding before proceeding",
    questions: [
      {
        id: "scope",
        type: "single",
        question: "I understand the goal as: '<restatement>'. Is this correct?",
        options: ["Yes, proceed", "No, let me clarify"]
      },
      {
        id: "priorities",
        type: "multi",
        question: "Which areas are highest priority?",
        options: ["Feature A", "Feature B", "Bug fixes", "Documentation"]
      }
    ]
  })
});
```

### 2. Lightweight Confirmation Message

Best for moderately consequential work where a full interview is overhead.

```
Here's my understanding of scope/goals/success before I proceed:

**Scope:** <restatement of what will be done>
**Goals:** <what success looks like>
**Non-goals:** <what will NOT be done>
**Tradeoffs:** <any tradeoffs I'm making>

Confirm or correct before I start planning.
```

### 3. Reviewed Brief Capture

Best when the user provided a loose prompt that needs to be crystallized into a short spec before routing.

Write a brief spec document capturing scope, goals, and acceptance criteria. Present it for review before proceeding to `plan` or `work`.

---

## Crew Workflow Integration

### Where Confirmation Fits in the Crew Lifecycle

```
User prompt
    │
    ▼
┌─────────────────────┐
│ GSD-lite preflight   │  ← Selects lane/substrate (NOT intent confirmation)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Scope confirmation?  │  ← Is this consequential enough?
│ (triggers above)     │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     │ YES       │ NO
     ▼           ▼
  Confirm     Proceed
  scope       directly
     │           │
     ▼           │
  Adjust if     │
  needed        │
     │           │
     └─────┬─────┘
           │
           ▼
┌─────────────────────┐
│ pi_messenger plan    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ pi_messenger work    │
└─────────────────────┘
```

### Relationship Between Crew Planning and Scope Confirmation

| Crew Action | Scope Confirmation Role |
|-------------|------------------------|
| `plan` | If the PRD/prompt is consequential, confirm understanding of scope BEFORE decomposing into tasks. Planning without confirmation risks decomposing the wrong problem. |
| `work` | If tasks are already planned and confirmed, no additional confirmation is needed. If `work` is invoked on an unconfirmed plan, the coordinator should flag this. |
| `task.start` | Individual workers do NOT confirm scope — their task spec IS the confirmed scope. Confirmation happens at the plan level, not the task level. |
| `review` | Review should check whether scope confirmation was done when it should have been (see Review Rule below). |

### Recording Confirmation in Crew State

When scope confirmation occurs, the confirmation method and result should be recorded so that:

1. **Recap generation** can populate the `understanding_confirmed` field in `session-recap-v1`
2. **Review** can verify that confirmation happened when it should have
3. **Feed data** reflects the confirmation event

The `understanding_confirmed` object in `session-recap-v1` captures this:

```json
{
  "confirmed": true,
  "method": "interview",
  "details": "User confirmed scope: implement auth middleware refactor using wrapper pattern, excluding legacy routes"
}
```

Valid `method` values: `"interview"`, `"inline-message"`, `"brief-capture"`, `"implicit-proceed"`, `"skipped"`

---

## Review Rule

Session review should explicitly check:

1. **Was the request consequential enough to need confirmation?** — Apply the trigger criteria above.
2. **Did Helios confirm its understanding before routing?** — Check for evidence of confirmation (interview, message, brief).
3. **Did Helios mistake confidence for confirmation?** — Proceeding because "I can infer it" is not the same as confirming it.
4. **Was there a recap artifact at the end?** — See `recap-artifacts.md`.

### Anti-Overconfidence Check

Before committing to a consequential plan, Helios should ask internally:

> "Am I proceeding because I confirmed the intended outcome, or because I merely believe I can infer it?"

If the answer is "infer" and the task is consequential → trigger scope confirmation.

---

## Schema Reference

- **Scope confirmation recording:** `understanding_confirmed` field in `~/.pi/agent/schemas/session-recap-v1.json`
- **Rendering modes:** `~/.pi/agent/docs/recap-rendering-modes.md`
- **Handoff artifact:** `~/.pi/agent/schemas/helios-handoff-v1.json`
