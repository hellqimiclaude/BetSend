<#
.SYNOPSIS
  Keeps the BetSend server running. Started by the "BetSend" scheduled task.

.DESCRIPTION
  Windows Task Scheduler only restarts a task that *fails*; a process that
  exits cleanly is left dead. This wrapper restarts BetSend whatever the exit
  code, with a backoff so a crash loop cannot spin the CPU, and appends both
  output streams to a rotating log.

  It is not meant to be run by hand -- use "Install BetSend.bat".
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $AppRoot,
  [Parameter(Mandatory)] [string] $NodeExe
)

$ErrorActionPreference = 'Continue'

$logDir  = Join-Path $AppRoot 'logs'
$logFile = Join-Path $logDir 'betsend.log'
$entry   = Join-Path $AppRoot 'server\dist\index.js'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($message) {
  $line = "{0}  [supervisor] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Invoke-LogRotation {
  try {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 20MB)) {
      $archive = Join-Path $logDir 'betsend.log.1'
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
      Move-Item $logFile $archive -Force
    }
  } catch { }
}

if (-not (Test-Path $entry)) {
  Write-Log "server\dist\index.js is missing -- run 'npm run build' or re-run the installer. Giving up."
  exit 1
}

Write-Log 'starting'

# Back off further each time it dies quickly, so a misconfiguration (a taken
# port, an unwritable storage directory) does not restart in a tight loop.
$delay = 5

while ($true) {
  Invoke-LogRotation

  $startedAt = Get-Date
  $exitCode  = -1

  # Append rather than Start-Process -Redirect*, which truncates the file on
  # every restart and refuses to point both streams at the same path.
  $writer = $null
  try {
    $writer = New-Object System.IO.StreamWriter($logFile, $true)
    $writer.AutoFlush = $true

    # *>&1 merges stdout and stderr so the ordering matches what you would
    # have seen in a console.
    & $NodeExe $entry *>&1 | ForEach-Object { $writer.WriteLine([string]$_) }
    $exitCode = $LASTEXITCODE
  } catch {
    if ($writer) { $writer.WriteLine("could not start node: $($_.Exception.Message)") }
  } finally {
    if ($writer) { $writer.Dispose() }
  }

  $ranFor = (Get-Date) - $startedAt
  Write-Log ("exited with code {0} after {1:n0}s" -f $exitCode, $ranFor.TotalSeconds)

  if ($ranFor.TotalSeconds -gt 60) {
    $delay = 5           # it was healthy for a while; treat this as a one-off
  } else {
    $delay = [Math]::Min($delay * 2, 300)
  }

  Write-Log "restarting in ${delay}s"
  Start-Sleep -Seconds $delay
}
