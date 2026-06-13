import { Request, Response } from "express";
import Jimp from "jimp";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { callMcpTool } from "../lib/mcpClient";

/**
 * Express route handler that serves an ANIMATED map as a GIF.
 *
 * Cowork renders a markdown image inline and browsers auto-play GIFs, so this
 * gives genuine motion inside the chat bubble (a cinematic "fly-in" zoom toward
 * the location) without depending on the (host-blocked) interactive widget.
 *
 * It reuses the existing static-map pipeline: it calls the upstream
 * `tomtom-dynamic-map` tool N times at increasing (or decreasing) zoom levels,
 * decodes each frame with Jimp, then quantizes + encodes them into a single
 * looping GIF with the pure-JS `gifenc` encoder.
 *
 * GET /api/get-map-animation?tool=<tool>&args=<base64JSON>&frames=<n>&effect=<zoom-in|zoom-out>&apiKey=<key>
 *
 * Query parameters:
 *   - tool:   MCP tool name. Defaults to "tomtom-dynamic-map".
 *   - args:   Base64-encoded JSON of the base map arguments (center/markers/route/zoom).
 *   - frames: Number of frames (2-10). Default 6.
 *   - effect: "zoom-in" (default) or "zoom-out".
 *   - span:   How many zoom levels the fly-in spans. Default 5.
 *   - w/h:    Frame width/height in px. Defaults 640 x 400.
 *   - apiKey: Optional TomTom key override (else TOMTOM_API_KEY env).
 */

interface LatLon {
  lat: number;
  lon: number;
}

