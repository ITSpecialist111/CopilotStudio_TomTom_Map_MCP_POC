# TomTom MCP Server -- Interactive Maps for Microsoft 365 & Teams

> **Proof of Concept** -- Connecting a hosted [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server on Azure to Copilot Studio, Power Automate, and Microsoft 365 Copilot, featuring interactive map visualizations powered by TomTom Orbis Maps.

## What's New in v2.0

| Feature | Details |
|---------|---------|
| **TomTom Orbis Maps backend** | Upgraded from `tomtom-maps` to `tomtom-orbis-maps` -- richer tiles, vector rendering, and 5 additional geospatial tools |
| **16 MCP tools (was 11)** | New tools: EV routing, area search, search along route, EV charging search, data visualization |
| **Interactive map web app** | Azure Static Web App with full zoom, pan, click, markers, routes, and traffic overlays |
| **Adaptive Card integration** | Rich map cards rendered natively inside Microsoft Teams conversations |
| **Map proxy Azure Function** | Bridges the MCP server and Teams/Copilot Studio, generating Adaptive Cards and serving map images via URL |
| **Orbis test suite** | Dedicated 18-test suite covering all 16 Orbis tools plus security and performance checks |
| **EV charging Graph indexing** | Graph Connector can now index EV charging station data into Microsoft Search |

## What's New in v3.0 — Microsoft Copilot Cowork plugin

| Feature | Details |
|---------|---------|
| **Copilot Cowork custom plugin** | New `cowork-plugin/` package (M365 manifest v1.28) with 6 correlated Agent Skills + an MCP connector, deployable via **M365 Admin Center → Copilot → Agents → All agents → Add agent**. |
| **MCP gateway** | New `POST /api/mcp` route on the map-proxy (`map-proxy-api/src/lib/mcpGateway.ts`) bridges Cowork to the official TomTom MCP, injecting the `tomtom-api-key` server-side (Cowork connector auth = `None`). |
| **`render_live_map` tool** | Synthetic gateway tool returning an inline map image **and** a live interactive map link (pan/zoom/traffic) so maps render directly in Cowork. |
| **Correlated skills** | Location search, route planning, live traffic, EV journey, live map, and (optional) MOVE traffic analytics — each hands off to `tomtom-live-map`. |
| **Key-leak hardening** | The gateway filters the upstream `tomtom-get-api-key` tool out of discovery and blocks calls to it. |
| **Live maps render in Cowork (MCP Apps / SEP-1865)** | The gateway serves its own self-contained **MCP App widget** and bakes a server-rendered map image into it (correlated via `Mcp-Session-Id`), so dynamic, live TomTom maps render inside Cowork. See **[docs/COWORK-MCP-APPS-ADAPTATION.md](docs/COWORK-MCP-APPS-ADAPTATION.md)**. |

> See **[cowork-plugin/README.md](cowork-plugin/README.md)**, the
> **[deployment guide](cowork-plugin/COWORK-DEPLOYMENT-GUIDE.md)**, the design
> **[plan](docs/COWORK-PLUGIN-PLAN.md)**, and the **[implementation log](docs/COWORK-IMPLEMENTATION-LOG.md)**.
>
> **How the MCP server was adapted for Cowork (live maps):** [docs/COWORK-MCP-APPS-ADAPTATION.md](docs/COWORK-MCP-APPS-ADAPTATION.md).

## Architecture

```
                                    Azure
 +-----------------------------------------------------------------+
 |                                                                 |
 |   Azure Container Apps              Azure Static Web App        |
 |  +---------------------------+    +-------------------------+   |
 |  | TomTom MCP Server         |    | Interactive Map App     |   |
 |  | (Orbis Maps backend)      |    | (TomTom Maps SDK +      |   |
 |  |                           |    |  MapLibre GL JS)        |   |
 |  | Image: ghcr.io/tomtom-    |    |                         |   |
 |  |   international/          |    | Renders markers, routes,|   |
 |  |   tomtom-mcp:latest       |    | polygons, traffic via   |   |
 |  |                           |    | URL query parameters    |   |
 |  | MAPS=tomtom-orbis-maps    |    +-------------------------+   |
 |  | 16 tools | Port 3000      |                ^                 |
 |  | 1.5 CPU, 3Gi RAM          |                |                 |
 |  | Replicas: 1-3             |        "Open Interactive Map"    |
 |  |                           |                |                 |
 |  | Endpoints:                |    +-------------------------+   |
 |  |   GET  /health            |    | Azure Function App      |   |
 |  |   POST /mcp              +--->| Map Proxy API            |   |
 |  +---------------------------+    |                         |   |
 |                                   | POST /api/generate-     |   |
 |                                   |       map-card          |   |
 |                                   | GET  /api/get-map-image |   |
 |                                   |                         |   |
 |                                   | Returns Adaptive Cards  |   |
 |                                   | + image URLs            |   |
 |                                   +------------+------------+   |
 |                                                |                |
 +-----------------------------------------------------------------+
                                                  |
                          HTTPS + API Key header   |
                   +------------------------------+|
                   |              |                ||
           Copilot Studio   Power Automate   Graph Connector
           (Native MCP +    (Custom          (.NET 9 console)
            Adaptive Cards)  Connector)
                   |              |                |
                   +--------------+----------------+
                                  |
                            M365 Copilot
                      (answers location queries)
```

## Available MCP Tools (16)

| # | Tool | Description | Status |
|---|------|-------------|--------|
| 1 | `tomtom-geocode` | Convert addresses to coordinates | |
| 2 | `tomtom-reverse-geocode` | Convert coordinates to addresses | |
| 3 | `tomtom-fuzzy-search` | Intelligent search with typo tolerance | |
| 4 | `tomtom-poi-search` | Find specific business categories | |
| 5 | `tomtom-nearby` | Discover services within a radius | |
| 6 | `tomtom-routing` | Calculate optimal routes between locations | |
| 7 | `tomtom-waypoint-routing` | Multi-stop route planning with optional best-order | |
| 8 | `tomtom-reachable-range` | Determine reachable coverage areas by time or distance | |
| 9 | `tomtom-traffic` | Real-time traffic incident data | |
| 10 | `tomtom-dynamic-map` | Advanced map rendering with markers, routes, polygons | |
| 11 | `tomtom-static-map` | Generate custom map images | |
| 12 | `tomtom-ev-routing` | Electric vehicle route planning with battery/charging parameters | **NEW** |
| 13 | `tomtom-search-along-route` | Find POIs along a given route with max detour constraint | **NEW** |
| 14 | `tomtom-area-search` | Search within a geographic bounding box | **NEW** |
| 15 | `tomtom-ev-search` | Find EV charging stations by location and radius | **NEW** |
| 16 | `tomtom-data-viz` | Visualize GeoJSON feature collections on a map | **NEW** |

> **Note:** The test suite also validates `tomtom-waypoint-optimization` as a routing variant.

## Prerequisites

- An [Azure subscription](https://azure.microsoft.com/free/)
- A [TomTom Developer API key](https://developer.tomtom.com/) (free tier available)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) (for the Graph Connector)
- [Node.js 18+](https://nodejs.org/) (for the Map Proxy Azure Function)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local) (for local Function App development)
- [Azure Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/) (optional, for local interactive map development)
- A [Microsoft 365 tenant](https://developer.microsoft.com/microsoft-365/dev-program) with Copilot Studio access

## Quick Start

### 1. Deploy MCP Server (Orbis)

Deploy a fresh MCP server with the Orbis Maps backend:

```powershell
.\deploy\Deploy-TomTomMCP.ps1 -TomTomApiKey "<YOUR_KEY>" `
    -SubscriptionId "<YOUR_SUB>" -TenantId "<YOUR_TENANT>"
```

Or upgrade an existing deployment to Orbis:

```powershell
.\deploy\Deploy-OrbisUpgrade.ps1
.\deploy\Deploy-OrbisUpgrade.ps1 -TomTomApiKey "<YOUR_NEW_KEY>"
```

Both scripts verify the deployment by running a health check and confirming all 16 tools are available.

### 2. Deploy Interactive Map Web App

Create an Azure Static Web App to host the interactive map front-end:

```powershell
.\deploy\Deploy-InteractiveMap.ps1 -ResourceGroupName "rg-tomtom-mcp" -Location "uksouth"
```

Then deploy the app content using either GitHub Actions or the SWA CLI:

```bash
# Option: Manual deploy via SWA CLI
npm install -g @azure/static-web-apps-cli
cd interactive-map-app
swa deploy . --deployment-token <TOKEN>
```

The interactive map accepts URL query parameters for markers, routes, center, zoom, and overlays, allowing the Adaptive Card button to deep-link directly into a configured map view.

### 3. Deploy Map Proxy Function

Deploy the Azure Function App that bridges the MCP server and Teams/Copilot Studio:

```powershell
.\deploy\Deploy-MapProxy.ps1 `
    -TomTomApiKey "<YOUR_KEY>" `
    -McpServerUrl "https://ca-tomtom-mcp.azurecontainerapps.io" `
    -InteractiveMapUrl "https://swa-tomtom-map.azurestaticapps.net"
```

Then deploy the function code:

```bash
cd map-proxy-api
npm install && npm run build
func azure functionapp publish func-tomtom-map-proxy
```

The proxy exposes two endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/generate-map-card` | POST | Calls an MCP tool, returns an Adaptive Card JSON + summary text |
| `/api/get-map-image` | GET | Calls a map tool, returns the PNG image directly (URL-addressable) |

### 4. Connect to Copilot Studio

1. Open [Copilot Studio](https://copilotstudio.microsoft.com) and select your agent
2. Go to **Actions** > **+ Add an action** > **MCP Server**
3. Enter your deployed server URL: `https://<your-app>.azurecontainerapps.io/mcp`
4. Authentication: API Key in header `tomtom-api-key`
5. All 16 tools are auto-discovered with typed parameters
6. Configure the agent to call the Map Proxy for Adaptive Card responses in Teams

See [power-platform/COPILOT-AGENT-GUIDE.md](power-platform/COPILOT-AGENT-GUIDE.md) for agent instructions, example prompts, and JSON body samples.

### 5. Connect via Power Automate

1. Import `power-platform/TomTomMCP-connector.swagger.json` as a custom connector
2. Configure API Key authentication
3. Use the `CallMcpTool` action in your flows

See [power-platform/SETUP-GUIDE.md](power-platform/SETUP-GUIDE.md) for step-by-step instructions.

### 6. Index Data into Microsoft Graph

```powershell
# Create the Entra ID app registration
.\graph-connector\Setup-AppRegistration.ps1 -TenantId "<YOUR_TENANT_ID>"

# Copy the template and fill in your credentials
cp graph-connector/appsettings.template.json graph-connector/appsettings.json
# Edit appsettings.json with your tenantId, clientId, clientSecret, tomTomApiKey, mcpBaseUrl

# Run the connector to index location data
dotnet run --project graph-connector
```

This creates a Microsoft Graph External Connection, registers a search schema, crawls TomTom data (offices, nearby POIs, landmarks, EV charging stations), and pushes items into Microsoft Search. M365 Copilot can then natively answer questions like *"What restaurants are near the London office?"* or *"Where are the nearest EV chargers?"*.

See [graph-connector/DEPLOYMENT-GUIDE.md](graph-connector/DEPLOYMENT-GUIDE.md) for the full walkthrough and troubleshooting.

### 7. Run Tests

**Original smoke tests** (11 tools, basic validation):

```powershell
.\tests\Invoke-SmokeTests.ps1 -BaseUrl "https://<your-app>.azurecontainerapps.io" -ApiKey "<YOUR_KEY>"
```

**Orbis test suite** (16 tools, full Orbis validation):

```powershell
.\tests\Invoke-OrbisTests.ps1 -BaseUrl "https://<your-app>.azurecontainerapps.io"

# Run a subset of tests
.\tests\Invoke-OrbisTests.ps1 -BaseUrl "https://<your-app>.azurecontainerapps.io" -TestFilter "*ev*"
```

The Orbis suite runs 18 tests: health check, tools/list verification, all 16 tool invocations (geocode, reverse geocode, fuzzy search, POI search, nearby, routing, reachable range, traffic, EV routing, search along route, area search, EV search, data viz), plus invalid API key rejection and response time validation.

**Cowork plugin tests** (static package validation + optional live gateway smoke):

```powershell
# Static only (validates manifest/skills, builds the .zip)
.\tests\Invoke-CoworkPluginTests.ps1

# With live gateway checks
.\tests\Invoke-CoworkPluginTests.ps1 -GatewayUrl "https://<map-proxy>/api/mcp"
```

### 8. Build & deploy the Cowork plugin

```powershell
# Deploy the gateway to the map-proxy Container App
.\deploy\Deploy-CoworkGateway.ps1 -TomTomApiKey "<YOUR_KEY>"

# Validate + package the plugin into an uploadable .zip
.\cowork-plugin\Build-CoworkPlugin.ps1
```

Then upload `cowork-plugin/dist/tomtom-cowork-plugin-1.0.0.zip` via the M365 Admin Center
(**Copilot → Agents → All agents → Add agent**). See
[cowork-plugin/COWORK-DEPLOYMENT-GUIDE.md](cowork-plugin/COWORK-DEPLOYMENT-GUIDE.md).

## Project Structure

```
TomTom/
+-- README.md                                  # This file
+-- .gitignore
+-- docs/
|   +-- COWORK-PLUGIN-PLAN.md                  # Cowork plugin design plan + alignment checklist
|   +-- COWORK-IMPLEMENTATION-LOG.md           # Running change log + test evidence
+-- cowork-plugin/
|   +-- manifest.json                          # M365 app manifest v1.28 (skills + connector)
|   +-- color.png / outline.png                # Plugin icons (192x192 / 32x32)
|   +-- New-Icons.ps1                          # Icon generator
|   +-- Build-CoworkPlugin.ps1                 # Validate + package the .zip
|   +-- README.md                              # Plugin overview
|   +-- COWORK-DEPLOYMENT-GUIDE.md             # Register -> package -> upload -> enable -> test
|   +-- skills/                                # 6 Agent Skills (live-map, search, route, traffic, ev, analytics)
+-- deploy/
|   +-- Deploy-TomTomMCP.ps1                   # Full Azure deployment (Orbis by default)
|   +-- Deploy-OrbisUpgrade.ps1                # Upgrade existing deployment to Orbis
|   +-- Deploy-InteractiveMap.ps1              # Deploy Static Web App for interactive map
|   +-- Deploy-MapProxy.ps1                    # Deploy Azure Function App (map proxy)
|   +-- Update-Container.ps1                   # Update container to latest image
|   +-- Deploy-CoworkGateway.ps1               # Redeploy map-proxy w/ Cowork MCP gateway
|   +-- Remove-TomTomMCP.ps1                   # Tear down all resources
+-- interactive-map-app/
|   +-- index.html                             # Single-page interactive map (TomTom SDK + MapLibre)
|   +-- package.json                           # App metadata and dev scripts
|   +-- staticwebapp.config.json               # Azure Static Web App routing and headers
+-- map-proxy-api/
|   +-- package.json                           # Node.js 18 Azure Function project
|   +-- tsconfig.json                          # TypeScript configuration
|   +-- host.json                              # Azure Functions host settings
|   +-- local.settings.json                    # Local development environment variables
|   +-- src/
|       +-- functions/
|       |   +-- generateMapCard.ts             # POST endpoint: MCP tool -> Adaptive Card
|       |   +-- getMapImage.ts                 # GET endpoint: MCP tool -> PNG image
|       |   +-- mcpGateway.ts                  # POST /api/mcp -- Cowork MCP gateway route
|       +-- lib/
|           +-- mcpClient.ts                   # MCP JSON-RPC client with SSE parsing
|           +-- mcpGateway.ts                  # Gateway logic + render_live_map tool
|           +-- adaptiveCards.ts               # Adaptive Card builders (search, route, traffic, map)
+-- tests/
|   +-- Invoke-SmokeTests.ps1                  # 13 smoke tests (original 11 tools)
|   +-- Invoke-OrbisTests.ps1                  # 18 Orbis tests (all 16 tools + security + perf)
|   +-- Invoke-CoworkPluginTests.ps1           # Cowork package validation + live gateway smoke
+-- power-platform/
|   +-- TomTomMCP-connector.swagger.json       # OpenAPI definition for Power Automate
|   +-- SETUP-GUIDE.md                         # Custom connector setup guide
|   +-- COPILOT-AGENT-GUIDE.md                 # Agent instructions & examples
+-- graph-connector/
    +-- TomTomGraphConnector.csproj             # .NET 9 project
    +-- Program.cs                             # Main entry point
    +-- ConnectorConfig.cs                     # Configuration model
    +-- GraphConnectorService.cs               # Microsoft Graph external connection
    +-- TomTomClient.cs                        # TomTom MCP API client
    +-- LocationItem.cs                        # Data model for indexed items
    +-- appsettings.template.json              # Configuration template (copy to appsettings.json)
    +-- Setup-AppRegistration.ps1              # Entra ID app registration script
    +-- DEPLOYMENT-GUIDE.md                    # Full deployment & troubleshooting guide
```

## Interactive Maps in Teams

The project uses an **Adaptive Card + Static Web App** approach to deliver interactive maps inside Microsoft Teams:

```
  User asks a location question in Teams
                    |
                    v
  Copilot Studio agent receives the message
                    |
                    v
  Agent calls MCP tool via the MCP server
  (e.g., tomtom-dynamic-map, tomtom-routing, tomtom-poi-search)
                    |
                    v
  MCP server returns tool result
  (JSON data, and/or base64 PNG image)
                    |
                    v
  Agent calls Map Proxy  POST /api/generate-map-card
  with the tool name + arguments
                    |
                    v
  Map Proxy calls MCP server, parses the result,
  and builds a typed Adaptive Card:
    - Search results card  (geocode, POI, fuzzy, nearby, area, EV search)
    - Route card           (routing, EV routing, waypoint optimization)
    - Traffic card         (traffic incidents)
    - Dynamic map card     (map images with overlays)
    - Generic fallback     (any other tool)
                    |
                    v
  Adaptive Card is returned to Teams with:
    - A static map image (embedded or via /api/get-map-image URL)
    - Result summary text (distances, addresses, counts)
    - "Open Interactive Map" button linking to the Static Web App
                    |
                    v
  User sees the card in Teams and can:
    [View the static map inline]
    [Click "Open Interactive Map" to zoom/pan/explore in the browser]
```

The interactive map web app reads URL query parameters to configure its initial view, so the Adaptive Card button can deep-link to a specific location, zoom level, set of markers, or route.

## Deployment Scripts

| Script | Description |
|--------|-------------|
| `Deploy-TomTomMCP.ps1` | Full Azure deployment: resource group, Container Apps environment, and MCP server container with Orbis Maps backend. Verifies health and tool count on completion. |
| `Deploy-OrbisUpgrade.ps1` | In-place upgrade of an existing Container App from `tomtom-maps` to `tomtom-orbis-maps`. Updates environment variables and image, verifies 16 tools are available. |
| `Deploy-InteractiveMap.ps1` | Creates an Azure Static Web App resource for hosting the interactive map. Outputs the deployment token and instructions for GitHub Actions or SWA CLI deployment. |
| `Deploy-MapProxy.ps1` | Creates a Storage Account and Azure Function App (Node.js 20, Linux, consumption plan). Configures app settings for TomTom API key, MCP server URL, interactive map URL, and CORS. |
| `Update-Container.ps1` | Pulls the latest `ghcr.io/tomtom-international/tomtom-mcp` image and restarts the Container App. |
| `Remove-TomTomMCP.ps1` | Tears down the resource group and all associated Azure resources. |

## Authentication

All MCP requests require the TomTom API key in the `tomtom-api-key` header:

```bash
curl -X POST "https://<your-app>.azurecontainerapps.io/mcp" \
  -H "Accept: application/json,text/event-stream" \
  -H "tomtom-api-key: <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "tools/call",
    "params": {
      "name": "tomtom-geocode",
      "arguments": { "query": "Cardiff Castle, Wales" }
    },
    "jsonrpc": "2.0",
    "id": 1
  }'
```

The Map Proxy Function App uses function-level auth (`authLevel: "function"`) and reads the TomTom API key from its own environment variables, so callers do not need to pass the key directly.

## Key Links

- [TomTom MCP Server (official)](https://github.com/tomtom-international/tomtom-mcp)
- [TomTom Developer Portal](https://developer.tomtom.com/)
- [TomTom Orbis Maps](https://developer.tomtom.com/orbis-maps/documentation/introduction)
- [Model Context Protocol specification](https://modelcontextprotocol.io/)
- [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- [Microsoft Graph Connectors](https://learn.microsoft.com/en-us/graph/connecting-external-content-connectors-overview)
- [Federated Copilot Connectors](https://learn.microsoft.com/en-us/MicrosoftSearch/federated-connectors-overview)
- [Adaptive Cards schema](https://adaptivecards.io/)
- [Azure Static Web Apps](https://learn.microsoft.com/en-us/azure/static-web-apps/)
- [Azure Functions (Node.js)](https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node)

## Contributing

This is a proof-of-concept project. Issues and PRs are welcome.

## License

This project is provided as-is for demonstration purposes. The TomTom MCP Server is maintained by [TomTom International](https://github.com/tomtom-international/tomtom-mcp) under its own license. Refer to [TomTom's terms](https://developer.tomtom.com/terms-and-conditions) for API usage.
