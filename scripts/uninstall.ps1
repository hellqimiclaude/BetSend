<#
.SYNOPSIS
  Stops BetSend and removes it from this machine.

.DESCRIPTION
  Removes the scheduled task and the firewall rule. Your files, database and
  config.json are left alone — delete the storage directory by hand if you
  want those gone too.

.PARAMETER RemoveData
  Also delete the storage directory (uploaded files and the database).
  There is no undo.
#>
[CmdletBinding()]
param(
  [switch] $RemoveData
)

$ErrorActionPreference = 'Continue'

$TaskName     = 'BetSend'
$FirewallRule = 'BetSend'
$AppRoot      = Split-Path -Parent $PSScriptRoot

function Test-Administrator {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  Write-Host "`nThis needs to run as Administrator.`n" -ForegroundColor Red
  exit 1
}

Write-Host ''

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask       -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host '  Scheduled task removed.' -ForegroundColor Green
} else {
  Write-Host '  No scheduled task found.' -ForegroundColor DarkGray
}

# The supervisor may still be mid-restart; make sure nothing is left running.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*server\dist\index.js*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  Stopped BetSend (pid $($_.ProcessId))." -ForegroundColor Green
  }

$rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
if ($rule) {
  $rule | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Write-Host '  Firewall rule removed.' -ForegroundColor Green
} else {
  Write-Host '  No firewall rule found.' -ForegroundColor DarkGray
}

try {
  $shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'BetSend.url'
  if (Test-Path $shortcut) { Remove-Item $shortcut -Force }
} catch { }

if ($RemoveData) {
  $configPath = Join-Path $AppRoot 'config.json'
  if (Test-Path $configPath) {
    $storageDir = (Get-Content $configPath -Raw | ConvertFrom-Json).storageDir
    if ($storageDir -and (Test-Path $storageDir)) {
      Remove-Item $storageDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "  Deleted $storageDir." -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '  Your files and database were kept. Use -RemoveData to delete them too.' -ForegroundColor DarkGray
}

Write-Host "`n  BetSend removed.`n" -ForegroundColor Green
