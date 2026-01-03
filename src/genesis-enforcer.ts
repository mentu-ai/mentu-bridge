/**
 * Genesis Enforcer - Runtime enforcement of Genesis.key constitutional rules
 *
 * Checks operations against genesis key permissions and constraints before execution.
 * Integrates with mentu-ai's genesis module for validation logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

/**
 * Violation code types for enforcement results.
 */
export type ViolationCode =
  | 'PERMISSION_DENIED'
  | 'CONSTRAINT_VIOLATED'
  | 'AUTHOR_TYPE_DENIED';

/**
 * Enforcement result returned by check().
 */
export interface EnforcementResult {
  allowed: boolean;
  violation?: {
    code: ViolationCode;
    actor: string;
    operation: string;
    constraint?: string;
    message: string;
  };
}

/**
 * Simplified genesis key structure for bridge enforcement.
 * Only includes fields needed for command execution checks.
 */
interface GenesisKeySimple {
  genesis: {
    version: string;
    created: string;
  };
  identity: {
    workspace: string;
    owner: string;
  };
  permissions?: {
    actors?: Record<string, {
      operations: string[];
      author_type?: string;
      author_types?: string[];
      role?: string;
    }>;
    defaults?: {
      authenticated?: { operations: string[] };
      anonymous?: { operations: string[] };
    };
  };
  trust_gradient?: {
    enabled: boolean;
    author_types?: Record<string, {
      allowed_operations: string[];
    }>;
    constraints?: Array<{
      match: { author_type: string };
      deny?: string[];
    }>;
  };
}

/**
 * Match an actor against a pattern.
 * Patterns support * as a wildcard for any sequence of characters.
 */
function matchActorPattern(actor: string, pattern: string): boolean {
  if (pattern === actor) {
    return true;
  }

  if (pattern.includes('*')) {
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(actor);
  }

  return false;
}

/**
 * Genesis Enforcer class for checking operations against genesis key rules.
 */
