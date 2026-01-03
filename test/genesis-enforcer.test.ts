import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { GenesisEnforcer } from '../src/genesis-enforcer.js';

describe('GenesisEnforcer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentu-bridge-test-'));
    fs.mkdirSync(path.join(testDir, '.mentu'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('without genesis.key', () => {
    it('should allow all operations when no genesis.key exists', () => {
      const enforcer = new GenesisEnforcer(testDir);

      const result = enforcer.check('agent:bridge-daemon', 'execute');
      expect(result.allowed).toBe(true);

      enforcer.dispose();
    });

    it('should report no genesis', () => {
      const enforcer = new GenesisEnforcer(testDir);
      expect(enforcer.hasGenesis()).toBe(false);
      enforcer.dispose();
    });
  });

  describe('with genesis.key', () => {
    it('should check permissions', () => {
      const genesisPath = path.join(testDir, '.mentu', 'genesis.key');
      const genesis = {
        genesis: { version: '1.0', created: '2025-01-01T00:00:00Z' },
        identity: { workspace: 'test', owner: 'alice' },
        permissions: {
          actors: {
            'agent:bridge-daemon': { operations: ['execute', 'capture'] },
            'agent:other': { operations: ['capture'] },
          },
        },
      };
      fs.writeFileSync(genesisPath, YAML.stringify(genesis), 'utf-8');

      const enforcer = new GenesisEnforcer(testDir);
      expect(enforcer.hasGenesis()).toBe(true);

      const result1 = enforcer.check('agent:bridge-daemon', 'execute');
      expect(result1.allowed).toBe(true);

      const result2 = enforcer.check('agent:other', 'execute');
      expect(result2.allowed).toBe(false);
      expect(result2.violation?.code).toBe('PERMISSION_DENIED');

      enforcer.dispose();
    });

    it('should use wildcard patterns', () => {
      const genesisPath = path.join(testDir, '.mentu', 'genesis.key');
      const genesis = {
        genesis: { version: '1.0', created: '2025-01-01T00:00:00Z' },
        identity: { workspace: 'test', owner: 'alice' },
        permissions: {
          actors: {
            'agent:*': { operations: ['capture'] },
          },
        },
      };
      fs.writeFileSync(genesisPath, YAML.stringify(genesis), 'utf-8');

      const enforcer = new GenesisEnforcer(testDir);

      const result1 = enforcer.check('agent:bridge-daemon', 'capture');
      expect(result1.allowed).toBe(true);

      const result2 = enforcer.check('agent:bridge-daemon', 'execute');
      expect(result2.allowed).toBe(false);

      enforcer.dispose();
    });

    it('should use default permissions', () => {
      const genesisPath = path.join(testDir, '.mentu', 'genesis.key');
      const genesis = {
        genesis: { version: '1.0', created: '2025-01-01T00:00:00Z' },
        identity: { workspace: 'test', owner: 'alice' },
        permissions: {
          defaults: {
            authenticated: { operations: ['capture', 'annotate'] },
          },
        },
      };
      fs.writeFileSync(genesisPath, YAML.stringify(genesis), 'utf-8');

      const enforcer = new GenesisEnforcer(testDir);

      const result1 = enforcer.check('some-user', 'capture');
      expect(result1.allowed).toBe(true);

      const result2 = enforcer.check('some-user', 'execute');
      expect(result2.allowed).toBe(false);

      enforcer.dispose();
    });
  });

  describe('trust gradient', () => {
    it('should enforce author type constraints', () => {
      const genesisPath = path.join(testDir, '.mentu', 'genesis.key');
      const genesis = {
        genesis: { version: '1.0', created: '2025-01-01T00:00:00Z' },
        identity: { workspace: 'test', owner: 'alice' },
        permissions: {
          actors: {
            'agent:architect': {
              operations: ['capture', 'annotate', 'close'],
              author_type: 'architect',
            },
          },
        },
        trust_gradient: {
          enabled: true,
          author_types: {
            architect: {
              allowed_operations: ['capture', 'annotate'],
            },
          },
        },
      };
      fs.writeFileSync(genesisPath, YAML.stringify(genesis), 'utf-8');

      const enforcer = new GenesisEnforcer(testDir);

      const result1 = enforcer.check('agent:architect', 'capture');
      expect(result1.allowed).toBe(true);

      const result2 = enforcer.check('agent:architect', 'close');
      expect(result2.allowed).toBe(false);
      expect(result2.violation?.code).toBe('AUTHOR_TYPE_DENIED');

      enforcer.dispose();
    });

    it('should enforce deny constraints', () => {
      const genesisPath = path.join(testDir, '.mentu', 'genesis.key');
      const genesis = {
        genesis: { version: '1.0', created: '2025-01-01T00:00:00Z' },
        identity: { workspace: 'test', owner: 'alice' },
        permissions: {
          actors: {
            'agent:architect': {
              operations: ['capture', 'annotate', 'close'],
              author_type: 'architect',
            },
          },
        },
        trust_gradient: {
          enabled: true,
          author_types: {
            architect: {
              allowed_operations: ['capture', 'annotate', 'close'],
            },
          },
          constraints: [
            {
              match: { author_type: 'architect' },
              deny: ['close'],
            },
          ],
        },
      };
      fs.writeFileSync(genesisPath, YAML.stringify(genesis), 'utf-8');

      const enforcer = new GenesisEnforcer(testDir);

      const result = enforcer.check('agent:architect', 'close');
      expect(result.allowed).toBe(false);
      expect(result.violation?.code).toBe('AUTHOR_TYPE_DENIED');
      expect(result.violation?.message).toContain('denied');

      enforcer.dispose();
    });
  });

  describe('refresh', () => {
    it('should reload genesis on refresh', () => {
      const genesisPath = path.join(testDir, '.mentu', 'genesis.key');

      // Start without genesis
      const enforcer = new GenesisEnforcer(testDir);
      expect(enforcer.hasGenesis()).toBe(false);

      // Create genesis
      const genesis = {
        genesis: { version: '1.0', created: '2025-01-01T00:00:00Z' },
        identity: { workspace: 'test', owner: 'alice' },
        permissions: {
          actors: {
            'agent:test': { operations: ['capture'] },
          },
        },
      };
      fs.writeFileSync(genesisPath, YAML.stringify(genesis), 'utf-8');

      // Refresh
      enforcer.refresh();
      expect(enforcer.hasGenesis()).toBe(true);

      const result = enforcer.check('agent:test', 'capture');
      expect(result.allowed).toBe(true);

      enforcer.dispose();
    });
  });

  describe('getWorkspacePath', () => {
    it('should return workspace path', () => {
      const enforcer = new GenesisEnforcer(testDir);
      expect(enforcer.getWorkspacePath()).toBe(testDir);
      enforcer.dispose();
    });
  });
});
