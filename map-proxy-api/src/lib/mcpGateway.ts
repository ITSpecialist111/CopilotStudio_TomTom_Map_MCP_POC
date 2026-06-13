/**
 * MCP gateway for Microsoft Copilot Cowork.
 *
 * Cowork connects to this gateway as a remote MCP server (Streamable HTTP,
 * JSON-RPC 2.0) using `None` auth. The gateway proxies the upstream TomTom MCP
 * server, injecting the `tomtom-api-key` header server-side so the secret never
 * reaches the client. It also:
 *   - filters the key-leaking `tomtom-get-api-key` tool out of discovery,
 *   - guarantees a `readOnlyHint` annotation so Cowork auto-runs tools, and
 *   - adds a synthetic `render_live_map` tool that returns an inline map image
 *     plus a link to the live, interactive map (pan / zoom / live traffic).
 */

import { callMcpRpc, JsonRpcResponse } from "./mcpClient";
import { getAppSdkScript } from "./appSdk";
import Jimp from "jimp";

/** MCP protocol version advertised when a client omits one during initialize. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Tools that must never be exposed to the AI client (security). */
const BLOCKED_TOOLS = new Set<string>(["tomtom-get-api-key"]);

/** Map tools whose bulky base64 image output is replaced with a hosted URL. */
const IMAGE_TOOLS = new Set<string>(["tomtom-dynamic-map", "tomtom-data-viz"]);

/** Synthetic tool name for rendering a live / dynamic map. */
export const RENDER_LIVE_MAP = "render_live_map";

/** App-only tool the widget calls back to pull a rendered map image (base64). */
export const MAP_IMAGE_TOOL = "tomtom_map_image";

/**
 * MCP Apps (SEP-1865) UI resource for the live-map widget. Cowork fetches this
 * via `resources/read` and renders the returned HTML in a sandboxed iframe.
 * A per-call variant `ui://tomtom-cowork/live-map/<token>.html` bakes the map
 * state into the URI so the widget can render with no bridge round-trip.
 */
const UI_RESOURCE_BASE = "ui://tomtom-cowork/live-map";
const UI_RESOURCE_STATIC = `${UI_RESOURCE_BASE}.html`;
const UI_MIME = "text/html;profile=mcp-app";

/**
 * Live data overlays the interactive map (Static Web App) can render on top of
 * the base map: a heatmap of hotspots + clustered markers (points) or
 * severity-coloured areas (polygons). Fetched client-side from public,
 * CORS-enabled feeds. Passed to the SWA via the `overlay` query parameter.
 */
const OVERLAY_KEYS = new Set(["earthquakes", "uk-crime", "uk-floods", "uk-bikes", "uk-tube"]);

/**
 * In-memory store of the most recent map per MCP session. Cowork fetches the
 * widget HTML via `resources/read` for the static `ui://` URI (it does not echo
 * the per-call token URI), but it re-attaches the same `Mcp-Session-Id`. We use
 * that to bake the right map image into the widget server-side — no in-iframe
 * bridge required.
 */
interface StoredMap {
  tool: string;
  args: Record<string, unknown>;
  /** Pre-rendered map image as a `data:` URL (baked at tools/call time). */
  dataUrl?: string | null;
  /** Fully-built interactive map (SWA) URL, incl. overlays/traffic/center. */
  liveUrl?: string | null;
  /** Map title/caption. */
  title?: string | null;
  ts: number;
}
const SESSION_MAPS = new Map<string, StoredMap>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 500;

function rememberMap(
  sessionId: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  dataUrl?: string | null,
  liveUrl?: string | null,
  title?: string | null
): void {
  if (!sessionId) return;
  if (SESSION_MAPS.size >= SESSION_MAX) {
    const oldest = SESSION_MAPS.keys().next().value;
    if (oldest) SESSION_MAPS.delete(oldest);
  }
  SESSION_MAPS.set(sessionId, {
    tool,
    args,
    dataUrl: dataUrl ?? null,
    liveUrl: liveUrl ?? null,
    title: title ?? null,
    ts: Date.now(),
  });
}

function recallMap(sessionId: string | undefined): StoredMap | null {
  if (!sessionId) return null;
  const m = SESSION_MAPS.get(sessionId);
  if (!m) return null;
  if (Date.now() - m.ts > SESSION_TTL_MS) {
    SESSION_MAPS.delete(sessionId);
    return null;
  }
  return m;
}

/** Runtime configuration resolved per request from environment + headers. */
export interface GatewayContext {
  /** TomTom API key, injected server-side into upstream calls. */
  apiKey: string;
  /** Upstream TomTom MCP server base URL. */
  mcpUrl: string;
  /** This proxy's own public base URL (used to build image URLs). */
  publicBaseUrl: string;
  /** Interactive map (Static Web App) base URL, if configured. */
  interactiveMapUrl?: string;
  /** Optional client-side maps key for the interactive deep link. */
  mapClientKey?: string;
  /** TomTom Maps backend header value (default `tomtom-orbis-maps`). */
  mapsBackend?: string;
  /**
   * When true, advertise the MCP Apps (SEP-1865) widget on `render_live_map`
   * (interactive SWA iframe inline). Default false: Cowork's widget-renderer host
   * (`mcpwidget.html`) aborts at ~10s in the current preview build even after a
   * spec-correct handshake, so we ship the reliable clickable-image experience
   * instead. Flip `ENABLE_COWORK_WIDGET=true` to re-enable (e.g. once the official
   * `@modelcontextprotocol/ext-apps` SDK is bundled or the host is fixed).
   */
  widgetEnabled?: boolean;
  /** MCP Streamable HTTP session id (correlates a widget mount with its map). */
  sessionId?: string;
}

/** Minimal JSON-RPC request shape accepted by the gateway. */
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface LatLon {
  lat: number;
  lon: number;
  label?: string;
}

interface LiveMapArgs {
  title?: string;
  center?: LatLon;
  zoom?: number;
  markers?: Array<LatLon & { category?: string; address?: string }>;
  route?: {
    origin: LatLon;
    destination: LatLon;
    waypoints?: LatLon[];
    travelMode?: string;
    label?: string;
  };
  traffic?: boolean;
  width?: number;
  height?: number;
  /** When true, render an animated GIF fly-in instead of a still image. */
  animate?: boolean;
  /** Animation style: "zoom-in" (default) or "zoom-out". */
  animationEffect?: string;
  /** Live data overlays to show on the interactive map (e.g. "earthquakes"). */
  overlays?: string[];
}

