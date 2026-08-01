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

  // ── Port-reachability gate ────────────────────────────────────────────────
  // Regression pins for a measured outage (2026-08-01): a discovery file
  // advertised a port, its writer pid was ALIVE, and nothing was listening on
  // that port — so the pid-only gate passed and every consumer on the box went
  // into an ECONNREFUSED storm instead of using the healthy fallback.
  //
  // These are Linux-gated because the check reads /proc/net/tcp; elsewhere the
  // function deliberately declines to judge (a check that cannot run must never
  // reject a healthy config), so asserting rejection there would be wrong.
  //
  // ⚠ The first two tests are EACH OTHER'S mutation check, which is why both
  // directions are pinned rather than just the bug: a gate stubbed to always-
  // pass fails the dead-port test, and one stubbed to always-fail fails the
  // listening-port test. Only a gate that genuinely discriminates on live port
  // state passes both — so their joint green cannot be faked by removing the
  // gate, and no source mutation is needed to prove they are live.
  const onLinux = process.platform === 'linux' ? it : it.skip;

  onLinux('THE OUTAGE: rejects a file whose pid is ALIVE but whose port is dead', () => {
    // process.pid is unambiguously alive, so the pid gate passes and only the
    // port gate can catch this — which is precisely the case that got through.
    const deadPort = 9;
    fs.writeFileSync(
      '/tmp/__epd_test_discovery.json',
      JSON.stringify({ url: `postgres://localhost:${deadPort}/papercusp`, port: deadPort, pid: process.pid }),
    );
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
  });

  onLinux('accepts a file whose advertised port IS being listened on', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      fs.writeFileSync(
        '/tmp/__epd_test_discovery.json',
        JSON.stringify({ url: `postgres://localhost:${port}/papercusp`, port, pid: process.pid }),
      );
      expect(resolvePgUrl(CFG)).toEqual({
        url: `postgres://localhost:${port}/papercusp`,
        source: 'discovery-file',
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  onLinux('a port that STOPS being served flips the verdict on the next resolve', () => {
    // resolvePgUrl re-reads per call by contract; the port gate must honour
    // that too, or a port that dies mid-process stays trusted forever — the
    // "pinned to a dead port and never recovers" shape this whole module is about.
    const port = 9;
    fs.writeFileSync(
      '/tmp/__epd_test_discovery.json',
      JSON.stringify({ url: `postgres://localhost:${port}/db`, port, pid: process.pid }),
    );
    expect(resolvePgUrl(CFG).source).toBe('fallback');
    expect(resolvePgUrl(CFG).source).toBe('fallback');
  });

  onLinux('derives the port from the URL when no explicit port field is present', () => {
    fs.writeFileSync(
      '/tmp/__epd_test_discovery.json',
      JSON.stringify({ url: 'postgres://localhost:9/papercusp', pid: process.pid }),
    );
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://fallback/db', source: 'fallback' });
  });

  it('a file with NO port at all is still trusted (port gate has nothing to judge)', () => {
    // Backward compatibility: older writers recorded no port. The gate must
    // defer rather than reject, or it breaks every pre-existing discovery file.
    fs.writeFileSync('/tmp/__epd_test_discovery.json', JSON.stringify({ url: 'postgres://disc/db' }));
    expect(resolvePgUrl(CFG)).toEqual({ url: 'postgres://disc/db', source: 'discovery-file' });
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
