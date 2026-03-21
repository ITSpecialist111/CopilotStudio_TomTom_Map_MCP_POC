/**
 * Adaptive Card builder functions for TomTom map data.
 * All cards conform to Adaptive Card schema version 1.5 for Microsoft Teams compatibility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A complete Adaptive Card payload. */
export interface AdaptiveCard {
  type: "AdaptiveCard";
  $schema: string;
  version: string;
  body: AdaptiveCardElement[];
  actions?: AdaptiveCardAction[];
}

/** Union type for elements that can appear in an Adaptive Card body. */
type AdaptiveCardElement =
  | TextBlock
  | Image
  | ColumnSet
  | Container
  | FactSet
  | ActionSet;

/** Text block element. */
interface TextBlock {
  type: "TextBlock";
  text: string;
  size?: string;
  weight?: string;
  wrap?: boolean;
  color?: string;
  spacing?: string;
  separator?: boolean;
  isSubtle?: boolean;
}

/** Image element. */
interface Image {
  type: "Image";
  url: string;
  size?: string;
  altText?: string;
  width?: string;
  height?: string;
}

/** Column set for side-by-side layout. */
interface ColumnSet {
  type: "ColumnSet";
  columns: Column[];
  separator?: boolean;
}

/** A single column within a ColumnSet. */
interface Column {
  type: "Column";
  width: string;
  items: AdaptiveCardElement[];
}

/** Container to group elements. */
interface Container {
  type: "Container";
  items: AdaptiveCardElement[];
  style?: string;
  separator?: boolean;
  spacing?: string;
}

/** Fact set for key-value display. */
interface FactSet {
  type: "FactSet";
  facts: Fact[];
  separator?: boolean;
  spacing?: string;
}

interface Fact {
  title: string;
  value: string;
}

/** Action set element (for inline actions). */
interface ActionSet {
  type: "ActionSet";
  actions: AdaptiveCardAction[];
  separator?: boolean;
  spacing?: string;
}

/** Union of supported action types. */
type AdaptiveCardAction = OpenUrlAction | SubmitAction;

interface OpenUrlAction {
  type: "Action.OpenUrl";
  title: string;
  url: string;
  style?: string;
}

interface SubmitAction {
  type: "Action.Submit";
  title: string;
  data: Record<string, unknown>;
  style?: string;
}

// ---------------------------------------------------------------------------
// Data shapes (loosely typed to handle varied MCP responses)
// ---------------------------------------------------------------------------

export interface SearchResult {
  name?: string;
  address?: string;
  position?: { lat: number; lon: number };
  category?: string;
  phone?: string;
  distance?: number;
  score?: number;
}

export interface RouteData {
  summary?: {
    lengthInMeters?: number;
    travelTimeInSeconds?: number;
    departureTime?: string;
    arrivalTime?: string;
    trafficDelayInSeconds?: number;
  };
  legs?: Array<{
    summary?: {
      lengthInMeters?: number;
      travelTimeInSeconds?: number;
    };
    points?: Array<{ latitude: number; longitude: number }>;
  }>;
  origin?: string;
  destination?: string;
}

export interface TrafficIncident {
  description?: string;
  severity?: string;
  type?: string;
  from?: string;
  to?: string;
  delay?: number;
  road?: string;
  location?: { lat: number; lon: number };
}

export interface MapData {
  center?: { lat: number; lon: number };
  zoom?: number;
  markers?: Array<{ lat: number; lon: number; label?: string }>;
  description?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA_URL = "http://adaptivecards.io/schemas/adaptive-card.json";
const SCHEMA_VERSION = "1.5";

function createCardShell(): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: SCHEMA_URL,
    version: SCHEMA_VERSION,
    body: [],
    actions: [],
  };
}

function addHeader(card: AdaptiveCard, title: string): void {
  card.body.push({
    type: "TextBlock",
    text: title,
    size: "Large",
    weight: "Bolder",
    wrap: true,
  });
}

