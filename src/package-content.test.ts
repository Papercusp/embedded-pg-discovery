import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('packs the maintained runtime while excluding local operational state', () => {
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const fixture = mkdtempSync(join(tmpdir(), 'discovery-pack-'));
  try {
    for (const file of ['package.json', 'src/index.ts', 'LICENSE']) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      cpSync(join(source, file), join(fixture, file));
    }
    mkdirSync(join(fixture, '.papercusp'), { recursive: true });
    writeFileSync(join(fixture, '.papercusp/config.json'), '{"sentinel":"local-state"}');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: fixture, encoding: 'utf8', timeout: 10000,
    }));
    const paths = packed[0].files.map((file: {path: string}) => file.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('LICENSE');
    expect(paths.some((path: string) => path.startsWith('.papercusp/'))).toBe(false);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
