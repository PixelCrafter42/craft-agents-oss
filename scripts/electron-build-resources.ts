/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";
import { copyRuntimeServersToResources } from "./electron-copy-runtime-servers.ts";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}

copyRuntimeServersToResources({
  rootDir: ROOT_DIR,
  destResourcesDir: destDir,
});
