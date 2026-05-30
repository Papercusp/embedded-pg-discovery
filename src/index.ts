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
      const parsed = JSON.parse(raw) as { url?: string };
      if (parsed?.url) return { url: parsed.url, source: 'discovery-file' };
    } catch {
      // file missing or unparseable — fall through
    }
  }

  return { url: config.fallbackUrl, source: 'fallback' };
}
