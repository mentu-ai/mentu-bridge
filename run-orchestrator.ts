/**
 * Standalone workflow orchestrator runner
 */
import { WorkflowOrchestrator } from "./src/workflow-orchestrator";

// Use same config as bridge daemon
const SUPABASE_URL = "https://nwhtjzgcbjuewuhapjua.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53aHRqemdjYmp1ZXd1aGFwanVhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Njk4MjMyNCwiZXhwIjoyMDgyNTU4MzI0fQ.o3nKybEz1rQHyjiHYRwpJJsHi5jpOV2IPJul8TtvwuY";

const config = {
  supabaseUrl: process.env.SUPABASE_URL || SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY || SUPABASE_KEY,
  workspaceId: process.env.MENTU_WORKSPACE_ID || "9584ae30-14f5-448a-9ff1-5a6f5caf6312",
  workspacePath: process.env.MENTU_WORKSPACE_PATH || "/home/mentu/Workspaces/mentu-ai",
};

console.log("[run-orchestrator] Starting with config:", {
  supabaseUrl: config.supabaseUrl,
  workspaceId: config.workspaceId,
  workspacePath: config.workspacePath,
});

const orchestrator = new WorkflowOrchestrator(config);
orchestrator.start();

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[run-orchestrator] Shutting down...");
  orchestrator.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[run-orchestrator] Received SIGTERM, shutting down...");
  orchestrator.stop();
  process.exit(0);
});

console.log("[run-orchestrator] Orchestrator running. Press Ctrl+C to stop.");
