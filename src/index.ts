/**
 * Generic Postgres connection-URL discovery for desktop / local-first apps.
 *
 * Resolution order (configurable):
 *   1. Explicit env vars (first set wins), in the given order.
 *   2. A JSON discovery file written by the desktop host at boot
 *      (e.g. ~/.papercusp/embedded-pg.json) — reads its `url` field.
 *   3. A caller-supplied fallback URL (e.g. native PG for zero-config dev).
 *
 * Pure infra: no domain coupling. The Papercusp-specific configuration
 * (env var names, discovery path, native fallback) lives in the consumer
 * wrapper, not here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type PgUrlSource = 'env' | 'discovery-file' | 'fallback';

export interface PgUrlResult {
  url: string;
  source: PgUrlSource;
}

export interface DiscoveryConfig {
  /** Env var names checked in order; first non-empty wins. */
  envVars: string[];
  /**
   * Discovery file location. If `path` is absolute it is used as-is;
   * otherwise it is resolved under the user's home directory.
   * The file is JSON with a `url` string field.
   */
  discoveryFile?: { path: string };
  /** Last-resort connection string. */
  fallbackUrl: string;
}

/**
 * Resolve a Postgres URL per `config`. Pure (no caching) — callers that
 * want memoization wrap it (see the Papercusp `getHarnessAdminUrl`).
 */
export function resolvePgUrl(config: DiscoveryConfig): PgUrlResult {
  for (const name of config.envVars) {
    const v = process.env[name];
    if (v) return { url: v, source: 'env' };
  }

  if (config.discoveryFile) {
    const p = config.discoveryFile.path;
    const resolved = path.isAbsolute(p) ? p : path.join(os.homedir(), p);
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = JSON.parse(raw) as { url?: string; pid?: number };
      // Liveness check: the file is written once at boot by the process that owns the
      // embedded-pg instance and is never cleaned up on an unclean exit (crash, SIGKILL,
      // host reboot) — so a STALE file from a long-dead writer otherwise wins forever over
      // the correct native-PG fallback, and every consumer (deploy tooling, a fresh `npm run
      // dev`, …) gets a permanent ECONNREFUSED on the recorded port until a human notices and
      // deletes the file. When the file records a `pid`, verify that process is still alive
      // (`process.kill(pid, 0)` — a same-host existence probe, no signal actually delivered;
      // reliable on POSIX, and Node documents it as usable for existence-checking on Windows
      // too) before trusting its port; a dead pid is treated exactly like a missing file
      // (fall through to the next source). No `pid` recorded (an older writer, or a caller
      // that never set one) preserves the prior unconditional-trust behavior — this is an
      // additive safety check, not a stricter file-format requirement.
      const pidLooksLive = parsed?.pid == null || isPidAlive(parsed.pid);
      if (parsed?.url && pidLooksLive) return { url: parsed.url, source: 'discovery-file' };
    } catch {
      // file missing or unparseable — fall through
    }
  }

  return { url: config.fallbackUrl, source: 'fallback' };
}

/** Same-host process-existence probe: signal `0` delivers nothing, it only checks that the
 *  pid is a live process this user can signal. Cheap + synchronous (no network I/O), so it's
 *  safe to call on every {@link resolvePgUrl} invocation despite that function's "re-read per
 *  call, no caching" contract (see the discovery-port-changes-across-launches note on the
 *  Papercusp wrapper). Any thrown errno (ESRCH = gone, EPERM = alive but owned by another
 *  user — still "alive", so EPERM must NOT read as dead) is handled explicitly rather than a
 *  blanket catch, so a permissions quirk can't silently make a live port look stale. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
