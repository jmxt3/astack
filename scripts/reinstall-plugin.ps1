<#
.SYNOPSIS
Uninstalls and reinstalls the local AStack plugin into Antigravity.

.DESCRIPTION
Removes leftover files under the installed plugin folder after uninstall so
Windows directory locks are caught with a clear close-Antigravity prompt
instead of leaving a half-removed install behind.
#>
[CmdletBinding()]
param(
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$PluginName = "astack",
  [string]$PluginsDir = (Join-Path $HOME ".gemini\config\plugins")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
  Write-Error "agy CLI not found on PATH."
  exit 1
}

if (-not (Test-Path -LiteralPath $RepoDir -PathType Container)) {
  Write-Error "Plugin repository directory not found: $RepoDir"
  exit 1
}

$ResolvedRepo = (Resolve-Path -LiteralPath $RepoDir).Path
$ManifestPath = Join-Path $ResolvedRepo "plugin.json"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  Write-Error "Missing plugin.json in $ResolvedRepo"
  exit 1
}

$InstalledDir = Join-Path $PluginsDir $PluginName

Write-Host "[1/3] Uninstalling $PluginName..."
$null = Invoke-Agy @("plugin", "uninstall", $PluginName)

Write-Host "[2/3] Cleaning leftover directory $InstalledDir..."
if (Test-Path -LiteralPath $InstalledDir) {
  try {
    Remove-Item -LiteralPath $InstalledDir -Recurse -Force -ErrorAction Stop
  } catch {
    Write-Error (
      "Failed to remove ${InstalledDir}: $($_.Exception.Message)`n" +
      "Close Antigravity so the running sidecar releases the directory handle, then re-run .\scripts\reinstall-plugin.ps1."
    )
    exit 1
  }
}

Write-Host "[3/3] Installing $PluginName from $ResolvedRepo..."
$installExit = Invoke-Agy @("plugin", "install", $ResolvedRepo)
if ($installExit -ne 0) {
  Write-Error "agy plugin install exited with code $installExit."
  exit $installExit
}

$InstalledManifest = Join-Path $InstalledDir "plugin.json"
if (-not (Test-Path -LiteralPath $InstalledManifest -PathType Leaf)) {
  Write-Error "Install finished, but $InstalledManifest was not found."
  exit 1
}

Write-Host ""
Write-Host "Reinstalled $PluginName cleanly:"
& agy plugin list | Select-String -Context 0, 2 "^\-\s+$PluginName\b"
Write-Host "Reopen Antigravity (or reload the sidecar pane) to load the updated plugin."
