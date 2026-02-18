<#
.SYNOPSIS
    Update the TomTom MCP container to the latest image.
#>

[CmdletBinding()]
param(
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [string]$AppName = "ca-tomtom-mcp",
    [string]$Image = "ghcr.io/tomtom-international/tomtom-mcp:latest"
)

$ErrorActionPreference = "Stop"

Write-Host "Updating container image to: $Image" -ForegroundColor Cyan
az containerapp update --name $AppName --resource-group $ResourceGroupName --image $Image -o table

$fqdn = az containerapp show --name $AppName --resource-group $ResourceGroupName `
    --query "properties.configuration.ingress.fqdn" -o tsv

Write-Host ""
Write-Host "Update complete. Verifying..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

$health = Invoke-RestMethod -Uri "https://$fqdn/health" -Method GET -TimeoutSec 30
Write-Host "Health: status=$($health.status), version=$($health.version)" -ForegroundColor Green
