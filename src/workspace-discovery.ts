/**
 * Workspace Discovery - Scans filesystem for genesis.key files
 *
 * Uses genesis.key files as the source of truth for workspace identity,
 * directory paths, and machine affinity. The daemon discovers workspaces
 * by scanning configured root directories for .mentu/genesis.key files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { SupabaseClient } from '@supabase/supabase-js';
import type { WorkspaceConfig } from './types.js';

interface GenesisMachine {
  id: string;
  role: string;
}

interface GenesisIdentity {
  workspace: string;
  name?: string;
  description?: string;
  paths?: {
    local?: string;
    vps?: string;
  };
  machines?: GenesisMachine[];
}

interface GenesisKey {
  genesis: {
    version: string;
    created: string;
  };
  identity: GenesisIdentity;
}

/**
 * Find all genesis.key files in a directory tree
 */
function findGenesisKeys(rootDir: string, maxDepth: number = 5): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip common ignored directories
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'dist', 'build', '.cache'].includes(entry.name)) {
            continue;
          }

          // Check for .mentu/genesis.key
          const genesisPath = path.join(fullPath, '.mentu', 'genesis.key');
          if (fs.existsSync(genesisPath)) {
            results.push(genesisPath);
          }

          // Continue recursion
          walk(fullPath, depth + 1);
        }

        // Direct .mentu directory check at current level
        if (entry.name === '.mentu' && entry.isDirectory()) {
          const genesisPath = path.join(fullPath, 'genesis.key');
          if (fs.existsSync(genesisPath) && !results.includes(genesisPath)) {
            results.push(genesisPath);
          }
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  // Check root directory directly first
  const rootGenesis = path.join(rootDir, '.mentu', 'genesis.key');
  if (fs.existsSync(rootGenesis)) {
    results.push(rootGenesis);
  }

  walk(rootDir, 0);

  return results;
}

/**
 * Parse a genesis.key file and extract workspace config
 */
function parseGenesisKey(genesisPath: string, machineId: string): WorkspaceConfig | null {
  try {
    const content = fs.readFileSync(genesisPath, 'utf-8');
    const genesis = yaml.parse(content) as GenesisKey;

    if (!genesis?.identity?.workspace) {
      console.warn(`[Discovery] Invalid genesis.key (no identity.workspace): ${genesisPath}`);
      return null;
    }

    const identity = genesis.identity;

    // Check machine affinity if machines list is specified
    if (identity.machines && identity.machines.length > 0) {
      const hasAffinity = identity.machines.some(m => m.id === machineId);
      if (!hasAffinity) {
        console.log(`[Discovery] Skipping ${identity.workspace} - no affinity for machine ${machineId}`);
        return null;
      }
    }

    // Determine working directory
    // Priority: identity.paths.vps (if running on VPS) > identity.paths.local > parent of .mentu dir
    const isVPS = process.platform === 'linux' && fs.existsSync('/home/mentu');
    let directory = path.dirname(path.dirname(genesisPath)); // Default: parent of .mentu

    if (identity.paths) {
      if (isVPS && identity.paths.vps) {
        directory = identity.paths.vps;
      } else if (!isVPS && identity.paths.local) {
        directory = identity.paths.local;
      }
    }

    // Verify directory exists
    if (!fs.existsSync(directory)) {
      console.warn(`[Discovery] Directory does not exist for ${identity.workspace}: ${directory}`);
      // Fall back to genesis.key location
      directory = path.dirname(path.dirname(genesisPath));
    }

    return {
      id: '', // Will be resolved from Supabase
      name: identity.workspace,
      directory,
      genesis: genesisPath,
    };
  } catch (err) {
    console.error(`[Discovery] Failed to parse ${genesisPath}:`, err);
    return null;
  }
}

/**
 * Resolve workspace IDs from Supabase by name
 */
async function resolveWorkspaceIds(
  supabase: SupabaseClient,
  workspaces: WorkspaceConfig[]
): Promise<WorkspaceConfig[]> {
  if (workspaces.length === 0) return [];

  const names = workspaces.map(w => w.name);

  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name')
    .in('name', names);

  if (error) {
    console.error('[Discovery] Failed to resolve workspace IDs:', error);
    return [];
  }

  const idMap = new Map<string, string>(
    (data || []).map(w => [w.name, w.id])
  );

  // Filter to workspaces that exist in Supabase
  return workspaces
    .map(w => ({
      ...w,
      id: idMap.get(w.name) || '',
    }))
    .filter(w => {
      if (!w.id) {
        console.warn(`[Discovery] Workspace "${w.name}" not found in Supabase`);
        return false;
      }
      return true;
    });
}

/**
 * Discover workspaces from genesis.key files in allowed directories
 */
export async function discoverWorkspaces(
  supabase: SupabaseClient,
  rootDirs: string[],
  machineId: string
): Promise<WorkspaceConfig[]> {
  console.log(`[Discovery] Scanning for workspaces (machine: ${machineId})`);

  const allGenesisFiles: string[] = [];

  for (const rootDir of rootDirs) {
    if (!fs.existsSync(rootDir)) {
      console.warn(`[Discovery] Root directory does not exist: ${rootDir}`);
      continue;
    }

    console.log(`[Discovery] Scanning: ${rootDir}`);
    const found = findGenesisKeys(rootDir);
    allGenesisFiles.push(...found);
  }

  console.log(`[Discovery] Found ${allGenesisFiles.length} genesis.key files`);

  // Parse each genesis.key and filter by machine affinity
  const workspaces: WorkspaceConfig[] = [];

  for (const genesisPath of allGenesisFiles) {
    const config = parseGenesisKey(genesisPath, machineId);
    if (config) {
      // Avoid duplicates
      if (!workspaces.some(w => w.name === config.name)) {
        workspaces.push(config);
      }
    }
  }

  console.log(`[Discovery] ${workspaces.length} workspaces have affinity for this machine`);

  // Resolve IDs from Supabase
  const resolved = await resolveWorkspaceIds(supabase, workspaces);

  console.log(`[Discovery] Resolved ${resolved.length} workspace IDs`);
  for (const w of resolved) {
    console.log(`[Discovery]   - ${w.name}: ${w.id} (${w.directory})`);
  }

  return resolved;
}

/**
 * Get the working directory for a workspace by ID
 */
export function getWorkspaceDirectory(
  workspaces: WorkspaceConfig[],
  workspaceId: string
): string | undefined {
  const workspace = workspaces.find(w => w.id === workspaceId);
  return workspace?.directory;
}
