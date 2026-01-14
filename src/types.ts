export interface WorkspaceConfig {
  id: string;
  name: string;
  directory: string;
  genesis?: string;
}

export interface BridgeConfig {
  machine: {
    id: string;
    name: string;
  };
  workspace: {
    id: string;
  };
  // Multi-workspace support (preferred over single workspace)
  workspaces?: WorkspaceConfig[];
  user: {
    id: string;
  };
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey?: string;  // For operations that need RLS bypass
  };
  mentu: {
    proxy_url: string;
    api_key: string;
  };
  execution: {
    allowed_directories: string[];
    default_timeout_seconds: number;
    max_output_bytes: number;
  };
  agents: Record<string, AgentConfig>;
}

export interface MentuOperation {
  id: string;
  op: string;
  ts: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface AgentConfig {
  path: string;
  default_flags: string[];
}

export type CommandStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'rejected';

export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface Command {
  id: string;
  workspace_id: string;
  prompt: string;
  working_directory: string;
  agent: string;
  flags: string[];
  timeout_seconds: number;
  target_machine_id: string | null;
  status: CommandStatus;
  created_at: string;

  // Approval flow
  approval_required: boolean;
  on_approve: string | null;
  approval_status: ApprovalStatus;
  approved_at: string | null;
  approved_by: string | null;

  // Worktree isolation
  with_worktree?: boolean;         // Create worktree before spawn
  commitment_id?: string;          // Commitment ID for worktree naming

  // Bug execution support
  command_type?: 'spawn' | 'bug_execution';
  payload?: {
    memory_id?: string;
    commitment_id?: string;
    timeout_seconds?: number;
    [key: string]: unknown;
  };
}

export interface WorktreeEnv {
  MENTU_COMMITMENT: string;
  MENTU_WORKTREE: string;
  MENTU_WORKSPACE: string;
}

export interface ApprovalEvent {
  command_id: string;
  action: 'approve' | 'reject';
  actor: string;
  comment?: string;
}

export interface ExecutionResult {
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  exit_code: number;
  stdout: string;
  stderr: string;
  error_message?: string;
}
