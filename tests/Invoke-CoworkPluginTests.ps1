<#
.SYNOPSIS
    Tests the TomTom Cowork plugin: static package validation + (optional) live gateway smoke tests.

.DESCRIPTION
    STATIC (always): runs the package validator/builder (manifest + skills + connector rules,
    then produces the .zip).

    LIVE (when -GatewayUrl is supplied): exercises the deployed MCP gateway over JSON-RPC:
      initialize, tools/list (render_live_map present, tomtom-get-api-key filtered),
      tomtom-geocode, render_live_map, and an actual map-image fetch.

.PARAMETER GatewayUrl
    The deployed gateway endpoint, e.g.
    https://ca-tomtom-map-proxy.<region>.azurecontainerapps.io/api/mcp
    Omit to run static checks only.

.EXAMPLE
    ./Invoke-CoworkPluginTests.ps1

.EXAMPLE
    ./Invoke-CoworkPluginTests.ps1 -GatewayUrl "https://ca-tomtom-map-proxy.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io/api/mcp"
#>
[CmdletBinding()]
param(
    [string]$GatewayUrl,
    [string]$PluginDir = (Join-Path (Split-Path $PSScriptRoot -Parent) "cowork-plugin")
)

$ErrorActionPreference = "Stop"
$pass = 0; $fail = 0
function Check($name, [bool]$cond, $detail) {
    if ($cond) { Write-Host "  [PASS] $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "  [FAIL] $name — $detail" -ForegroundColor Red; $script:fail++ }
}

Write-Host "=== Cowork plugin tests ===" -ForegroundColor Cyan

# --- STATIC ---------------------------------------------------------------
Write-Host "`n[Static] Validate & package..." -ForegroundColor Yellow
$build = Join-Path $PluginDir "Build-CoworkPlugin.ps1"
Check "Build-CoworkPlugin.ps1 exists" (Test-Path $build) $build
& pwsh -NoProfile -File $build | Write-Host
Check "package zip produced" (Test-Path (Join-Path $PluginDir "dist\tomtom-cowork-plugin-1.0.0.zip")) "zip not found"

# --- LIVE -----------------------------------------------------------------
if (-not $GatewayUrl) {
    Write-Host "`n[Live] Skipped (no -GatewayUrl provided)." -ForegroundColor DarkGray
} else {
    Write-Host "`n[Live] Gateway smoke tests against $GatewayUrl" -ForegroundColor Yellow
    function Rpc($obj) { Invoke-RestMethod -Uri $GatewayUrl -Method Post -ContentType "application/json" -Body ($obj | ConvertTo-Json -Depth 12) -TimeoutSec 60 }

    $init = Rpc @{ jsonrpc="2.0"; id=1; method="initialize"; params=@{ protocolVersion="2025-06-18"; capabilities=@{}; clientInfo=@{ name="tests"; version="1.0" } } }
    Check "initialize returns serverInfo" ($null -ne $init.result.serverInfo) "no serverInfo"

    $tl = Rpc @{ jsonrpc="2.0"; id=2; method="tools/list"; params=@{} }
    $names = @($tl.result.tools.name)
    Check "tools/list returns tools" ($names.Count -gt 0) "no tools"
    Check "render_live_map present" ($names -contains 'render_live_map') "missing render_live_map"
    Check "tomtom-get-api-key filtered out" (-not ($names -contains 'tomtom-get-api-key')) "key tool leaked"
    $rlm = $tl.result.tools | Where-Object { $_.name -eq 'render_live_map' }
    Check "render_live_map is read-only" ($rlm.annotations.readOnlyHint -eq $true) "not read-only"

    $g = Rpc @{ jsonrpc="2.0"; id=3; method="tools/call"; params=@{ name="tomtom-geocode"; arguments=@{ query="Cardiff Castle, Cardiff, Wales, UK" } } }
    $gt = ($g.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
    Check "geocode returns content" ($gt.Length -gt 0) "empty geocode"

    $r = Rpc @{ jsonrpc="2.0"; id=4; method="tools/call"; params=@{ name="render_live_map"; arguments=@{ title="Cardiff Castle"; markers=@(@{ lat=51.4816; lon=-3.1791; label="Cardiff Castle" }); zoom=14; traffic=$true } } }
    $img = $r.result.structuredContent.imageUrl
    Check "render_live_map returns imageUrl" ($img -match '^https?://') "no imageUrl"

    if ($img) {
        try {
            $resp = Invoke-WebRequest -Uri $img -Method Get -TimeoutSec 60
            $ct = [string]$resp.Headers['Content-Type']
            Check "map image fetch is 200 image/*" ($resp.StatusCode -eq 200 -and $ct -like 'image/*') "status=$($resp.StatusCode) ct=$ct"
        } catch {
            Check "map image fetch is 200 image/*" $false $_.Exception.Message
        }
    }
}

Write-Host "`n=== Results: $pass passed, $fail failed ===" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
