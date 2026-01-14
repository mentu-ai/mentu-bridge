import { loadConfig } from './config';
import { BridgeDaemon } from './daemon';

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
export { SimpleBugExecutor } from './simple-bug-executor.js';
export { OutputStreamer } from './output-streamer.js';

async function main() {
  try {
    // No executor lock - systemd manages process lifecycle
    // Multiple instances are prevented by systemd, not file locks
    const config = loadConfig();

    const daemon = new BridgeDaemon(config);
    await daemon.start();
  } catch (error) {
    console.error('Failed to start daemon:', error);
    process.exit(1);
  }
}

main();
