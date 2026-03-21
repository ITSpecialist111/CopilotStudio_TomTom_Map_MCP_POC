import { Request, Response } from "express";
import { callMcpTool, McpToolResult } from "../lib/mcpClient";
import {
  buildSearchResultCard,
  buildRouteCard,
  buildTrafficCard,
  buildDynamicMapCard,
  AdaptiveCard,
  SearchResult,
  RouteData,
  TrafficIncident,
  MapData,
} from "../lib/adaptiveCards";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GenerateMapCardRequest {
  tool: string;
  arguments: Record<string, unknown>;
  title?: string;
}

interface GenerateMapCardResponse {
  card: AdaptiveCard;
  text: string;
  imageBase64?: string;
}

// Tool-name classification helpers
const SEARCH_TOOLS = [
  "tomtom-search",
  "tomtom-geocode",
  "tomtom-reverse-geocode",
  "tomtom-poi-search",
  "tomtom-nearby-search",
  "tomtom-category-search",
  "tomtom-fuzzy-search",
];

const ROUTE_TOOLS = [
  "tomtom-routing",
  "tomtom-calculate-route",
  "tomtom-route",
  "tomtom-ev-routing",
  "tomtom-long-distance-ev-routing",
  "tomtom-waypoint-optimization",
];

const TRAFFIC_TOOLS = [
  "tomtom-traffic",
  "tomtom-traffic-incidents",
  "tomtom-traffic-flow",
];

const MAP_TOOLS = [
  "tomtom-dynamic-map",
  "tomtom-static-map",
  "tomtom-map-image",
];

// ---------------------------------------------------------------------------
// Express route handler
// ---------------------------------------------------------------------------

