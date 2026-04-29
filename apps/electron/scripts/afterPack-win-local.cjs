const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const run = promisify(execFile);
const baseAfterPack = require("./afterPack.cjs");

function firstExistingPath(paths) {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function getWindowsVersion(appInfo) {
  if (appInfo.shortVersionWindows) {
    return appInfo.shortVersionWindows;
  }

  if (typeof appInfo.getVersionInWeirdWindowsForm === "function") {
    return appInfo.getVersionInWeirdWindowsForm();
  }

  const parts = String(appInfo.version || "0.0.0")
    .split(".")
    .map((part) => part.replace(/\D.*/, "") || "0");

  while (parts.length < 4) {
    parts.push("0");
  }

  return parts.slice(0, 4).join(".");
}

async function editWindowsExecutableResources(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const projectDir = context.packager.projectDir;
  const rootDir = path.resolve(projectDir, "..", "..");
  const appInfo = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const iconPath = path.join(projectDir, "resources", "icon.ico");
  const rceditPath = firstExistingPath([
    path.join(rootDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe"),
    path.join(projectDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe"),
  ]);

  if (!fs.existsSync(exePath)) {
    throw new Error(`Windows executable not found for resource edit: ${exePath}`);
  }

  if (!fs.existsSync(iconPath)) {
    throw new Error(`Windows icon not found for resource edit: ${iconPath}`);
  }

  if (!rceditPath) {
    throw new Error("rcedit.exe not found. Run dependency install before packaging.");
  }

  const args = [
    exePath,
    "--set-version-string",
    "FileDescription",
    appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "LegalCopyright",
    appInfo.copyright || "",
    "--set-version-string",
    "InternalName",
    appInfo.productFilename,
    "--set-version-string",
    "OriginalFilename",
    "",
    "--set-file-version",
    appInfo.shortVersion || appInfo.buildVersion || appInfo.version,
    "--set-product-version",
    getWindowsVersion(appInfo),
    "--set-icon",
    iconPath,
  ];

  if (appInfo.companyName) {
    args.push("--set-version-string", "CompanyName", appInfo.companyName);
  }

  const requestedExecutionLevel = context.packager.platformSpecificBuildOptions.requestedExecutionLevel;
  if (requestedExecutionLevel && requestedExecutionLevel !== "asInvoker") {
    args.push("--set-requested-execution-level", requestedExecutionLevel);
  }

  console.log(`afterPack-win-local: editing resources for ${exePath}`);
  await run(rceditPath, args, { windowsHide: true });
}

module.exports = async function afterPackWinLocal(context) {
  await baseAfterPack(context);
  await editWindowsExecutableResources(context);
};
