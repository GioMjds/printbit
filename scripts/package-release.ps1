[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Version,

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "release",

    [switch]$SkipBuild,
    [switch]$SkipWorker,
    [switch]$IncludeNodeModules
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptsDir

# Read version from package.json if not provided
if ([string]::IsNullOrWhiteSpace($Version)) {
    $PackageJsonPath = Join-Path $ProjectDir "package.json"
    if (Test-Path $PackageJsonPath) {
        $packageJson = Get-Content -Raw $PackageJsonPath | ConvertFrom-Json
        $Version = $packageJson.version
    }
    if ([string]::IsNullOrWhiteSpace($Version)) {
        $Version = "1.0.0"
    }
}

$ReleaseFolder = "printbit-v$Version-windows-x64"
$OutPath = Join-Path $ProjectDir $OutputDir
$StagingDir = Join-Path $OutPath $ReleaseFolder
$ZipName = "$ReleaseFolder.zip"
$ZipPath = Join-Path $OutPath $ZipName

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " PrintBit Release Packager: v$Version" -ForegroundColor Cyan
Write-Host " Target Output: $ZipPath" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Prepare Staging Directory
if (Test-Path $StagingDir) {
    Write-Host "[1/6] Cleaning existing staging directory: $StagingDir..." -ForegroundColor Yellow
    Remove-Item -Path $StagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StagingDir "dist") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StagingDir "worker") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StagingDir "firmware") -Force | Out-Null

# 2. Build Web Application (Client & Server)
if (-not $SkipBuild) {
    Write-Host "[2/6] Building Client and Server bundles..." -ForegroundColor Green
    Set-Location -Path $ProjectDir
    node scripts/build-client.js
    if ($LASTEXITCODE -ne 0) { throw "build-client.js failed" }
    node scripts/build-server.js
    if ($LASTEXITCODE -ne 0) { throw "build-server.js failed" }
} else {
    Write-Host "[2/6] Skipping build step as requested." -ForegroundColor DarkGray
}

if (-not (Test-Path (Join-Path $ProjectDir "dist\server.js"))) {
    throw "dist\server.js does not exist. Run build before packaging."
}

