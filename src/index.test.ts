import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { resolvePgUrl, type DiscoveryConfig } from './index';

const CFG: DiscoveryConfig = {
  envVars: ['TEST_PG_A', 'TEST_PG_B'],
  discoveryFile: { path: '/tmp/__epd_test_discovery.json' },
  fallbackUrl: 'postgres://fallback/db',
};

describe('resolvePgUrl', () => {
  beforeEach(() => {
    delete process.env.TEST_PG_A;
    delete process.env.TEST_PG_B;
    try { fs.unlinkSync('/tmp/__epd_test_discovery.json'); } catch { /* noop */ }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.unlinkSync('/tmp/__epd_test_discovery.json'); } catch { /* noop */ }
  });

  it('prefers env vars, first non-empty in order', () => {
    process.env.TEST_PG_B = 'postgres://b/db';
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://b/db', source: 'env' });
    process.env.TEST_PG_A = 'postgres://a/db';
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://a/db', source: 'env' });
  });

  it('falls through empty env to the discovery file', () => {
    fs.writeFileSync('/tmp/__epd_test_discovery.json', JSON.stringify({ url: 'postgres://disc/db' }));
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://disc/db', source: 'discovery-file' });
  });

  it('falls back when env and file are absent', () => {
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
  });

  it('falls back when the discovery file is malformed or has no url', () => {
    fs.writeFileSync('/tmp/__epd_test_discovery.json', 'not json');
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
    fs.writeFileSync('/tmp/__epd_test_discovery.json', JSON.stringify({ port: 5432 }));
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
  });

  it('works with no discoveryFile configured', () => {
    expect(resolvePgUrl({ envVars: ['TEST_PG_A'], fallbackUrl: 'postgres://fb/db' }))
      .toEqual({ url: 'postgres://fb/db', source: 'fallback' });
  });
});
