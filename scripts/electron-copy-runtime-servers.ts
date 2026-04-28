import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

interface CopyRuntimeServersOptions {
  rootDir: string;
  destResourcesDir: string;
  platform?: string;
  arch?: string;
}

function copySessionServer(rootDir: string, destResourcesDir: string): void {
  const source = join(rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  const destDir = join(destResourcesDir, 'session-mcp-server');

  if (!existsSync(source)) {
    console.warn(`Warning: Session MCP server not found at ${source}. Session-scoped tools will not work.`);
    return;
  }

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, join(destDir, 'index.js'));
  console.log('Copied Session MCP server to dist resources');
}

function koffiPlatformDir(platform: string, arch: string): string {
  return `${platform}_${arch}`;
}

function copyPiAgentServer(rootDir: string, destResourcesDir: string, platform: string, arch: string): void {
  const sourceDir = join(rootDir, 'packages', 'pi-agent-server', 'dist');
  const source = join(sourceDir, 'index.js');
  const destDir = join(destResourcesDir, 'pi-agent-server');

  if (!existsSync(source)) {
    console.warn(`Warning: Pi agent server not found at ${source}. Pi SDK sessions will not work.`);
    return;
  }

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, join(destDir, 'index.js'));

  const koffiSource = join(rootDir, 'node_modules', 'koffi');
  if (!existsSync(koffiSource)) {
    console.warn('Warning: koffi not found in node_modules. Pi SDK sessions may not work.');
    return;
  }

  const koffiDest = join(destDir, 'node_modules', 'koffi');
  mkdirSync(koffiDest, { recursive: true });

  for (const entry of ['package.json', 'index.js', 'indirect.js', 'index.d.ts', 'lib']) {
    const src = join(koffiSource, entry);
    if (existsSync(src)) {
      cpSync(src, join(koffiDest, entry), { recursive: true, force: true });
    }
  }

  const nativeDir = koffiPlatformDir(platform, arch);
  const nativeSrc = join(koffiSource, 'build', 'koffi', nativeDir);
  const nativeDest = join(koffiDest, 'build', 'koffi', nativeDir);

  if (existsSync(nativeSrc)) {
    mkdirSync(nativeDest, { recursive: true });
    cpSync(nativeSrc, nativeDest, { recursive: true, force: true });
    console.log(`Copied Pi agent server to dist resources with koffi/${nativeDir}`);
    return;
  }

  const buildSrc = join(koffiSource, 'build');
  if (existsSync(buildSrc)) {
    cpSync(buildSrc, join(koffiDest, 'build'), { recursive: true, force: true });
    console.warn(`Warning: koffi native binary for ${nativeDir} not found. Copied all koffi builds as fallback.`);
  }
}

export function copyRuntimeServersToResources(options: CopyRuntimeServersOptions): void {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  mkdirSync(options.destResourcesDir, { recursive: true });
  copySessionServer(options.rootDir, options.destResourcesDir);
  copyPiAgentServer(options.rootDir, options.destResourcesDir, platform, arch);
}
