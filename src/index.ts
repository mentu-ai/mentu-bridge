import { loadConfig } from './config';
import { BridgeDaemon } from './daemon';
import { checkExecutorLock, acquireExecutorLock, getStopInstructions } from './executor-lock';

// Re-export modules for external use
export { CraftExecutor } from './craft-executor.js';
export {
  buildCraftPrompt,
  buildCraftExecutorPrompt,
  buildExecutionPrompt,
  isCraftPrompt,
  parseCraftFeatureName,
  type BugContext
} from './prompt-builder.js';
export { BugExecutor } from './bug-executor.js';
export { OutputStreamer } from './output-streamer.js';

async function main() {
  try {
    // Check for existing executor BEFORE loading config
    const existingLock = checkExecutorLock();
    if (existingLock) {
      console.error('');
      console.error('╔════════════════════════════════════════════════════════════╗');
      console.error('║  Another executor is already running on this machine       ║');
      console.error('╠════════════════════════════════════════════════════════════╣');
      console.error(`║  Type:    ${existingLock.type.padEnd(48)}║`);
      console.error(`║  PID:     ${String(existingLock.pid).padEnd(48)}║`);
      console.error(`║  Started: ${existingLock.started_at.padEnd(48)}║`);
      console.error('╠════════════════════════════════════════════════════════════╣');
      console.error(`║  ${getStopInstructions(existingLock).padEnd(57)}║`);
      console.error('╚════════════════════════════════════════════════════════════╝');
      console.error('');
      process.exit(1);
    }

    const config = loadConfig();

    // Acquire lock after config is loaded (need workspace_id)
    acquireExecutorLock(config.workspace.id);

    const daemon = new BridgeDaemon(config);
    await daemon.start();
  } catch (error) {
    console.error('Failed to start daemon:', error);
    process.exit(1);
  }
}

main();
