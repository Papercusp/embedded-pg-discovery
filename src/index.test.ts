import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePgUrl, type DiscoveryConfig } from './index';

// S4: ESM namespace exports can't be vi.spyOn'd, so mock node:os and drive
// homedir() via a hoisted, mutable holder the factory closes over.
const homeHolder = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, homedir: () => homeHolder.dir || actual.homedir() };
});

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

  // S4: a RELATIVE discoveryFile.path resolves under os.homedir() (the absolute
  // branch is covered above by the /tmp/... path). Mock homedir to a temp dir,
  // drop the file there under the relative name, and assert it resolves.
  it('resolves a relative discoveryFile.path under the home directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-home-'));
    homeHolder.dir = home;
    try {
      fs.writeFileSync(path.join(home, 'epd.json'), JSON.stringify({ url: 'postgres://rel/db' }));
      const cfg: DiscoveryConfig = {
        envVars: [],
        discoveryFile: { path: 'epd.json' }, // relative → joined with homedir()
        fallbackUrl: 'postgres://fallback/db',
      };
      expect(resolvePgUrl(cfg)).toEqual({ url: 'postgres://rel/db', source: 'discovery-file' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      homeHolder.dir = '';
    }
  });

  // S4: with the relative path resolved under home but no file present, it falls
  // through to the fallback (the join must not accidentally hit some other file).
  it('falls back when the relative discovery file is absent under home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-home-'));
    homeHolder.dir = home;
    try {
      const cfg: DiscoveryConfig = {
        envVars: [],
        discoveryFile: { path: 'nope.json' },
        fallbackUrl: 'postgres://fallback/db',
      };
      expect(resolvePgUrl(cfg)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      homeHolder.dir = '';
    }
  });

  // An empty-string env var is treated as ABSENT (truthy check), so a later
  // env var still wins. This is a deliberate, locked improvement over the
  // pre-extraction operator code, whose `A ?? B` + `if(fromEnv)` guard let an
  // empty earlier var mask a valid later one (it fell through to fallback).
  // Unreachable in the operator (Tauri always injects a real value), but
  // pinned so the behavior can't silently regress.
  it('treats an empty-string earlier env var as absent; a later var still wins', () => {
    process.env.TEST_PG_A = '';
    process.env.TEST_PG_B = 'postgres://b/db';
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://b/db', source: 'env' });
  });

  // EI-18132413325218110's root cause: a discovery file survives its writer's death (crash,
  // SIGKILL, host reboot with no cleanup) and, absent a liveness check, wins over the fallback
  // forever — every consumer gets a permanent ECONNREFUSED on the recorded dead port.
  describe('pid liveness (stale discovery file)', () => {
    it('trusts the discovery file when its recorded pid is alive', () => {
      fs.writeFileSync(
        '/tmp/__epd_test_discovery.json',
        JSON.stringify({ url: 'postgres://disc/db', pid: process.pid }),
      );
      expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://disc/db', source: 'discovery-file' });
    });

    it('falls back when the recorded pid is dead (a stale file from a long-gone writer)', () => {
      // A pid essentially guaranteed not to exist: max signed 32-bit minus a bit of headroom.
      const deadPid = 2_147_480_000;
      fs.writeFileSync(
        '/tmp/__epd_test_discovery.json',
        JSON.stringify({ url: 'postgres://disc/db', pid: deadPid }),
      );
      expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
    });

    it('trusts the discovery file when no pid was recorded (back-compat, pre-liveness writers)', () => {
      fs.writeFileSync('/tmp/__epd_test_discovery.json', JSON.stringify({ url: 'postgres://disc/db' }));
      expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://disc/db', source: 'discovery-file' });
    });

    it('treats EPERM (alive but owned by another user) as alive, not dead', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      fs.writeFileSync(
        '/tmp/__epd_test_discovery.json',
        JSON.stringify({ url: 'postgres://disc/db', pid: 1 }),
      );
      expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://disc/db', source: 'discovery-file' });
      killSpy.mockRestore();
    });
  });
});
