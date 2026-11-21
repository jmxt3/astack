<#
.SYNOPSIS
Uninstalls and reinstalls the local AStack plugin into Antigravity.

.DESCRIPTION
Stops any running AStack sidecar Node processes, removes leftover files under
the installed plugin directory, and reinstalls from the local repository.
Pass -CloseAntigravity to close running Antigravity processes if they still
hold a lock on the plugin directory.
#>
[CmdletBinding()]
param(
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$PluginName = "astack",
  [string]$PluginsDir = (Join-Path $HOME ".gemini\config\plugins"),
  [switch]$CloseAntigravity
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

function Stop-SidecarProcesses {
  param([string]$PluginDir)
  $escapedDir = [regex]::Escape($PluginDir)
  $procs = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match $escapedDir -or $_.CommandLine -match 'astack_timeline') }
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
  if ($remaining.Count -gt 0) {
    Start-Sleep -Seconds 1
  }
  return $true
}

function Remove-DirectoryWithRetry {
  param([string]$Path, [int]$Attempts = 4)
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

Write-Host "[1/3] Stopping sidecar processes and uninstalling $PluginName..."
Stop-SidecarProcesses -PluginDir $InstalledDir
$null = Invoke-Agy @("plugin", "uninstall", $PluginName)

Write-Host "[2/3] Cleaning leftover directory $InstalledDir..."
if (Test-Path -LiteralPath $InstalledDir) {
  Stop-SidecarProcesses -PluginDir $InstalledDir
  $cleared = Remove-DirectoryWithRetry -Path $InstalledDir
  if (-not $cleared -and $CloseAntigravity) {
    Write-Host "Directory is locked by Antigravity. Closing Antigravity..."
    if (Stop-AntigravityProcesses) {
      $cleared = Remove-DirectoryWithRetry -Path $InstalledDir -Attempts 6
    }
  }
  if (-not $cleared) {
    Fail-Script (
      "Failed to remove $InstalledDir because another process holds a lock on it.`n" +
      "Close Antigravity and re-run .\scripts\reinstall-plugin.ps1, or pass -CloseAntigravity from an external terminal."
    )
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
Write-Host "Reopen Antigravity (or reload the sidecar pane) to load the updated plugin."