function isLatLon(v: unknown): v is LatLon {
  return (
    typeof v === "object" &&
    v !== null &&
    Number.isFinite((v as LatLon).lat) &&
    Number.isFinite((v as LatLon).lon)
  );
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Picks a map centre from the base args (centre / markers / route). */
function deriveCenter(args: Record<string, unknown>): LatLon | null {
  if (isLatLon(args.center)) {
    return { lat: (args.center as LatLon).lat, lon: (args.center as LatLon).lon };
  }
  const markers = Array.isArray(args.markers)
    ? (args.markers as unknown[]).filter(isLatLon)
    : [];
  if (markers.length > 0) {
    const lat = markers.reduce((s, m) => s + m.lat, 0) / markers.length;
    const lon = markers.reduce((s, m) => s + m.lon, 0) / markers.length;
    return { lat, lon };
  }
  const plans = args.routePlans;
  if (Array.isArray(plans) && plans.length > 0) {
    const p = plans[0] as Record<string, unknown>;
    if (isLatLon(p.origin) && isLatLon(p.destination)) {
      return {
        lat: ((p.origin as LatLon).lat + (p.destination as LatLon).lat) / 2,
        lon: ((p.origin as LatLon).lon + (p.destination as LatLon).lon) / 2,
      };
    }
    if (isLatLon(p.origin)) return p.origin as LatLon;
  }
  return null;
}

async function getMapAnimation(req: Request, res: Response): Promise<void> {
  console.log("getMapAnimation: Processing request");

  const tool = (req.query.tool as string) || "tomtom-dynamic-map";
  const argsBase64 = req.query.args as string | undefined;
  const apiKeyParam = req.query.apiKey as string | undefined;
  const apiKey = apiKeyParam || process.env.TOMTOM_API_KEY;
  const mcpUrl = process.env.MCP_SERVER_URL;
  const backend = process.env.MCP_MAPS_BACKEND || "tomtom-orbis-maps";

  if (!apiKey) {
    res.status(400).json({ error: "No API key. Pass apiKey or set TOMTOM_API_KEY." });
    return;
  }
  if (!mcpUrl) {
    res.status(500).json({ error: "Server misconfigured: missing MCP_SERVER_URL." });
    return;
  }

  // Decode base args
  let base: Record<string, unknown> = {};
  if (argsBase64) {
    try {
      const safe = argsBase64.replace(/-/g, "+").replace(/_/g, "/");
      base = JSON.parse(Buffer.from(safe, "base64").toString("utf-8")) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Parse error";
      res.status(400).json({ error: `Invalid args. Must be base64 JSON. ${message}` });
      return;
    }
  }

  // Animation parameters
  const frames = clampInt(req.query.frames, 2, 10, 6);
  const effect = (req.query.effect as string) === "zoom-out" ? "zoom-out" : "zoom-in";
  const span = clampInt(req.query.span, 1, 10, 5);
  const W = clampInt(req.query.w, 160, 1024, 640);
  const H = clampInt(req.query.h, 120, 1024, 400);

  // Force a consistent frame size + compact response.
  base.width = W;
  base.height = H;
  base.showLabels = true;
  base.detail = "compact";

  // The dynamic-map tool needs content to render. If only a centre was given,
  // inject a marker there so every frame has a focal pin.
  const center = deriveCenter(base);
  const hasContent =
    (Array.isArray(base.markers) && (base.markers as unknown[]).length > 0) ||
    (Array.isArray(base.routePlans) && (base.routePlans as unknown[]).length > 0);
  if (!hasContent && center) {
    base.markers = [{ lat: center.lat, lon: center.lon, priority: "high" }];
  }

  // Build the per-frame zoom ladder (cinematic fly-in / out).
  const targetZoom = clampInt(base.zoom, 1, 22, 14);
  const startZoom = Math.max(1, targetZoom - span);
  const zooms: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? 1 : i / (frames - 1);
    zooms.push(Math.round((startZoom + (targetZoom - startZoom) * t) * 10) / 10);
  }
  if (effect === "zoom-out") zooms.reverse();

  // Each frame keeps the same content but overrides centre + zoom.
  const frameArgsList = zooms.map((z) => {
    const fa: Record<string, unknown> = { ...base, zoom: z };
    if (center) fa.center = { lat: center.lat, lon: center.lon };
    return fa;
  });

  // Fetch all frames in parallel (a handful of fast static-map calls).
  let results: Array<Awaited<ReturnType<typeof callMcpTool>> | null>;
  try {
    results = await Promise.all(
      frameArgsList.map((fa) =>
        callMcpTool(tool, fa, apiKey, mcpUrl, backend).catch(() => null)
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown MCP error";
    res.status(502).json({ error: `MCP server error: ${message}` });
    return;
  }

  // Decode each rendered frame to a W x H RGBA bitmap.
  const bitmaps: Buffer[] = [];
  for (const r of results) {
    if (r && r.imageBase64) {
      try {
        const img = await Jimp.read(Buffer.from(r.imageBase64, "base64"));
        if (img.bitmap.width !== W || img.bitmap.height !== H) {
          img.cover(W, H);
        }
        bitmaps.push(img.bitmap.data);
      } catch {
        /* skip undecodable frame */
      }
    }
  }

  if (bitmaps.length === 0) {
    res.status(502).json({ error: "No frames could be rendered for the animation." });
    return;
  }

  // Single usable frame: still return a valid (1-frame) GIF.
  try {
    const gif = GIFEncoder();
    bitmaps.forEach((data, idx) => {
      const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      const isLast = idx === bitmaps.length - 1;
      const delay = isLast ? 1400 : idx === 0 ? 650 : 430;
      const opts: Record<string, unknown> = { palette, delay };
      if (idx === 0) opts.repeat = 0; // loop forever
      gif.writeFrame(index, W, H, opts);
    });
    gif.finish();
    const out = Buffer.from(gif.bytes());

    console.log(
      `getMapAnimation: Returning GIF (${out.length} bytes, ${bitmaps.length}/${frames} frames, ${W}x${H}, ${effect})`
    );
    res
      .status(200)
      .set({
        "Content-Type": "image/gif",
        "Content-Length": out.length.toString(),
        "Cache-Control": "public, max-age=300",
      })
      .send(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GIF encode error";
    console.error(`getMapAnimation: encode failed: ${message}`);
    res.status(500).json({ error: `Animation encode failed: ${message}` });
  }
}

export default getMapAnimation;
