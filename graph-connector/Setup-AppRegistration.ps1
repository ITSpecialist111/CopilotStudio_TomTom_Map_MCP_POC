<#
.SYNOPSIS
    Set up the Entra ID app registration required for the TomTom Graph Connector.

.DESCRIPTION
    Creates an app registration in the Contoso tenant with the required
    Microsoft Graph permissions for External Connections.

.PARAMETER TenantId
    The Contoso tenant ID.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId
)

$ErrorActionPreference = "Stop"

Write-Host "=== TomTom Graph Connector - App Registration Setup ===" -ForegroundColor Cyan
Write-Host ""

# 1. Login to Contoso tenant
Write-Host "[1/4] Logging in to target tenant..." -ForegroundColor Yellow
az login --tenant $TenantId --allow-no-subscriptions
Write-Host "  Logged in to tenant: $TenantId" -ForegroundColor Green

# 2. Create app registration
Write-Host "[2/4] Creating app registration..." -ForegroundColor Yellow
$appName = "TomTom Graph Connector"

$app = az ad app create `
    --display-name $appName `
    --sign-in-audience "AzureADMyOrg" `
    -o json | ConvertFrom-Json

$clientId = $app.appId
Write-Host "  App ID: $clientId" -ForegroundColor Green

# 3. Add required Graph permissions
Write-Host "[3/4] Adding Microsoft Graph permissions..." -ForegroundColor Yellow

# ExternalConnection.ReadWrite.OwnedBy (application)
az ad app permission add --id $clientId `
    --api 00000003-0000-0000-c000-000000000000 `
    --api-permissions "f431331c-49a6-499f-be1c-62af19c34a9d=Role" # ExternalConnection.ReadWrite.OwnedBy

# ExternalItem.ReadWrite.OwnedBy (application)
az ad app permission add --id $clientId `
    --api 00000003-0000-0000-c000-000000000000 `
    --api-permissions "8116ae0f-55c2-452d-9571-d9b8f291f8e5=Role" # ExternalItem.ReadWrite.OwnedBy

Write-Host "  Permissions added" -ForegroundColor Green

# 4. Create client secret
Write-Host "[4/4] Creating client secret..." -ForegroundColor Yellow
$secret = az ad app credential reset --id $clientId --append -o json | ConvertFrom-Json
$clientSecret = $secret.password

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "IMPORTANT: Grant admin consent in the Azure portal:" -ForegroundColor Red
Write-Host "  https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/$clientId" -ForegroundColor White
Write-Host ""
Write-Host "Update your appsettings.json with these values:" -ForegroundColor Yellow
Write-Host "  tenantId:     $TenantId" -ForegroundColor White
Write-Host "  clientId:     $clientId" -ForegroundColor White
Write-Host "  clientSecret: $clientSecret" -ForegroundColor White
Write-Host ""
Write-Host "Then run: dotnet run --project graph-connector" -ForegroundColor Yellow
