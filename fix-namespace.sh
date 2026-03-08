#!/usr/bin/env bash
set -e
cd /Users/chikochingaya/.pi/agent/git/github.com/nicobailon/pi-messenger

TASK_TS="crew/handlers/task.ts"
ACTIONS_TS="crew/task-actions.ts"

# 1. taskStart: rename _namespace→namespace, add namespace as 5th arg
python3 - <<'PYEOF'
import re

with open("crew/handlers/task.ts", "r") as f:
    content = f.read()

# Fix 1: taskStart signature
content = content.replace(
    "function taskStart(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {",
    "function taskStart(cwd: string, params: CrewParams, state: MessengerState, namespace: string) {"
)
# Fix 1b: taskStart executeTaskAction call
content = content.replace(
    '  const actionResult = executeTaskAction(cwd, "start", id, agentName);',
    '  const actionResult = executeTaskAction(cwd, "start", id, agentName, namespace);',
    1
)

# Fix 2: taskBlock signature
content = content.replace(
    "function taskBlock(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {",
    "function taskBlock(cwd: string, params: CrewParams, state: MessengerState, namespace: string) {"
)
# Fix 2b: taskBlock executeTaskAction call - fix arg order (namespace 5th, reason 6th)
content = content.replace(
    '  const actionResult = executeTaskAction(cwd, "block", id, state.agentName || "unknown", params.reason);',
    '  const actionResult = executeTaskAction(cwd, "block", id, state.agentName || "unknown", namespace, params.reason);',
    1
)

# Fix 3: taskUnblock signature
content = content.replace(
    "function taskUnblock(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {",
    "function taskUnblock(cwd: string, params: CrewParams, state: MessengerState, namespace: string) {"
)
# Fix 3b: taskUnblock executeTaskAction call
content = content.replace(
    '  const actionResult = executeTaskAction(cwd, "unblock", id, state.agentName || "unknown");',
    '  const actionResult = executeTaskAction(cwd, "unblock", id, state.agentName || "unknown", namespace);',
    1
)

# Fix 4: taskReset signature
content = content.replace(
    "function taskReset(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {",
    "function taskReset(cwd: string, params: CrewParams, state: MessengerState, namespace: string) {"
)
# Fix 4b: taskReset executeTaskAction call
content = content.replace(
    '  const actionResult = executeTaskAction(cwd, action, id, state.agentName || "unknown");',
    '  const actionResult = executeTaskAction(cwd, action, id, state.agentName || "unknown", namespace);',
    1
)

with open("crew/handlers/task.ts", "w") as f:
    f.write(content)

print("crew/handlers/task.ts patched OK")
PYEOF

# Fix 5: task-actions.ts - store.getTask for unmet dependencies
python3 - <<'PYEOF'
with open("crew/task-actions.ts", "r") as f:
    content = f.read()

content = content.replace(
    "const unmetDependencies = task.depends_on.filter(depId => store.getTask(cwd, depId)?.status !== \"done\");",
    "const unmetDependencies = task.depends_on.filter(depId => store.getTask(cwd, depId, namespace)?.status !== \"done\");",
    1
)

with open("crew/task-actions.ts", "w") as f:
    f.write(content)

print("crew/task-actions.ts patched OK")
PYEOF

echo "All patches applied."

# Verify changes
echo "=== Verifying crew/handlers/task.ts ==="
grep -n "function taskStart\|function taskBlock\|function taskUnblock\|function taskReset" crew/handlers/task.ts
echo ""
grep -n "executeTaskAction.*namespace\|executeTaskAction.*agentName" crew/handlers/task.ts

echo ""
echo "=== Verifying crew/task-actions.ts ==="
grep -n "store.getTask(cwd, depId" crew/task-actions.ts

# Build
echo ""
echo "=== Building ==="
npm run build 2>&1 | tail -30

# Commit
echo ""
echo "=== Committing ==="
git add crew/handlers/task.ts crew/task-actions.ts
git commit -m "fix: pass namespace to executeTaskAction in task handlers and fix unmet-deps lookup"
