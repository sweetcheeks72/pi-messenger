/**
 * Crew - Artifact Cleanup Utility
 *
 * Prunes old crew run artifacts to prevent unbounded disk growth.
 * Called during session_start if last cleanup was > 24h ago.
 *
 * Configuration:
 *   MESSENGER_ARTIFACT_MAX_AGE_DAYS — max age for run artifacts in days (default: 7)
 */

import * as fs from 'fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'path';

const MAX_AGE_DAYS = parseInt(process.env.MESSENGER_ARTIFACT_MAX_AGE_DAYS ?? '7', 10);
const RUNS_DIR = path.join(process.env.HOME ?? '~', '.pi/messenger/crew/runs');

/**
 * Prune old run artifact directories under RUNS_DIR.
 * Removes any run directory whose mtime is older than MAX_AGE_DAYS.
 * Gracefully handles missing directory (no-op).
 */
export async function pruneOldRuns(): Promise<void> {
  const cutoffMs = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch (err) {
    // Directory doesn't exist or isn't readable — nothing to clean up
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Other errors: log and return gracefully
    console.warn(`[pi-messenger/cleanup] Could not read runs dir ${RUNS_DIR}: ${(err as Error).message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const runPath = path.join(RUNS_DIR, entry.name);
    try {
      const stat = await fs.stat(runPath);
      if (stat.mtimeMs < cutoffMs) {
        await fs.rm(runPath, { recursive: true, force: true });
        console.log(`[pi-messenger/cleanup] Removed old run artifact: ${runPath} (age: ${Math.round((Date.now() - stat.mtimeMs) / 86400000)}d)`);
      }
    } catch (err) {
      // Skip entries we can't stat or remove
      console.warn(`[pi-messenger/cleanup] Could not process ${runPath}: ${(err as Error).message}`);
    }
  }
}

/**
 * Returns true if cleanup should run:
 *   - lastCleanupFile doesn't exist, OR
 *   - lastCleanupFile is older than 24 hours
 */
export async function shouldRunCleanup(lastCleanupFile: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lastCleanupFile);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > 24 * 60 * 60 * 1000; // older than 24h
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return true; // File doesn't exist → cleanup needed
    }
    // Other stat errors: assume cleanup is needed
    return true;
  }
}

/**
 * Run cleanup if the last cleanup was more than 24 hours ago.
 * Updates lastCleanupFile with current timestamp after successful cleanup.
 *
 * @param lastCleanupFile - Path to a sentinel file tracking last cleanup time
 */
export async function runCleanupIfNeeded(lastCleanupFile: string): Promise<void> {
  if (await shouldRunCleanup(lastCleanupFile)) {
    try {
      await pruneOldRuns();
      // Ensure parent directory exists before writing sentinel
      const dir = path.dirname(lastCleanupFile);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(lastCleanupFile, new Date().toISOString());
    } catch (err) {
      // Cleanup failure is non-fatal — log and continue
      console.warn(`[pi-messenger/cleanup] Cleanup failed: ${(err as Error).message}`);
    }
  }
}
