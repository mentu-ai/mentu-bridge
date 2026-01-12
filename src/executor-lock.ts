import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ExecutorLock {
  type: 'beacon' | 'bridge';
  pid: number;
  workspace_id: string;
  started_at: string;
}

const LOCK_DIR = path.join(os.homedir(), '.mentu');
const LOCK_PATH = path.join(LOCK_DIR, 'executor.lock');

/**
 * Check if a process with given PID is running
 */
function isProcessAlive(pid: number): boolean {
  try {
    // kill with signal 0 doesn't actually kill, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for an existing executor lock
 * Returns the lock info if another executor is running, null otherwise
 */
export function checkExecutorLock(): ExecutorLock | null {
  if (!fs.existsSync(LOCK_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(LOCK_PATH, 'utf-8');
    const lock: ExecutorLock = JSON.parse(content);

    // Check if the process is still alive
    if (isProcessAlive(lock.pid)) {
      return lock;
    }

    // Stale lock - process is dead
    console.log(`[executor-lock] Removing stale lock (PID ${lock.pid} is dead)`);
    fs.unlinkSync(LOCK_PATH);
    return null;
  } catch (error) {
    // Invalid lock file - remove it
    console.log('[executor-lock] Removing invalid lock file');
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // Ignore
    }
    return null;
  }
}

/**
 * Acquire the executor lock
 * Throws if lock cannot be acquired
 */
export function acquireExecutorLock(workspaceId: string): void {
  // Ensure .mentu directory exists
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }

  const lock: ExecutorLock = {
    type: 'bridge',
    pid: process.pid,
    workspace_id: workspaceId,
    started_at: new Date().toISOString(),
  };

  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
  console.log(`[executor-lock] Acquired lock (PID: ${process.pid})`);
}

/**
 * Release the executor lock
 * Only removes if we own the lock
 */
export function releaseExecutorLock(): void {
  if (!fs.existsSync(LOCK_PATH)) {
    return;
  }

  try {
    const content = fs.readFileSync(LOCK_PATH, 'utf-8');
    const lock: ExecutorLock = JSON.parse(content);

    // Only release if we own the lock
    if (lock.pid === process.pid) {
      fs.unlinkSync(LOCK_PATH);
      console.log('[executor-lock] Released lock');
    }
  } catch {
    // Ignore errors during release
  }
}

/**
 * Get a helpful message for stopping the other executor
 */
export function getStopInstructions(lock: ExecutorLock): string {
  if (lock.type === 'beacon') {
    return 'To stop Beacon: Click menu bar icon → Quit, or: pkill -f beacon';
  } else {
    return `To stop Bridge: kill ${lock.pid}`;
  }
}
