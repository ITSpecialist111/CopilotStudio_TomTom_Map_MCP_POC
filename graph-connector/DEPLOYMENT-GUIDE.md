# TomTom Graph Connector - Deployment & Troubleshooting Guide

## Overview

This document captures the full deployment process for the TomTom Graph Connector on your target tenant, including all issues encountered and their resolutions. Use this as the definitive reference for future deployments.

## What This Does

The Graph Connector is a .NET 9 console app that:
1. Creates an **External Connection** in Microsoft Graph
2. Registers a **search schema** with 16 queryable/searchable properties
3. **Crawls TomTom data** via the deployed MCP server (geocoding offices, finding nearby POIs, searching landmarks)
4. **Pushes items** into Microsoft Search so M365 Copilot can answer location questions natively

## Deployment Summary

| Item | Value |
|------|-------|
| **Tenant** | `<YOUR_TENANT_ID>` |
| **Admin Account** | `admin@yourtenant.onmicrosoft.com` |
| **App Registration** | `TomTom Graph Connector` (`<YOUR_APP_CLIENT_ID>`) |
| **Service Principal** | `<YOUR_SERVICE_PRINCIPAL_ID>` |
| **Graph SP (Microsoft Graph)** | `<YOUR_GRAPH_SP_ID>` |
| **External Connection ID** | `TomTomLocations` |
| **Items Indexed** | 55 (3 offices, 45 POIs, 7 landmarks) |
| **MCP Server** | `https://<YOUR_CONTAINER_APP>.azurecontainerapps.io` |

---

## Step-by-Step Deployment Process

### Prerequisites

- Azure CLI installed (`az --version`)
- .NET 9 SDK installed (`dotnet --version`)
- Global admin access to the target tenant
- TomTom MCP server running and accessible

### Step 1: Login to Target Tenant

```powershell
# Refresh PATH if az was just installed
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

# Login to the tenant (use --allow-no-subscriptions for tenants without Azure subscriptions)
az login --tenant <YOUR_TENANT_ID> --allow-no-subscriptions

# Verify login
az account show --query "{tenant:tenantId, user:user.name}" -o table
```

**Note:** The `--allow-no-subscriptions` flag is critical for tenants that don't have Azure subscriptions (like pure M365 tenants). Without it, the login will fail.

### Step 2: Create App Registration

```powershell
az ad app create --display-name "TomTom Graph Connector" --sign-in-audience "AzureADMyOrg" --query "{appId:appId, id:id}" -o table
```

Save the `appId` — you'll need it for all subsequent steps.

### Step 3: Add API Permissions

```powershell
$appId = "YOUR_APP_ID"

# ExternalConnection.ReadWrite.OwnedBy (Application permission)
az ad app permission add --id $appId `
    --api 00000003-0000-0000-c000-000000000000 `
    --api-permissions "f431331c-49a6-499f-be1c-62af19c34a9d=Role"

# ExternalItem.ReadWrite.OwnedBy (Application permission)
az ad app permission add --id $appId `
    --api 00000003-0000-0000-c000-000000000000 `
    --api-permissions "8116ae0f-55c2-452d-9944-d18420f5b2c8=Role"
```

> **IMPORTANT:** The `ExternalItem.ReadWrite.OwnedBy` GUID is `8116ae0f-55c2-452d-9944-d18420f5b2c8`. Some documentation lists `8116ae0f-55c2-452d-9571-d9b8f291f8e5` which is WRONG and will fail. See Troubleshooting section below.

### Step 4: Create Service Principal

```powershell
az ad sp create --id $appId -o table --query "{appId:appId, displayName:displayName}"
```

### Step 5: Grant Admin Consent

The `az ad app permission admin-consent` command **does not work** for application permissions (Role type). Use the `appRoleAssignments` API instead:

```powershell
# Get the service principal object IDs
$spId = az ad sp show --id $appId --query "id" -o tsv
$graphSpId = az ad sp show --id "00000003-0000-0000-c000-000000000000" --query "id" -o tsv

# Grant ExternalConnection.ReadWrite.OwnedBy
$body1 = "{`"principalId`":`"$spId`",`"resourceId`":`"$graphSpId`",`"appRoleId`":`"f431331c-49a6-499f-be1c-62af19c34a9d`"}"
$body1 | Out-File -Encoding utf8 body1.json
az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignments" --body "@body1.json" -o json

# Grant ExternalItem.ReadWrite.OwnedBy
$body2 = "{`"principalId`":`"$spId`",`"resourceId`":`"$graphSpId`",`"appRoleId`":`"8116ae0f-55c2-452d-9944-d18420f5b2c8`"}"
$body2 | Out-File -Encoding utf8 body2.json
az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignments" --body "@body2.json" -o json

# Clean up temp files
Remove-Item body1.json, body2.json -ErrorAction SilentlyContinue
```

### Step 6: Create Client Secret

```powershell
az ad app credential reset --id $appId --append --display-name "GraphConnector" --years 1 -o json
```

Save the `password` value — this is your `clientSecret`.

### Step 7: Update Configuration

Edit `graph-connector/appsettings.json`:

