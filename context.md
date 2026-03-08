---

## Summary

Found the exact bug you suspected! In `crew/handlers/task.ts`, there are **4 incorrect calls** to `executeTaskAction`:

1. **Line 399** (task.start): `executeTaskAction(cwd, "start", id, agentName, namespace)`
2. **Line 554** (task.block): `executeTaskAction(cwd, "block", id, agentName, namespace, params.reason)`
3. **Line 591** (task.unblock): `executeTaskAction(cwd, "unblock", id, agentName, namespace)`
4. **Line 682** (task.reset): `executeTaskAction(cwd, action, id, agentName, namespace)`

All of them pass `namespace` as the **5th parameter** (which is `reason`), when it should be passed as part of the **6th parameter** (`options` object).

**Correct signature:**
```typescript
executeTaskAction(cwd, action, taskId, agentName, reason?, options?: { namespace? })
```

**Should be:**
```typescript
executeTaskAction(cwd, "start", id, agentName, undefined, { namespace })
```

Full findings written to `context.md`.

✅ DONE: Identified 4 instances of namespace parameter bug in crew/handlers/task.ts where namespace is incorrectly passed as reason parameter instead of in options object