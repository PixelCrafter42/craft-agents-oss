# Build script for Windows NSIS installer.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1 -SkipInstall
#   powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1 -Signed
#
# Default builds are intentionally unsigned local test builds. They still let
# electron-builder edit Windows executable resources, so the packaged exe keeps
# the configured app icon. Use -Signed for release signing.

param(
    [switch]$SkipInstall,
    [switch]$Signed
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

$BunVersion = "bun-v1.3.9"
$BunDownload = "bun-windows-x64-baseline"
$NoopSignHook = Join-Path $ElectronDir "scripts\noop-win-sign.cjs"
$LocalBuilderConfig = Join-Path $ElectronDir "scripts\electron-builder-win-local.cjs"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

function Remove-DirectoryWithRetry {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq 3) {
                throw
            }
            Write-Host "  Retrying cleanup of $Path (attempt $attempt)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 2
        }
    }
}

function Copy-DirectoryFresh {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Required source not found: $Source"
    }

    Remove-DirectoryWithRetry $Destination
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Get-SdkVersion {
    $packageJsonPath = Join-Path $RootDir "package.json"
    $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    $version = $packageJson.dependencies.'@anthropic-ai/claude-agent-sdk'
    if (-not $version) {
        throw "@anthropic-ai/claude-agent-sdk dependency not found in $packageJsonPath"
    }
    return ($version -replace '^[~^]', '')
}

function Ensure-SdkBinaryPackage {
    $sdkBinPkg = "claude-agent-sdk-win32-x64"
    $sdkBinSource = Join-Path $RootDir "node_modules\@anthropic-ai\$sdkBinPkg"
    if (Test-Path -LiteralPath $sdkBinSource) {
        return $sdkBinSource
    }

    $sdkVersion = Get-SdkVersion
    Write-Host "Cross-arch build: @anthropic-ai/$sdkBinPkg not in node_modules; fetching $sdkVersion from npm..."
    $pkgTmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine($env:TEMP, [System.Guid]::NewGuid().ToString()))
    try {
        Push-Location $pkgTmp.FullName
        try {
            Invoke-Checked "npm" "pack" "@anthropic-ai/$sdkBinPkg@$sdkVersion"
            $tarball = Get-ChildItem -Filter "anthropic-ai-*.tgz" | Select-Object -First 1
            if (-not $tarball) {
                throw "npm pack did not produce a tarball for @anthropic-ai/$sdkBinPkg@$sdkVersion"
            }
            Invoke-Checked "tar" "-xzf" $tarball.Name
        } finally {
            Pop-Location
        }

        New-Item -ItemType Directory -Force -Path $sdkBinSource | Out-Null
        Copy-Item -Path (Join-Path $pkgTmp.FullName "package\*") -Destination $sdkBinSource -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $pkgTmp.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $sdkBinSource)) {
        throw "SDK native binary package not found after npm pack: $sdkBinSource"
    }
    return $sdkBinSource
}

function Ensure-BundledBun {
    $bunExePath = Join-Path $ElectronDir "vendor\bun\bun.exe"
    if (Test-Path -LiteralPath $bunExePath) {
        Write-Host "Bundled Bun present: $bunExePath"
        return
    }

    Write-Host "Downloading Bun $BunVersion for Windows x64 (baseline)..."
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bunExePath) | Out-Null

    $tempDir = Join-Path $env:TEMP "bun-download-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    try {
        $zipUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip"
        $checksumUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt"
        $zipPath = Join-Path $tempDir "$BunDownload.zip"
        $checksumPath = Join-Path $tempDir "SHASUMS256.txt"

        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
        Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath

        $expectedHash = (Get-Content $checksumPath | Select-String "$BunDownload.zip").ToString().Split(" ")[0]
        $actualHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
        if ($actualHash -ne $expectedHash) {
            throw "Bun checksum verification failed. Expected: $expectedHash, got: $actualHash"
        }

        Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
        Unblock-File -Path (Join-Path $tempDir "$BunDownload\bun.exe") -ErrorAction SilentlyContinue

        $robocopyResult = robocopy (Join-Path $tempDir $BunDownload) (Split-Path -Parent $bunExePath) "bun.exe" /R:5 /W:3 /NP /NFL /NDL
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed with exit code $LASTEXITCODE"
        }
        Write-Host "Bundled Bun ready: $bunExePath" -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Copy-PackagingSupportFiles {
    Write-Host "Copying packaging support files..."

    $sdkSource = Join-Path $RootDir "node_modules\@anthropic-ai\claude-agent-sdk"
    $sdkDest = Join-Path $ElectronDir "node_modules\@anthropic-ai\claude-agent-sdk"
    Copy-DirectoryFresh -Source $sdkSource -Destination $sdkDest

    $sdkBinSource = Ensure-SdkBinaryPackage
    $sdkBinDest = Join-Path $ElectronDir "node_modules\@anthropic-ai\claude-agent-sdk-binary"
    Copy-DirectoryFresh -Source $sdkBinSource -Destination $sdkBinDest
    $claudeBinPath = Join-Path $sdkBinDest "claude.exe"
    if (-not (Test-Path -LiteralPath $claudeBinPath)) {
        throw "Native Claude binary not found at $claudeBinPath"
    }
    $claudeBinSize = (Get-Item -LiteralPath $claudeBinPath).Length
    if ($claudeBinSize -lt 50000000) {
        throw "claude.exe is only $claudeBinSize bytes; expected the native SDK binary"
    }
    Write-Host "  Native Claude binary: $([math]::Round($claudeBinSize / 1MB)) MB"

    $rgSource = Join-Path $RootDir "node_modules\@vscode\ripgrep"
    $rgBinPath = Join-Path $rgSource "bin\rg.exe"
    if (-not (Test-Path -LiteralPath $rgSource) -or -not (Test-Path -LiteralPath $rgBinPath)) {
        throw "@vscode/ripgrep not installed or postinstall did not run. Run 'bun install' and 'bun pm trust @vscode/ripgrep'."
    }
    $rgDest = Join-Path $ElectronDir "node_modules\@vscode\ripgrep"
    Copy-DirectoryFresh -Source $rgSource -Destination $rgDest

    $sharedSrcDest = Join-Path $ElectronDir "packages\shared\src"
    New-Item -ItemType Directory -Force -Path $sharedSrcDest | Out-Null
    foreach ($file in @("unified-network-interceptor.ts", "interceptor-common.ts", "feature-flags.ts", "interceptor-request-utils.ts")) {
        Copy-Item -LiteralPath (Join-Path $RootDir "packages\shared\src\$file") -Destination $sharedSrcDest -Force
    }
}