```json
{
  "tenantId": "YOUR_TENANT_ID",
  "clientId": "YOUR_APP_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "tomTomApiKey": "YOUR_TOMTOM_API_KEY",
  ...
}
```

### Step 8: Build and Run

```powershell
cd graph-connector
dotnet build
dotnet run
```

Expected output:
- Connection created (or "already exists" on re-run)
- Schema registered (or "already exists" on re-run)
- Offices geocoded, POIs found near each
- Landmarks searched
- Items pushed to Microsoft Search

### Step 9: Verify in Admin Centre

1. Go to https://admin.microsoft.com
2. Navigate to **Settings** > **Search & intelligence** > **Data sources**
3. You should see the **TomTomLocations** connection with 55 items

---

## Troubleshooting

### Issue 1: `az ad app permission admin-consent` Fails with "Consent validation failed"

**Error:**
```
ERROR: Bad Request - Consent validation failed
```

**Cause:** The `admin-consent` CLI command doesn't work properly for application-level permissions (`=Role`). It's designed for delegated permissions.

**Solution:** Use the `appRoleAssignments` REST API directly (see Step 5 above). This assigns the app roles and grants admin consent in one operation.

### Issue 2: Wrong Permission GUID for ExternalItem.ReadWrite.OwnedBy

**Error:**
```
Permission being assigned was not found on application
```

**Cause:** The GUID `8116ae0f-55c2-452d-9571-d9b8f291f8e5` is commonly found online but is incorrect. The actual GUID varies by tenant's Graph service principal.

**Solution:** Look up the correct GUIDs from your tenant's Graph service principal:

```powershell
$graphSpId = az ad sp show --id "00000003-0000-0000-c000-000000000000" --query "id" -o tsv
az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId/appRoles" `
    --query "value[?contains(value, 'External')].[value,id]" -o table
```

This lists the actual permission GUIDs for your tenant. Use those.

### Issue 3: `az rest` Fails with "Write requests must contain Content-Type header"

**Error:**
```
Write requests (excluding DELETE) must contain the Content-Type header declaration
```

**Cause:** PowerShell's JSON escaping with `az rest --body` inline doesn't always work correctly.

**Solution:** Write the JSON body to a file first, then reference it with `@filename.json`:

```powershell
$body | Out-File -Encoding utf8 body.json
az rest --method POST --url "..." --body "@body.json" -o json
```

### Issue 4: "Config file not found: appsettings.json"

**Error:**
```
System.IO.FileNotFoundException: Config file not found: appsettings.json
```

**Cause:** When running `dotnet run --project graph-connector` from the parent directory, the working directory is the parent, not the project directory.

**Solution:** Either:
- Run from the project directory: `cd graph-connector; dotnet run`
- Or add `<CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>` to the csproj for appsettings.json (already done)

### Issue 5: "The specified resource name already exists" When Registering Schema

**Error:**
```
Microsoft.Graph.Models.ODataErrors.ODataError: The specified resource name already exists
```

**Cause:** The schema was already registered in a previous run. The PATCH endpoint can't be called twice.

**Solution:** The code now checks for existing schema before attempting registration. If you need to change the schema, delete the connection first and recreate:

```powershell
cd graph-connector
dotnet run -- --delete
dotnet run
```

### Issue 6: All Items Fail with "The request is malformed or incorrect"

**Error:**
```
Failed to index [item]: The request is malformed or incorrect
```

**Cause:** Multiple issues found during our deployment:
1. **Item IDs** - TomTom returns IDs like `lIXM0fsMqmoaWKpV49fY8g` which, after sanitization, could be empty or invalid
2. **Empty string properties** - Graph API rejects items where a property is declared in the schema but the value is an empty string for certain types
3. **DateTime format** - Passing `DateTime.ToString("o")` as a string instead of the actual `DateTime` object

**Solution:**
- Generate deterministic, hash-based IDs: `SHA256(name + lat + lon + type)` truncated to 32 hex chars
- Only include properties that have non-empty values
- Pass `DateTime` objects directly, not string representations

### Issue 7: Azure CLI Not Found After Fresh Install

**Solution:** Refresh the PATH:
```powershell
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
```

---

## Re-running the Connector

The connector is idempotent. Running it again will:
- Skip connection creation (already exists)
- Skip schema registration (already exists)
- Re-crawl TomTom data (gets fresh results)
- Upsert items (PUT is idempotent — same ID overwrites)

```powershell
cd graph-connector
dotnet run
```

## Deleting Everything

```powershell
cd graph-connector
dotnet run -- --delete
```

This removes the external connection and all indexed items. The app registration remains (delete manually in Entra if needed).

## Adding More Data

Edit `appsettings.json` to add:
- More offices in the `offices` array
- More landmarks in the `landmarks` array
- More POI categories in `poiCategories` (see TomTom category IDs)
- Adjust `poiSearchRadius` and `poiLimitPerCategory`

Then re-run `dotnet run`.

## Search Propagation Time

After indexing, items typically appear in Microsoft Search within **15-30 minutes**. M365 Copilot may take slightly longer to incorporate the new data source. Check status at:

**Admin Centre** > **Settings** > **Search & intelligence** > **Data sources** > **TomTomLocations**
