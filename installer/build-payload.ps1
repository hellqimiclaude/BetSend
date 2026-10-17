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
function Write-JsonFile($path, $value) {
  # Without the $false, Set-Content -Encoding UTF8 prefixes a byte-order mark
  # under Windows PowerShell 5.1, and Node refuses the file: "Unexpected
  # token". Both of these are read by Node.
  $json = $value | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding $false))
}
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
Write-JsonFile (Join-Path $Staging 'package.json') $minimal

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
Write-JsonFile (Join-Path $Payload 'package.json') @{
  name = 'betsend'; version = '1.1.4'; private = $true; type = 'module'
}

Step 'Checking the payload actually runs'
# A file rather than -e: Start-Process splits its argument list on whitespace,
# so an inline expression arrives at node cut in half.
# .cjs because the payload package.json says type=module, and the prebuilt
# binary is loaded through require.
$probeFile = Join-Path $Payload 'probe.cjs'
@'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('create table t (a integer)');
db.prepare('insert into t values (?)').run(1);
if (db.prepare('select count(*) as n from t').get().n !== 1) process.exit(1);
db.close();
'@ | Set-Content $probeFile -Encoding ASCII

$probe = Start-Process -FilePath (Join-Path $Payload 'node\node.exe') `
                       -ArgumentList 'probe.cjs' `
                       -WorkingDirectory $Payload -NoNewWindow -PassThru -Wait
Remove-Item $probeFile -Force
if ($probe.ExitCode -ne 0) { throw 'the bundled Node could not open a database with the bundled better-sqlite3' }
Ok 'bundled Node opens a SQLite database'

$size = [math]::Round(((Get-ChildItem $Payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Remove-Item $Staging -Recurse -Force

Write-Host ''
Write-Host "  Payload ready: $Payload ($size MB)" -ForegroundColor Green
Write-Host ''
