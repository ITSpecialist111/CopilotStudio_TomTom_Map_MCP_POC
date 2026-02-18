<#
.SYNOPSIS
    Deploy TomTom MCP Server to Azure Container Apps.

.DESCRIPTION
    Creates all Azure resources and deploys the TomTom MCP server container.

.PARAMETER TomTomApiKey
    Your TomTom API key.

.PARAMETER SubscriptionId
    Azure subscription ID.

.PARAMETER TenantId
    Azure tenant ID.

.PARAMETER Location
    Azure region. Default: uksouth

.PARAMETER ResourceGroupName
    Resource group name. Default: rg-tomtom-mcp
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TomTomApiKey,

    [Parameter(Mandatory = $true)]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $true)]
    [string]$TenantId,
    [string]$Location = "uksouth",
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [string]$EnvironmentName = "cae-tomtom-mcp",
    [string]$AppName = "ca-tomtom-mcp"
)

$ErrorActionPreference = "Stop"

Write-Host "=== TomTom MCP Server - Azure Deployment ===" -ForegroundColor Cyan
Write-Host ""

# 1. Login check
Write-Host "[1/6] Checking Azure login..." -ForegroundColor Yellow
$account = az account show -o json 2>$null | ConvertFrom-Json
if (-not $account -or $account.tenantId -ne $TenantId) {
    Write-Host "  Logging in to tenant $TenantId..." -ForegroundColor DarkGray
    az login --tenant $TenantId
}
az account set --subscription $SubscriptionId
Write-Host "  Subscription: $($account.name) ($SubscriptionId)" -ForegroundColor Green

# 2. Register providers
Write-Host "[2/6] Registering resource providers..." -ForegroundColor Yellow
az provider register --namespace Microsoft.App --wait | Out-Null
az provider register --namespace Microsoft.OperationalInsights --wait | Out-Null
Write-Host "  Providers registered" -ForegroundColor Green

# 3. Create Resource Group
Write-Host "[3/6] Creating resource group..." -ForegroundColor Yellow
az group create --name $ResourceGroupName --location $Location -o none
Write-Host "  Resource group: $ResourceGroupName ($Location)" -ForegroundColor Green

# 4. Create Container Apps Environment
Write-Host "[4/6] Creating Container Apps environment..." -ForegroundColor Yellow
$envExists = az containerapp env show --name $EnvironmentName --resource-group $ResourceGroupName -o json 2>$null
if (-not $envExists) {
    az containerapp env create --name $EnvironmentName --resource-group $ResourceGroupName --location $Location -o none
}
Write-Host "  Environment: $EnvironmentName" -ForegroundColor Green

# 5. Deploy Container App
Write-Host "[5/6] Deploying container app..." -ForegroundColor Yellow
$appExists = az containerapp show --name $AppName --resource-group $ResourceGroupName -o json 2>$null
if ($appExists) {
    Write-Host "  Updating existing app..." -ForegroundColor DarkGray
    az containerapp update --name $AppName --resource-group $ResourceGroupName `
        --set-env-vars "TOMTOM_API_KEY=$TomTomApiKey" "PORT=3000" "MAPS=tomtom-maps" `
        "ENABLE_DYNAMIC_MAPS=true" "NODE_ENV=production" "LOG_LEVEL=info" -o none
}
else {
    az containerapp create --name $AppName --resource-group $ResourceGroupName `
        --environment $EnvironmentName `
        --image ghcr.io/tomtom-international/tomtom-mcp:latest `
        --target-port 3000 --ingress external `
        --min-replicas 1 --max-replicas 3 `
        --cpu 1.0 --memory 2.0Gi `
        --env-vars "TOMTOM_API_KEY=$TomTomApiKey" "PORT=3000" "MAPS=tomtom-maps" `
        "ENABLE_DYNAMIC_MAPS=true" "NODE_ENV=production" "LOG_LEVEL=info" -o none
}

$fqdn = az containerapp show --name $AppName --resource-group $ResourceGroupName `
    --query "properties.configuration.ingress.fqdn" -o tsv
Write-Host "  Container app deployed: https://$fqdn" -ForegroundColor Green

# 6. Verify deployment
Write-Host "[6/6] Verifying deployment..." -ForegroundColor Yellow
Start-Sleep -Seconds 10
try {
    $health = Invoke-RestMethod -Uri "https://$fqdn/health" -Method GET -TimeoutSec 30
    if ($health.status -eq "ok") {
        Write-Host "  Health check passed: status=$($health.status), version=$($health.version)" -ForegroundColor Green
    }
    else {
        Write-Host "  Health check warning: unexpected status - $($health.status)" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  Health check failed (may still be starting): $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "  Try again in a few minutes: Invoke-RestMethod -Uri 'https://$fqdn/health'" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host "  URL: https://$fqdn" -ForegroundColor White
Write-Host "  MCP: https://$fqdn/mcp" -ForegroundColor White
Write-Host "  Health: https://$fqdn/health" -ForegroundColor White
Write-Host ""