function addImage(card: AdaptiveCard, imageUrl: string, alt: string): void {
  card.body.push({
    type: "Image",
    url: imageUrl,
    size: "Stretch",
    altText: alt,
  });
}

function addSeparator(card: AdaptiveCard): void {
  card.body.push({
    type: "TextBlock",
    text: " ",
    spacing: "Small",
    separator: true,
  });
}

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

function buildInteractiveMapLink(
  baseUrl: string,
  params: Record<string, string>
): string {
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

/**
 * Builds an Adaptive Card for geocode/search/POI results.
 */
export function buildSearchResultCard(
  results: SearchResult[],
  title: string,
  interactiveMapUrl: string
): AdaptiveCard {
  const card = createCardShell();
  addHeader(card, title || "Search Results");

  if (results.length === 0) {
    card.body.push({
      type: "TextBlock",
      text: "No results found.",
      wrap: true,
      isSubtle: true,
    });
    return card;
  }

  // Show up to 5 results
  const displayResults = results.slice(0, 5);

  for (let i = 0; i < displayResults.length; i++) {
    const result = displayResults[i];

    if (i > 0) {
      addSeparator(card);
    }

    // Result name
    card.body.push({
      type: "TextBlock",
      text: `**${i + 1}. ${result.name || "Unknown"}**`,
      wrap: true,
      spacing: "Medium",
    });

    // Facts about the result
    const facts: Fact[] = [];
    if (result.address) {
      facts.push({ title: "Address", value: result.address });
    }
    if (result.category) {
      facts.push({ title: "Category", value: result.category });
    }
    if (result.position) {
      facts.push({
        title: "Coordinates",
        value: `${result.position.lat.toFixed(6)}, ${result.position.lon.toFixed(6)}`,
      });
    }
    if (result.phone) {
      facts.push({ title: "Phone", value: result.phone });
    }
    if (result.distance !== undefined) {
      facts.push({ title: "Distance", value: formatDistance(result.distance) });
    }

    if (facts.length > 0) {
      card.body.push({
        type: "FactSet",
        facts,
      });
    }

    // Per-result actions
    if (result.position) {
      card.body.push({
        type: "ActionSet",
        actions: [
          {
            type: "Action.Submit",
            title: "Copy Coordinates",
            data: {
              action: "copyCoordinates",
              coordinates: `${result.position.lat}, ${result.position.lon}`,
              name: result.name || "Location",
            },
          },
        ],
      });
    }
  }

  if (results.length > 5) {
    card.body.push({
      type: "TextBlock",
      text: `_...and ${results.length - 5} more results_`,
      wrap: true,
      isSubtle: true,
      spacing: "Medium",
    });
  }

  // Build interactive map link with markers
  const markers = displayResults
    .filter((r) => r.position)
    .map(
      (r, idx) =>
        `${r.position!.lat},${r.position!.lon},${encodeURIComponent(r.name || `Result ${idx + 1}`)}`
    )
    .join(";");

  const firstResult = displayResults.find((r) => r.position);
  const mapLink = buildInteractiveMapLink(interactiveMapUrl, {
    lat: firstResult?.position?.lat.toString() || "",
    lon: firstResult?.position?.lon.toString() || "",
    zoom: "13",
    markers,
  });

  card.actions = [
    {
      type: "Action.OpenUrl",
      title: "Open Interactive Map",
      url: mapLink,
      style: "positive",
    },
  ];

  return card;
}

/**
 * Builds an Adaptive Card for routing results.
 */
export function buildRouteCard(
  routeData: RouteData,
  title: string,
  interactiveMapUrl: string
): AdaptiveCard {
  const card = createCardShell();
  addHeader(card, title || "Route Information");

  const summary = routeData.summary;

  // Route summary facts
  const facts: Fact[] = [];

  if (routeData.origin) {
    facts.push({ title: "Origin", value: routeData.origin });
  }
  if (routeData.destination) {
    facts.push({ title: "Destination", value: routeData.destination });
  }
  if (summary?.lengthInMeters !== undefined) {
    facts.push({
      title: "Distance",
      value: formatDistance(summary.lengthInMeters),
    });
  }
  if (summary?.travelTimeInSeconds !== undefined) {
    facts.push({
      title: "Travel Time",
      value: formatDuration(summary.travelTimeInSeconds),
    });
  }
  if (summary?.trafficDelayInSeconds && summary.trafficDelayInSeconds > 0) {
    facts.push({
      title: "Traffic Delay",
      value: formatDuration(summary.trafficDelayInSeconds),
    });
  }
  if (summary?.departureTime) {
    facts.push({
      title: "Departure",
      value: new Date(summary.departureTime).toLocaleString(),
    });
  }
  if (summary?.arrivalTime) {
    facts.push({
      title: "Arrival",
      value: new Date(summary.arrivalTime).toLocaleString(),
    });
  }

  if (facts.length > 0) {
    card.body.push({
      type: "FactSet",
      facts,
      spacing: "Medium",
    });
  }

  // Leg summaries
  if (routeData.legs && routeData.legs.length > 1) {
    addSeparator(card);
    card.body.push({
      type: "TextBlock",
      text: "**Route Legs**",
      wrap: true,
    });

    for (let i = 0; i < routeData.legs.length; i++) {
      const leg = routeData.legs[i];
      const legFacts: Fact[] = [];
      if (leg.summary?.lengthInMeters !== undefined) {
        legFacts.push({
          title: `Leg ${i + 1} Distance`,
          value: formatDistance(leg.summary.lengthInMeters),
        });
      }
      if (leg.summary?.travelTimeInSeconds !== undefined) {
        legFacts.push({
          title: `Leg ${i + 1} Time`,
          value: formatDuration(leg.summary.travelTimeInSeconds),
        });
      }
      if (legFacts.length > 0) {
        card.body.push({ type: "FactSet", facts: legFacts });
      }
    }
  }

  // Interactive map link
  const mapParams: Record<string, string> = { view: "route" };
  if (routeData.origin) {
    mapParams.origin = routeData.origin;
  }
  if (routeData.destination) {
    mapParams.destination = routeData.destination;
  }

  const mapLink = buildInteractiveMapLink(interactiveMapUrl, mapParams);

  card.actions = [
    {
      type: "Action.OpenUrl",
      title: "Open Interactive Map",
      url: mapLink,
      style: "positive",
    },
  ];

  return card;
}

/**
 * Builds an Adaptive Card for traffic incident data.
 */
export function buildTrafficCard(
  incidents: TrafficIncident[],
  title: string,
  interactiveMapUrl: string
): AdaptiveCard {
  const card = createCardShell();
  addHeader(card, title || "Traffic Incidents");

  if (incidents.length === 0) {
    card.body.push({
      type: "TextBlock",
      text: "No traffic incidents reported in this area.",
      wrap: true,
      isSubtle: true,
    });
    return card;
  }

  // Summary
  card.body.push({
    type: "TextBlock",
    text: `**${incidents.length} incident${incidents.length !== 1 ? "s" : ""} found**`,
    wrap: true,
    spacing: "Medium",
  });

  // Show up to 5 incidents
  const displayIncidents = incidents.slice(0, 5);

  for (let i = 0; i < displayIncidents.length; i++) {
    const incident = displayIncidents[i];

    if (i > 0) {
      addSeparator(card);
    }

    // Severity indicator
    const severityColor = getSeverityColor(incident.severity);
    card.body.push({
      type: "TextBlock",
      text: `**${incident.type || "Incident"}** - ${incident.severity || "Unknown"} severity`,
      wrap: true,
      color: severityColor,
      spacing: "Medium",
    });

    const facts: Fact[] = [];
    if (incident.description) {
      facts.push({ title: "Description", value: incident.description });
    }
    if (incident.road) {
      facts.push({ title: "Road", value: incident.road });
    }
    if (incident.from) {
      facts.push({ title: "From", value: incident.from });
    }
    if (incident.to) {
      facts.push({ title: "To", value: incident.to });
    }
    if (incident.delay !== undefined && incident.delay > 0) {
      facts.push({ title: "Delay", value: formatDuration(incident.delay) });
    }

    if (facts.length > 0) {
      card.body.push({ type: "FactSet", facts });
    }
  }

  if (incidents.length > 5) {
    card.body.push({
      type: "TextBlock",
      text: `_...and ${incidents.length - 5} more incidents_`,
      wrap: true,
      isSubtle: true,
      spacing: "Medium",
    });
  }

  // Interactive map link
  const firstIncident = displayIncidents.find((inc) => inc.location);
  const mapLink = buildInteractiveMapLink(interactiveMapUrl, {
    lat: firstIncident?.location?.lat.toString() || "",
    lon: firstIncident?.location?.lon.toString() || "",
    zoom: "12",
    view: "traffic",
  });

  card.actions = [
    {
      type: "Action.OpenUrl",
      title: "Open Interactive Map",
      url: mapLink,
      style: "positive",
    },
  ];

  return card;
}

/**
 * Builds an Adaptive Card for dynamic map image results.
 */
export function buildDynamicMapCard(
  imageBase64: string | undefined,
  mapData: MapData,
  title: string,
  interactiveMapUrl: string
): AdaptiveCard {
  const card = createCardShell();
  addHeader(card, title || "Map View");

  // Embed the map image
  if (imageBase64) {
    addImage(card, `data:image/png;base64,${imageBase64}`, title || "Map");
  }

  // Map details
  const facts: Fact[] = [];
  if (mapData.center) {
    facts.push({
      title: "Center",
      value: `${mapData.center.lat.toFixed(6)}, ${mapData.center.lon.toFixed(6)}`,
    });
  }
  if (mapData.zoom !== undefined) {
    facts.push({ title: "Zoom Level", value: mapData.zoom.toString() });
  }
  if (mapData.description) {
    card.body.push({
      type: "TextBlock",
      text: mapData.description,
      wrap: true,
      spacing: "Medium",
    });
  }

  if (facts.length > 0) {
    card.body.push({
      type: "FactSet",
      facts,
      spacing: "Medium",
    });
  }

  // List markers if present
  if (mapData.markers && mapData.markers.length > 0) {
    addSeparator(card);
    card.body.push({
      type: "TextBlock",
      text: "**Markers**",
      wrap: true,
    });

    for (const marker of mapData.markers.slice(0, 10)) {
      card.body.push({
        type: "TextBlock",
        text: `- ${marker.label || "Pin"}: ${marker.lat.toFixed(6)}, ${marker.lon.toFixed(6)}`,
        wrap: true,
        isSubtle: true,
      });
    }
  }

  // Interactive map link
  const mapParams: Record<string, string> = {};
  if (mapData.center) {
    mapParams.lat = mapData.center.lat.toString();
    mapParams.lon = mapData.center.lon.toString();
  }
  if (mapData.zoom !== undefined) {
    mapParams.zoom = mapData.zoom.toString();
  }
  if (mapData.markers && mapData.markers.length > 0) {
    mapParams.markers = mapData.markers
      .map(
        (m) =>
          `${m.lat},${m.lon},${encodeURIComponent(m.label || "Pin")}`
      )
      .join(";");
  }

  const mapLink = buildInteractiveMapLink(interactiveMapUrl, mapParams);

  card.actions = [
    {
      type: "Action.OpenUrl",
      title: "Open Interactive Map",
      url: mapLink,
      style: "positive",
    },
  ];

  // Add copy coordinates action if there is a center
  if (mapData.center) {
    card.actions.push({
      type: "Action.Submit",
      title: "Copy Coordinates",
      data: {
        action: "copyCoordinates",
        coordinates: `${mapData.center.lat}, ${mapData.center.lon}`,
      },
    });
  }

  return card;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSeverityColor(
  severity?: string
): "attention" | "warning" | "good" | "default" {
  switch (severity?.toLowerCase()) {
    case "critical":
    case "major":
      return "attention";
    case "moderate":
    case "minor":
      return "warning";
    case "low":
      return "good";
    default:
      return "default";
  }
}
