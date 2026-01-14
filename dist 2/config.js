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
exports.loadConfig = loadConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("yaml"));
const os = __importStar(require("os"));
function loadConfig() {
    const configPath = path.join(os.homedir(), '.mentu', 'bridge.yaml');
    const credentialsPath = path.join(os.homedir(), '.mentu', 'credentials');
    if (!fs.existsSync(configPath)) {
        console.error(`Config not found: ${configPath}`);
        console.error('Create ~/.mentu/bridge.yaml with your configuration.');
        process.exit(1);
    }
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = yaml.parse(configContent);
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
        }
        catch (e) {
            console.error('Failed to parse credentials:', e);
        }
    }
    // Validate required fields
    if (!config.machine?.id) {
        throw new Error('Missing machine.id in config');
    }
    if (!config.workspace?.id) {
        throw new Error('Missing workspace.id in config');
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
    config.mentu = config.mentu || {
        proxy_url: process.env.MENTU_PROXY_URL || 'https://mentu-proxy.affihub.workers.dev',
        api_key: process.env.MENTU_API_KEY || '',
    };
    if (!config.mentu.api_key) {
        console.warn('Warning: mentu.api_key not set. Bridge commands will not be recorded in Mentu.');
    }
    return config;
}
