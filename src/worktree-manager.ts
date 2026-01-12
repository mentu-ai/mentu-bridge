/**
 * Worktree Manager - Git worktree isolation for per-commitment execution
 *
 * Ported from beacon/worktree.rs for beacon-parity.
 * Provides class-based API around worktree utilities.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface WorktreeResult {
  success: boolean;
  worktreePath?: string;
  branchName?: string;
  error?: string;
}

/**
 * WorktreeManager provides git worktree isolation for per-commitment execution.
 */
export class WorktreeManager {
  private worktreesDir = ".worktrees";

  /**
   * Get the worktree path for a commitment
   */
  getWorktreePath(repoPath: string, commitmentId: string): string {
    return path.join(repoPath, this.worktreesDir, commitmentId);
  }

  /**
   * Create a worktree for a commitment
   */
  async createWorktree(repoPath: string, commitmentId: string): Promise<WorktreeResult> {
    const worktreePath = this.getWorktreePath(repoPath, commitmentId);
    const branchName = commitmentId;

    try {
      // Ensure .worktrees directory exists
      const worktreesPath = path.join(repoPath, this.worktreesDir);
      if (!fs.existsSync(worktreesPath)) {
        fs.mkdirSync(worktreesPath, { recursive: true });
      }

      // Check if worktree already exists
      if (fs.existsSync(worktreePath)) {
        console.log(`[WorktreeManager] Worktree ${commitmentId} already exists`);
        return {
          success: true,
          worktreePath,
          branchName
        };
      }

      // Check if branch already exists
      let branchExists = false;
      try {
        const result = execSync(`git branch --list ${branchName}`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        branchExists = result.trim().length > 0;
      } catch {
        branchExists = false;
      }

      // Create worktree with new branch or existing branch
      if (branchExists) {
        execSync(`git worktree add "${worktreePath}" ${branchName}`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
      } else {
        execSync(`git worktree add -b ${branchName} "${worktreePath}"`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
      }

      // Create symlink to .mentu directory
      const mentuSrc = path.join(repoPath, ".mentu");
      const mentuDest = path.join(worktreePath, ".mentu");

      if (fs.existsSync(mentuSrc) && !fs.existsSync(mentuDest)) {
        // Create relative symlink
        const relPath = path.relative(worktreePath, mentuSrc);
        fs.symlinkSync(relPath, mentuDest, 'dir');
        console.log(`[WorktreeManager] Symlinked .mentu to worktree`);
      }

      console.log(`[WorktreeManager] Created worktree at ${worktreePath}`);

      return {
        success: true,
        worktreePath,
        branchName
      };

    } catch (e) {
      const error = e as Error;
      console.error(`[WorktreeManager] Failed to create worktree:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cleanup a worktree
   */
  async cleanupWorktree(worktreePath: string): Promise<void> {
    try {
      if (!fs.existsSync(worktreePath)) {
        console.log(`[WorktreeManager] Worktree ${worktreePath} doesn't exist`);
        return;
      }

      // Get parent repo path
      const repoPath = path.dirname(path.dirname(worktreePath));

      // Remove worktree
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe'
      });

      console.log(`[WorktreeManager] Removed worktree ${worktreePath}`);

    } catch (e) {
      const error = e as Error;
      console.error(`[WorktreeManager] Failed to cleanup worktree:`, error.message);
    }
  }

  /**
   * List all managed worktrees
   */
  listWorktrees(repoPath: string): string[] {
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const worktrees: string[] = [];
      const lines = output.split('\n');

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          const wt = line.replace('worktree ', '');
          if (wt.includes(this.worktreesDir)) {
            worktrees.push(wt);
          }
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  /**
   * Check if a worktree exists
   */
  worktreeExists(repoPath: string, commitmentId: string): boolean {
    const worktreePath = this.getWorktreePath(repoPath, commitmentId);
    return fs.existsSync(worktreePath);
  }
}
