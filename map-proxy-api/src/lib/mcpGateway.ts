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
  ts: number;
}
const SESSION_MAPS = new Map<string, StoredMap>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 500;

function rememberMap(
  sessionId: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  dataUrl?: string | null
): void {
  if (!sessionId) return;
  if (SESSION_MAPS.size >= SESSION_MAX) {
    const oldest = SESSION_MAPS.keys().next().value;
    if (oldest) SESSION_MAPS.delete(oldest);
  }
  SESSION_MAPS.set(sessionId, { tool, args, dataUrl: dataUrl ?? null, ts: Date.now() });
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
    "traffic=true to show live traffic. Always prefer this tool to show results on a map.",
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
 * sandboxed iframe. The widget performs the SEP-1865 handshake (ui/initialize ->
 * ui/notifications/initialized) and reports its size so the host dismisses the
 * loading skeleton. Its PRIMARY content is the full interactive map (the SWA /
 * MapLibre app) embedded as a nested iframe: Cowork honours `frameDomains` on the
 * UI resource's `_meta.ui.csp`, and the SWA is its own origin, so it loads its own
 * tiles and gives real inline pan / zoom / live-traffic. The pre-rendered `data:`
 * image sits behind it as an instant poster + fallback. The TomTom key stays
 * server-side (the SWA deep link uses the referrer-restricted client key).
 */
function buildWidgetHtml(
  ctx: GatewayContext,
  baked: { tool: string; args: Record<string, unknown>; dataUrl?: string | null } | null
): string {
  let dataUrl: string | null = null;
  let liveUrl: string | null = null;
  let imageUrl: string | null = null;
  let title = "Map";

  if (baked) {
    const tool = baked.tool || "tomtom-dynamic-map";
    imageUrl = buildImageUrl(ctx, tool, baked.args);
    if (tool === "tomtom-dynamic-map") {
      liveUrl = buildInteractiveUrl(ctx, dynamicArgsToLive(baked.args)) ?? null;
    }
    if (typeof baked.args.title === "string") title = baked.args.title as string;
    dataUrl = baked.dataUrl ?? null;
  }

  const init = JSON.stringify({
    dataUrl,
    imageUrl,
    liveUrl,
    title,
    mapArgs: baked ? baked.args : null,
  }).replace(/</g, "\\u003c");
  const mapImageToolName = JSON.stringify(MAP_IMAGE_TOOL);

  // PRIMARY content = the full interactive map (SWA / MapLibre) embedded as a
  // nested iframe. Cowork honours `frameDomains` (set on the UI resource's
  // `_meta.ui.csp`), and the SWA is its own origin, so it loads its own tiles and
  // is fully pannable / zoomable INLINE. The pre-rendered `data:` image sits
  // BEHIND it as an instant poster (no blank flash) and as a fallback if the
  // iframe is ever unavailable — so the map is visible with zero script reliance.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const titleHtml = esc(title);
  const posterHtml = dataUrl
    ? `<img class="poster" id="poster" alt="${titleHtml}" src="${dataUrl}" />`
    : "";
  let slotInner: string;
  if (liveUrl) {
    slotInner =
      `<div class="frame">` +
      posterHtml +
      `<iframe class="live" id="live" src="${esc(liveUrl)}" loading="eager" title="${titleHtml}"></iframe>` +
      `</div>`;
  } else if (dataUrl) {
    slotInner = `<div class="frame">${posterHtml}</div>`;
  } else if (imageUrl) {
    slotInner = `<div class="frame"><iframe class="live" src="${esc(imageUrl)}" loading="eager" scrolling="no"></iframe></div>`;
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
<script>
(function(){
  var INIT = ${init};
  var MAP_IMAGE_TOOL = ${mapImageToolName};
  var PROTOCOL = "2026-01-26";
  var liveUrl = INIT.liveUrl || null;
  var slot = document.getElementById('slot');
  var go = document.getElementById('go');
  var tEl = document.getElementById('t');

  // ---- JSON-RPC 2.0 over postMessage (SEP-1865 iframe transport) ----
  var nextId = 1, pending = {};
  function post(m){ try { window.parent.postMessage(m, '*'); } catch(e){} }
  function request(method, params){
    var id = nextId++;
    return new Promise(function(resolve, reject){
      pending[id] = [resolve, reject];
      post({ jsonrpc:"2.0", id:id, method:method, params:params||{} });
      setTimeout(function(){ if(pending[id]){ delete pending[id]; reject(new Error('timeout')); } }, 5000);
    });
  }
  function notify(method, params){ post({ jsonrpc:"2.0", method:method, params:params||{} }); }

  // ---- SEP-1865 lifecycle state ----
  // The host shows a loading skeleton until the View completes the
  // ui/initialize -> ui/notifications/initialized handshake. Per spec the View
  // MUST send the handshake first; size notifications sent BEFORE 'initialized'
  // are ignored. The map (SWA iframe + poster image) is baked into the HTML, so
  // the visual never depends on this script — the handshake just clears the
  // skeleton, enables resizing, and wires the fullscreen toggle.
  var initialized = false;
  var handshakeDone = false;
  var curMode = "inline";
  var hostModes = ["inline"];

  // ---- size reporting (only AFTER the handshake completes) ----
  var lastH = 0, lastW = 0;
  function reportSize(){
    if(!initialized) return;
    var h = Math.ceil(Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight || 0));
    var w = Math.ceil(Math.max(document.body ? document.body.scrollWidth : 0, document.documentElement.scrollWidth || 0));
    if(h > 0 && (Math.abs(h - lastH) > 1 || Math.abs(w - lastW) > 1)){
      lastH = h; lastW = w;
      notify("ui/notifications/size-changed", { width: w, height: h });
    }
  }
  function startSizing(){
    initialized = true;
    try {
      if(window.ResizeObserver){
        var ro = new ResizeObserver(reportSize);
        ro.observe(document.documentElement);
        if(document.body) ro.observe(document.body);
      }
    } catch(e){}
    window.addEventListener('resize', reportSize);
    var live = document.getElementById('live');
    if(live){ live.addEventListener('load', reportSize); }
    reportSize();
  }

  function setTitle(t){ if(t){ tEl.textContent = t; document.title = t; } }
  function setLive(u){ if(u){ liveUrl = u; } if(liveUrl){ go.style.display='inline-block'; } }
  setTitle(INIT.title);
  setLive(INIT.liveUrl);

  // ---- theming + container sizing from host context ----
  function applyTheme(ctx){
    try {
      if(ctx && ctx.theme){ document.documentElement.style.colorScheme = ctx.theme; }
      var v = ctx && ctx.styles && ctx.styles.variables;
      if(v){ for(var k in v){ if(v[k] != null){ document.documentElement.style.setProperty(k, v[k]); } } }
    } catch(e){}
  }
  function applyDimensions(ctx){
    try {
      var cd = ctx && ctx.containerDimensions; if(!cd) return;
      var de = document.documentElement;
      if('height' in cd){ de.style.height = '100vh'; }
      else if(cd.maxHeight){ de.style.maxHeight = cd.maxHeight + 'px'; }
    } catch(e){}
  }

  // ---- fullscreen toggle (ui/open-link is NOT supported in Cowork; the
  // embedded SWA iframe is the interactive map, and fullscreen gives it room) ----
  function setGoLabel(){ go.textContent = (curMode === 'fullscreen') ? 'Exit full screen' : 'Expand to full screen'; }
  go.addEventListener('click', function(){
    var want = (curMode === 'fullscreen') ? 'inline' : 'fullscreen';
    request("ui/request-display-mode", { mode: want }).then(function(r){
      if(r && r.mode){ curMode = r.mode; setGoLabel(); reportSize(); }
    }).catch(function(){});
  });

  // ---- host -> view messages ----
  function respond(rid, result){ post({ jsonrpc:"2.0", id:rid, result: result||{} }); }
  function initResult(){
    return { protocolVersion: PROTOCOL,
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      appInfo: { name: "tomtom-live-map", version: "1.0.0" } };
  }
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if(!d || d.jsonrpc !== "2.0") return;

    // A response to one of OUR outgoing requests (resolve the pending promise).
    if(d.id != null && pending[d.id] && (d.result !== undefined || d.error !== undefined)){
      var p = pending[d.id]; delete pending[d.id];
      if(d.error){ p[1](new Error((d.error && d.error.message) || 'error')); } else { p[0](d.result); }
      return;
    }

    var m = d.method;
    if(!m) return;

    // Host -> View REQUESTS (have an id; the host waits for a response — failing
    // to answer is what triggers "widget didn't respond in time").
    if(d.id != null){
      if(m === 'ping'){ respond(d.id, {}); return; }
      if(m === 'ui/initialize'){
        // Some hosts INITIATE the handshake toward the View. Answer with our
        // capabilities, then complete our side.
        respond(d.id, initResult());
        finishHandshake(d.params || null);
        return;
      }
      if(m === 'ui/resource-teardown'){ respond(d.id, {}); return; }
      // Unknown request: acknowledge so the host never considers us unresponsive.
      respond(d.id, {});
      return;
    }

    // Host -> View NOTIFICATIONS (no id).
    if(m === 'ui/notifications/host-context-changed'){
      applyTheme(d.params); applyDimensions(d.params);
      if(d.params && d.params.displayMode){ curMode = d.params.displayMode; setGoLabel(); }
      reportSize();
      return;
    }
    if(m === 'ui/notifications/tool-result' || m === 'ui/notifications/tool-input'){
      // The map is already baked in; just keep the title/link in sync + remeasure.
      try {
        var sc = d.params && d.params.structuredContent;
        if(sc && sc.title) setTitle(sc.title);
        if(sc && sc.interactiveUrl) setLive(sc.interactiveUrl);
      } catch(e){}
      reportSize();
      return;
    }
  });

  // ---- handshake (idempotent): View-initiated ui/initialize -> initialized ----
  // We also answer a host-INITIATED ui/initialize (above). Whichever fires first
  // wins; finishHandshake is guarded so it runs exactly once.
  function finishHandshake(res){
    if(handshakeDone) return; handshakeDone = true;
    try {
      var ctx = (res && res.hostContext) ? res.hostContext : res;
      if(ctx){
        applyTheme(ctx); applyDimensions(ctx);
        if(ctx.displayMode){ curMode = ctx.displayMode; setGoLabel(); }
        if(ctx.availableDisplayModes){ hostModes = ctx.availableDisplayModes; }
      }
    } catch(e){}
    notify("ui/notifications/initialized", {});
    startSizing();
  }
  request("ui/initialize", initResult()).then(finishHandshake, function(){ finishHandshake(null); });

  // Fallback: if neither direction completes quickly, finish anyway so the
  // skeleton clears and the baked map shows.
  setTimeout(function(){ finishHandshake(null); }, 1200);
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
  const imageUrl = buildImageUrl(ctx, "tomtom-dynamic-map", dynamicArgs);
  const imageArgs = base64Json(dynamicArgs);
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
    // Pre-render a poster image and cache the map for THIS MCP session. Cowork
    // mounts the widget via `resources/read` for the static `ui://` URI and
    // re-attaches the same `Mcp-Session-Id`, so handleResourcesRead rebuilds the
    // right widget (interactive SWA iframe + poster fallback) from this entry.
    const center = pickCenter(a);
    const zoom =
      typeof a.zoom === "number"
        ? clampInt(a.zoom, 1, 22, 14)
        : a.route
        ? 11
        : a.markers && a.markers.length > 1
        ? 12
        : 15;
    const widgetArgs: Record<string, unknown> = { ...dynamicArgs, width: 640, height: 400 };
    if (center) {
      widgetArgs.center = center;
      widgetArgs.zoom = zoom;
    }
    let dataUrl: string | null = null;
    try {
      dataUrl = await fetchMapDataUrl(ctx, "tomtom-dynamic-map", widgetArgs);
    } catch {
      dataUrl = null;
    }
    rememberMap(ctx.sessionId, "tomtom-dynamic-map", widgetArgs, dataUrl);
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

/** True for the upstream `{ "_meta": { "show_ui": ... } }` marker text block. */
function isShowUiMetaText(text?: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  return t.startsWith("{") && t.includes('"_meta"') && t.includes("show_ui");
}

/** Removes upstream MCP App widget hints so Cowork won't mount a broken widget. */
function stripUpstreamWidget(result: Record<string, unknown>): void {
  if (result._meta) delete result._meta;
  const content = result.content;
  if (Array.isArray(content)) {
    result.content = (content as McpBlock[]).filter(
      (b) => !(b && b.type === "text" && isShowUiMetaText(b.text))
    );
  }
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
        (b) => b && b.type === "text" && !isShowUiMetaText(b.text)
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
    let baked: { tool: string; args: Record<string, unknown>; dataUrl?: string | null } | null = null;
    const match = uri.match(/\/live-map\/(.+?)\.html$/);
    if (match) {
      const decoded = decodeMapToken(match[1]);
      if (decoded) baked = { tool: decoded.tool, args: decoded.args };
    }
    if (!baked) {
      const recalled = recallMap(ctx.sessionId);
      if (recalled) baked = { tool: recalled.tool, args: recalled.args, dataUrl: recalled.dataUrl };
    }
    console.log(
      `mcpGateway: live-map widget session=${ctx.sessionId ?? "-"} baked=${
        baked ? "yes" : "no"
      } hasImage=${baked && baked.dataUrl ? "yes" : "no"}`
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
