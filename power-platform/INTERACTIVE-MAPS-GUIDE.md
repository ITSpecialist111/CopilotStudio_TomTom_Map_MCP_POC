# Interactive Maps Guide for Copilot Studio with TomTom Orbis Maps

This guide covers setting up interactive map support in Microsoft Copilot Studio using the TomTom MCP server upgraded to Orbis Maps. With the v2.0.0 connector, your Copilot agent can display interactive, zoomable maps directly in Microsoft Teams conversations via Adaptive Cards.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Updating the Copilot Studio Agent](#2-updating-the-copilot-studio-agent)
3. [Agent Instructions (Ready to Paste)](#3-agent-instructions-ready-to-paste)
4. [Setting Up the Map Proxy in Power Automate](#4-setting-up-the-map-proxy-in-power-automate)
5. [Sample Prompts for Testing](#5-sample-prompts-for-testing)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

Before configuring interactive maps in Copilot Studio, ensure the following components are deployed and running:

### 1.1 TomTom MCP Server with Orbis Maps

- The MCP server must be running **v2.0.0 or later** with Orbis Maps support enabled.
- Deployed on **Azure Container Apps** with the `TOMTOM_API_KEY` environment variable set.
- The server must expose the `/mcp` endpoint (JSON-RPC) and the `/api/generate-map-card` endpoint (Adaptive Card proxy).
- Verify the server is healthy by calling `GET /health` -- the response should include `"version": "2.0.0"` or later.

### 1.2 Azure Static Web App (Interactive Map Viewer)

- The **Static Web App** hosts the interactive map viewer that renders Orbis Maps in an iframe.
- It must be deployed and publicly accessible (or accessible within your tenant).
- The Static Web App URL is used in Adaptive Cards to embed the interactive map.
- Ensure the `STATIC_WEB_APP_URL` environment variable is configured on the MCP server.

### 1.3 Azure Function App (Map Proxy)

- The **Function App** hosts the `/api/generate-map-card` endpoint that acts as a proxy.
- It receives tool name + arguments, calls the MCP server, and returns an Adaptive Card JSON.
- This function can be hosted as part of your Container App or as a standalone Azure Function.
- Ensure CORS is configured to allow requests from your Power Platform environment.

### 1.4 Power Platform Custom Connector

- Import the updated `TomTomMCP-connector.swagger.json` (v2.0.0) as a Custom Connector in Power Platform.
- Configure the API key authentication with your TomTom API key.
- Test the connector by calling the `GetHealth` operation.

### 1.5 TomTom API Key

- A valid TomTom API key with access to:
  - Search API (geocoding, POI, fuzzy search, area search)
  - Routing API (standard, EV, waypoint optimization)
  - Traffic API
  - Maps API (Orbis Maps SDK)
- Obtain your key from [developer.tomtom.com](https://developer.tomtom.com/).

---

## 2. Updating the Copilot Studio Agent

### 2.1 Update the Custom Connector

1. Go to **Power Platform Admin Center** > **Custom Connectors**.
2. Find your existing TomTom MCP connector.
3. Click **Edit** and select **Import from file**.
4. Upload the updated `TomTomMCP-connector.swagger.json` (v2.0.0).
5. Update the **Host** field to your Container App URL (e.g., `your-app.azurecontainerapps.io`).
6. Save and test the connector:
   - Test `GetHealth` to verify connectivity.
   - Test `CallMcpTool` with a simple geocode request.
   - Test `GenerateMapCard` with a basic map request.

### 2.2 Update the Copilot Studio Agent

1. Open your agent in **Copilot Studio**.
2. Navigate to **Settings** > **Instructions**.
3. Replace the existing instructions with the updated instructions from Section 3 below.
4. Navigate to **Actions** > **Custom Connectors**.
5. Ensure the updated TomTom MCP connector (v2.0.0) is enabled.
6. Verify all 16 tools appear in the connector's available operations.

### 2.3 Add the GenerateMapCard Action

1. In Copilot Studio, go to **Actions** and click **+ Add an action**.
2. Select your TomTom MCP custom connector.
3. Choose the **GenerateMapCard** operation.
4. Configure the action:
   - **Input**: tool (string), arguments (object), title (string, optional)
   - **Output**: Adaptive Card JSON
5. In the action's output handling, select **Send as Adaptive Card** for the response.

---

## 3. Agent Instructions (Ready to Paste)

Copy the entire text block below and paste it into your Copilot Studio agent's **Instructions** field:

---

```
You are a geospatial assistant powered by TomTom Orbis Maps. You help users with location search, directions, traffic, EV routing, and interactive map visualization. You access TomTom services through the MCP (Model Context Protocol) connector.

## Available Tools (16 total)

### Search & Geocoding Tools
- **tomtom-geocode**: Convert an address or place name into geographic coordinates (latitude/longitude). Use when the user provides a specific street address or named location and needs coordinates.
- **tomtom-reverse-geocode**: Convert geographic coordinates into a human-readable address. Use when the user provides lat/lon coordinates and needs to know the address or place name at that location.
- **tomtom-fuzzy-search**: Perform a flexible search that handles misspellings, partial addresses, and ambiguous queries. Use this as the default search tool when the user's query does not clearly match a specific search type. Supports filtering by category, country, and bounding box.
- **tomtom-poi-search**: Search for Points of Interest by name or category (e.g., "Starbucks", "gas station", "museum"). Use when the user asks for a specific type of business, amenity, or landmark.
- **tomtom-nearby**: Search for places near a specific location within a given radius. Use when the user says "near me", "nearby", "close to", or "within X km/miles of" a location. Requires coordinates and radius.
- **tomtom-area-search**: Search for places within a defined geographic area (bounding box or polygon). Use when the user wants to find all locations of a type within a city, region, or custom area boundary.

### Routing Tools
- **tomtom-routing**: Calculate a route between two points with distance, time, and turn-by-turn directions. Use for standard driving, walking, cycling, or transit directions between an origin and destination.
- **tomtom-waypoint-routing**: Calculate a route through multiple waypoints in order. Use when the user wants directions that pass through several stops in a specific sequence (e.g., "drive from A to B to C to D").
- **tomtom-ev-routing**: Calculate a route optimized for electric vehicles, including charging stop recommendations, battery level management, and range-aware planning. Use when the user mentions an EV, electric car, charging stops, or range anxiety.
- **tomtom-reachable-range**: Calculate the area reachable from a point within a given time or distance budget. Use when the user asks "how far can I go in 30 minutes?" or "what areas are within a 50km drive?"
- **tomtom-waypoint-optimization**: Optimize the order of multiple waypoints to minimize total travel time or distance (travelling salesman problem). Use when the user has multiple stops and wants the most efficient visiting order (e.g., "what is the best order to visit these 5 locations?").
- **tomtom-search-along-route**: Search for points of interest along a calculated route. Use when the user wants to find gas stations, restaurants, rest stops, or other amenities along their planned route.

### Traffic & Visualization Tools
- **tomtom-traffic**: Get real-time traffic flow and incident data for a location or area. Use when the user asks about current traffic conditions, congestion, accidents, road closures, or travel delays.
- **tomtom-dynamic-map**: Generate an interactive, zoomable map centered on a location with optional markers, routes, and overlays. Use this tool whenever the user requests a map, asks to "show me on a map", or when a visual map would enhance the response. Set show_ui: true to generate an interactive Orbis Maps view.
- **tomtom-data-viz**: Create data visualization overlays on maps including heatmaps, cluster maps, and choropleth maps. Use when the user wants to visualize geographic data patterns, density, or distributions on a map (e.g., "show a heatmap of restaurants in Manhattan").

## How to Handle Map Requests

### When to Show Interactive Maps
- Whenever the user explicitly asks for a map ("show me a map", "map it", "visualize this").
- After geocoding or searching, if the results would benefit from visual context.
- When showing routes, traffic, or geographic data.
- When showing EV routes with charging stops.
- When displaying reachable range areas.

### How to Request Dynamic Maps
When calling the **tomtom-dynamic-map** tool, always set `show_ui: true` in the arguments to generate an interactive Orbis Maps visualization. Example arguments:
- Center on a location: { "latitude": 51.5074, "longitude": -0.1278, "zoom": 13, "show_ui": true }
- With markers: { "latitude": 51.5074, "longitude": -0.1278, "zoom": 13, "markers": [...], "show_ui": true }

### Formatting Responses for Teams
When the MCP tool returns a map URL or interactive map data:
1. Present the key information (address, coordinates, distance, time) in clear text first.
2. If an interactive map URL is returned, use the GenerateMapCard action to wrap it in an Adaptive Card for Teams display.
3. Always include an "Open Full Map" button linking to the interactive map viewer.
4. For routes, include summary information (total distance, estimated time, number of steps) alongside the map.

### Adaptive Card Map Display
When you need to display a map in Teams:
1. Call the appropriate MCP tool first to get the map data.
2. Then call the **GenerateMapCard** action with:
   - tool: the tool name you used
   - arguments: the same arguments you passed to the tool
   - title: a descriptive title for the map card (e.g., "Route from London to Paris")
3. The response will be an Adaptive Card that Teams renders natively with the interactive map embedded.

## General Guidelines
- Always confirm ambiguous locations with the user before routing or mapping.
- When a user asks for directions, use tomtom-routing for simple A-to-B routes and tomtom-waypoint-routing for multi-stop routes.
- For EV users, proactively suggest tomtom-ev-routing if they mention electric vehicles or charging.
- Use tomtom-fuzzy-search as the default when the query type is unclear.
- Provide distances in both kilometers and miles when relevant.
- Include estimated travel times in hours and minutes.
- When showing search results, offer to display them on a map.
- For traffic queries, always mention the timestamp of the data so users know how current it is.
- When using tomtom-data-viz, explain what the visualization shows and what patterns the user should look for.
- For waypoint optimization, show both the original order and the optimized order so the user can compare.
```

---

## 4. Setting Up the Map Proxy in Power Automate

The map proxy flow bridges the Copilot Studio agent and the Azure Function App that generates Adaptive Cards.

### 4.1 Create the Power Automate Flow

1. Open **Power Automate** and create a new **Instant cloud flow**.
2. Name it: `TomTom Generate Map Card`.
3. Set the trigger to **When Copilot Studio calls a flow** (or **When a HTTP request is received** for manual setup).

### 4.2 Configure the Flow Steps

**Step 1: Parse Input**

Add a **Parse JSON** action with the following schema:

```json
{
  "type": "object",
  "properties": {
    "tool": {
      "type": "string"
    },
    "arguments": {
      "type": "object"
    },
    "title": {
      "type": "string"
    }
  },
  "required": ["tool", "arguments"]
}
```

**Step 2: Call the GenerateMapCard Endpoint**

Add an **HTTP** action:

| Setting    | Value                                                                           |
|------------|---------------------------------------------------------------------------------|
| Method     | POST                                                                            |
| URI        | `https://<YOUR_CONTAINER_APP>.azurecontainerapps.io/api/generate-map-card`      |
| Headers    | `Content-Type: application/json`, `tomtom-api-key: <YOUR_API_KEY>`              |
| Body       | Use the parsed JSON from Step 1                                                 |

**Step 3: Parse the Adaptive Card Response**

Add another **Parse JSON** action with this schema:

```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string" },
    "version": { "type": "string" },
    "body": {
      "type": "array",
      "items": { "type": "object" }
    },
    "actions": {
      "type": "array",
      "items": { "type": "object" }
    }
  }
}
```

**Step 4: Return the Adaptive Card**

Add a **Respond to Copilot** action (or **Response** action for HTTP triggers):

- Set the response body to the parsed Adaptive Card JSON from Step 3.
- Set Content-Type to `application/json`.

### 4.3 Connect the Flow to Copilot Studio

1. In Copilot Studio, navigate to **Actions** > **+ Add an action**.
2. Select **Power Automate flows** and choose `TomTom Generate Map Card`.
3. Map the input parameters:
   - `tool` -> Tool name from the agent's context
   - `arguments` -> Tool arguments from the agent's context
   - `title` -> Optional title string
4. Map the output to be sent as an **Adaptive Card** in the chat.

### 4.4 Alternative: Direct Custom Connector Approach

If you prefer not to use a separate Power Automate flow, you can call the `GenerateMapCard` operation directly from the custom connector:

1. In Copilot Studio, ensure the `GenerateMapCard` action is enabled on the custom connector.
2. The agent can call it directly -- the connector will POST to `/api/generate-map-card` and return the Adaptive Card.
3. Configure the agent's output to render the returned JSON as an Adaptive Card in Teams.

---

## 5. Sample Prompts for Testing

Use these prompts to verify each capability works correctly after setup:

### Search & Geocoding

| Prompt | Expected Tool | Expected Behavior |
|--------|---------------|-------------------|
| "What are the coordinates of the Eiffel Tower?" | `tomtom-geocode` | Returns lat/lon for the Eiffel Tower |
| "What address is at 40.7128, -74.0060?" | `tomtom-reverse-geocode` | Returns "New York City" area address |
| "Find coffee shops near Times Square" | `tomtom-poi-search` | Returns nearby coffee POIs |
| "Search for pharmacies within 2km of my office at 51.5074, -0.1278" | `tomtom-nearby` | Returns pharmacies within radius |
| "What restaurants are in the Dublin city center area?" | `tomtom-area-search` | Returns restaurants within Dublin area |
| "Find sprts stadums in London" | `tomtom-fuzzy-search` | Handles misspelling, returns sports stadiums |

### Routing

| Prompt | Expected Tool | Expected Behavior |
|--------|---------------|-------------------|
| "Get directions from Amsterdam to Berlin" | `tomtom-routing` | Returns route with distance and time |
| "Plan a road trip from London to Edinburgh via Manchester and Leeds" | `tomtom-waypoint-routing` | Returns multi-stop route |
| "I need to drive my Tesla from Paris to Lyon, where should I charge?" | `tomtom-ev-routing` | Returns EV route with charging stops |
| "How far can I drive from Munich in 2 hours?" | `tomtom-reachable-range` | Returns reachable area polygon |
| "What is the best order to visit these 5 client offices: [addresses]?" | `tomtom-waypoint-optimization` | Returns optimized stop order |
| "Find rest stops along my route from Boston to Philadelphia" | `tomtom-search-along-route` | Returns POIs along the route corridor |

### Traffic & Maps

| Prompt | Expected Tool | Expected Behavior |
|--------|---------------|-------------------|
| "What is the traffic like in central London right now?" | `tomtom-traffic` | Returns traffic flow and incidents |
| "Show me a map of downtown San Francisco" | `tomtom-dynamic-map` | Returns interactive map Adaptive Card |
| "Show a heatmap of hotels in Manhattan" | `tomtom-data-viz` | Returns data visualization map |

### Interactive Map Combinations

| Prompt | Expected Behavior |
|--------|-------------------|
| "Find Italian restaurants near the Colosseum and show them on a map" | POI search followed by interactive map with markers |
| "Get directions from JFK Airport to Central Park and display the route on a map" | Route calculation followed by map with route overlay |
| "Show EV charging stations along the route from LA to San Diego on a map" | EV routing with charging stops displayed on interactive map |

---

## 6. Troubleshooting

### 6.1 Connector Issues

**Problem: Custom connector test returns 401 Unauthorized**
- Verify your TomTom API key is correctly set in the connector's authentication settings.
- Ensure the key is passed in the `tomtom-api-key` header (not as a query parameter).
- Check that the API key has not expired or been revoked.

**Problem: Custom connector test returns 404 Not Found**
- Verify the Host field matches your Container App URL exactly (no trailing slash, no protocol prefix).
- Ensure the MCP server is running and the `/mcp` endpoint is accessible.
- For the map card endpoint, ensure `/api/generate-map-card` is deployed.

**Problem: Custom connector returns 502 Bad Gateway**
- The Container App may have scaled to zero. Make a health check request to wake it up, then retry.
- Check the Container App's minimum replica count is set to at least 1.

### 6.2 Map Display Issues

**Problem: Interactive map does not render in Teams**
- Verify the Static Web App URL is correct and accessible.
- Check that the `STATIC_WEB_APP_URL` environment variable is set on the MCP server.
- Ensure the Adaptive Card version is compatible with your Teams client (v1.4+ required).
- Test the Static Web App URL directly in a browser to confirm it loads.

**Problem: Map shows but is blank or grey**
- The TomTom API key may not have Maps API access. Check your key's permissions at developer.tomtom.com.
- Check browser console for CORS errors if testing in the Static Web App directly.
- Verify the Orbis Maps SDK is loading correctly (check for JavaScript errors).

**Problem: Adaptive Card shows raw JSON instead of a map**
- Ensure the Copilot Studio action output is configured to send as **Adaptive Card**, not plain text.
- In Power Automate, verify the response Content-Type is `application/json`.
- Check that the Adaptive Card schema is valid at [adaptivecards.io/designer](https://adaptivecards.io/designer/).

### 6.3 Tool-Specific Issues

**Problem: tomtom-ev-routing returns an error**
- Ensure you are providing required EV parameters: `vehicleEngineType`, `currentChargeInkWh`, `maxChargeInkWh`, and `currentFuelInLiters` (set to 0 for pure EVs).
- Check that the route has charging stations available along the path.

**Problem: tomtom-data-viz returns no visualization**
- Data visualization requires search results or data points as input. Ensure you are passing a valid dataset.
- Check that the `vizType` parameter is set to a supported type: `heatmap`, `cluster`, or `choropleth`.

**Problem: tomtom-waypoint-optimization times out**
- Optimization complexity grows with the number of waypoints. Keep waypoints under 20 for best performance.
- Ensure all waypoint coordinates are valid and geocoded correctly.

**Problem: tomtom-search-along-route returns no results**
- The route must be calculated first before searching along it. Pass the route geometry or route ID.
- Increase the `maxDetourTime` parameter to widen the search corridor.

### 6.4 Power Automate Flow Issues

**Problem: Flow fails with "InvalidTemplate" error**
- Check that the Parse JSON schema matches the actual response format from the MCP server.
- Test the endpoint directly with Postman or curl to see the raw response format.

**Problem: Flow runs but Copilot Studio does not display the card**
- Ensure the flow's **Respond to Copilot** action returns the Adaptive Card in the correct output variable.
- Verify the flow is published and the Copilot Studio action references the latest version.
- Check the flow run history for any warnings or errors in individual steps.

### 6.5 General Debugging Steps

1. **Test the MCP server directly**: Use curl or Postman to call `POST /mcp` with a JSON-RPC request. This isolates server issues from connector issues.
2. **Test the Custom Connector**: Use the Power Platform connector test page to call each operation independently.
3. **Test the Power Automate flow**: Trigger the flow manually with sample data and inspect each step's output.
4. **Check Copilot Studio logs**: Review the agent's conversation logs to see which tools it attempted to call and what responses it received.
5. **Verify API quotas**: TomTom API keys have rate limits. Check the [developer dashboard](https://developer.tomtom.com/) for quota usage.

---

## Appendix: Tool Parameter Quick Reference

| Tool | Key Parameters |
|------|---------------|
| `tomtom-geocode` | `address` (string) |
| `tomtom-reverse-geocode` | `latitude`, `longitude` (number) |
| `tomtom-fuzzy-search` | `query` (string), `lat`, `lon`, `countrySet`, `limit` |
| `tomtom-poi-search` | `query` (string), `lat`, `lon`, `categorySet`, `radius` |
| `tomtom-nearby` | `latitude`, `longitude`, `radius` (meters), `categorySet` |
| `tomtom-area-search` | `query`, `boundingBox` or `geometry`, `categorySet` |
| `tomtom-routing` | `origin`, `destination`, `travelMode` |
| `tomtom-waypoint-routing` | `waypoints` (array of coordinates), `travelMode` |
| `tomtom-ev-routing` | `origin`, `destination`, `vehicleEngineType`, `currentChargeInkWh`, `maxChargeInkWh` |
| `tomtom-reachable-range` | `latitude`, `longitude`, `timeBudgetInSec` or `distanceBudgetInMeters` |
| `tomtom-waypoint-optimization` | `waypoints` (array), `optimizeBy` (`time` or `distance`) |
| `tomtom-search-along-route` | `query`, `route` (geometry), `maxDetourTime` |
| `tomtom-traffic` | `latitude`, `longitude`, `radius`, `style` |
| `tomtom-dynamic-map` | `latitude`, `longitude`, `zoom`, `markers`, `show_ui` |
| `tomtom-data-viz` | `dataPoints`, `vizType` (`heatmap`, `cluster`, `choropleth`) |
