<#
.SYNOPSIS
Uninstalls and reinstalls the local AStack plugin into Antigravity.

.DESCRIPTION
Stops any process referencing the installed plugin directory, falls back to
closing Antigravity if a directory lock remains, removes any leftover plugin
folder, and reinstalls from the local repository.
#>
[CmdletBinding()]
param(
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$PluginName = "astack",
  [string]$PluginsDir = (Join-Path $HOME ".gemini\config\plugins")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail-Script {
  param([string]$Message, [int]$ExitCode = 1)
  [Console]::Error.WriteLine($Message)
  exit $ExitCode
}

function Invoke-Agy {
  param([string[]]$Arguments)
  $prevPref = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & agy @Arguments
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPref
  }
}

function Stop-LockingProcesses {
  param([string]$PluginDir)
  $escapedDir = [regex]::Escape($PluginDir)
  $procs = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        ($_.CommandLine -match $escapedDir -or ($_.Name -eq "node.exe" -and $_.CommandLine -match 'astack_timeline'))
      }
  )
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($procs.Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
}

function Stop-AntigravityProcesses {
  $procs = @(Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    return $false
  }
  foreach ($proc in $procs) {
    $null = $proc.CloseMainWindow()
  }
  Start-Sleep -Seconds 2
  $remaining = @(Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue)
  foreach ($proc in $remaining) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  return $true
}

function Remove-DirectoryWithRetry {
  param([string]$Path, [int]$Attempts = 6)
  for ($i = 1; $i -le $Attempts; $i++) {
    if (-not (Test-Path -LiteralPath $Path)) {
      return $true
    }
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return $true
    } catch {
      if ($i -lt $Attempts) {
        Start-Sleep -Milliseconds 500
      }
    }
  }
  return (-not (Test-Path -LiteralPath $Path))
}

if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
  Fail-Script "agy CLI not found on PATH."
}

if (-not (Test-Path -LiteralPath $RepoDir -PathType Container)) {
  Fail-Script "Plugin repository directory not found: $RepoDir"
}

$ResolvedRepo = (Resolve-Path -LiteralPath $RepoDir).Path
$ManifestPath = Join-Path $ResolvedRepo "plugin.json"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  Fail-Script "Missing plugin.json in $ResolvedRepo"
}

$InstalledDir = Join-Path $PluginsDir $PluginName
$closedAntigravity = $false

Write-Host "[1/3] Stopping plugin processes and uninstalling $PluginName..."
Stop-LockingProcesses -PluginDir $InstalledDir
$null = Invoke-Agy @("plugin", "uninstall", $PluginName)

Write-Host "[2/3] Cleaning leftover directory $InstalledDir..."
if (Test-Path -LiteralPath $InstalledDir) {
  Stop-LockingProcesses -PluginDir $InstalledDir
  $cleared = Remove-DirectoryWithRetry -Path $InstalledDir -Attempts 4
  if (-not $cleared) {
    Write-Host "Directory is locked by Antigravity. Closing Antigravity to release the handle..."
    $closedAntigravity = Stop-AntigravityProcesses
    Stop-LockingProcesses -PluginDir $InstalledDir
    $cleared = Remove-DirectoryWithRetry -Path $InstalledDir -Attempts 10
  }
  if (-not $cleared) {
    Fail-Script "Failed to remove $InstalledDir because another process (for example an open Explorer or terminal in that folder) still holds a lock on it."
  }
}

Write-Host "[3/3] Installing $PluginName from $ResolvedRepo..."
$installExit = Invoke-Agy @("plugin", "install", $ResolvedRepo)
if ($installExit -ne 0) {
  Fail-Script "agy plugin install exited with code $installExit." $installExit
}

$InstalledManifest = Join-Path $InstalledDir "plugin.json"
if (-not (Test-Path -LiteralPath $InstalledManifest -PathType Leaf)) {
  Fail-Script "Install finished, but $InstalledManifest was not found."
}

Write-Host ""
Write-Host "Reinstalled $PluginName cleanly:"
& agy plugin list | Select-String -Context 0, 2 "^\-\s+$PluginName\b"
if ($closedAntigravity) {
  Write-Host "Antigravity was closed to release the directory lock. Reopen Antigravity to load the updated plugin."
} else {
  Write-Host "Reload the sidecar pane (or reopen Antigravity) to load the updated plugin."
}
