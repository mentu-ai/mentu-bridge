import type { BridgeConfig } from './types';
export declare class BridgeDaemon {
    private config;
    private supabase;
    private channel;
    private currentProcess;
    private currentCommandId;
    private heartbeatInterval;
    constructor(config: BridgeConfig);
    private log;
    private captureMemory;
    start(): Promise<void>;
    private registerMachine;
    private heartbeat;
    private subscribe;
    private handleCommand;
    private claimCommand;
    private validateCommand;
    private executeCommand;
    private submitResult;
    shutdown(): Promise<void>;
}
