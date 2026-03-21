<#
.SYNOPSIS
    Deploy the TomTom Interactive Map web app as an Azure Static Web App.

.DESCRIPTION
    Creates an Azure Static Web App resource for hosting the interactive map
    front-end. After creation, provides instructions for deploying the app
    content via GitHub Actions or manual upload.

.PARAMETER ResourceGroupName
    Resource group name. Default: rg-tomtom-mcp

.PARAMETER Location
    Azure region for the Static Web App. Default: uksouth

.PARAMETER StaticWebAppName
    Name for the Static Web App resource. Default: swa-tomtom-map

.EXAMPLE
    .\Deploy-InteractiveMap.ps1 -ResourceGroupName "rg-tomtom-mcp" -Location "uksouth"
    .\Deploy-InteractiveMap.ps1 -StaticWebAppName "swa-my-map"
#>

[CmdletBinding()]
param(
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [string]$Location = "uksouth",
    [string]$StaticWebAppName = "swa-tomtom-map"
)

$ErrorActionPreference = "Stop"

Write-Host "=== TomTom Interactive Map - Azure Static Web App Deployment ===" -ForegroundColor Cyan
Write-Host ""

# 1. Verify resource group exists
Write-Host "[1/4] Verifying resource group..." -ForegroundColor Yellow
$rgExists = az group show --name $ResourceGroupName -o json 2>$null
if (-not $rgExists) {
    Write-Host "  Creating resource group: $ResourceGroupName ($Location)..." -ForegroundColor DarkGray
    az group create --name $ResourceGroupName --location $Location -o none
}
Write-Host "  Resource group: $ResourceGroupName" -ForegroundColor Green

# 2. Register provider
Write-Host "[2/4] Registering Static Web App provider..." -ForegroundColor Yellow
az provider register --namespace Microsoft.Web --wait | Out-Null
Write-Host "  Provider registered" -ForegroundColor Green

# 3. Create the Static Web App
Write-Host "[3/4] Creating Azure Static Web App..." -ForegroundColor Yellow
$swaExists = az staticwebapp show --name $StaticWebAppName --resource-group $ResourceGroupName -o json 2>$null
if ($swaExists) {
    Write-Host "  Static Web App '$StaticWebAppName' already exists, skipping creation." -ForegroundColor DarkGray
}
else {
    az staticwebapp create `
        --name $StaticWebAppName `
        --resource-group $ResourceGroupName `
        --location $Location `
        --sku Free `
        -o none
    Write-Host "  Static Web App created: $StaticWebAppName" -ForegroundColor Green
}

# 4. Get deployment details
Write-Host "[4/4] Retrieving deployment details..." -ForegroundColor Yellow
$swaJson = az staticwebapp show --name $StaticWebAppName --resource-group $ResourceGroupName -o json | ConvertFrom-Json
$defaultHostname = $swaJson.defaultHostname
$deploymentToken = az staticwebapp secrets list --name $StaticWebAppName --resource-group $ResourceGroupName `
    --query "properties.apiKey" -o tsv

Write-Host "  Default URL: https://$defaultHostname" -ForegroundColor Green

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Static Web App URL: https://$defaultHostname" -ForegroundColor White
Write-Host ""
Write-Host "=== Next Steps: Deploy Your App Content ===" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Option 1: GitHub Actions (recommended)" -ForegroundColor White
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray
Write-Host "  1. Add the deployment token as a GitHub secret:" -ForegroundColor DarkGray
Write-Host "     Secret name: AZURE_STATIC_WEB_APPS_API_TOKEN" -ForegroundColor DarkGray
Write-Host "     Secret value: $deploymentToken" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  2. Add a GitHub Actions workflow (.github/workflows/deploy-map.yml):" -ForegroundColor DarkGray
Write-Host "     - Uses: Azure/static-web-apps-deploy@v1" -ForegroundColor DarkGray
Write-Host "     - app_location: '/interactive-map'" -ForegroundColor DarkGray
Write-Host "     - output_location: 'dist'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Option 2: Manual Upload via SWA CLI" -ForegroundColor White
Write-Host "  ------------------------------------" -ForegroundColor DarkGray
Write-Host "  1. Install the SWA CLI:" -ForegroundColor DarkGray
Write-Host "     npm install -g @azure/static-web-apps-cli" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  2. Build and deploy:" -ForegroundColor DarkGray
Write-Host "     cd interactive-map && npm run build" -ForegroundColor DarkGray
Write-Host "     swa deploy ./dist --deployment-token $deploymentToken" -ForegroundColor DarkGray
Write-Host ""
