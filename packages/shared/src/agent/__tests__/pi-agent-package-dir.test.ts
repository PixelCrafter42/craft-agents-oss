import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolvePiPackageDir } from '../pi-agent.ts';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-pi-package-dir-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs = [];
});

describe('resolvePiPackageDir', () => {
  it('prefers Pi package assets bundled beside the packaged server', () => {
    const root = makeTempDir();
    const serverDir = join(root, 'resources', 'pi-agent-server');
    const serverPath = join(serverDir, 'index.js');
    writeFile(join(serverDir, 'docs', 'skills.md'), '# skills');

    expect(resolvePiPackageDir(serverPath)).toBe(serverDir);
  });

  it('falls back to the dev node_modules package from the server path', () => {
    const root = makeTempDir();
    const serverPath = join(root, 'packages', 'pi-agent-server', 'dist', 'index.js');
    const packageDir = join(root, 'node_modules', '@mariozechner', 'pi-coding-agent');
    writeFile(join(packageDir, 'docs', 'skills.md'), '# skills');

    expect(resolvePiPackageDir(serverPath)).toBe(packageDir);
  });
});
