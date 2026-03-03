/**
 * Git-based checkpoint system for crew tasks.
 * Creates lightweight git snapshots before/after each task execution,
 * enabling rollback of any individual task's changes.
 *
 * Uses git stash-based approach to avoid polluting commit history.
 * Checkpoints are stored as refs under refs/crew-checkpoints/<taskId>
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface Checkpoint {
  taskId: string;
  commitHash: string;
  timestamp: number;
  label: string; // "pre" or "post"
  message: string;
}

const CHECKPOINT_REF_PREFIX = "refs/crew-checkpoints";

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function gitExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: "pipe", timeout: 10_000 }).toString().trim();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Git command failed: ${cmd}\n${msg}`);
  }
}

/**
 * Create a checkpoint (snapshot of current working tree state).
 * Uses git stash create to make a commit object without affecting the index.
 */
export function createCheckpoint(cwd: string, taskId: string, label: "pre" | "post", message?: string): Checkpoint | null {
  if (!isGitRepo(cwd)) return null;

  try {
    // Get current HEAD
    const headHash = gitExec("git rev-parse HEAD", cwd);
    
    // Create a tree object from the current working tree (including unstaged changes)
    // First, add everything to a temporary index
    const envOverride = `GIT_INDEX_FILE=${path.join(cwd, ".git", `crew-checkpoint-${taskId}.idx`)}`;
    
    // Copy current index
    const realIndex = path.join(cwd, ".git", "index");
    const tempIndex = path.join(cwd, ".git", `crew-checkpoint-${taskId}.idx`);
    
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tempIndex);
    }
    
    // Add all changes to temp index
    try {
      execSync(`${envOverride} git add -A`, { cwd, stdio: "pipe", timeout: 10_000, shell: "/bin/sh" });
    } catch {
      // If add fails, fall back to just using HEAD
    }
    
    // Write tree from temp index
    let treeHash: string;
    try {
      treeHash = execSync(`${envOverride} git write-tree`, { cwd, stdio: "pipe", timeout: 10_000, shell: "/bin/sh" }).toString().trim();
    } catch {
      // Cleanup and bail
      try { fs.unlinkSync(tempIndex); } catch {}
      return null;
    }
    
    // Cleanup temp index
    try { fs.unlinkSync(tempIndex); } catch {}
    
    // Create commit object
    const commitMsg = message || `crew checkpoint: ${taskId} ${label}`;
    const commitHash = gitExec(
      `git commit-tree ${treeHash} -p ${headHash} -m "${commitMsg.replace(/"/g, '\\"')}"`,
      cwd,
    );
    
    // Store as ref
    const refName = `${CHECKPOINT_REF_PREFIX}/${taskId}/${label}`;
    gitExec(`git update-ref ${refName} ${commitHash}`, cwd);
    
    const checkpoint: Checkpoint = {
      taskId,
      commitHash,
      timestamp: Date.now(),
      label,
      message: commitMsg,
    };
    
    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * List all checkpoints for a task.
 */
export function listCheckpoints(cwd: string, taskId: string): Checkpoint[] {
  if (!isGitRepo(cwd)) return [];
  
  const checkpoints: Checkpoint[] = [];
  
  for (const label of ["pre", "post"] as const) {
    const refName = `${CHECKPOINT_REF_PREFIX}/${taskId}/${label}`;
    try {
      const hash = gitExec(`git rev-parse ${refName}`, cwd);
      if (hash) {
        const timestamp = parseInt(gitExec(`git log -1 --format=%ct ${hash}`, cwd)) * 1000;
        const message = gitExec(`git log -1 --format=%s ${hash}`, cwd);
        checkpoints.push({ taskId, commitHash: hash, timestamp, label, message });
      }
    } catch {
      // Ref doesn't exist
    }
  }
  
  return checkpoints;
}

/**
 * Restore working tree to a checkpoint state.
 * This is destructive — current changes will be lost.
 */
export function restoreCheckpoint(cwd: string, taskId: string, label: "pre" | "post"): boolean {
  if (!isGitRepo(cwd)) return false;
  
  const refName = `${CHECKPOINT_REF_PREFIX}/${taskId}/${label}`;
  
  try {
    // Verify ref exists
    const hash = gitExec(`git rev-parse ${refName}`, cwd);
    if (!hash) return false;
    
    // Checkout the tree from the checkpoint commit without moving HEAD
    gitExec(`git read-tree ${hash}`, cwd);
    gitExec(`git checkout-index -a -f`, cwd);
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Get diff between pre and post checkpoints for a task.
 * Shows what the task actually changed.
 */
export function getCheckpointDiff(cwd: string, taskId: string): string | null {
  if (!isGitRepo(cwd)) return null;
  
  const preRef = `${CHECKPOINT_REF_PREFIX}/${taskId}/pre`;
  const postRef = `${CHECKPOINT_REF_PREFIX}/${taskId}/post`;
  
  try {
    return gitExec(`git diff ${preRef} ${postRef} --stat`, cwd);
  } catch {
    return null;
  }
}

/**
 * Clean up checkpoints for a task.
 */
export function deleteCheckpoints(cwd: string, taskId: string): void {
  if (!isGitRepo(cwd)) return;
  
  for (const label of ["pre", "post"]) {
    const refName = `${CHECKPOINT_REF_PREFIX}/${taskId}/${label}`;
    try {
      gitExec(`git update-ref -d ${refName}`, cwd);
    } catch {
      // Ref doesn't exist, that's fine
    }
  }
}