/** A content block in an MCP tool result. */
interface McpBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Synthetic tool definition
// ---------------------------------------------------------------------------

const RENDER_LIVE_MAP_TOOL = {
  name: RENDER_LIVE_MAP,
  description:
    "Render a TomTom map for the user. Returns an inline map image PLUS a link to a live, " +
    "interactive map (pan, zoom, live traffic overlay). Use this AFTER gathering coordinates " +
    "from geocode/search/routing/traffic/EV tools to visualise places, routes, traffic or EV " +
    "chargers. Pass markers for places, a route (origin+destination) for directions, and set " +
    "traffic=true to show live traffic. Pass overlays to add live data layers (heatmap + " +
    "clusters) to the interactive map: 'earthquakes' (global USGS, last 30 days), 'uk-crime' " +
    "(Police.uk street crime near the map centre), 'uk-floods' (Environment Agency warnings), " +
    "'uk-bikes' (London cycle hire), 'uk-tube' (live London Underground line status, lines " +
    "drawn in their colours with delays highlighted). Set animate=true to return an animated " +
    "map (a looping GIF that flies/zooms in to the location) for 'animate', 'fly to', 'zoom " +
    "into' or cinematic requests. Always prefer this tool to show results on a map.",
  annotations: {
    title: "Render Live Map",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Caption shown above the map. EXAMPLE: 'Cardiff Castle'.",
      },
      center: {
        type: "object",
        description:
          "Optional map centre. Auto-calculated from markers/route when omitted.",
        properties: {
          lat: { type: "number", description: "Latitude (-90 to 90)." },
          lon: { type: "number", description: "Longitude (-180 to 180)." },
        },
        required: ["lat", "lon"],
      },
      zoom: {
        type: "number",
        minimum: 0,
        maximum: 22,
        description: "Zoom 0-22 (10 = city, 15 = neighbourhood). Auto if omitted.",
      },
      markers: {
        type: "array",
        description:
          "Places to pin. EXAMPLE: [{lat:51.48,lon:-3.18,label:'Cardiff Castle'}].",
        items: {
          type: "object",
          properties: {
            lat: { type: "number" },
            lon: { type: "number" },
            label: { type: "string", description: "Marker label." },
            category: {
              type: "string",
              description: "Optional POI category (renders a coloured dot).",
            },
            address: {
              type: "string",
              description: "Optional address shown in the marker popup.",
            },
          },
          required: ["lat", "lon"],
        },
      },
      route: {
        type: "object",
        description:
          "Optional road-following route to draw. Provide origin + destination (+ optional waypoints).",
        properties: {
          origin: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
              label: { type: "string" },
            },
            required: ["lat", "lon"],
          },
          destination: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
              label: { type: "string" },
            },
            required: ["lat", "lon"],
          },
          waypoints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                lat: { type: "number" },
                lon: { type: "number" },
                label: { type: "string" },
              },
              required: ["lat", "lon"],
            },
          },
          travelMode: {
            type: "string",
            enum: ["car", "truck", "bicycle", "pedestrian"],
            description: "Mode of transport. DEFAULT car.",
          },
        },
        required: ["origin", "destination"],
      },
      traffic: {
        type: "boolean",
        description: "Overlay live traffic. DEFAULT false.",
      },
      animate: {
        type: "boolean",
        description:
          "When true, return an ANIMATED map (a looping GIF that flies/zooms in to the " +
          "location) instead of a still image. Use for 'animate', 'fly to', 'zoom into' or " +
          "cinematic requests. DEFAULT false.",
      },
      animationEffect: {
        type: "string",
        enum: ["zoom-in", "zoom-out"],
        description: "Animation style when animate=true. DEFAULT zoom-in.",
      },
      overlays: {
        type: "array",
        description:
          "Live data layers to add to the interactive map (heatmap + clustered markers). " +
          "Allowed: 'earthquakes' (global USGS M2.5+, last 30 days), 'uk-crime' (Police.uk " +
          "street crime near the map centre), 'uk-floods' (Environment Agency flood warnings), " +
          "'uk-bikes' (London cycle hire docks), 'uk-tube' (live London Underground line status). " +
          "For 'uk-crime' set center to a UK location; for 'uk-tube'/'uk-bikes' centre on London.",
        items: {
          type: "string",
          enum: ["earthquakes", "uk-crime", "uk-floods", "uk-bikes", "uk-tube"],
        },
      },
      width: {
        type: "number",
        minimum: 100,
        maximum: 2048,
        description: "Image width in px. DEFAULT 1000.",
      },
      height: {
        type: "number",
        minimum: 100,
        maximum: 2048,
        description: "Image height in px. DEFAULT 700.",
      },
    },
  },
  // MCP Apps (SEP-1865) widget binding. Cowork mounts a widget for this tool and
  // fetches its HTML from `resources/read` for this `ui://` URI. The widget embeds
  // the interactive map (SWA / MapLibre) as a nested iframe — Cowork honours
  // `frameDomains` on the UI resource's `_meta.ui.csp` — giving real inline pan /
  // zoom / live traffic. `openai/outputTemplate` is the OpenAI Apps SDK alias
  // Microsoft 365 Copilot also honours. The tool result stays self-sufficient
  // (text + structuredContent) for graceful degradation if no widget mounts.
  _meta: {
    ui: { resourceUri: UI_RESOURCE_STATIC },
    "openai/outputTemplate": UI_RESOURCE_STATIC,
  },
};

/**
 * App-only tool (hidden from the agent) that the widget calls back via
 * `tools/call` to pull a rendered map image as a data URL. This is the
 * Cowork-recommended pattern for bulk data: the server makes the outbound
 * request (with the API key) and returns the bytes to the sandboxed widget.
 */
const MAP_IMAGE_TOOL_DEF = {
  name: MAP_IMAGE_TOOL,
  description:
    "Internal: returns a rendered TomTom map image as a data URL for the live-map widget.",
  annotations: { title: "Map image", readOnlyHint: true },
  _meta: { ui: { visibility: ["app"] }, "openai/visibility": ["app"] },
  inputSchema: {
    type: "object",
    properties: {
      argsB64: {
        type: "string",
        description: "Base64-encoded JSON of the map tool arguments.",
      },
      tool: {
        type: "string",
        description: "Map tool name. DEFAULT tomtom-dynamic-map.",
      },
    },
    required: ["argsB64"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isLatLon(value: unknown): value is LatLon {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as LatLon).lat) &&
    Number.isFinite((value as LatLon).lon)
  );
}

