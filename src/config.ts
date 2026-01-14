import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as os from 'os';
import type { BridgeConfig } from './types';

export function loadConfig(): BridgeConfig {
  const configPath = path.join(os.homedir(), '.mentu', 'bridge.yaml');
  const credentialsPath = path.join(os.homedir(), '.mentu', 'credentials');

  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error('Create ~/.mentu/bridge.yaml with your configuration.');
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = yaml.parse(configContent) as Partial<BridgeConfig>;

  // Load Supabase credentials from mentu credentials file
  if (fs.existsSync(credentialsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
      // Use service role key for daemon - it needs full access to manage machines and results
      config.supabase = {
        url: process.env.SUPABASE_URL || 'https://nwhtjzgcbjuewuhapjua.supabase.co',
        anonKey: process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53aHRqemdjYmp1ZXd1aGFwanVhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Njk4MjMyNCwiZXhwIjoyMDgyNTU4MzI0fQ.o3nKybEz1rQHyjiHYRwpJJsHi5jpOV2IPJul8TtvwuY',
      };
      config.user = {
        id: creds.cloud?.userId || '',
      };
    } catch (e) {
      console.error('Failed to parse credentials:', e);
    }
  }

  // Validate required fields
  if (!config.machine?.id) {
    throw new Error('Missing machine.id in config');
  }
  // workspace.id is optional now - discovery from genesis.key is preferred
  if (!config.workspace?.id) {
    console.log('[Config] No workspace.id configured - will use genesis.key discovery');
  }
  if (!config.supabase?.url) {
    throw new Error('Missing supabase.url in config or environment');
  }

  // Set defaults
  config.execution = config.execution || {
    allowed_directories: [os.homedir()],
    default_timeout_seconds: 3600,
    max_output_bytes: 10485760,
  };

  config.agents = config.agents || {
    claude: {
      path: '/usr/local/bin/claude',
      default_flags: ['--dangerously-skip-permissions'],
    },
  };

  // Mentu integration config (for auto-capturing tasks and evidence)
  // Environment variables take precedence over YAML config for secrets
  const apiKeyFromEnv = process.env.MENTU_API_KEY
    || process.env.MENTU_PROXY_TOKEN
    || process.env.X_PROXY_TOKEN;

  // Initialize mentu config with defaults if not present
  config.mentu = config.mentu || {
    proxy_url: 'https://mentu-proxy.affihub.workers.dev',
    api_key: '',
  };

  // Environment variables override YAML for proxy_url and api_key
  if (process.env.MENTU_PROXY_URL) {
    config.mentu.proxy_url = process.env.MENTU_PROXY_URL;
  }
  if (apiKeyFromEnv) {
    config.mentu.api_key = apiKeyFromEnv;
  }

  if (!config.mentu.api_key) {
    console.warn('[Config] Warning: No Mentu API key found. Checked: MENTU_API_KEY, MENTU_PROXY_TOKEN, X_PROXY_TOKEN');
    console.warn('[Config] Bridge captures via proxy will fail. Direct Supabase operations will still work.');
  } else {
    console.log('[Config] Mentu API key loaded from environment');
  }

  return config as BridgeConfig;
}
