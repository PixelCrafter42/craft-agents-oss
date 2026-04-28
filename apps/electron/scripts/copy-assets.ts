/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { copyRuntimeServersToResources } from '../../../scripts/electron-copy-runtime-servers.ts';

const ELECTRON_DIR = join(import.meta.dir, '..');
const ROOT_DIR = join(ELECTRON_DIR, '..', '..');
const DIST_RESOURCES_DIR = join(ELECTRON_DIR, 'dist', 'resources');

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
cpSync(join(ELECTRON_DIR, 'resources'), DIST_RESOURCES_DIR, { recursive: true });

console.log('✓ Copied resources/ → dist/resources/');

copyRuntimeServersToResources({
  rootDir: ROOT_DIR,
  destResourcesDir: DIST_RESOURCES_DIR,
});

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join(ROOT_DIR, 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join(DIST_RESOURCES_DIR, 'powershell-parser.ps1');
try {
  mkdirSync(DIST_RESOURCES_DIR, { recursive: true });
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}
