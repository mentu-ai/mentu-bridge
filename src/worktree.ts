/**
 * Worktree Utilities for Bridge Daemon
 *
 * Creates isolated git worktrees for commitment execution.
 * The .mentu folder is SYMLINKED to preserve ledger integrity.
 *
 * Re-implemented from mentu-ai/src/utils/worktree.ts since
 * cross-repo imports are not possible.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WorktreeEnv } from './types.js';

/**
 * Validate commitment ID is safe for use in paths and shell commands.
 * Only allows alphanumeric characters and underscores (cmt_xxxxxxxx format).
 */
function validateCommitmentId(commitmentId: string): void {
  // Commitment IDs must match the format cmt_xxxxxxxx
  if (!/^cmt_[a-f0-9]{8}$/.test(commitmentId)) {
    throw new Error(`Invalid commitment ID format: ${commitmentId}`);
  }
  // Additional safety: no path separators or shell metacharacters
  if (/[\/\\$`;"'&|<>(){}[\]!#~*?\s]/.test(commitmentId)) {
    throw new Error(`Commitment ID contains unsafe characters: ${commitmentId}`);
  }
}

/**
 * Validate a path stays within its parent directory (prevent path traversal).
 */
function validatePathWithinParent(childPath: string, parentPath: string): void {
  const resolvedChild = path.resolve(childPath);
  const resolvedParent = path.resolve(parentPath);
  if (!resolvedChild.startsWith(resolvedParent + path.sep) && resolvedChild !== resolvedParent) {
    throw new Error(`Path traversal detected: ${childPath} escapes ${parentPath}`);
  }
}

/**
 * Validate .mentu source is a real directory (not a symlink pointing elsewhere).
 */
function validateMentuSource(mentuPath: string, workspacePath: string): void {
  const realMentuPath = fs.realpathSync(mentuPath);
  const expectedPath = path.join(fs.realpathSync(workspacePath), '.mentu');
  if (realMentuPath !== expectedPath) {
    throw new Error(`.mentu source is not in expected location: ${realMentuPath} !== ${expectedPath}`);
  }
}

export interface WorktreeMetadata {
  worktree_path: string;       // /worktrees/{cmt_id}
  worktree_branch: string;     // {cmt_id} (same as commitment ID)
  worktree_created_at: string;
  base_commit?: string;
}

/**
 * Check if the current directory is a git repository
 */
export function isGitRepo(workspacePath: string): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: workspacePath,
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit SHA
 */
export function getHeadCommit(workspacePath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: workspacePath,
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get worktrees directory from config or default
 */
export function getWorktreesDir(workspacePath: string): string {
  return path.join(path.dirname(workspacePath), 'worktrees');
}

/**
 * Get worktree path for a commitment
 *
 * NAMING: /worktrees/{cmt_id}
 * The commitment ID IS the directory name. No suffixes. No prefixes.
 */
export function getWorktreePath(workspacePath: string, commitmentId: string): string {
  // Validate commitment ID format to prevent command injection and path traversal
  validateCommitmentId(commitmentId);

  const worktreesDir = getWorktreesDir(workspacePath);
  const worktreePath = path.join(worktreesDir, commitmentId);

  // Validate path stays within worktrees directory
  validatePathWithinParent(worktreePath, worktreesDir);

  return worktreePath;
}

/**
 * Create an isolated worktree for a commitment
 *
 * CRITICAL: .mentu is SYMLINKED, not copied!
 */
export function createWorktree(
  workspacePath: string,
  commitmentId: string
): WorktreeMetadata {
  const worktreesDir = getWorktreesDir(workspacePath);
  const worktreePath = getWorktreePath(workspacePath, commitmentId);

  // Branch name = commitment ID (no prefix!)
  const branch = commitmentId;

  // Ensure worktrees directory exists
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true });
  }

  // Get base commit before creating worktree
  const baseCommit = getHeadCommit(workspacePath);

  // Create worktree with new branch (or use existing branch)
  try {
    execSync(`git worktree add "${worktreePath}" -b "${branch}" 2>&1`, {
      cwd: workspacePath,
      stdio: 'pipe'
    });
  } catch {
    // Branch might already exist (from reopen), try without -b
    try {
      execSync(`git worktree add "${worktreePath}" "${branch}" 2>&1`, {
        cwd: workspacePath,
        stdio: 'pipe'
      });
    } catch (e) {
      throw new Error(`Failed to create worktree: ${e}`);
    }
  }

  // CRITICAL: SYMLINK .mentu (not copy!)
  const mentuSrc = path.join(workspacePath, '.mentu');
  const mentuDst = path.join(worktreePath, '.mentu');
  if (fs.existsSync(mentuSrc)) {
    // Validate .mentu source is the real directory (prevent symlink-to-symlink attacks)
    validateMentuSource(mentuSrc, workspacePath);
    // Create symlink to parent .mentu
    fs.symlinkSync(mentuSrc, mentuDst);
  }

  return {
    worktree_path: worktreePath,
    worktree_branch: branch,
    worktree_created_at: new Date().toISOString(),
    base_commit: baseCommit || undefined,
  };
}

/**
 * Check if a worktree exists for a commitment
 */
export function worktreeExists(
  workspacePath: string,
  commitmentId: string
): boolean {
  try {
    const worktreePath = getWorktreePath(workspacePath, commitmentId);
    return fs.existsSync(worktreePath);
  } catch {
    return false;
  }
}

/**
 * Build environment variables for worktree execution
 */
export function buildWorktreeEnv(
  commitmentId: string,
  worktreePath: string,
  workspacePath: string
): WorktreeEnv {
  return {
    MENTU_COMMITMENT: commitmentId,
    MENTU_WORKTREE: worktreePath,
    MENTU_WORKSPACE: workspacePath,
  };
}