async function generateMapCard(req: Request, res: Response): Promise<void> {
  console.log("generateMapCard: Processing request");

  // Parse request body
  const body = req.body as GenerateMapCardRequest;

  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid JSON body." });
    return;
  }

  // Validate required fields
  if (!body.tool || typeof body.tool !== "string") {
    res.status(400).json({
      error: 'Missing or invalid "tool" field. Provide the MCP tool name.',
    });
    return;
  }

  if (!body.arguments || typeof body.arguments !== "object") {
    res.status(400).json({
      error:
        'Missing or invalid "arguments" field. Provide tool arguments as an object.',
    });
    return;
  }

  // Read configuration from environment
  const apiKey = process.env.TOMTOM_API_KEY;
  const mcpUrl = process.env.MCP_SERVER_URL;
  const interactiveMapUrl = process.env.INTERACTIVE_MAP_URL;

  if (!apiKey) {
    console.error("TOMTOM_API_KEY is not configured.");
    res.status(500).json({ error: "Server misconfigured: missing TOMTOM_API_KEY." });
    return;
  }
  if (!mcpUrl) {
    console.error("MCP_SERVER_URL is not configured.");
    res.status(500).json({ error: "Server misconfigured: missing MCP_SERVER_URL." });
    return;
  }

  const mapAppUrl = interactiveMapUrl || "https://localhost:4280";

  // Call the MCP server
  let mcpResult: McpToolResult;
  try {
    console.log(
      `generateMapCard: Calling MCP tool "${body.tool}" with args:`,
      JSON.stringify(body.arguments).substring(0, 200)
    );
    mcpResult = await callMcpTool(body.tool, body.arguments, apiKey, mcpUrl);
    console.log("generateMapCard: MCP tool call succeeded");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown MCP error";
    console.error(`generateMapCard: MCP tool call failed: ${message}`);
    res.status(502).json({ error: `MCP server error: ${message}` });
    return;
  }

  // Build the Adaptive Card based on the tool type
  let card: AdaptiveCard;
  let summaryText: string;
  const toolLower = body.tool.toLowerCase();

  try {
    if (SEARCH_TOOLS.some((t) => toolLower.includes(t))) {
      const results = parseSearchResults(mcpResult);
      card = buildSearchResultCard(results, body.title || "Search Results", mapAppUrl);
      summaryText =
        results.length > 0
          ? `Found ${results.length} result${results.length !== 1 ? "s" : ""}. Top: ${results[0].name || results[0].address || "Unknown"}`
          : "No results found.";
    } else if (ROUTE_TOOLS.some((t) => toolLower.includes(t))) {
      const routeData = parseRouteData(mcpResult);
      card = buildRouteCard(routeData, body.title || "Route", mapAppUrl);
      const distance = routeData.summary?.lengthInMeters;
      const time = routeData.summary?.travelTimeInSeconds;
      summaryText = `Route: ${distance ? formatDistance(distance) : "N/A"}, ${time ? formatDuration(time) : "N/A"}`;
    } else if (TRAFFIC_TOOLS.some((t) => toolLower.includes(t))) {
      const incidents = parseTrafficIncidents(mcpResult);
      card = buildTrafficCard(
        incidents,
        body.title || "Traffic",
        mapAppUrl
      );
      summaryText = `${incidents.length} traffic incident${incidents.length !== 1 ? "s" : ""} found.`;
    } else if (MAP_TOOLS.some((t) => toolLower.includes(t))) {
      const mapData = parseMapData(mcpResult, body.arguments);
      card = buildDynamicMapCard(
        mcpResult.imageBase64,
        mapData,
        body.title || "Map View",
        mapAppUrl
      );
      summaryText = mapData.description || "Map image generated.";
    } else {
      // Fallback: generic card with text content
      card = buildGenericCard(mcpResult, body.title || body.tool, mapAppUrl);
      summaryText = mcpResult.text?.substring(0, 200) || "Tool executed successfully.";
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Card building error";
    console.error(`generateMapCard: Failed to build card: ${message}`);
    // Fallback to generic card
    card = buildGenericCard(mcpResult, body.title || body.tool, mapAppUrl);
    summaryText = mcpResult.text?.substring(0, 200) || "Tool result received.";
  }

  const response: GenerateMapCardResponse = {
    card,
    text: summaryText,
  };

  if (mcpResult.imageBase64) {
    response.imageBase64 = mcpResult.imageBase64;
  }

  res.status(200).json(response);
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

function parseSearchResults(result: McpToolResult): SearchResult[] {
  // Attempt to parse structured results from the text content
  if (result.text) {
    try {
      const parsed = JSON.parse(result.text);
      if (Array.isArray(parsed)) {
        return parsed as SearchResult[];
      }
      if (parsed.results && Array.isArray(parsed.results)) {
        return parsed.results as SearchResult[];
      }
    } catch {
      // Text is not JSON; try to extract info from plain text
      return parseSearchFromText(result.text);
    }
  }

  // Try raw result
  const raw = result.raw as Record<string, unknown> | null;
  if (raw) {
    if (Array.isArray(raw)) {
      return raw as SearchResult[];
    }
    const rawResults = (raw as Record<string, unknown>).results;
    if (Array.isArray(rawResults)) {
      return rawResults as SearchResult[];
    }
  }

  return [];
}

function parseSearchFromText(text: string): SearchResult[] {
  // Basic heuristic: try to find numbered results in the text
  const results: SearchResult[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    // Match lines like "1. Place Name (lat, lon)"
    const match = line.match(
      /^\d+\.\s*(.+?)(?:\s*[-:]\s*(.+?))?(?:\s*\((-?\d+\.?\d*),\s*(-?\d+\.?\d*)\))?$/
    );
    if (match) {
      const result: SearchResult = {
        name: match[1].trim(),
      };
      if (match[2]) {
        result.address = match[2].trim();
      }
      if (match[3] && match[4]) {
        result.position = {
          lat: parseFloat(match[3]),
          lon: parseFloat(match[4]),
        };
      }
      results.push(result);
    }
  }

  return results;
}

function parseRouteData(result: McpToolResult): RouteData {
  if (result.text) {
    try {
      const parsed = JSON.parse(result.text);
      return parsed as RouteData;
    } catch {
      // Extract route info from text
      return parseRouteFromText(result.text);
    }
  }

  const raw = result.raw as RouteData | null;
  if (raw) {
    return raw;
  }

  return {};
}

function parseRouteFromText(text: string): RouteData {
  const route: RouteData = { summary: {} };

  // Try to extract distance
  const distMatch = text.match(
    /distance[:\s]*(\d+(?:\.\d+)?)\s*(km|m|miles|mi)/i
  );
  if (distMatch) {
    const value = parseFloat(distMatch[1]);
    const unit = distMatch[2].toLowerCase();
    route.summary!.lengthInMeters =
      unit === "km"
        ? value * 1000
        : unit === "m"
          ? value
          : value * 1609.34;
  }

  // Try to extract travel time
  const timeMatch = text.match(
    /(?:travel\s*time|duration|time)[:\s]*(?:(\d+)\s*h(?:r|ours?)?\s*)?(\d+)\s*min/i
  );
  if (timeMatch) {
    const hours = timeMatch[1] ? parseInt(timeMatch[1]) : 0;
    const minutes = parseInt(timeMatch[2]);
    route.summary!.travelTimeInSeconds = hours * 3600 + minutes * 60;
  }

  return route;
}

function parseTrafficIncidents(result: McpToolResult): TrafficIncident[] {
  if (result.text) {
    try {
      const parsed = JSON.parse(result.text);
      if (Array.isArray(parsed)) {
        return parsed as TrafficIncident[];
      }
      if (parsed.incidents && Array.isArray(parsed.incidents)) {
        return parsed.incidents as TrafficIncident[];
      }
    } catch {
      return [];
    }
  }

  const raw = result.raw as Record<string, unknown> | null;
  if (raw) {
    if (Array.isArray(raw)) {
      return raw as TrafficIncident[];
    }
    const rawIncidents = raw.incidents;
    if (Array.isArray(rawIncidents)) {
      return rawIncidents as TrafficIncident[];
    }
  }

  return [];
}

function parseMapData(
  result: McpToolResult,
  requestArgs: Record<string, unknown>
): MapData {
  const mapData: MapData = {};

  // Extract center and zoom from the original request arguments
  if (requestArgs.center) {
    const center = requestArgs.center as { lat: number; lon: number } | string;
    if (typeof center === "object") {
      mapData.center = center;
    } else if (typeof center === "string") {
      const parts = center.split(",").map(Number);
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        mapData.center = { lat: parts[0], lon: parts[1] };
      }
    }
  }
  if (requestArgs.lat && requestArgs.lon) {
    mapData.center = {
      lat: Number(requestArgs.lat),
      lon: Number(requestArgs.lon),
    };
  }
  if (requestArgs.zoom) {
    mapData.zoom = Number(requestArgs.zoom);
  }

  // Parse text for additional info
  if (result.text) {
    try {
      const parsed = JSON.parse(result.text);
      if (parsed.center) mapData.center = parsed.center;
      if (parsed.zoom) mapData.zoom = parsed.zoom;
      if (parsed.markers) mapData.markers = parsed.markers;
      if (parsed.description) mapData.description = parsed.description;
    } catch {
      mapData.description = result.text.substring(0, 300);
    }
  }

  return mapData;
}

// ---------------------------------------------------------------------------
// Fallback generic card
// ---------------------------------------------------------------------------

function buildGenericCard(
  result: McpToolResult,
  title: string,
  interactiveMapUrl: string
): AdaptiveCard {
  const card: AdaptiveCard = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: title,
        size: "Large",
        weight: "Bolder",
        wrap: true,
      },
    ],
    actions: [],
  };

  if (result.imageBase64) {
    card.body.push({
      type: "Image",
      url: `data:image/png;base64,${result.imageBase64}`,
      size: "Stretch",
      altText: title,
    });
  }

  if (result.text) {
    card.body.push({
      type: "TextBlock",
      text: result.text.substring(0, 1000),
      wrap: true,
      spacing: "Medium",
    });
  }

  card.actions!.push({
    type: "Action.OpenUrl",
    title: "Open Interactive Map",
    url: interactiveMapUrl,
    style: "positive",
  });

  return card;
}

// ---------------------------------------------------------------------------
// Format helpers (duplicated locally to avoid circular deps)
// ---------------------------------------------------------------------------

function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${meters} m`;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours} hr ${minutes} min`;
  }
  return `${minutes} min`;
}

export default generateMapCard;
