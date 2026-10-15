<#
.SYNOPSIS
  Installs BetSend as a always-on background service on this Windows machine.

.DESCRIPTION
  Idempotent — safe to run again after a `git pull` to rebuild and restart.
  It will:
    1. check for Node.js 20+
    2. install dependencies and build the app
    3. create config.json with a generated admin token (existing file is kept)
    4. open the port on the Windows firewall for private/domain networks
    5. register a scheduled task that starts BetSend at boot and restarts it
       if it ever exits
    6. start it and wait until it answers
    7. print the address to hand round the office

.PARAMETER Port
  Port to listen on. 8080 by default. Use 80 to drop the ":8080" from the URL.

.PARAMETER StorageDir
  Where uploaded files and the database live. Defaults to .\data next to the
  app. Put this on a drive with room to spare. Must be a local path — the
  service runs as SYSTEM and cannot reach mapped network drives.

.PARAMETER NoService
  Do everything except registering the scheduled task. Useful for a dry run.

.EXAMPLE
  .\install.ps1 -Port 80 -StorageDir D:\BetSendData
#>
[CmdletBinding()]
param(
  [int]    $Port = 8080,
  [string] $StorageDir,
  [switch] $NoService
)

$ErrorActionPreference = 'Stop'

$TaskName     = 'BetSend'
$FirewallRule = 'BetSend'

