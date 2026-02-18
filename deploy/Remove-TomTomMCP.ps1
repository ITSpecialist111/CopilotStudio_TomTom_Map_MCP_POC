<#
.SYNOPSIS
    Remove all TomTom MCP Azure resources.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $Force) {
    $confirm = Read-Host "This will DELETE resource group '$ResourceGroupName' and ALL resources. Type 'yes' to confirm"
    if ($confirm -ne "yes") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        return
    }
}

Write-Host "Deleting resource group: $ResourceGroupName..." -ForegroundColor Red
az group delete --name $ResourceGroupName --yes --no-wait
Write-Host "Deletion initiated (runs in background). Resources will be removed within a few minutes." -ForegroundColor Yellow
