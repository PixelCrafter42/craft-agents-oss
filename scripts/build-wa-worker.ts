/**
 * WhatsApp worker build script.
 *
 * Bundles the Baileys-backed WhatsApp subprocess into a single CJS file at
 * packages/messaging-whatsapp-worker/dist/worker.cjs.
 *
 * Baileys is bundled into the output so the packaged app ships a
 * self-contained worker. The dynamic import at runtime still works because
 * esbuild resolves literal dynamic-import strings at bundle time.
 */

import { spawn } from "bun";
import { execSync } from "child_process";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import * as esbuild from "esbuild";

function resolveGitSha(cwd: string): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd }).toString().trim();
    let dirty = false;
    try {
      const status = execSync("git status --porcelain", { cwd }).toString().trim();
      dirty = status.length > 0;
    } catch {
      // Treat status failures as clean so build provenance remains best-effort.
    }
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

const ROOT_DIR = join(import.meta.dir, "..");
const WORKER_DIR = join(ROOT_DIR, "packages/messaging-whatsapp-worker");
const SOURCE = join(WORKER_DIR, "src/worker.ts");
const DIST_DIR = join(WORKER_DIR, "dist");
const OUTPUT = join(DIST_DIR, "worker.cjs");

async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) return { valid: false, error: "File does not exist" };
  const stats = statSync(filePath);
  if (stats.size === 0) return { valid: false, error: "File is empty" };

  const proc = spawn({
    cmd: ["node", "--check", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return { valid: false, error: stderr || "Syntax error" };
  return { valid: true };
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE)) {
    console.error("WhatsApp worker source not found at", SOURCE);
    process.exit(1);
  }

  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  const buildId = new Date().toISOString();
  const gitSha = resolveGitSha(ROOT_DIR);
  console.log(`Building WhatsApp worker (bundling Baileys) - build ${buildId} (${gitSha})...`);

  try {
    await esbuild.build({
      entryPoints: [SOURCE],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: OUTPUT,
      define: {
        __WA_WORKER_BUILD_ID__: JSON.stringify(buildId),
        __WA_WORKER_GIT_SHA__: JSON.stringify(gitSha),
      },
      external: ["electron", "link-preview-js", "qrcode-terminal", "jimp"],
      logLevel: "info",
    });
  } catch (err) {
    console.error("WhatsApp worker build failed:", err);
    process.exit(1);
  }

  console.log("Verifying worker output...");
  const verification = await verifyJsFile(OUTPUT);
  if (!verification.valid) {
    console.error("Worker build verification failed:", verification.error);
    process.exit(1);
  }

  const { size } = statSync(OUTPUT);
  console.log(`WhatsApp worker built (${(size / 1024 / 1024).toFixed(2)} MB) -> ${OUTPUT}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
