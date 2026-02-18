# TomTom MCP Server — Copilot Studio & M365 Copilot Integration (POC)

> **Proof of Concept** — Connecting a hosted [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server on Azure to Microsoft Copilot Studio and Microsoft 365 Copilot.

## What This Project Demonstrates

| Capability | Status |
|------------|--------|
| **MCP Server on Azure** — Deploy the [official TomTom MCP server](https://github.com/tomtom-international/tomtom-mcp) to Azure Container Apps | ✅ Working |
| **Copilot Studio + MCP** — Use the native MCP wizard in Copilot Studio to auto-discover all 11 TomTom geospatial tools | ✅ Working |
| **Power Automate Custom Connector** — Call the MCP server from Power Automate flows via an OpenAPI-based connector | ✅ Working |
| **Microsoft Graph Connector** — Index TomTom location data into Microsoft Search so M365 Copilot can answer location queries natively | ✅ Working |
| **Federated Copilot Connectors** — Future capability allowing MCP servers to be called natively from M365 Copilot ([learn more](https://learn.microsoft.com/en-us/MicrosoftSearch/federated-connectors-overview)) | 👀 On radar |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│           Azure Container Apps                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │      TomTom MCP Server (Docker)                     │ │
│  │      Image: ghcr.io/tomtom-international/           │ │
│  │             tomtom-mcp:latest                       │ │
│  │      Port: 3000 | 1 CPU, 2Gi RAM                   │ │
│  │      Replicas: 1-3 (auto-scale)                     │ │
│  │                                                     │ │
│  │      Endpoints:                                     │ │
│  │        GET  /health       — Health check            │ │
│  │        POST /mcp          — MCP JSON-RPC endpoint   │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────┬────────────────────────────────┘
                          │  HTTPS + API Key header
            ┌─────────────┼─────────────┐
            │             │             │
    Copilot Studio   Power Automate   Graph Connector
    (Native MCP)   (Custom Connector)  (.NET 9 console)
            │             │             │
            └─────────────┴─────────────┘
                          │
                    M365 Copilot
              (answers location queries)
```

## Available MCP Tools (11)

| Tool | Description |
|------|-------------|
| `tomtom-geocode` | Convert addresses to coordinates |
| `tomtom-reverse-geocode` | Convert coordinates to addresses |
| `tomtom-fuzzy-search` | Intelligent search with typo tolerance |
| `tomtom-poi-search` | Find specific business categories |
| `tomtom-nearby` | Discover services within a radius |
| `tomtom-routing` | Calculate optimal routes between locations |
| `tomtom-waypoint-routing` | Multi-stop route planning with optional best-order |
| `tomtom-reachable-range` | Determine reachable coverage areas by time/distance |
| `tomtom-traffic` | Real-time traffic incident data |
| `tomtom-static-map` | Generate custom map images |
| `tomtom-dynamic-map` | Advanced map rendering with markers, routes, polygons |

## Prerequisites

- An [Azure subscription](https://azure.microsoft.com/free/)
- A [TomTom Developer API key](https://developer.tomtom.com/) (free tier available)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) (for the Graph Connector)
- A [Microsoft 365 tenant](https://developer.microsoft.com/microsoft-365/dev-program) with Copilot Studio access

## Quick Start

### 1. Deploy the MCP Server to Azure

```powershell
.\deploy\Deploy-TomTomMCP.ps1 -TomTomApiKey "<YOUR_TOMTOM_API_KEY>"
```

This creates a resource group, Container Apps environment, and deploys the TomTom MCP container with external HTTPS ingress. The script outputs the public URL.

### 2. Connect to Copilot Studio (Recommended)

1. Open [Copilot Studio](https://copilotstudio.microsoft.com) → your agent
2. Go to **Actions** → **+ Add an action** → **MCP Server**
3. Enter your deployed server URL: `https://<your-app>.azurecontainerapps.io/mcp`
4. Authentication: API Key in header `tomtom-api-key`
5. All 11 tools are auto-discovered with typed parameters

See [power-platform/COPILOT-AGENT-GUIDE.md](power-platform/COPILOT-AGENT-GUIDE.md) for agent instructions, example prompts, and JSON body samples.

### 3. Connect via Power Automate (Custom Connector)

1. Import `power-platform/TomTomMCP-connector.swagger.json` as a custom connector
2. Configure API Key authentication
3. Use the `CallMcpTool` action in your flows

See [power-platform/SETUP-GUIDE.md](power-platform/SETUP-GUIDE.md) for step-by-step instructions.

### 4. Index Data into Microsoft Graph (for M365 Copilot)

```powershell
# Create the Entra ID app registration
.\graph-connector\Setup-AppRegistration.ps1 -TenantId "<YOUR_TENANT_ID>"

# Copy the template and fill in your credentials
cp graph-connector/appsettings.template.json graph-connector/appsettings.json
# Edit appsettings.json with your tenantId, clientId, clientSecret, tomTomApiKey, mcpBaseUrl

# Run the connector to index location data
dotnet run --project graph-connector
```

This creates a Microsoft Graph External Connection, registers a search schema, crawls TomTom data (offices, nearby POIs, landmarks), and pushes items into Microsoft Search. M365 Copilot can then natively answer questions like *"What restaurants are near the London office?"*.

See [graph-connector/DEPLOYMENT-GUIDE.md](graph-connector/DEPLOYMENT-GUIDE.md) for the full walkthrough and troubleshooting.

### 5. Run Smoke Tests

```powershell
.\tests\Invoke-SmokeTests.ps1 -BaseUrl "https://<your-app>.azurecontainerapps.io" -ApiKey "<YOUR_KEY>"
```

13 tests covering health, all 11 tools, security, and performance.

## Project Structure

```
TomTomMCP/
├── README.md                              # This file
├── .gitignore
├── deploy/
│   ├── Deploy-TomTomMCP.ps1              # Full Azure deployment script
│   ├── Update-Container.ps1              # Update container to latest image
│   └── Remove-TomTomMCP.ps1              # Tear down all resources
├── tests/
│   └── Invoke-SmokeTests.ps1             # 13 smoke tests
├── power-platform/
│   ├── TomTomMCP-connector.swagger.json  # OpenAPI def for Power Automate
│   ├── SETUP-GUIDE.md                    # Custom connector setup guide
│   └── COPILOT-AGENT-GUIDE.md            # Agent instructions & examples
└── graph-connector/
    ├── TomTomGraphConnector.csproj        # .NET 9 project
    ├── Program.cs                         # Main entry point
    ├── ConnectorConfig.cs                 # Configuration model
    ├── GraphConnectorService.cs           # Microsoft Graph external connection
    ├── TomTomClient.cs                    # TomTom MCP API client
    ├── LocationItem.cs                    # Data model for indexed items
    ├── appsettings.template.json          # Configuration template (copy → appsettings.json)
    ├── Setup-AppRegistration.ps1          # Entra ID app registration script
    └── DEPLOYMENT-GUIDE.md               # Full deployment & troubleshooting guide
```

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

## Key Links

- [TomTom MCP Server (official)](https://github.com/tomtom-international/tomtom-mcp)
- [TomTom Developer Portal](https://developer.tomtom.com/)
- [Model Context Protocol specification](https://modelcontextprotocol.io/)
- [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- [Microsoft Graph Connectors](https://learn.microsoft.com/en-us/graph/connecting-external-content-connectors-overview)
- [Federated Copilot Connectors](https://learn.microsoft.com/en-us/MicrosoftSearch/federated-connectors-overview)

## Deployment Scripts

```powershell
# Full deployment (creates all Azure resources from scratch)
.\deploy\Deploy-TomTomMCP.ps1 -TomTomApiKey "<YOUR_KEY>"

# Customise the deployment
.\deploy\Deploy-TomTomMCP.ps1 -TomTomApiKey "<YOUR_KEY>" `
    -SubscriptionId "<YOUR_SUB>" -TenantId "<YOUR_TENANT>" `
    -Location "westeurope" -ResourceGroupName "rg-my-mcp"

# Update container to latest image
.\deploy\Update-Container.ps1

# Tear down all resources
.\deploy\Remove-TomTomMCP.ps1
```

## Contributing

This is a proof-of-concept project. Issues and PRs are welcome.

## License

This project is provided as-is for demonstration purposes. The TomTom MCP Server is maintained by [TomTom International](https://github.com/tomtom-international/tomtom-mcp) under its own license. Refer to [TomTom's terms](https://developer.tomtom.com/terms-and-conditions) for API usage.