# 3. Build & Publish C# Hardware Worker Service
if (-not $SkipWorker) {
    Write-Host "[3/6] Publishing C# Hardware Worker Service (self-contained win-x64)..." -ForegroundColor Green
    $CsprojPath = Join-Path $ProjectDir "worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj"
    $WorkerOutputDir = Join-Path $StagingDir "worker"

    if (Test-Path $CsprojPath) {
        $dotnetCmd = Get-Command "dotnet" -ErrorAction SilentlyContinue
        if ($null -ne $dotnetCmd) {
            dotnet publish $CsprojPath `
                -c Release `
                -r win-x64 `
                --self-contained true `
                -p:PublishSingleFile=true `
                -o $WorkerOutputDir
            if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
        } else {
            Write-Warning "dotnet CLI not found. Falling back to pre-built worker\Release folder if present."
            $PrebuiltWorker = Join-Path $ProjectDir "worker\Release"
            if (Test-Path $PrebuiltWorker) {
                Copy-Item -Path "$PrebuiltWorker\*" -Destination $WorkerOutputDir -Recurse -Force
            } else {
                throw "dotnet CLI not available and worker\Release does not exist."
            }
        }
    }
} else {
    Write-Host "[3/6] Skipping C# worker publish step as requested." -ForegroundColor DarkGray
}

# 4. Copy Required Files to Staging
Write-Host "[4/6] Copying application assets and scripts to staging directory..." -ForegroundColor Green

# 4.1 Server bundle
Copy-Item (Join-Path $ProjectDir "dist\server.js") -Destination (Join-Path $StagingDir "dist\server.js") -Force

# 4.2 Public assets, HTML, bundled JS, styles
Copy-Item -Path (Join-Path $ProjectDir "src\public") -Destination (Join-Path $StagingDir "src\public") -Recurse -Force

# 4.3 Static assets, fonts, locales
if (Test-Path (Join-Path $ProjectDir "src\assets")) {
    Copy-Item -Path (Join-Path $ProjectDir "src\assets") -Destination (Join-Path $StagingDir "src\assets") -Recurse -Force
}
if (Test-Path (Join-Path $ProjectDir "src\fonts")) {
    Copy-Item -Path (Join-Path $ProjectDir "src\fonts") -Destination (Join-Path $StagingDir "src\fonts") -Recurse -Force
}
if (Test-Path (Join-Path $ProjectDir "src\locales")) {
    Copy-Item -Path (Join-Path $ProjectDir "src\locales") -Destination (Join-Path $StagingDir "src\locales") -Recurse -Force
}

# 4.4 Scripts
$TargetScriptsDir = Join-Path $StagingDir "scripts"
New-Item -ItemType Directory -Path $TargetScriptsDir -Force | Out-Null
Copy-Item -Path (Join-Path $ProjectDir "scripts\*.ps1") -Destination $TargetScriptsDir -Force
Copy-Item -Path (Join-Path $ProjectDir "scripts\*.psm1") -Destination $TargetScriptsDir -Force
Copy-Item -Path (Join-Path $ProjectDir "scripts\*.bat") -Destination $TargetScriptsDir -Force
Copy-Item -Path (Join-Path $ProjectDir "scripts\*.json") -Destination $TargetScriptsDir -Force
Copy-Item -Path (Join-Path $ProjectDir "scripts\reset-db.js") -Destination $TargetScriptsDir -Force

# 4.5 Firmware
Copy-Item (Join-Path $ProjectDir "esp32-softAP.ino") -Destination (Join-Path $StagingDir "firmware\esp32-softAP.ino") -Force

# 4.6 Config & Package definitions
Copy-Item (Join-Path $ProjectDir ".env.example") -Destination (Join-Path $StagingDir ".env.example") -Force
Copy-Item (Join-Path $ProjectDir "package.json") -Destination (Join-Path $StagingDir "package.json") -Force
Copy-Item (Join-Path $ProjectDir "pnpm-lock.yaml") -Destination (Join-Path $StagingDir "pnpm-lock.yaml") -Force

# 4.7 Documentation & Quickstart
$DocsToCopy = @(
    "README.md",
    "WINDOWS_10_PRODUCTION_DEPLOYMENT_QUICKSTART.md",
    "INSTALLATIONS.md",
    "OPERATIONS.md",
    "ARCHITECTURE.md",
    "LICENSE.md"
)
foreach ($doc in $DocsToCopy) {
    $srcDoc = Join-Path $ProjectDir $doc
    if (Test-Path $srcDoc) {
        Copy-Item $srcDoc -Destination (Join-Path $StagingDir $doc) -Force
    }
}

# 4.8 Node modules if requested
if ($IncludeNodeModules -and (Test-Path (Join-Path $ProjectDir "node_modules"))) {
    Write-Host "Copying node_modules to staging (this may take a minute)..." -ForegroundColor Yellow
    Copy-Item -Path (Join-Path $ProjectDir "node_modules") -Destination (Join-Path $StagingDir "node_modules") -Recurse -Force
}

# 4.9 Add 1-click bootstrap installer script
$BootstrapScriptContent = @'
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " PrintBit Kiosk Deployment & Setup Initializer" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$CurrentDir = $PSScriptRoot

# 1. Verify Node.js
Write-Host "[1/4] Checking Node.js runtime..." -ForegroundColor Green
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) {
    Write-Error "Node.js is not found in PATH. Please install Node.js (>= 22.5.0) before proceeding."
    exit 1
}
$nodeVer = & node -v
Write-Host "Found Node.js: $nodeVer"

# 2. Check pnpm & install dependencies
Write-Host "[2/4] Ensuring production dependencies..." -ForegroundColor Green
$pnpmCmd = Get-Command "pnpm" -ErrorAction SilentlyContinue
if ($null -eq $pnpmCmd) {
    Write-Host "pnpm not found. Installing pnpm globally..." -ForegroundColor Yellow
    npm install -g pnpm
}
pnpm install --prod

# 3. Initialize fresh database
Write-Host "[3/4] Initializing clean SQLite database..." -ForegroundColor Green
node .\scripts\reset-db.js

# 4. Prompt for system kiosk setup
Write-Host "[4/4] Release installation ready!" -ForegroundColor Green
Write-Host "To register kiosk startup, watchdog, and Windows Assigned Access lockdown," -ForegroundColor Yellow
Write-Host "run: powershell -ExecutionPolicy Bypass -File .\scripts\install-kiosk.ps1" -ForegroundColor Yellow
Write-Host "Or consult WINDOWS_10_PRODUCTION_DEPLOYMENT_QUICKSTART.md for environment variables." -ForegroundColor Yellow
'@

Set-Content -Path (Join-Path $StagingDir "bootstrap-kiosk.ps1") -Value $BootstrapScriptContent -Encoding UTF8

# 5. Compress Staging Directory to .zip
Write-Host "[5/6] Creating ZIP archive: $ZipPath..." -ForegroundColor Green
if (Test-Path $ZipPath) {
    Remove-Item -Path $ZipPath -Force
}
Compress-Archive -Path "$StagingDir\*" -DestinationPath $ZipPath -CompressionLevel Optimal

function Get-Sha256Checksum {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    # 1. Try native PowerShell cmdlet if available
    $cmd = Get-Command "Get-FileHash" -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
        try {
            $result = & $cmd -Path $FilePath -Algorithm SHA256
            if ($result -and $result.Hash) {
                return [string]$result.Hash
            }
        } catch {
            # Fall back to .NET below
        }
    }

    # 2. Universal .NET Cryptography fallback (works across all PowerShell / Windows versions)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
        $hashBytes = $hasher.ComputeHash($stream)
        return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToUpperInvariant()
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
}

# 6. Generate SHA256 Checksum
Write-Host "[6/6] Generating SHA256 checksum..." -ForegroundColor Green
$Hash = Get-Sha256Checksum -FilePath $ZipPath
$HashFile = "$ZipPath.sha256"
"$Hash  $ZipName" | Set-Content -Path $HashFile -Encoding UTF8

$ZipFileInfo = Get-Item $ZipPath
$ZipSizeMB = [math]::Round($ZipFileInfo.Length / 1MB, 2)

Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Package successfully created!" -ForegroundColor Green
Write-Host " Archive:  $ZipPath ($ZipSizeMB MB)" -ForegroundColor Green
Write-Host " SHA256:   $Hash" -ForegroundColor Green
Write-Host " Checksum: $HashFile" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
