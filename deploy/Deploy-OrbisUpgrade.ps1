<#
.SYNOPSIS
    Upgrade an existing TomTom MCP Container App to the Orbis Maps backend.

.DESCRIPTION
    Updates the Azure Container App environment variables and container image
    to switch from tomtom-maps to tomtom-orbis-maps. The Orbis backend provides
    5 additional tools (16 total vs 11) including EV routing, search along route,
    area search, EV charging search, and data visualization.

.PARAMETER ResourceGroupName
    Resource group containing the Container App. Default: rg-tomtom-mcp

.PARAMETER AppName
    Container App name. Default: ca-tomtom-mcp

.PARAMETER TomTomApiKey
    Optional. If provided, updates the TomTom API key in the container app.

.EXAMPLE
    .\Deploy-OrbisUpgrade.ps1
    .\Deploy-OrbisUpgrade.ps1 -TomTomApiKey "YOUR_NEW_KEY"
    .\Deploy-OrbisUpgrade.ps1 -ResourceGroupName "rg-custom" -AppName "ca-custom"
#>

[CmdletBinding()]
param(
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [string]$AppName = "ca-tomtom-mcp",
    [string]$TomTomApiKey
)

$ErrorActionPreference = "Stop"

Write-Host "=== TomTom MCP Server - Orbis Maps Upgrade ===" -ForegroundColor Cyan
Write-Host ""

# 1. Verify the container app exists
Write-Host "[1/5] Verifying existing container app..." -ForegroundColor Yellow
$appJson = az containerapp show --name $AppName --resource-group $ResourceGroupName -o json 2>$null
if (-not $appJson) {
    Write-Error "Container app '$AppName' not found in resource group '$ResourceGroupName'. Deploy first using Deploy-TomTomMCP.ps1."
    exit 1
}
$app = $appJson | ConvertFrom-Json
$fqdn = $app.properties.configuration.ingress.fqdn
Write-Host "  Found app: $AppName (https://$fqdn)" -ForegroundColor Green

# 2. Build environment variable arguments
Write-Host "[2/5] Preparing Orbis Maps environment variables..." -ForegroundColor Yellow
$envVars = @(
    "MAPS=tomtom-orbis-maps",
    "ENABLE_DYNAMIC_MAPS=true",
    "PORT=3000",
    "NODE_ENV=production",
    "LOG_LEVEL=info"
)

if ($TomTomApiKey) {
    $envVars += "TOMTOM_API_KEY=$TomTomApiKey"
    Write-Host "  API key will be updated" -ForegroundColor DarkGray
}

Write-Host "  MAPS=tomtom-orbis-maps" -ForegroundColor DarkGray
Write-Host "  ENABLE_DYNAMIC_MAPS=true" -ForegroundColor DarkGray

# 3. Update the container app with new env vars and latest image
Write-Host "[3/5] Updating container app to Orbis Maps backend..." -ForegroundColor Yellow
$envVarArgs = $envVars -join " "
az containerapp update --name $AppName --resource-group $ResourceGroupName `
    --image ghcr.io/tomtom-international/tomtom-mcp:latest `
    --set-env-vars @envVars `
    -o none
Write-Host "  Container app updated with Orbis Maps configuration" -ForegroundColor Green

# 4. Wait and run health check
Write-Host "[4/5] Running health check (waiting 15 seconds for restart)..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

$fqdn = az containerapp show --name $AppName --resource-group $ResourceGroupName `
    --query "properties.configuration.ingress.fqdn" -o tsv

$healthPassed = $false
$retries = 3
for ($i = 1; $i -le $retries; $i++) {
    try {
        $health = Invoke-RestMethod -Uri "https://$fqdn/health" -Method GET -TimeoutSec 30
        if ($health.status -eq "ok") {
            Write-Host "  Health check passed: status=$($health.status), version=$($health.version)" -ForegroundColor Green
            $healthPassed = $true
            break
        }
        else {
            Write-Host "  Health check attempt $i/$retries - unexpected status: $($health.status)" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Health check attempt $i/$retries failed: $($_.Exception.Message)" -ForegroundColor Yellow
        if ($i -lt $retries) {
            Start-Sleep -Seconds 10
        }
    }
}

if (-not $healthPassed) {
    Write-Host "  Health check did not pass after $retries attempts. The app may still be starting." -ForegroundColor Yellow
    Write-Host "  Try manually: Invoke-RestMethod -Uri 'https://$fqdn/health'" -ForegroundColor DarkGray
}

# 5. Verify tool count
Write-Host "[5/5] Verifying Orbis tools availability..." -ForegroundColor Yellow
try {
    $body = @{
        method  = "tools/list"
        params  = @{}
        jsonrpc = "2.0"
        id      = 1
    } | ConvertTo-Json -Depth 5

    $headers = @{
        "Accept"       = "application/json,text/event-stream"
        "Content-Type" = "application/json"
    }

    $response = Invoke-RestMethod -Uri "https://$fqdn/mcp" -Method POST -Body $body -Headers $headers -TimeoutSec 30
    $jsonMatch = [regex]::Match($response, 'data:\s*(\{.*\})')
    if ($jsonMatch.Success) {
        $parsed = $jsonMatch.Groups[1].Value | ConvertFrom-Json
        $tools = $parsed.result.tools
        $toolCount = $tools.Count
        $toolNames = ($tools | ForEach-Object { $_.name }) -join ", "

        if ($toolCount -ge 16) {
            Write-Host "  Tool count: $toolCount (expected 16)" -ForegroundColor Green
        }
        else {
            Write-Host "  Tool count: $toolCount (expected 16 - some Orbis tools may not be loaded)" -ForegroundColor Yellow
        }
        Write-Host "  Tools: $toolNames" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  Could not parse tool list response" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  Could not verify tool count: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Orbis Upgrade Complete ===" -ForegroundColor Cyan
Write-Host "  URL:     https://$fqdn" -ForegroundColor White
Write-Host "  MCP:     https://$fqdn/mcp" -ForegroundColor White
Write-Host "  Health:  https://$fqdn/health" -ForegroundColor White
Write-Host "  Backend: tomtom-orbis-maps (16 tools)" -ForegroundColor White
Write-Host ""
