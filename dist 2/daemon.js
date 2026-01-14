"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeDaemon = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const child_process_1 = require("child_process");
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
class BridgeDaemon {
    constructor(config) {
        this.channel = null;
        this.currentProcess = null;
        this.currentCommandId = null;
        this.heartbeatInterval = null;
        this.config = config;
        this.supabase = (0, supabase_js_1.createClient)(config.supabase.url, config.supabase.anonKey);
    }
    log(message) {
        console.log(`[${new Date().toISOString()}] ${message}`);
    }
    // Mentu integration: capture a memory
    async captureMemory(body, kind) {
        try {
            const response = await fetch(`${this.config.mentu.proxy_url}/ops`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Proxy-Token': this.config.mentu.api_key,
                },
                body: JSON.stringify({
                    op: 'capture',
                    body,
                    kind,
                }),
            });
            if (!response.ok) {
                const error = await response.text();
                this.log(`Mentu capture failed: ${error}`);
                return null;
            }
            const operation = await response.json();
            this.log(`Mentu: Captured ${operation.id} (${kind || 'observation'})`);
            return operation;
        }
        catch (error) {
            this.log(`Mentu capture error: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    async start() {
        this.log('Starting bridge daemon...');
        this.log(`Machine ID: ${this.config.machine.id}`);
        this.log(`Workspace ID: ${this.config.workspace.id}`);
        // Register machine
        await this.registerMachine();
        // Subscribe to commands
        await this.subscribe();
        // Handle shutdown signals
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
        this.log('Daemon running. Waiting for commands...');
    }
    async registerMachine() {
        const { error } = await this.supabase
            .from('bridge_machines')
            .upsert({
            id: this.config.machine.id,
            workspace_id: this.config.workspace.id,
            user_id: this.config.user.id,
            name: this.config.machine.name,
            hostname: os.hostname(),
            agents_available: Object.keys(this.config.agents),
            status: 'online',
            last_seen_at: new Date().toISOString(),
        });
        if (error) {
            this.log(`Failed to register machine: ${error.message}`);
            throw error;
        }
        this.log('Machine registered successfully');
        // Start heartbeat every 60 seconds
        this.heartbeatInterval = setInterval(() => this.heartbeat(), 60000);
    }
    async heartbeat() {
        await this.supabase
            .from('bridge_machines')
            .update({
            status: this.currentProcess ? 'busy' : 'online',
            last_seen_at: new Date().toISOString(),
            current_command_id: this.currentCommandId,
        })
            .eq('id', this.config.machine.id);
    }
    async subscribe() {
        this.channel = this.supabase
            .channel('bridge-commands')
            .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'bridge_commands',
            filter: `workspace_id=eq.${this.config.workspace.id}`,
        }, (payload) => {
            this.handleCommand(payload.new);
        })
            .subscribe((status) => {
            this.log(`Subscription status: ${status}`);
        });
    }
    async handleCommand(command) {
        // Check if targeted at another machine
        if (command.target_machine_id &&
            command.target_machine_id !== this.config.machine.id) {
            return; // Not for us
        }
        // Skip if not pending
        if (command.status !== 'pending') {
            return;
        }
        // Attempt to claim
        const claimed = await this.claimCommand(command.id);
        if (!claimed) {
            this.log(`Command ${command.id} already claimed by another machine`);
            return;
        }
        this.log(`Executing command ${command.id}`);
        this.log(`  Agent: ${command.agent}`);
        this.log(`  Directory: ${command.working_directory}`);
        this.log(`  Prompt: ${command.prompt.substring(0, 100)}...`);
        // Mentu: Capture task when claimed
        const taskMemory = await this.captureMemory(`Bridge Task [${command.agent}]: ${command.prompt}\n\nDirectory: ${command.working_directory}\nMachine: ${this.config.machine.name}`, 'task');
        try {
            // Validate
            this.validateCommand(command);
            // Execute
            const result = await this.executeCommand(command);
            // Report result (includes Mentu evidence capture)
            await this.submitResult(command.id, command, result, taskMemory?.id);
            this.log(`Command ${command.id} completed with status: ${result.status}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Command ${command.id} failed: ${message}`);
            await this.submitResult(command.id, command, {
                status: 'failed',
                exit_code: 1,
                stdout: '',
                stderr: message,
                error_message: message,
            }, taskMemory?.id);
        }
        this.currentCommandId = null;
    }
    async claimCommand(commandId) {
        const { data, error } = await this.supabase
            .from('bridge_commands')
            .update({
            status: 'claimed',
            claimed_by_machine_id: this.config.machine.id,
            claimed_at: new Date().toISOString(),
        })
            .eq('id', commandId)
            .eq('status', 'pending') // Only claim if still pending
            .select();
        if (error || !data || data.length === 0) {
            return false;
        }
        this.currentCommandId = commandId;
        return true;
    }
    validateCommand(command) {
        // Check working directory is allowed
        const allowed = this.config.execution.allowed_directories.some((dir) => command.working_directory.startsWith(dir));
        if (!allowed) {
            throw new Error(`Working directory not allowed: ${command.working_directory}. ` +
                `Allowed: ${this.config.execution.allowed_directories.join(', ')}`);
        }
        // Check agent is available
        if (!this.config.agents[command.agent]) {
            throw new Error(`Agent not available: ${command.agent}. ` +
                `Available: ${Object.keys(this.config.agents).join(', ')}`);
        }
        // Check directory exists
        if (!fs.existsSync(command.working_directory)) {
            throw new Error(`Working directory does not exist: ${command.working_directory}`);
        }
    }
    executeCommand(command) {
        return new Promise((resolve) => {
            const agentConfig = this.config.agents[command.agent];
            const args = [...agentConfig.default_flags, ...command.flags, command.prompt];
            // Update status to running
            this.supabase
                .from('bridge_commands')
                .update({
                status: 'running',
                started_at: new Date().toISOString(),
            })
                .eq('id', command.id);
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            this.log(`Spawning: ${agentConfig.path} ${args.join(' ')}`);
            const child = (0, child_process_1.spawn)(agentConfig.path, args, {
                cwd: command.working_directory,
                shell: false,
                env: { ...process.env },
            });
            this.currentProcess = child;
            // Timeout handler
            const timeoutMs = (command.timeout_seconds || this.config.execution.default_timeout_seconds) * 1000;
            const timeout = setTimeout(() => {
                timedOut = true;
                this.log(`Command ${command.id} timed out after ${timeoutMs}ms`);
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 5000);
            }, timeoutMs);
            child.stdout.on('data', (data) => {
                stdout += data.toString();
                // Truncate if too large
                if (stdout.length > this.config.execution.max_output_bytes) {
                    stdout = stdout.slice(-this.config.execution.max_output_bytes);
                }
            });
            child.stderr.on('data', (data) => {
                stderr += data.toString();
                if (stderr.length > this.config.execution.max_output_bytes) {
                    stderr = stderr.slice(-this.config.execution.max_output_bytes);
                }
            });
            child.on('close', (code) => {
                clearTimeout(timeout);
                this.currentProcess = null;
                resolve({
                    status: timedOut ? 'timeout' : code === 0 ? 'success' : 'failed',
                    exit_code: code ?? 1,
                    stdout,
                    stderr,
                });
            });
            child.on('error', (error) => {
                clearTimeout(timeout);
                this.currentProcess = null;
                resolve({
                    status: 'failed',
                    exit_code: 1,
                    stdout,
                    stderr,
                    error_message: error.message,
                });
            });
        });
    }
    async submitResult(commandId, command, result, taskMemoryId) {
        const now = new Date().toISOString();
        // Update command status
        await this.supabase
            .from('bridge_commands')
            .update({
            status: result.status === 'success' ? 'completed' : result.status,
            completed_at: now,
        })
            .eq('id', commandId);
        // Insert result
        await this.supabase.from('bridge_results').insert({
            command_id: commandId,
            machine_id: this.config.machine.id,
            status: result.status,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            stdout_truncated: result.stdout.length >= this.config.execution.max_output_bytes,
            stderr_truncated: result.stderr.length >= this.config.execution.max_output_bytes,
            error_message: result.error_message,
            started_at: now,
            completed_at: now,
        });
        // Mentu: Capture evidence with result
        const outputPreview = result.stdout.length > 500
            ? result.stdout.substring(0, 500) + '...'
            : result.stdout;
        const errorPreview = result.stderr.length > 200
            ? result.stderr.substring(0, 200) + '...'
            : result.stderr;
        const evidenceBody = result.status === 'success'
            ? `Bridge Result [${command.agent}]: SUCCESS (exit ${result.exit_code})\n\nTask: ${command.prompt.substring(0, 100)}${command.prompt.length > 100 ? '...' : ''}\n\nOutput:\n${outputPreview}${taskMemoryId ? `\n\nTask ref: ${taskMemoryId}` : ''}`
            : `Bridge Result [${command.agent}]: ${result.status.toUpperCase()} (exit ${result.exit_code})\n\nTask: ${command.prompt.substring(0, 100)}${command.prompt.length > 100 ? '...' : ''}\n\nError: ${result.error_message || errorPreview}${taskMemoryId ? `\n\nTask ref: ${taskMemoryId}` : ''}`;
        await this.captureMemory(evidenceBody, 'evidence');
    }
    async shutdown() {
        this.log('Shutting down...');
        // Stop heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        // Wait for current process if any
        if (this.currentProcess) {
            this.log('Waiting for current process to complete...');
            await new Promise((resolve) => setTimeout(resolve, 10000));
            if (this.currentProcess) {
                this.currentProcess.kill('SIGTERM');
            }
        }
        // Update machine status
        await this.supabase
            .from('bridge_machines')
            .update({ status: 'offline' })
            .eq('id', this.config.machine.id);
        // Unsubscribe
        if (this.channel) {
            await this.supabase.removeChannel(this.channel);
        }
        this.log('Shutdown complete');
        process.exit(0);
    }
}
exports.BridgeDaemon = BridgeDaemon;
