<#
.SYNOPSIS
    Deploy the TomTom Map Proxy as an Azure Function App.

.DESCRIPTION
    Creates a Storage Account and Azure Function App (Node.js 20 runtime)
    to serve as a proxy for TomTom map tile requests. The proxy handles
    API key injection, CORS, and request routing between the MCP server
    and the interactive map front-end.

.PARAMETER ResourceGroupName
    Resource group name. Default: rg-tomtom-mcp

.PARAMETER Location
    Azure region. Default: uksouth

.PARAMETER FunctionAppName
    Name for the Function App. Default: func-tomtom-map-proxy

.PARAMETER TomTomApiKey
    Your TomTom API key (required).

.PARAMETER McpServerUrl
    URL of the deployed TomTom MCP server (required).

.PARAMETER InteractiveMapUrl
    URL of the interactive map Static Web App (required for CORS).

.EXAMPLE
    .\Deploy-MapProxy.ps1 -TomTomApiKey "YOUR_KEY" `
        -McpServerUrl "https://ca-tomtom-mcp.azurecontainerapps.io" `
        -InteractiveMapUrl "https://swa-tomtom-map.azurestaticapps.net"
#>

[CmdletBinding()]
param(
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [string]$Location = "uksouth",
    [string]$FunctionAppName = "func-tomtom-map-proxy",

    [Parameter(Mandatory = $true)]
    [string]$TomTomApiKey,

    [Parameter(Mandatory = $true)]
    [string]$McpServerUrl,

    [Parameter(Mandatory = $true)]
    [string]$InteractiveMapUrl
)

$ErrorActionPreference = "Stop"

# Derive a storage account name from the function app name (lowercase, alphanumeric, max 24 chars)
$storageAccountName = ($FunctionAppName -replace '[^a-z0-9]', '').ToLower()
if ($storageAccountName.Length -gt 24) {
    $storageAccountName = $storageAccountName.Substring(0, 24)
}
# Ensure minimum length of 3 characters
if ($storageAccountName.Length -lt 3) {
    $storageAccountName = "stgtomtommapproxy"
}

Write-Host "=== TomTom Map Proxy - Azure Function App Deployment ===" -ForegroundColor Cyan
Write-Host ""

# 1. Verify resource group exists
Write-Host "[1/5] Verifying resource group..." -ForegroundColor Yellow
$rgExists = az group show --name $ResourceGroupName -o json 2>$null
if (-not $rgExists) {
    Write-Host "  Creating resource group: $ResourceGroupName ($Location)..." -ForegroundColor DarkGray
    az group create --name $ResourceGroupName --location $Location -o none
}
Write-Host "  Resource group: $ResourceGroupName" -ForegroundColor Green

# 2. Create Storage Account
Write-Host "[2/5] Creating storage account: $storageAccountName..." -ForegroundColor Yellow
$storageExists = az storage account show --name $storageAccountName --resource-group $ResourceGroupName -o json 2>$null
if (-not $storageExists) {
    az storage account create `
        --name $storageAccountName `
        --resource-group $ResourceGroupName `
        --location $Location `
        --sku Standard_LRS `
        --kind StorageV2 `
        --min-tls-version TLS1_2 `
        -o none
    Write-Host "  Storage account created: $storageAccountName" -ForegroundColor Green
}
else {
    Write-Host "  Storage account already exists: $storageAccountName" -ForegroundColor DarkGray
}

# 3. Register Function App provider
Write-Host "[3/5] Registering resource providers..." -ForegroundColor Yellow
az provider register --namespace Microsoft.Web --wait | Out-Null
Write-Host "  Providers registered" -ForegroundColor Green

# 4. Create Function App
Write-Host "[4/5] Creating Function App: $FunctionAppName..." -ForegroundColor Yellow
$funcExists = az functionapp show --name $FunctionAppName --resource-group $ResourceGroupName -o json 2>$null
if (-not $funcExists) {
    az functionapp create `
        --name $FunctionAppName `
        --resource-group $ResourceGroupName `
        --storage-account $storageAccountName `
        --consumption-plan-location $Location `
        --runtime node `
        --runtime-version 20 `
        --functions-version 4 `
        --os-type Linux `
        -o none
    Write-Host "  Function App created: $FunctionAppName" -ForegroundColor Green
}
else {
    Write-Host "  Function App already exists: $FunctionAppName" -ForegroundColor DarkGray
}

# 5. Configure app settings
Write-Host "[5/5] Configuring app settings..." -ForegroundColor Yellow
az functionapp config appsettings set `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName `
    --settings `
        "TOMTOM_API_KEY=$TomTomApiKey" `
        "MCP_SERVER_URL=$McpServerUrl" `
        "INTERACTIVE_MAP_URL=$InteractiveMapUrl" `
        "CORS_ORIGINS=$InteractiveMapUrl" `
        "NODE_ENV=production" `
    -o none
Write-Host "  App settings configured" -ForegroundColor Green

# Configure CORS
Write-Host "  Setting CORS allowed origins..." -ForegroundColor DarkGray
az functionapp cors add `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName `
    --allowed-origins $InteractiveMapUrl `
    -o none 2>$null
Write-Host "  CORS configured for: $InteractiveMapUrl" -ForegroundColor Green

# Get the Function App URL
$funcHostname = az functionapp show --name $FunctionAppName --resource-group $ResourceGroupName `
    --query "defaultHostName" -o tsv

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Function App URL: https://$funcHostname" -ForegroundColor White
Write-Host "  Storage Account:  $storageAccountName" -ForegroundColor White
Write-Host ""
Write-Host "  Environment Variables:" -ForegroundColor Yellow
Write-Host "    TOMTOM_API_KEY:      (set)" -ForegroundColor DarkGray
Write-Host "    MCP_SERVER_URL:      $McpServerUrl" -ForegroundColor DarkGray
Write-Host "    INTERACTIVE_MAP_URL: $InteractiveMapUrl" -ForegroundColor DarkGray
Write-Host "    CORS_ORIGINS:        $InteractiveMapUrl" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Next: Deploy your function code using:" -ForegroundColor Yellow
Write-Host "    func azure functionapp publish $FunctionAppName" -ForegroundColor DarkGray
Write-Host ""
