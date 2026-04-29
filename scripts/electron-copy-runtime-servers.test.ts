import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { copyPiCodingAgentPackageAssets } from './electron-copy-runtime-servers.ts';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-pi-assets-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(path: string, content: string): void {
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

describe('copyPiCodingAgentPackageAssets', () => {
  it('copies the Pi SDK package docs and examples beside the server bundle', () => {
    const root = makeTempDir();
    const destDir = join(root, 'dist', 'resources', 'pi-agent-server');
    const packageDir = join(root, 'node_modules', '@mariozechner', 'pi-coding-agent');

    mkdirSync(destDir, { recursive: true });
    writeFile(join(packageDir, 'package.json'), '{"name":"@mariozechner/pi-coding-agent"}');
    writeFile(join(packageDir, 'README.md'), '# pi');
    writeFile(join(packageDir, 'CHANGELOG.md'), '# changes');
    writeFile(join(packageDir, 'docs', 'skills.md'), '# skills');
    writeFile(join(packageDir, 'examples', 'README.md'), '# examples');

    copyPiCodingAgentPackageAssets(root, destDir);

    expect(readFileSync(join(destDir, 'docs', 'skills.md'), 'utf8')).toBe('# skills');
    expect(readFileSync(join(destDir, 'examples', 'README.md'), 'utf8')).toBe('# examples');
  });
});
