# Power Platform - TomTom MCP Custom Connector Setup Guide

## Overview

This guide walks you through connecting your deployed TomTom MCP Server to Microsoft Power Platform (Power Automate, Power Apps, Copilot Studio) via a custom connector.

## Prerequisites

- TomTom MCP Server deployed at: `https://<YOUR_CONTAINER_APP>.azurecontainerapps.io`
- TomTom API Key
- Power Platform environment on your tenant
- Maker permissions in Power Platform

## Step 1: Create Custom Connector

### Option A: Import from Swagger (Recommended)

1. Go to [Power Automate](https://make.powerautomate.com) or [Power Apps](https://make.powerapps.com)
2. Navigate to **Data** > **Custom connectors**
3. Click **+ New custom connector** > **Import an OpenAPI file**
4. Name it: `TomTom MCP`
5. Upload the file: `TomTomMCP-connector.swagger.json` from this directory
6. Click **Continue**

### Option B: Create from Blank

1. Go to **Data** > **Custom connectors** > **+ New custom connector** > **Create from blank**
2. Name: `TomTom MCP`
3. Host: `<YOUR_CONTAINER_APP>.azurecontainerapps.io`
4. Base URL: `/`
5. Scheme: `HTTPS`

## Step 2: Configure Security

1. In the **Security** tab:
   - Authentication type: **API Key**
   - Parameter label: `TomTom API Key`
   - Parameter name: `tomtom-api-key`
   - Parameter location: **Header**
2. Click **Update connector**

## Step 3: Test the Connection

1. Go to the **Test** tab
2. Click **+ New connection**
3. Enter your TomTom API key: `<YOUR_TOMTOM_API_KEY>`
4. Click **Create connection**
5. Test the **GetHealth** operation - should return `{"status": "ok"}`
6. Test the **CallMcpTool** operation with this body:

```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-geocode",
    "arguments": {
      "query": "Cardiff Castle, Wales"
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

## Step 4: Use in Power Automate

### Example Flow: Geocode an Address

1. Create a new **Instant cloud flow** with manual trigger
2. Add a **Compose** action with the MCP request body:
   ```json
   {
     "method": "tools/call",
     "params": {
       "name": "tomtom-geocode",
       "arguments": {
         "query": "@{triggerBody()['text']}"
       }
     },
     "jsonrpc": "2.0",
     "id": 1
   }
   ```
3. Add the **TomTom MCP** > **CallMcpTool** action
4. Set the body to the output of the Compose action
5. Add a **Parse JSON** action on the response

### Example Flow: Calculate Route

```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-routing",
    "arguments": {
      "origin": { "lat": 51.4816, "lon": -3.1791 },
      "destination": { "lat": 51.5074, "lon": -0.1278 },
      "travelMode": "car",
      "traffic": true
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Example Flow: Find Nearby POIs

```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-nearby",
    "arguments": {
      "lat": 51.4816,
      "lon": -3.1791,
      "radius": 2000,
      "categorySet": "7315",
      "limit": 10
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

## Step 5: Use in Copilot Studio (MCP Connector)

For native MCP integration with Copilot Studio:

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com)
2. Open your copilot
3. Navigate to **Settings** > **Generative AI** > **MCP Servers** (if available)
4. Add new MCP server:
   - **URL**: `https://<YOUR_CONTAINER_APP>.azurecontainerapps.io/mcp`
   - **Authentication**: API Key header `tomtom-api-key`
5. The copilot will automatically discover all 11 TomTom tools

## Available Tool Reference

| Tool Name | What It Does | Example Use Case |
|-----------|-------------|-----------------|
| `tomtom-geocode` | Address to coordinates | "Where is Cardiff Castle?" |
| `tomtom-reverse-geocode` | Coordinates to address | "What's at 51.48, -3.18?" |
| `tomtom-fuzzy-search` | Smart search with typos | "Find resturants near me" |
| `tomtom-poi-search` | Find business categories | "Hotels in London" |
| `tomtom-nearby` | Find things within radius | "Coffee shops within 1km" |
| `tomtom-routing` | Calculate routes | "Drive from Cardiff to London" |
| `tomtom-waypoint-routing` | Multi-stop routes | "Route: A → B → C → D" |
| `tomtom-reachable-range` | Coverage area | "Where can I drive in 30min?" |
| `tomtom-traffic` | Traffic incidents | "Traffic around London M25" |
| `tomtom-static-map` | Map images | "Show me a map of Cardiff" |
| `tomtom-dynamic-map` | Rich map with markers | "Map with route and POIs" |

## Troubleshooting

### Connection Test Fails
- Verify the server is running: `curl https://<YOUR_CONTAINER_APP>.azurecontainerapps.io/health`
- Check the API key is correct
- Ensure the connector security is set to API Key in Header

### Response Not Parsing
The MCP endpoint returns Server-Sent Events (SSE) format. Use a **Compose** action to extract the JSON:
```
@{substring(outputs('CallMcpTool')?['body'], add(indexOf(outputs('CallMcpTool')?['body'], 'data: '), 6))}
```

### Rate Limiting
TomTom API has rate limits based on your plan. If you hit limits, consider:
- Adding delays between calls in Power Automate
- Upgrading your TomTom API plan

## Support

- TomTom Developer Portal: https://developer.tomtom.com/
- TomTom MCP GitHub: https://github.com/tomtom-international/tomtom-mcp
- Azure Container Apps: Check logs in Azure Portal > rg-tomtom-mcp > ca-tomtom-mcp > Log stream
