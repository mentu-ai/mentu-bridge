import { loadConfig } from './config';
import { BridgeDaemon } from './daemon';

async function main() {
  try {
    const config = loadConfig();
    const daemon = new BridgeDaemon(config);
    await daemon.start();
  } catch (error) {
    console.error('Failed to start daemon:', error);
    process.exit(1);
  }
}

main();