/** Picks a sensible map centre from render_live_map args (centre/markers/route). */
function pickCenter(a: LiveMapArgs): LatLon | null {
  if (isLatLon(a.center)) return { lat: a.center.lat, lon: a.center.lon };
  const markers = Array.isArray(a.markers) ? a.markers.filter(isLatLon) : [];
  if (markers.length > 0) {
    const lat = markers.reduce((s, m) => s + m.lat, 0) / markers.length;
    const lon = markers.reduce((s, m) => s + m.lon, 0) / markers.length;
    return { lat, lon };
  }
  if (a.route && isLatLon(a.route.origin) && isLatLon(a.route.destination)) {
    return {
      lat: (a.route.origin.lat + a.route.destination.lat) / 2,
      lon: (a.route.origin.lon + a.route.destination.lon) / 2,
    };
  }
  if (a.route && isLatLon(a.route.origin)) {
    return { lat: a.route.origin.lat, lon: a.route.origin.lon };
  }
  return null;
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

/** Builds the upstream `tomtom-dynamic-map` arguments from render_live_map args. */
function buildDynamicMapArgs(a: LiveMapArgs): Record<string, unknown> {
  const args: Record<string, unknown> = {
    width: clampInt(a.width, 100, 2048, 1000),
    height: clampInt(a.height, 100, 2048, 700),
    showLabels: true,
    detail: "compact",
  };

  if (isLatLon(a.center)) {
    args.center = { lat: a.center.lat, lon: a.center.lon };
    if (a.zoom != null) args.zoom = clampInt(a.zoom, 0, 22, 12);
  }

  if (Array.isArray(a.markers) && a.markers.length > 0) {
    args.markers = a.markers
      .filter((m) => isLatLon(m))
      .map((m) => ({
        lat: m.lat,
        lon: m.lon,
        ...(m.label ? { label: m.label } : {}),
        ...(m.category ? { category: m.category } : {}),
        ...(m.address ? { address: m.address } : {}),
        priority: "high",
      }));
  }

  if (a.route && isLatLon(a.route.origin) && isLatLon(a.route.destination)) {
    const plan: Record<string, unknown> = {
      origin: a.route.origin,
      destination: a.route.destination,
      ...(Array.isArray(a.route.waypoints)
        ? { waypoints: a.route.waypoints }
        : {}),
      ...(a.route.travelMode ? { travelMode: a.route.travelMode } : {}),
      ...(a.traffic ? { traffic: true } : {}),
      ...(a.route.label ? { label: a.route.label } : {}),
    };
    args.routePlans = [plan];
    args.routeInfoDetail = "distance-time";
  }

  return args;
}

/** Builds the inline image URL served by `GET /api/get-map-image`. */
function buildImageUrl(
  ctx: GatewayContext,
  tool: string,
  toolArgs: Record<string, unknown>
): string {
  const base = ctx.publicBaseUrl.replace(/\/+$/, "");
  const b64 = base64Json(toolArgs);
  return `${base}/api/get-map-image?tool=${encodeURIComponent(
    tool
  )}&args=${encodeURIComponent(b64)}`;
}

/** Builds the animated (GIF fly-in) image URL served by `GET /api/get-map-animation`. */
function buildAnimationUrl(
  ctx: GatewayContext,
  tool: string,
  toolArgs: Record<string, unknown>,
  effect?: string
): string {
  const base = ctx.publicBaseUrl.replace(/\/+$/, "");
  const b64 = base64Json(toolArgs);
  const eff = effect === "zoom-out" ? "zoom-out" : "zoom-in";
  return `${base}/api/get-map-animation?tool=${encodeURIComponent(
    tool
  )}&args=${encodeURIComponent(b64)}&effect=${eff}`;
}

/** Builds the live, interactive map deep link into the Static Web App. */
function buildInteractiveUrl(
  ctx: GatewayContext,
  a: LiveMapArgs
): string | undefined {
  if (!ctx.interactiveMapUrl) return undefined;
  const base = ctx.interactiveMapUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();

  let center: LatLon | undefined = a.center;
  if (!center && Array.isArray(a.markers) && a.markers.length > 0) {
    center = a.markers[0];
  } else if (!center && a.route && isLatLon(a.route.origin)) {
    center = a.route.origin;
  }
  if (isLatLon(center)) {
    params.set("center", `${center.lat},${center.lon}`);
  }
  if (a.zoom != null) params.set("zoom", String(clampInt(a.zoom, 0, 22, 12)));

  if (Array.isArray(a.markers) && a.markers.length > 0) {
    const markers = a.markers
      .filter((m) => isLatLon(m))
      .map((m) => ({ lat: m.lat, lon: m.lon, label: m.label }));
    if (markers.length > 0) params.set("markers", base64Json(markers));
  }

  if (a.route && isLatLon(a.route.origin) && isLatLon(a.route.destination)) {
    const pts = [
      a.route.origin,
      ...(Array.isArray(a.route.waypoints) ? a.route.waypoints : []),
      a.route.destination,
    ]
      .filter((p) => isLatLon(p))
      .map((p) => [p.lat, p.lon]);
    params.set("route", base64Json({ points: pts }));
  }

  if (a.traffic) params.set("traffic", "true");
  if (a.title) params.set("title", a.title);
  if (Array.isArray(a.overlays) && a.overlays.length > 0) {
    const keys = a.overlays
      .map((o) => String(o).trim().toLowerCase())
      .filter((o) => OVERLAY_KEYS.has(o));
    if (keys.length > 0) params.set("overlay", Array.from(new Set(keys)).join(","));
  }
  if (ctx.mapClientKey) params.set("apiKey", ctx.mapClientKey);

  return `${base}/?${params.toString()}`;
}

/** Converts native `tomtom-dynamic-map` args into the live-link arg shape. */
function dynamicArgsToLive(args: Record<string, unknown>): LiveMapArgs {
  const live: LiveMapArgs = {};
  if (typeof args.title === "string") live.title = args.title;
  if (isLatLon(args.center)) live.center = args.center as LatLon;
  if (typeof args.zoom === "number") live.zoom = args.zoom;
  if (Array.isArray(args.markers)) {
    live.markers = (args.markers as Array<Record<string, unknown>>).filter(
      (m) => isLatLon(m)
    ) as LiveMapArgs["markers"];
  }
  const plans = args.routePlans;
  if (Array.isArray(plans) && plans.length > 0) {
    const p = plans[0] as Record<string, unknown>;
    if (isLatLon(p.origin) && isLatLon(p.destination)) {
      live.route = {
        origin: p.origin as LatLon,
        destination: p.destination as LatLon,
        waypoints: Array.isArray(p.waypoints)
          ? (p.waypoints as LatLon[])
          : undefined,
      };
      if (p.traffic === true) live.traffic = true;
    }
  }
  return live;
}

// ---------------------------------------------------------------------------
// MCP Apps widget helpers
// ---------------------------------------------------------------------------

/** Encodes the map tool + args into a URI-safe token for a per-call `ui://` URI. */
function encodeMapToken(tool: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({ t: tool, a: args });
  return Buffer.from(payload, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes a per-call widget token into its tool name and arguments. */
function decodeMapToken(
  token: string
): { tool: string; args: Record<string, unknown> } | null {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    if (obj && typeof obj === "object") {
      if (obj.t && obj.a) {
        return { tool: String(obj.t), args: obj.a as Record<string, unknown> };
      }
      return { tool: "tomtom-dynamic-map", args: obj as Record<string, unknown> };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Decodes a base64(url) JSON args blob (used by the app-callable map tool). */
function decodeArgsB64(b64: string): Record<string, unknown> {
  try {
    const s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const o = JSON.parse(Buffer.from(s, "base64").toString("utf-8"));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function originOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Origins the widget iframe is allowed to embed (Cowork honours frameDomains). */
function frameDomainsFor(ctx: GatewayContext): string[] {
  const set = new Set<string>();
  const p = originOf(ctx.publicBaseUrl);
  const s = originOf(ctx.interactiveMapUrl);
  if (p) set.add(p);
  if (s) set.add(s);
  return Array.from(set);
}

/**
 * Re-encodes a base64 map image (often PNG, ~150–400 KB) into a small JPEG so
 * it can be safely inlined as a `data:` URL in the widget HTML. Cowork's widget
 * sandbox won't reliably paint a large `data:` image / oversized resource HTML
 * (observed grey box at ≥150 KB), and the upstream tool's `detail` flag controls
 * *response fields*, not image bytes — so we downscale + JPEG-compress here to
 * guarantee a tiny, reliable payload (≈ 20–40 KB). Falls back to the original
 * data on any failure so the pipeline never breaks.
 */
async function shrinkToJpegDataUrl(
  base64: string,
  mimeType: string,
  maxEdge = 560,
  quality = 58
): Promise<string> {
  const original = `data:${mimeType || "image/png"};base64,${base64}`;
  try {
    const buf = Buffer.from(base64, "base64");
    const img = await Jimp.read(buf);
    img.scaleToFit(maxEdge, maxEdge);
    img.quality(quality);
    const out = await img.getBufferAsync(Jimp.MIME_JPEG);
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return original;
  }
}

/** Calls the upstream map tool and returns a `data:` URL (JPEG) for the rendered image. */
async function fetchMapDataUrl(
  ctx: GatewayContext,
  tool: string,
  args: Record<string, unknown>,
  maxEdge = 560,
  quality = 58
): Promise<string | null> {
  const env = await callMcpRpc(
    "tools/call",
    { name: tool, arguments: args },
    ctx.apiKey,
    ctx.mcpUrl,
    1,
    ctx.mapsBackend
  );
  const content = env.result?.content;
  if (Array.isArray(content)) {
    for (const b of content as McpBlock[]) {
      if (b && b.type === "image" && typeof b.data === "string") {
        return shrinkToJpegDataUrl(b.data, b.mimeType || "image/png", maxEdge, quality);
      }
    }
  }
  return null;
}

/**
 * Builds the self-contained MCP App widget HTML (SEP-1865) Cowork renders in a
 * sandboxed iframe. It inlines the official `@modelcontextprotocol/ext-apps`
 * SDK (export stripped to `window.App`) and uses `App.connect()` for the
 * handshake — byte-compatible with the host's `AppBridge`, which is what makes
 * the widget actually mount (a hand-rolled handshake is silently rejected and
 * times out). Its content is the full interactive map (the SWA / MapLibre app)
 * embedded as a nested iframe: Cowork honours `frameDomains` on the UI
 * resource's `_meta.ui.csp`, and the SWA is its own origin, so it loads its own
 * tiles and gives real inline pan / zoom / live-traffic / data overlays. The
 * TomTom key stays server-side (the SWA deep link uses the referrer-restricted
 * client key).
 */
function buildWidgetHtml(
  ctx: GatewayContext,
  baked: {
    tool: string;
    args: Record<string, unknown>;
    dataUrl?: string | null;
    liveUrl?: string | null;
    title?: string | null;
  } | null
): string {
  let dataUrl: string | null = null;
  let liveUrl: string | null = null;
  let title = "Map";

  if (baked) {
    const tool = baked.tool || "tomtom-dynamic-map";
    if (typeof baked.liveUrl === "string" && baked.liveUrl) {
      liveUrl = baked.liveUrl;
    } else if (tool === "tomtom-dynamic-map") {
      liveUrl = buildInteractiveUrl(ctx, dynamicArgsToLive(baked.args)) ?? null;
    }
    title =
      baked.title ||
      (typeof baked.args.title === "string" ? (baked.args.title as string) : "Map");
    dataUrl = baked.dataUrl ?? null;
  }

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const titleHtml = esc(title);
  const init = JSON.stringify({ title, liveUrl }).replace(/</g, "\\u003c");
  const sdk = getAppSdkScript();

  // ---- DIAGNOSTIC MODE (WIDGET_DIAG=1) -------------------------------------
  // A minimal widget that does the official-SDK handshake and renders a map
  // image fetched via a widget `tools/call` (the Cowork-sanctioned network
  // path) — with NO nested cross-origin iframe. This isolates the cause of the
  // "didn't respond in time" timeout: if THIS mounts, the nested SWA iframe was
  // the blocker and the production widget should use the image+tools/call
  // pattern instead of an embedded iframe.
  if (process.env.WIDGET_DIAG === "1") {
    const argsB64 = baked ? base64Json(baked.args) : "";
    const diagInit = JSON.stringify({ argsB64, title }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  html,body{margin:0;padding:0;font-family:'Segoe UI',system-ui,sans-serif;}
  .box{padding:12px;border-radius:10px;background:#0a8a3f;color:#fff;font-weight:600;font-size:14px;}
  .s{font-size:12px;font-weight:400;margin-top:6px;opacity:.95;white-space:pre-wrap;}
  img.m{display:block;width:100%;border-radius:10px;margin-top:8px;background:#eef1f5;}
</style></head>
<body>
<div class="wrap" style="padding:8px">
  <div class="box">TomTom widget diagnostic
    <div class="s" id="s">booting…</div>
  </div>
  <img class="m" id="m" alt="map" style="display:none"/>
</div>
<script>${sdk}</script>
<script>
(function(){
  var INIT = ${diagInit};
  var s = document.getElementById('s');
  var m = document.getElementById('m');
  function say(t){ try{ s.textContent = t; }catch(e){} }
  var App = window.App;
  if(!App){ say('ERROR: window.App not defined (SDK did not load)'); return; }
  say('SDK loaded. Connecting…');
  var app = new App({ name:"tomtom-diag", version:"1.0.0" }, {}, { autoResize:true });
  app.onerror = function(e){ say('app error: ' + (e && e.message ? e.message : e)); };
  app.connect().then(function(){
    say('CONNECTED ✓ — fetching map image via tools/call…');
    if(!INIT.argsB64){ say('CONNECTED ✓ (no map args to fetch)'); return; }
    app.callServerTool({ name:"tomtom_map_image", arguments:{ argsB64: INIT.argsB64, tool:"tomtom-dynamic-map" } })
      .then(function(res){
        var du=null; try{ du = res && res.structuredContent && res.structuredContent.dataUrl; }catch(e){}
        if(!du){ try{ var c=res&&res.content; if(c&&c[0]&&typeof c[0].text==='string'&&c[0].text.indexOf('data:image')===0) du=c[0].text; }catch(e){} }
        if(du){ m.src=du; m.style.display='block'; say('CONNECTED ✓ + image via tools/call ✓'); }
        else { say('CONNECTED ✓ but tools/call returned no image'); }
      }, function(err){ say('CONNECTED ✓ but tools/call FAILED: ' + (err&&err.message?err.message:err)); });
  }, function(err){ say('connect() FAILED: ' + (err && err.message ? err.message : err)); });
})();
</script>
</body></html>`;
  }

  // The interactive map (SWA / MapLibre) is embedded as a nested iframe. Cowork
  // honours `frameDomains` (set on the UI resource's `_meta.ui.csp`), and the SWA
  // is its own origin, so it loads its own tiles and is fully pannable / zoomable
  // INLINE. An optional pre-rendered `data:` image sits behind it as a poster.
  const posterHtml = dataUrl
    ? `<img class="poster" id="poster" alt="${titleHtml}" src="${dataUrl}" />`
    : "";
  let slotInner: string;
  if (liveUrl) {
    slotInner =
      `<div class="frame">` +
      posterHtml +
      `<iframe class="live" id="live" src="${esc(liveUrl)}" loading="eager" title="${titleHtml}" allow="fullscreen; geolocation"></iframe>` +
      `</div>`;
  } else if (dataUrl) {
    slotInner = `<div class="frame">${posterHtml}</div>`;
  } else {
    slotInner = `<div class="msg">Map unavailable.</div>`;
  }
  const goStyle = liveUrl ? "" : ' style="display:none"';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TomTom Live Map</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; font-family:'Segoe UI',system-ui,sans-serif; }
  .wrap { padding:8px; }
  .title { font-size:14px; font-weight:600; margin:2px 4px 8px; }
  .hdr { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:600; color:#fff; background:#E2231A; padding:8px 12px; border-radius:8px 8px 0 0; }
  .hdr .dot { width:10px; height:10px; border-radius:50%; background:#fff; display:inline-block; }
  .map { width:100%; border:0; border-radius:10px; overflow:hidden; background:#eef1f5; display:block; }
  .frame { width:100%; aspect-ratio: 8 / 5; min-height:320px; position:relative; border-radius:0 0 10px 10px; overflow:hidden; background:#eef1f5; }
  .frame .poster { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; z-index:0; }
  .frame .live { position:absolute; inset:0; width:100%; height:100%; border:0; z-index:1; background:transparent; }
  img.map { object-fit:cover; }
  .ctrls { position:absolute; top:10px; right:10px; display:flex; flex-direction:column; gap:6px; z-index:4; }
  .ctrls button { width:34px; height:34px; border:0; border-radius:8px; background:rgba(255,255,255,.92); color:#111; font-size:18px; font-weight:700; line-height:1; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,.35); }
  .ctrls button:hover, .pad button:hover { background:#fff; }
  .pad { position:absolute; bottom:10px; right:10px; display:grid; grid-template-columns:repeat(3,30px); grid-template-rows:repeat(3,30px); gap:3px; z-index:4; }
  .pad button { border:0; border-radius:7px; background:rgba(255,255,255,.92); color:#111; font-size:11px; line-height:1; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,.3); padding:0; }
  .pad button[data-act=up]{ grid-column:2; grid-row:1; }
  .pad button[data-act=left]{ grid-column:1; grid-row:2; }
  .pad button[data-act=right]{ grid-column:3; grid-row:2; }
  .pad button[data-act=down]{ grid-column:2; grid-row:3; }
  .spin { position:absolute; left:10px; top:10px; background:rgba(0,0,0,.6); color:#fff; font-size:11px; padding:3px 8px; border-radius:6px; z-index:5; }
  .bar { display:flex; gap:8px; align-items:center; margin-top:8px; }
  button.go { border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; font-weight:600; background:#E2231A; color:#fff; }
  .msg { padding:16px; font-size:13px; color:#666; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr"><span class="dot"></span><span id="t">${titleHtml}</span></div>
  <div id="slot">${slotInner}</div>
  <div class="bar"><button class="go" id="go"${goStyle}>Expand to full screen</button></div>
</div>
<script>${sdk}</script>
<script>
(function(){
  var INIT = ${init};
  var tEl = document.getElementById('t');
  var go = document.getElementById('go');
  var curMode = 'inline';
  function setGoLabel(){ if(go){ go.textContent = (curMode === 'fullscreen') ? 'Exit full screen' : 'Expand to full screen'; } }
  function applyTheme(ctx){
    try {
      if(ctx && ctx.theme){ document.documentElement.style.colorScheme = ctx.theme; }
      var v = ctx && ctx.styles && ctx.styles.variables;
      if(v){ for(var k in v){ if(v[k] != null){ document.documentElement.style.setProperty(k, v[k]); } } }
    } catch(e){}
  }

  // The map is the embedded SWA iframe; it renders regardless of the handshake.
  // The official ext-apps App SDK (inlined above as window.App) drives the
  // SEP-1865 lifecycle so Cowork mounts us and clears the loading skeleton.
  var App = window.App;
  if(!App){ return; }

  var app = new App(
    { name: "tomtom-live-map", version: "1.0.0" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: true }
  );

  // Register handlers BEFORE connect() so no early notifications are missed.
  app.ontoolresult = function(res){
    try {
      var sc = res && res.structuredContent;
      if(sc && sc.title && tEl){ tEl.textContent = sc.title; }
      if(sc && sc.interactiveUrl){
        var f = document.getElementById('live');
        if(f && f.getAttribute('src') !== sc.interactiveUrl){ f.setAttribute('src', sc.interactiveUrl); }
      }
    } catch(e){}
  };
  app.ontoolinput = function(){};
  app.onhostcontextchanged = function(ctx){
    try { if(ctx && ctx.displayMode){ curMode = ctx.displayMode; setGoLabel(); } applyTheme(ctx); } catch(e){}
  };
  app.onerror = function(e){ try { console.error('mcp-app', e); } catch(_){ } };

  if(go){
    go.addEventListener('click', function(){
      var want = (curMode === 'fullscreen') ? 'inline' : 'fullscreen';
      try {
        var p = app.requestDisplayMode ? app.requestDisplayMode({ mode: want }) : null;
        if(p && p.then){ p.then(function(r){ if(r && r.mode){ curMode = r.mode; setGoLabel(); } }, function(){}); }
      } catch(e){}
    });
  }

  app.connect().then(function(){
    try {
      var ctx = app.getHostContext ? app.getHostContext() : null;
      if(ctx){ if(ctx.displayMode){ curMode = ctx.displayMode; setGoLabel(); } applyTheme(ctx); }
    } catch(e){}
  }, function(e){ try { console.error('mcp-app connect failed', e); } catch(_){ } });
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function renderLiveMapResult(
  ctx: GatewayContext,
  id: number | string | null,
  rawArgs: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const a = (rawArgs || {}) as LiveMapArgs;
  const dynamicArgs = buildDynamicMapArgs(a);
  const animate = a.animate === true;
  if (animate) {
    // Give the fly-in a focal centre + target zoom even if the caller omitted them.
    const c = pickCenter(a);
    if (c) {
      dynamicArgs.center = { lat: c.lat, lon: c.lon };
      dynamicArgs.zoom = clampInt(a.zoom, 0, 22, 14);
    }
  }
  const imageArgs = base64Json(dynamicArgs);
  const imageUrl = animate
    ? buildAnimationUrl(ctx, "tomtom-dynamic-map", dynamicArgs, a.animationEffect)
    : buildImageUrl(ctx, "tomtom-dynamic-map", dynamicArgs);
  const liveUrl = buildInteractiveUrl(ctx, a) ?? null;
  const title = a.title ? String(a.title) : "Map";
  const widget = ctx.widgetEnabled === true;

  // Build the base result. `structuredContent` (compact) feeds both the agent and
  // — when enabled — the widget; `content` keeps it self-sufficient for the agent.
  const result: JsonRpcResponse["result"] = {
    content: [],
    structuredContent: {
      title,
      imageUrl,
      imageArgs,
      imageTool: "tomtom-dynamic-map",
      interactiveUrl: liveUrl,
    },
    isError: false,
  };

  if (widget) {
    // Cache the fully-built interactive (SWA) URL + title for THIS MCP session.
    // Cowork mounts the widget via `resources/read` for the static `ui://` URI and
    // re-attaches the same `Mcp-Session-Id`, so handleResourcesRead rebuilds the
    // right widget (interactive SWA iframe, overlay-aware) from this entry. We do
    // NOT pre-render a poster image here — the embedded SWA iframe IS the live
    // map, so `resources/read` stays instant and the handshake isn't delayed.
    rememberMap(ctx.sessionId, "tomtom-dynamic-map", dynamicArgs, null, liveUrl, title);
    result.content = [
      {
        type: "text",
        text: liveUrl
          ? `Showing an interactive map of ${title} inline — pan, zoom, and live traffic. ` +
            `If the map isn't visible, share this link: ${liveUrl}`
          : `Showing a map of ${title} inline.`,
      },
    ];
    result._meta = {
      ui: { resourceUri: UI_RESOURCE_STATIC },
      "openai/outputTemplate": UI_RESOURCE_STATIC,
    };
  } else {
    // Reliable path (no widget): the agent relays a CLICKABLE inline image —
    // `[![title](imageUrl)](liveUrl)` — so tapping the map opens the full
    // pan/zoom/traffic interactive map, plus a text link as a guaranteed
    // fallback. This renders cleanly in Cowork with no widget host involved.
    result.content = [
      {
        type: "text",
        text: liveUrl
          ? `Map of ${title} is ready. Reply to the user with this exact markdown (a clickable map image, then the link):\n\n` +
            `[![${title}](${imageUrl})](${liveUrl})\n\n` +
            `🗺️ **[Open the interactive live map](${liveUrl})** — tap the map above or this link to pan, zoom, and toggle live traffic.`
          : `Map of ${title} is ready. Reply to the user with this exact markdown:\n\n![${title}](${imageUrl})`,
      },
    ];
  }

  return { jsonrpc: "2.0", id, result };
}

/** App-callable tool: render a map image and return it as a `data:` URL. */
async function mapImageResult(
  ctx: GatewayContext,
  id: number | string | null,
  args: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const tool = typeof args.tool === "string" ? args.tool : "tomtom-dynamic-map";
  const b64 = typeof args.argsB64 === "string" ? args.argsB64 : "";
  const dynArgs = decodeArgsB64(b64);
  let dataUrl: string | null = null;
  try {
    dataUrl = await fetchMapDataUrl(ctx, tool, dynArgs);
  } catch {
    dataUrl = null;
  }
  if (!dataUrl) {
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "No image." }], isError: true },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: dataUrl }],
      structuredContent: { dataUrl },
      isError: false,
    },
  };
}

async function handleToolsList(
  id: number | string | null,
  ctx: GatewayContext
): Promise<JsonRpcResponse> {
  const upstream = await callMcpRpc("tools/list", {}, ctx.apiKey, ctx.mcpUrl, id ?? 1, ctx.mapsBackend);
  if (upstream.error) {
    return { jsonrpc: "2.0", id, error: upstream.error };
  }

  const result = upstream.result ?? {};
  const rawTools = Array.isArray(result.tools)
    ? (result.tools as Array<Record<string, unknown>>)
    : [];

  const tools = rawTools
    .filter((t) => !BLOCKED_TOOLS.has(String(t?.name)))
    .map((t) => {
      // Drop upstream `_meta` so Cowork does not try to mount the upstream MCP
      // App widgets — their HTML fetches map tiles/SDK from external domains,
      // which Cowork's iframe CSP blocks. We provide our own widget instead.
      const tool: Record<string, unknown> = { ...t };
      delete tool._meta;
      const existing =
        tool.annotations && typeof tool.annotations === "object"
          ? (tool.annotations as Record<string, unknown>)
          : {};
      tool.annotations = { readOnlyHint: true, ...existing };
      return tool;
    });

  // `render_live_map` declares an MCP Apps widget via `_meta.ui`. Strip it unless
  // the widget is explicitly enabled (Cowork's host times out on it today), so
  // Cowork shows no "didn't respond in time" banner and we fall back to the
  // reliable clickable inline image (see renderLiveMapResult).
  const renderTool: Record<string, unknown> = {
    ...(RENDER_LIVE_MAP_TOOL as unknown as Record<string, unknown>),
  };
  if (!ctx.widgetEnabled) delete renderTool._meta;
  tools.push(renderTool);
  tools.push(MAP_IMAGE_TOOL_DEF as unknown as Record<string, unknown>);

  return { jsonrpc: "2.0", id, result: { tools } };
}

async function handleToolsCall(
  id: number | string | null,
  params: Record<string, unknown> | undefined,
  ctx: GatewayContext
): Promise<JsonRpcResponse> {
  const name = String(params?.name ?? "");
  const args = (params?.arguments as Record<string, unknown>) ?? {};
  console.log(`mcpGateway: tools/call ${name} session=${ctx.sessionId ?? "-"}`);

  if (BLOCKED_TOOLS.has(name)) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Tool not available: ${name}` },
    };
  }

  if (name === RENDER_LIVE_MAP) {
    return await renderLiveMapResult(ctx, id, args);
  }

  if (name === MAP_IMAGE_TOOL) {
    return mapImageResult(ctx, id, args);
  }

  const upstream = await callMcpRpc(
    "tools/call",
    { name, arguments: args },
    ctx.apiKey,
    ctx.mcpUrl,
    id ?? 1,
    ctx.mapsBackend
  );
  if (upstream.error) {
    return { jsonrpc: "2.0", id, error: upstream.error };
  }

  // Image tools: replace the bulky base64 image with our own widget binding so
  // the map renders in Cowork. Other tools: strip upstream widget hints so
  // Cowork does not attempt to mount a (non-loadable) upstream widget.
  if (upstream.result) {
    if (IMAGE_TOOLS.has(name)) {
      transformImageResult(upstream, ctx, name, args);
    } else {
      stripUpstreamWidget(upstream.result);
    }
  }

  upstream.id = id;
  return upstream;
}

/**
 * True only for a *pure* upstream UI-marker block — a text block whose JSON is
 * essentially just `{ "_meta": { "show_ui": ... } }` with no real payload.
 *
 * IMPORTANT: upstream tools (geocode, search, routing, EV, …) append a
 * top-level `"_meta": { "show_ui": false }` sibling NEXT TO their real data
 * (e.g. a GeoJSON FeatureCollection). A naive substring check would treat that
 * whole data block as a marker and drop it, leaving `content: []`. So we parse
 * the JSON and only flag blocks that carry nothing of substance beyond `_meta`.
 */
function isPureShowUiMarker(text?: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t.startsWith("{") || !t.includes("_meta")) return false;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object") return false;
  const keys = Object.keys(obj as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => k === "_meta");
}

/**
 * If a text block is JSON carrying a top-level `_meta` sibling alongside real
 * data, removes just the `_meta` (a widget hint the agent shouldn't see) and
 * returns the re-serialized text. Returns null when there is nothing to change.
 */
function stripTopLevelMetaFromText(text?: string): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith("{") || !t.includes("_meta")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || !("_meta" in obj)) return null;
  delete obj._meta;
  return JSON.stringify(obj, null, 2);
}

/**
 * Removes upstream MCP App widget hints so Cowork won't mount a broken widget,
 * WITHOUT discarding real tool output. Pure `_meta` marker blocks are dropped;
 * data blocks that merely carry a top-level `_meta` sibling keep their payload
 * with just the `_meta` stripped.
 */
function stripUpstreamWidget(result: Record<string, unknown>): void {
  if (result._meta) delete result._meta;
  const content = result.content;
  if (!Array.isArray(content)) return;
  const out: McpBlock[] = [];
  for (const b of content as McpBlock[]) {
    if (b && b.type === "text") {
      if (isPureShowUiMarker(b.text)) continue; // drop pure UI-marker blocks
      const cleaned = stripTopLevelMetaFromText(b.text);
      if (cleaned !== null) {
        out.push({ ...b, text: cleaned });
        continue;
      }
    }
    out.push(b);
  }
  result.content = out;
}

function transformImageResult(
  env: JsonRpcResponse,
  ctx: GatewayContext,
  tool: string,
  args: Record<string, unknown>
): void {
  const result = env.result;
  if (!result) return;

  const dynArgs =
    tool === "tomtom-dynamic-map" ? { ...args, detail: "compact" } : { ...args };
  // Capture the upstream-rendered image so the widget can show it inline as a
  // data: URL (nested iframes to our origin are blocked by Cowork's sandbox).
  let dataUrl: string | null = null;
  if (Array.isArray(result.content)) {
    for (const b of result.content as McpBlock[]) {
      if (b && b.type === "image" && typeof b.data === "string") {
        dataUrl = `data:${b.mimeType || "image/png"};base64,${b.data}`;
        break;
      }
    }
  }
  rememberMap(ctx.sessionId, tool, dynArgs, dataUrl);
  const token = encodeMapToken(tool, dynArgs);
  const imageUrl = buildImageUrl(ctx, tool, dynArgs);
  const imageArgs = base64Json(dynArgs);
  const liveUrl =
    tool === "tomtom-dynamic-map"
      ? buildInteractiveUrl(ctx, dynamicArgsToLive(args)) ?? null
      : null;

  // Keep the upstream text (minus the show_ui marker); drop the bulky base64 image.
  const textBlocks = Array.isArray(result.content)
    ? (result.content as McpBlock[]).filter(
        (b) => b && b.type === "text" && !isPureShowUiMarker(b.text)
      )
    : [];
  result.content = textBlocks.length
    ? textBlocks
    : [{ type: "text", text: "Map rendered." }];

  result.structuredContent = {
    ...((result.structuredContent as Record<string, unknown>) || {}),
    imageUrl,
    imageArgs,
    imageTool: tool,
    interactiveUrl: liveUrl,
  };

  const resourceUri = `${UI_RESOURCE_BASE}/${token}.html`;
  result._meta = {
    ui: { resourceUri },
    "openai/outputTemplate": resourceUri,
  };
}

// ---------------------------------------------------------------------------
// Resources (MCP Apps widget templates)
// ---------------------------------------------------------------------------

function handleResourcesList(
  id: number | string | null
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resources: [
        {
          uri: UI_RESOURCE_STATIC,
          name: "TomTom Live Map",
          description: "Interactive TomTom map widget for Cowork.",
          mimeType: UI_MIME,
        },
      ],
    },
  };
}

function handleResourcesTemplatesList(
  id: number | string | null
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resourceTemplates: [
        {
          uriTemplate: `${UI_RESOURCE_BASE}/{token}.html`,
          name: "TomTom Live Map",
          mimeType: UI_MIME,
        },
      ],
    },
  };
}

async function handleResourcesRead(
  id: number | string | null,
  params: Record<string, unknown> | undefined,
  ctx: GatewayContext
): Promise<JsonRpcResponse> {
  const uri = String(params?.uri ?? "");
  console.log(
    `mcpGateway: resources/read uri=${uri} session=${ctx.sessionId ?? "-"}`
  );

  // Diagnostic channel: the widget reads ui://tomtom-cowork/diag/<info>.html
  // (forwarded by Cowork) to report its environment to our logs.
  if (uri.startsWith(`${UI_RESOURCE_BASE.replace("/live-map", "")}/diag/`)) {
    return {
      jsonrpc: "2.0",
      id,
      result: { contents: [{ uri, mimeType: UI_MIME, text: "<!doctype html>" }] },
    };
  }

  if (uri === UI_RESOURCE_STATIC || uri.startsWith(`${UI_RESOURCE_BASE}/`)) {
    // Prefer the per-call token (if Cowork echoes it); otherwise fall back to the
    // most recent map for this MCP session (the static-URI mount path).
    let baked:
      | {
          tool: string;
          args: Record<string, unknown>;
          dataUrl?: string | null;
          liveUrl?: string | null;
          title?: string | null;
        }
      | null = null;
    const match = uri.match(/\/live-map\/(.+?)\.html$/);
    if (match) {
      const decoded = decodeMapToken(match[1]);
      if (decoded) baked = { tool: decoded.tool, args: decoded.args };
    }
    if (!baked) {
      const recalled = recallMap(ctx.sessionId);
      if (recalled)
        baked = {
          tool: recalled.tool,
          args: recalled.args,
          dataUrl: recalled.dataUrl,
          liveUrl: recalled.liveUrl,
          title: recalled.title,
        };
    }
    console.log(
      `mcpGateway: live-map widget session=${ctx.sessionId ?? "-"} baked=${
        baked ? "yes" : "no"
      } liveUrl=${baked && baked.liveUrl ? "yes" : "no"}`
    );
    const html = buildWidgetHtml(ctx, baked);
    const domains = frameDomainsFor(ctx);
    console.log(
      `mcpGateway: live-map html bytes=${html.length} dataUrlBytes=${
        baked && baked.dataUrl ? baked.dataUrl.length : 0
      }`
    );
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri,
            mimeType: UI_MIME,
            text: html,
            _meta: {
              ui: {
                csp: {
                  frameDomains: domains,
                  connectDomains: domains,
                  resourceDomains: domains,
                },
              },
            },
          },
        ],
      },
    };
  }

  // Any other resource (e.g. an upstream ui://) is proxied through.
  const upstream = await callMcpRpc(
    "resources/read",
    { uri },
    ctx.apiKey,
    ctx.mcpUrl,
    id ?? 1,
    ctx.mapsBackend
  );
  upstream.id = id;
  return upstream;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Handles a single JSON-RPC request on behalf of Cowork. Returns the response
 * envelope, or `null` for notifications (which receive an HTTP 202 with no body).
 */
export async function handleGatewayRpc(
  request: JsonRpcRequest,
  ctx: GatewayContext
): Promise<JsonRpcResponse | null> {
  const isNotification = request.id === undefined || request.id === null;
  const id: number | string | null = isNotification ? null : request.id!;
  const method = request.method;

  switch (method) {
    case "initialize": {
      const requested = request.params?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: "tomtom-cowork-gateway",
            title: "TomTom Maps & Traffic (Cowork Gateway)",
            version: "1.0.0",
          },
          instructions:
            "TomTom location, routing, traffic and EV tools with live map rendering. " +
            "Use the render_live_map tool to visualise any result on a live, interactive map.",
        },
      };
    }

    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return handleToolsList(id, ctx);

    case "tools/call":
      return handleToolsCall(id, request.params, ctx);

    case "resources/list":
      return handleResourcesList(id);

    case "resources/templates/list":
      return handleResourcesTemplatesList(id);

    case "resources/read":
      return handleResourcesRead(id, request.params, ctx);

    default:
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