export class GenesisEnforcer {
  private workspacePath: string;
  private genesis: GenesisKeySimple | null = null;
  private genesisPath: string;
  private lastModified: number = 0;
  private watcher: fs.FSWatcher | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.genesisPath = path.join(workspacePath, '.mentu', 'genesis.key');
    this.loadGenesis();
    this.setupWatcher();
  }

  /**
   * Load genesis key from file.
   */
  private loadGenesis(): void {
    try {
      if (!fs.existsSync(this.genesisPath)) {
        this.genesis = null;
        this.lastModified = 0;
        return;
      }

      const stats = fs.statSync(this.genesisPath);
      const content = fs.readFileSync(this.genesisPath, 'utf-8');
      this.genesis = YAML.parse(content) as GenesisKeySimple;
      this.lastModified = stats.mtimeMs;
    } catch {
      this.genesis = null;
      this.lastModified = 0;
    }
  }

  /**
   * Setup file watcher for genesis key changes.
   */
  private setupWatcher(): void {
    const mentuDir = path.dirname(this.genesisPath);

    // Only watch if directory exists
    if (!fs.existsSync(mentuDir)) {
      return;
    }

    try {
      this.watcher = fs.watch(mentuDir, (eventType, filename) => {
        if (filename === 'genesis.key') {
          this.refresh();
        }
      });
    } catch {
      // Watcher setup failed, will rely on manual refresh
    }
  }

  /**
   * Find actor permissions from genesis key.
   */
  private findActorPermissions(
    actor: string
  ): { operations: string[]; author_type?: string; author_types?: string[] } | null {
    if (!this.genesis?.permissions?.actors) {
      return null;
    }

    const actors = this.genesis.permissions.actors;
    let bestMatch: { pattern: string; value: typeof actors[string] } | null = null;

    for (const [pattern, value] of Object.entries(actors)) {
      if (matchActorPattern(actor, pattern)) {
        if (!bestMatch) {
          bestMatch = { pattern, value };
        } else {
          // Exact match wins
          if (pattern === actor) {
            bestMatch = { pattern, value };
            break;
          }
          // Non-wildcard wins over wildcard
          if (!pattern.includes('*') && bestMatch.pattern.includes('*')) {
            bestMatch = { pattern, value };
          } else if (pattern.length > bestMatch.pattern.length) {
            bestMatch = { pattern, value };
          }
        }
      }
    }

    return bestMatch?.value ?? null;
  }

  /**
   * Check if an actor has permission to perform an operation.
   */
  private hasPermission(actor: string, operation: string): boolean {
    const actorPerms = this.findActorPermissions(actor);

    if (actorPerms) {
      return actorPerms.operations.includes(operation);
    }

    // Check defaults
    if (this.genesis?.permissions?.defaults?.authenticated) {
      return this.genesis.permissions.defaults.authenticated.operations.includes(operation);
    }

    // If no permissions defined at all, allow everything
    if (!this.genesis?.permissions) {
      return true;
    }

    // Default deny
    return false;
  }

  /**
   * Get the author type for an actor.
   */
  private getActorAuthorType(actor: string): string | null {
    const perms = this.findActorPermissions(actor);
    if (!perms) {
      return null;
    }

    if (perms.author_type) {
      return perms.author_type;
    }

    if (perms.author_types && perms.author_types.length > 0) {
      return perms.author_types[0];
    }

    return null;
  }

  /**
   * Check author type constraints.
   */
  private checkAuthorTypeConstraints(
    actor: string,
    operation: string
  ): { allowed: boolean; reason?: string; author_type?: string } {
    if (!this.genesis?.trust_gradient?.enabled) {
      return { allowed: true };
    }

    const authorType = this.getActorAuthorType(actor);
    if (!authorType) {
      return { allowed: true };
    }

    // Check allowed_operations from author type definition
    const authorTypeDef = this.genesis.trust_gradient.author_types?.[authorType];
    if (authorTypeDef) {
      if (!authorTypeDef.allowed_operations.includes(operation)) {
        return {
          allowed: false,
          reason: `Author type '${authorType}' cannot perform '${operation}'`,
          author_type: authorType,
        };
      }
    }

    // Check deny rules in constraints
    if (this.genesis.trust_gradient.constraints) {
      for (const constraint of this.genesis.trust_gradient.constraints) {
        if (constraint.match.author_type === authorType) {
          if (constraint.deny?.includes(operation)) {
            return {
              allowed: false,
              reason: `Operation '${operation}' is denied for author type '${authorType}'`,
              author_type: authorType,
            };
          }
        }
      }
    }

    return { allowed: true, author_type: authorType };
  }

  /**
   * Check if an operation is allowed for an actor.
   *
   * @param actor - The actor identity (e.g., 'agent:bridge-daemon')
   * @param operation - The operation to check (e.g., 'execute', 'capture', 'commit')
   * @param _context - Optional context for the operation (reserved for future use)
   * @returns Enforcement result with allowed status and violation details if denied
   */
  check(actor: string, operation: string, _context?: object): EnforcementResult {
    // If no genesis key exists, allow all (backward compatible)
    if (!this.genesis) {
      return { allowed: true };
    }

    // Check basic permission
    if (!this.hasPermission(actor, operation)) {
      return {
        allowed: false,
        violation: {
          code: 'PERMISSION_DENIED',
          actor,
          operation,
          message: `Actor '${actor}' does not have permission to perform '${operation}'`,
        },
      };
    }

    // Check author type constraints
    const authorTypeResult = this.checkAuthorTypeConstraints(actor, operation);
    if (!authorTypeResult.allowed) {
      return {
        allowed: false,
        violation: {
          code: 'AUTHOR_TYPE_DENIED',
          actor,
          operation,
          constraint: authorTypeResult.author_type,
          message: authorTypeResult.reason || 'Author type constraint violated',
        },
      };
    }

    return { allowed: true };
  }

  /**
   * Refresh cached genesis key (call on file change or manually).
   */
  refresh(): void {
    this.loadGenesis();
  }

  /**
   * Check if genesis key exists.
   */
  hasGenesis(): boolean {
    return this.genesis !== null;
  }

  /**
   * Get the workspace path.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Dispose of resources (stop file watcher).
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
