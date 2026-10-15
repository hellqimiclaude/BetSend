<#
.SYNOPSIS
  Assembles everything the packaged installer ships, into dist-payload\.

.DESCRIPTION
  Runs on a Windows build machine (CI). The result is self-contained: the
  office PC needs no Node.js, no npm and no C++ compiler.

  That last point is the whole reason this exists. better-sqlite3 is a native
  module; older versions compiled themselves on the target machine, which
  needs Visual Studio with the Desktop C++ workload. v13 ships Node-API
  binaries inside its own package, and this script checks the Windows one is
  actually present rather than assuming.

.PARAMETER NodeVersion
  The Node.js runtime to bundle. Must satisfy the engines field in
  package.json.
#>
[CmdletBinding()]
param(
  [string] $NodeVersion = '22.21.0'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Payload  = Join-Path $RepoRoot 'dist-payload'
$Staging  = Join-Path $RepoRoot 'dist-staging'

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Ok($message)   { Write-Host "    $message" -ForegroundColor Green }

Set-Location $RepoRoot

Step 'Cleaning'
foreach ($dir in @($Payload, $Staging)) {
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  New-Item -ItemType Directory -Path $dir | Out-Null
}

Step 'Building the app'
# --ignore-scripts keeps npm from running node-gyp against better-sqlite3's
# binding.gyp, which would need Visual Studio even though the package already
# carries the binary. The repo .npmrc says the same thing; this is explicit
# because the staging install below sits outside that file's reach.
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
Ok 'frontend and server compiled'

Step 'Collecting runtime dependencies'
# A separate tree so the dev dependencies (TypeScript, Vite, the test runner)
# never reach the office machine.
$runtimePackage = Get-Content (Join-Path $RepoRoot 'server\package.json') -Raw | ConvertFrom-Json
$minimal = [ordered]@{
  name         = 'betsend-runtime'
  version      = '1.0.0'
  private      = $true
  type         = 'module'
  dependencies = $runtimePackage.dependencies
}
$minimal | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $Staging 'package.json') -Encoding UTF8

Push-Location $Staging
# dist-staging has its own package.json, so npm treats it as the project root
# and never reads the repo .npmrc. The flag has to be here.
npm install --omit=dev --no-audit --no-fund --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'runtime dependency install failed' }
Pop-Location

$prebuild = Join-Path $Staging 'node_modules\better-sqlite3\prebuilds\win32-x64.node'
if (-not (Test-Path $prebuild)) {
  throw "better-sqlite3 did not bring a win32-x64 binary. Without it the office PC would need a C++ compiler, which is exactly what this package exists to avoid."
}
Ok "better-sqlite3 Windows binary present ($([math]::Round((Get-Item $prebuild).Length / 1MB, 1)) MB)"

Step "Fetching the Node.js $NodeVersion runtime"
$nodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
if (-not (Test-Path $nodeZip)) {
  Invoke-WebRequest -UseBasicParsing -Uri $nodeUrl -OutFile $nodeZip
}
$nodeUnpack = Join-Path $env:TEMP "node-unpack-$NodeVersion"
if (Test-Path $nodeUnpack) { Remove-Item $nodeUnpack -Recurse -Force }
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeUnpack -Force

# Only node.exe is needed to run a built server: no npm, no npx, no docs.
New-Item -ItemType Directory -Path (Join-Path $Payload 'node') | Out-Null
Copy-Item (Join-Path $nodeUnpack "node-v$NodeVersion-win-x64\node.exe") (Join-Path $Payload 'node\node.exe')
Ok "node.exe bundled ($([math]::Round((Get-Item (Join-Path $Payload 'node\node.exe')).Length / 1MB, 1)) MB)"

Step 'Assembling the payload'
New-Item -ItemType Directory -Path (Join-Path $Payload 'server') -Force | Out-Null
Copy-Item (Join-Path $RepoRoot 'server\dist')   (Join-Path $Payload 'server\dist')   -Recurse
Copy-Item (Join-Path $RepoRoot 'server\public') (Join-Path $Payload 'server\public') -Recurse
Copy-Item (Join-Path $Staging  'node_modules')  (Join-Path $Payload 'node_modules')  -Recurse
Copy-Item (Join-Path $RepoRoot 'scripts')       (Join-Path $Payload 'scripts')       -Recurse
Copy-Item (Join-Path $RepoRoot 'README.md')     (Join-Path $Payload 'README.md')

# install.ps1 reads the version floor from here, and the server resolves its
# own paths relative to it.
@{ name = 'betsend'; version = '1.1.0'; private = $true; type = 'module' } |
  ConvertTo-Json | Set-Content (Join-Path $Payload 'package.json') -Encoding UTF8

Step 'Checking the payload actually runs'
$probe = Start-Process -FilePath (Join-Path $Payload 'node\node.exe') `
                       -ArgumentList '-e', "process.exit(require('better-sqlite3') ? 0 : 1)" `
                       -WorkingDirectory $Payload -NoNewWindow -PassThru -Wait
if ($probe.ExitCode -ne 0) { throw 'the bundled Node could not load the bundled better-sqlite3' }
Ok 'bundled Node loads the native module'

$size = [math]::Round(((Get-ChildItem $Payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Remove-Item $Staging -Recurse -Force

Write-Host ''
Write-Host "  Payload ready: $Payload ($size MB)" -ForegroundColor Green
Write-Host ''
