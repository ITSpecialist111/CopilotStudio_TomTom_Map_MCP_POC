<#
.SYNOPSIS
    Redeploys the map-proxy Container App with the Cowork MCP gateway and wires its settings.

.DESCRIPTION
    The map proxy (ca-tomtom-map-proxy) is an Azure Container App built from
    map-proxy-api/Dockerfile and pushed to ACR (acrtomtommcp). This script:
      1. Builds the updated image in ACR (no local Docker needed) via `az acr build`.
      2. Points the Container App at the new image.
      3. Sets the gateway environment variables (TomTom key stored as a Container App secret).
      4. Verifies /health and the GET /api/mcp probe.

    After this runs, the Cowork connector URL
    https://<proxy-fqdn>/api/mcp is live.

.PARAMETER TomTomApiKey
    TomTom API key (stored as a Container App secret, injected server-side). Optional on
    redeploys: if omitted, the existing Container App secret is reused (code-only updates
    do not need the key re-supplied).

.PARAMETER MapClientKey
    Optional client-side maps key appended to interactive map deep links. If omitted, links
    open without a key (the Static Web App must supply its own). Use a referrer-restricted key.

.EXAMPLE
    .\Deploy-CoworkGateway.ps1 -TomTomApiKey "YOUR_KEY"
#>
[CmdletBinding()]
param(
    [string]$ResourceGroupName = "rg-tomtom-mcp",
    [string]$AcrName = "acrtomtommcp",
    [string]$ContainerAppName = "ca-tomtom-map-proxy",
    [string]$ImageRepo = "tomtom-map-proxy",
    [string]$ImageTag = "cowork-gateway",
    [string]$SourceDir = (Join-Path (Split-Path $PSScriptRoot -Parent) "map-proxy-api"),

    # Optional on redeploys: if omitted, the existing Container App secret is reused.
    [string]$TomTomApiKey,

    [string]$McpServerUrl = "https://ca-tomtom-mcp.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io",
    [string]$InteractiveMapUrl = "https://thankful-sky-03359db03.2.azurestaticapps.net",
    [string]$MapClientKey,

    # TomTom Maps backend selected via the `tomtom-maps-backend` header on upstream
    # calls. Default is TomTom Orbis Maps; pass "tomtom-maps" for the legacy backend.
    [string]$MapsBackend = "tomtom-orbis-maps",

    # Advertise the MCP Apps (SEP-1865) interactive widget on render_live_map.
    # Default OFF: Cowork's widget-renderer host times out in the current preview
    # build, so we ship the reliable clickable inline image instead. Turn this on
    # to demo / re-test the native widget.
    [switch]$EnableCoworkWidget
)

$ErrorActionPreference = "Stop"
# Use a unique image tag per deploy. Azure Container Apps will NOT create a new
# revision (nor re-pull) if the image reference string is unchanged — reusing a
# mutable tag like ":cowork-gateway" silently keeps the old image running. A
# unique tag guarantees the new build is actually rolled out.
$ImageTag = "$ImageTag-$(Get-Date -Format 'yyyyMMddHHmmss')"
$image = "$AcrName.azurecr.io/$ImageRepo`:$ImageTag"

Write-Host "=== Deploy Cowork MCP Gateway (map proxy Container App) ===" -ForegroundColor Cyan
Write-Host "  Source:        $SourceDir"
Write-Host "  Image:         $image"
Write-Host "  Container App: $ContainerAppName ($ResourceGroupName)"
Write-Host ""

# 1. Build the image in ACR (uses map-proxy-api/Dockerfile).
Write-Host "[1/5] Building image in ACR (az acr build)..." -ForegroundColor Yellow
az acr build --registry $AcrName --image "$ImageRepo`:$ImageTag" $SourceDir -o table

# 2. Point the Container App at the new image.
Write-Host "[2/5] Updating Container App image..." -ForegroundColor Yellow
az containerapp update --name $ContainerAppName --resource-group $ResourceGroupName --image $image -o none

# Pin to a single replica so the in-memory per-session map store (used to bake
# the live-map widget at resources/read time) is consistent across requests.
az containerapp update --name $ContainerAppName --resource-group $ResourceGroupName `
    --min-replicas 1 --max-replicas 1 -o none

# 3. Resolve the proxy's own public FQDN (for PUBLIC_BASE_URL).
$fqdn = az containerapp show --name $ContainerAppName --resource-group $ResourceGroupName `
    --query "properties.configuration.ingress.fqdn" -o tsv
$publicBase = "https://$fqdn"

# 4. Store the TomTom key as a secret and set environment variables.
if ($TomTomApiKey) {
    Write-Host "[3/5] Setting TomTom key as a Container App secret..." -ForegroundColor Yellow
    az containerapp secret set --name $ContainerAppName --resource-group $ResourceGroupName `
        --secrets "tomtom-api-key=$TomTomApiKey" -o none
} else {
    Write-Host "[3/5] No -TomTomApiKey supplied; reusing existing Container App secret." -ForegroundColor DarkGray
}

Write-Host "[4/5] Setting environment variables..." -ForegroundColor Yellow
$envVars = @(
    "TOMTOM_API_KEY=secretref:tomtom-api-key",
    "MCP_SERVER_URL=$McpServerUrl",
    "MCP_MAPS_BACKEND=$MapsBackend",
    "ENABLE_COWORK_WIDGET=$($EnableCoworkWidget.IsPresent.ToString().ToLower())",
    "INTERACTIVE_MAP_URL=$InteractiveMapUrl",
    "PUBLIC_BASE_URL=$publicBase"
)
if ($MapClientKey) {
    az containerapp secret set --name $ContainerAppName --resource-group $ResourceGroupName `
        --secrets "map-client-key=$MapClientKey" -o none
    $envVars += "MAP_CLIENT_KEY=secretref:map-client-key"
}
az containerapp update --name $ContainerAppName --resource-group $ResourceGroupName `
    --set-env-vars $envVars -o none

# 5. Verify.
Write-Host "[5/5] Verifying gateway..." -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
    try {
        $health = Invoke-RestMethod -Uri "$publicBase/health" -Method GET -TimeoutSec 10
        if ($health.status -eq "ok") { $ok = $true; break }
    } catch { Start-Sleep -Seconds 5 }
}
if (-not $ok) { throw "Health check did not pass at $publicBase/health" }

$probe = Invoke-RestMethod -Uri "$publicBase/api/mcp" -Method GET -TimeoutSec 15

Write-Host ""
Write-Host "=== Gateway deployed ===" -ForegroundColor Green
Write-Host "  Health:            ok"
Write-Host "  Gateway probe:     service=$($probe.service), mcpConfigured=$($probe.mcpServerConfigured), apiKey=$($probe.apiKeyConfigured)"
Write-Host ""
Write-Host "  Cowork connector mcpServerUrl:" -ForegroundColor Cyan
Write-Host "    $publicBase/api/mcp" -ForegroundColor White
Write-Host ""
Write-Host "  Next: package the plugin pointing at this URL:" -ForegroundColor Yellow
Write-Host "    ./cowork-plugin/Build-CoworkPlugin.ps1 -GatewayUrl `"$publicBase/api/mcp`"" -ForegroundColor DarkGray
