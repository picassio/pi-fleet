# pi-fleet agent bootstrap (Windows). Idempotent.
#   irm https://raw.githubusercontent.com/picassio/pi-fleet/main/scripts/bootstrap-agent.ps1 | iex; Bootstrap-PiFleetAgent -Server <machine>
param(
	[Parameter(Mandatory=$true)][string]$Server,
	[int]$Port = 9788,
	[int]$MaxWorkers = 0,
	[switch]$ExecFull,
	[string[]]$ExecRoot = @(),
	[int]$MaxExecs = 0,
	[int]$ExecTimeout = 0,
	[switch]$Privileged
)
$ErrorActionPreference = "Stop"
foreach ($cmd in @("node", "pi", "tailscale")) {
	if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "missing prerequisite: $cmd" }
}
pi install git:github.com/picassio/pi-fleet
$pkg = Join-Path $env:USERPROFILE ".pi\agent\git\github.com\picassio\pi-fleet"
$entry = Join-Path $pkg "scripts\pi-fleet-agent.mjs"
if (-not (Test-Path $entry)) { throw "install did not produce $entry" }
$nodePath = (Get-Command node).Source
$action = "`"$nodePath`" `"$entry`" serve --server $Server --port $Port"
if ($MaxWorkers -gt 0) { $action += " --max-workers $MaxWorkers" }
if ($ExecFull) {
	$action += " --exec-policy full"
	foreach ($root in $ExecRoot) { $action += " --exec-root `"$root`"" }
}
if ($MaxExecs -gt 0) { $action += " --max-execs $MaxExecs" }
if ($ExecTimeout -gt 0) { $action += " --exec-timeout $ExecTimeout" }
$runLevel = if ($Privileged) { "highest" } else { "limited" }
schtasks /create /f /tn "pi-fleet-agent" /sc onlogon /rl $runLevel /tr $action | Out-Null
schtasks /run /tn "pi-fleet-agent" | Out-Null
Start-Sleep -Seconds 2
Write-Host "pi-fleet agent scheduled + started (pinned to $Server, port $Port)"