# --- helpers ---------------------------------------------------------------

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Ok($message)   { Write-Host "    $message" -ForegroundColor Green }
function Write-Note($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Stop-WithMessage($message) {
  Write-Host "`nSetup stopped: $message`n" -ForegroundColor Red
  exit 1
}

function Test-Administrator {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-AdminToken {
  # RNGCryptoServiceProvider works on both Windows PowerShell 5.1 and PowerShell 7.
  $rng   = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $bytes = New-Object byte[] 18
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return ([Convert]::ToBase64String($bytes) -replace '[+/=]', '').Substring(0, 20)
}

function Get-LanAddresses {
  try {
    return @(
      Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress
    )
  } catch {
    return @()
  }
}

# --- 0. preconditions ------------------------------------------------------

$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

Write-Host ''
Write-Host '  BetSend setup' -ForegroundColor White
Write-Host "  $AppRoot" -ForegroundColor DarkGray

# Firewall rules and startup tasks need elevation. Rather than telling the user
# to right-click the right thing, ask Windows for it and carry on in a new
# window (-NoExit so they can read the result).
if (-not $NoService -and -not (Test-Administrator)) {
  Write-Host "`n  Asking Windows for administrator rights..." -ForegroundColor DarkGray

  $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"")
  if ($PSBoundParameters.ContainsKey('Port'))       { $relaunch += @('-Port', "$Port") }
  if ($PSBoundParameters.ContainsKey('StorageDir')) { $relaunch += @('-StorageDir', "`"$StorageDir`"") }

  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $relaunch
  } catch {
    Stop-WithMessage 'administrator rights are required. Right-click "Install BetSend.bat" and choose "Run as administrator".'
  }
  exit 0
}

if (-not $StorageDir) { $StorageDir = Join-Path $AppRoot 'data' }

Write-Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-WithMessage 'Node.js is not installed. Get the LTS installer from https://nodejs.org, then run this again.'
}

$nodeExe     = $node.Source
$nodeVersion = (& $nodeExe --version).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  Stop-WithMessage "Node.js $nodeVersion is too old. BetSend needs 20 or newer — update from https://nodejs.org."
}
Write-Ok "Node.js $nodeVersion at $nodeExe"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) { Stop-WithMessage 'npm was not found alongside Node.js. Reinstall Node.js from https://nodejs.org.' }

# Warn early rather than failing after a five-minute build.
try {
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($inUse) {
    $owner = (Get-Process -Id $inUse[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    if ($owner -ne 'node') {
      Write-Host "    Warning: port $Port is already used by '$owner'." -ForegroundColor Yellow
      Write-Host "    Re-run with -Port 8081 (or stop that program) if setup fails to start." -ForegroundColor Yellow
    }
  }
} catch { }

# --- 1. build --------------------------------------------------------------

Write-Step 'Installing dependencies (this takes a minute the first time)'
& $npm.Source install
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'npm install failed. The output above says why.' }
Write-Ok 'dependencies installed'

Write-Step 'Building the app'
& $npm.Source run build
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'the build failed. The output above says why.' }
Write-Ok 'built'

# --- 2. configuration ------------------------------------------------------

Write-Step 'Configuration'
$configPath = Join-Path $AppRoot 'config.json'

if (Test-Path $configPath) {
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  # Honour a port passed on the command line even on a re-run.
  if ($PSBoundParameters.ContainsKey('Port'))       { $config.port       = $Port }
  if ($PSBoundParameters.ContainsKey('StorageDir')) { $config.storageDir = $StorageDir }
  $Port       = $config.port
  $StorageDir = $config.storageDir
  $config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
  Write-Ok 'kept your existing config.json'
  $adminToken = $config.adminToken
} else {
  $adminToken = New-AdminToken
  $config = [ordered]@{
    port                     = $Port
    host                     = '0.0.0.0'
    storageDir               = $StorageDir
    adminToken               = $adminToken
    retentionHours           = 72
    maxUploadSize            = 0
    deleteAfterAllDownloaded = $true
    registrationMode         = 'open'
  }
  $config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
  Write-Ok "created config.json with a generated admin token"
}

New-Item -ItemType Directory -Force -Path $StorageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'logs') | Out-Null
Write-Note "storage: $StorageDir"

# --- 3. firewall -----------------------------------------------------------

if (-not $NoService) {
  Write-Step 'Opening the firewall so colleagues can reach it'
  try {
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $FirewallRule `
                        -Description 'BetSend office file transfer (LAN only)' `
                        -Direction Inbound -Action Allow -Protocol TCP `
                        -LocalPort $Port -Profile Private,Domain | Out-Null
    Write-Ok "TCP $Port allowed on private and domain networks"
    Write-Note 'Public networks are deliberately excluded — this is a LAN-only tool.'
  } catch {
    Write-Host "    Could not add the firewall rule: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "    Add it by hand, or colleagues will not be able to connect." -ForegroundColor Yellow
  }
}

# --- 4. service ------------------------------------------------------------

if (-not $NoService) {
  Write-Step 'Registering BetSend to start with Windows'

  $supervisor = Join-Path $PSScriptRoot 'supervise.ps1'
  $arguments  = '-NoProfile -ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden ' +
                "-File `"$supervisor`" -AppRoot `"$AppRoot`" -NodeExe `"$nodeExe`""

  $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $AppRoot
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                            -DontStopIfGoingOnBatteries `
                                            -StartWhenAvailable `
                                            -MultipleInstances IgnoreNew `
                                            -ExecutionTimeLimit ([TimeSpan]::Zero) `
                                            -RestartCount 3 `
                                            -RestartInterval (New-TimeSpan -Minutes 1)

  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

  Register-ScheduledTask -TaskName $TaskName `
                         -Description 'BetSend office file transfer server' `
                         -Action $action -Trigger $trigger `
                         -Principal $principal -Settings $settings | Out-Null
  Write-Ok 'registered — it will come back automatically after a reboot'

  Write-Step 'Starting BetSend'
  Start-ScheduledTask -TaskName $TaskName

  $healthy = $false
  foreach ($attempt in 1..60) {
    Start-Sleep -Seconds 1
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
  }

  if ($healthy) {
    Write-Ok 'running'
  } else {
    Write-Host "    It did not answer within a minute." -ForegroundColor Yellow
    Write-Host "    Check logs\betsend.log for the reason." -ForegroundColor Yellow
  }
}

# --- 5. tell the human what to do next -------------------------------------

$addresses = Get-LanAddresses
$primary   = if ($addresses.Count -gt 0) { $addresses[0] } else { 'this-machine' }
$suffix    = if ($Port -eq 80) { '' } else { ":$Port" }

Write-Host ''
Write-Host '  ────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host '   BetSend is set up.' -ForegroundColor Green
Write-Host ''
Write-Host '   Send this address round the office:' -ForegroundColor White
foreach ($address in $addresses) {
  Write-Host "     http://$address$suffix" -ForegroundColor Cyan
}
if ($addresses.Count -eq 0) {
  Write-Host "     http://<this machine's IP>$suffix" -ForegroundColor Cyan
}
Write-Host ''
Write-Host '   Admin token (for the Admin page):' -ForegroundColor White
Write-Host "     $adminToken" -ForegroundColor Yellow
Write-Host '     Also saved in config.json.' -ForegroundColor DarkGray
Write-Host ''
Write-Host '   Next: open the address, go to Admin, paste in your staff list.' -ForegroundColor White
Write-Host '   Then set "Who can pick a name" to list-only.' -ForegroundColor DarkGray
Write-Host ''
Write-Host '   Useful later:' -ForegroundColor White
Write-Host '     Restart      Restart-ScheduledTask -TaskName BetSend' -ForegroundColor DarkGray
Write-Host '     Stop         Stop-ScheduledTask    -TaskName BetSend' -ForegroundColor DarkGray
Write-Host '     Logs         logs\betsend.log' -ForegroundColor DarkGray
Write-Host '     Remove       scripts\uninstall.ps1' -ForegroundColor DarkGray
Write-Host '  ────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''

# A shortcut on the desktop so whoever runs the machine can check on it.
try {
  $shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'BetSend.url'
  "[InternetShortcut]`r`nURL=http://$primary$suffix`r`n" | Set-Content $shortcut -Encoding ASCII
} catch { }
