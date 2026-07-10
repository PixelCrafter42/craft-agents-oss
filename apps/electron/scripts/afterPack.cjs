/**
 * electron-builder afterPack hook
 *
 * Compiles the macOS 26+ Liquid Glass icon directly into the app bundle.
 * A pre-compiled Assets.car is still accepted as a compatibility fallback.
 *
 * To regenerate Assets.car after icon changes:
 *   cd apps/electron
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 *
 * For older macOS versions, the app falls back to icon.icns which is
 * included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

async function afterPack(context) {
  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const resourcesDir = path.join(appPath, 'Craft Agents.app', 'Contents', 'Resources');
  const iconSource = path.join(context.packager.projectDir, 'resources', 'icon.icon');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');
  const destAssetsCar = path.join(resourcesDir, 'Assets.car');

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  fs.mkdirSync(resourcesDir, { recursive: true });

  if (fs.existsSync(iconSource)) {
    let compileDir;
    try {
      // actool uses the .icon bundle basename as the asset name selected by
      // --app-icon. Give it the same name declared in CFBundleIconName.
      compileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-icon-compile-'));
      const namedIconSource = path.join(compileDir, 'AppIcon.icon');
      fs.cpSync(iconSource, namedIconSource, { recursive: true });
      afterPack._execFileSync('xcrun', [
        'actool',
        namedIconSource,
        '--compile', resourcesDir,
        '--output-format', 'human-readable-text',
        '--notices',
        '--warnings',
        '--app-icon', 'AppIcon',
        '--include-all-app-icons',
        '--accent-color', 'AccentColor',
        '--enable-on-demand-resources', 'NO',
        '--development-region', 'en',
        '--target-device', 'mac',
        '--minimum-deployment-target', '26.0',
        '--platform', 'macosx',
        '--output-partial-info-plist', '/dev/null',
      ], { stdio: 'inherit' });
      if (!fs.existsSync(destAssetsCar)) {
        throw new Error('actool completed without producing Assets.car');
      }
      console.log(`Liquid Glass icon compiled: ${destAssetsCar}`);
      return;
    } catch (err) {
      console.log(`Warning: Could not compile icon.icon with actool: ${err.message}`);
    } finally {
      if (compileDir) fs.rmSync(compileDir, { recursive: true, force: true });
    }
  }

  if (fs.existsSync(precompiledAssets)) {
    fs.copyFileSync(precompiledAssets, destAssetsCar);
    console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
    return;
  }

  if (process.env.CRAFT_DEV_RUNTIME === '1') {
    console.log('Warning: Liquid Glass icon unavailable in development package');
    console.log('The app will use the fallback icon.icns on all macOS versions');
    return;
  }

  throw new Error(
    'Liquid Glass icon build failed: install Xcode 26+ with actool or provide resources/Assets.car',
  );
}

// Test seam; production always uses node:child_process.
afterPack._execFileSync = execFileSync;
module.exports = afterPack;