function Ensure-CopilotVendor {
    $source = Join-Path $RootDir "node_modules\@github\copilot-win32-x64"
    $dest = Join-Path $ElectronDir "vendor\copilot\win32-x64"

    if (-not (Test-Path -LiteralPath $source)) {
        Write-Host "Copilot vendor package not found at $source; bundled Copilot will be skipped." -ForegroundColor Yellow
        return
    }

    Copy-DirectoryFresh -Source $source -Destination $dest
    Write-Host "Bundled Copilot ready: $dest"
}

function Get-BuilderConfigArgs {
    if ($Signed) {
        Write-Host "Signed build requested; using electron-builder signing configuration."
        return @("--config", "electron-builder.yml")
    }

    if (-not (Test-Path -LiteralPath $NoopSignHook)) {
        throw "No-op signing hook not found: $NoopSignHook"
    }

    if (-not (Test-Path -LiteralPath $LocalBuilderConfig)) {
        throw "Local electron-builder config not found: $LocalBuilderConfig"
    }

    # Local builds avoid electron-builder's winCodeSign bundle because it
    # requires Windows symlink privileges to extract. The local builder config
    # edits exe resources with the repo's rcedit.exe after packaging instead.
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue

    return @("--config", "scripts/electron-builder-win-local.cjs")
}

Write-Host "=== Building Craft Agents Windows Installer ===" -ForegroundColor Cyan
Write-Host "Root: $RootDir"
Write-Host "Electron: $ElectronDir"
Write-Host "Mode: $(if ($Signed) { 'signed' } else { 'unsigned local test' })"

Write-Host "Stopping lingering Electron processes..."
Get-Process -Name "Craft Agents", "electron", "electron-builder" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  Stopping $($_.ProcessName) (PID: $($_.Id))" -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

Write-Host "Cleaning build artifacts..."
Remove-DirectoryWithRetry (Join-Path $ElectronDir "release")
Remove-DirectoryWithRetry (Join-Path $ElectronDir "node_modules\@anthropic-ai")
Remove-DirectoryWithRetry (Join-Path $ElectronDir "node_modules\@vscode")
Remove-DirectoryWithRetry (Join-Path $ElectronDir "packages")
Remove-DirectoryWithRetry (Join-Path $ElectronDir "vendor\bun")

if (-not $SkipInstall) {
    Write-Host "Installing dependencies..."
    Push-Location $RootDir
    try {
        Invoke-Checked "bun" "install"
    } finally {
        Pop-Location
    }
}

Ensure-BundledBun
Ensure-CopilotVendor

Write-Host "Building Electron app via canonical build pipeline..."
Push-Location $RootDir
try {
    Invoke-Checked "bun" "run" "electron:build"
} finally {
    Pop-Location
}

Copy-PackagingSupportFiles

Write-Host "Packaging app with electron-builder..."
$builderConfigArgs = Get-BuilderConfigArgs

Push-Location $ElectronDir
try {
    $builderArgs = @(
        "electron-builder",
        "--win",
        "--x64",
        "--publish", "never"
    ) + $builderConfigArgs

    $maxRetries = 3
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        Write-Host "  electron-builder attempt $attempt of $maxRetries..." -ForegroundColor Cyan
        try {
            Invoke-Checked "npx" @builderArgs
            break
        } catch {
            if ($attempt -eq $maxRetries) {
                throw
            }

            Write-Host "  electron-builder failed: $_" -ForegroundColor Yellow
            Write-Host "  Cleaning release directory and retrying..." -ForegroundColor Yellow
            Remove-DirectoryWithRetry (Join-Path $ElectronDir "release")
            Start-Sleep -Seconds 5
        }
    }
} finally {
    Pop-Location
}

$installerPath = Get-ChildItem -Path (Join-Path $ElectronDir "release") -Filter "*.exe" |
    Where-Object { $_.Name -notlike "*__uninstaller.exe" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installerPath) {
    throw "Installer not found in $ElectronDir\release"
}

$hash = Get-FileHash -Algorithm SHA256 $installerPath.FullName
$signature = Get-AuthenticodeSignature $installerPath.FullName

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $($installerPath.FullName)"
Write-Host "Size: $([math]::Round($installerPath.Length / 1MB, 2)) MB"
Write-Host "SHA256: $($hash.Hash)"
Write-Host "Signature: $($signature.Status)"
