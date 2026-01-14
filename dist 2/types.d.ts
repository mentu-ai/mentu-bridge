export interface BridgeConfig {
    machine: {
        id: string;
        name: string;
    };
    workspace: {
        id: string;
    };
    user: {
        id: string;
    };
    supabase: {
        url: string;
        anonKey: string;
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
export interface Command {
    id: string;
    workspace_id: string;
    prompt: string;
    working_directory: string;
    agent: string;
    flags: string[];
    timeout_seconds: number;
    target_machine_id: string | null;
    status: string;
    created_at: string;
}
export interface ExecutionResult {
    status: 'success' | 'failed' | 'timeout' | 'cancelled';
    exit_code: number;
    stdout: string;
    stderr: string;
    error_message?: string;
}
