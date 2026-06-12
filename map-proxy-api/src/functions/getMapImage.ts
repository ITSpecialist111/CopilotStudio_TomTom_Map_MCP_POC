import { Request, Response } from "express";
import { callMcpTool } from "../lib/mcpClient";

/**
 * Express route handler that serves map images directly as PNG.
 *
 * This allows Adaptive Cards (and other clients) to reference a map image
 * via a URL instead of embedding a potentially large base64 payload.
 *
 * GET /api/get-map-image?tool=<toolName>&args=<base64JSON>&apiKey=<key>
 *
 * Query parameters:
 *   - tool:   The MCP tool name (e.g., "tomtom-dynamic-map"). Defaults to "tomtom-dynamic-map".
 *   - args:   Base64-encoded JSON string of the tool arguments.
 *   - apiKey: (Optional) TomTom API key override. If omitted, the server-side
 *             TOMTOM_API_KEY environment variable is used.
 */
async function getMapImage(req: Request, res: Response): Promise<void> {
  console.log("getMapImage: Processing request");

  // Parse query parameters
  const tool = (req.query.tool as string) || "tomtom-dynamic-map";
  const argsBase64 = req.query.args as string | undefined;
  const apiKeyParam = req.query.apiKey as string | undefined;

  // Resolve API key: query param overrides env var
  const apiKey = apiKeyParam || process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    res.status(400).json({
      error:
        "No API key provided. Pass apiKey as a query parameter or set TOMTOM_API_KEY.",
    });
    return;
  }

  // Resolve MCP server URL
  const mcpUrl = process.env.MCP_SERVER_URL;
  if (!mcpUrl) {
    console.error("MCP_SERVER_URL is not configured.");
    res.status(500).json({ error: "Server misconfigured: missing MCP_SERVER_URL." });
    return;
  }

  // Decode args
  let toolArgs: Record<string, unknown> = {};
  if (argsBase64) {
    try {
      const decoded = Buffer.from(argsBase64, "base64").toString("utf-8");
      toolArgs = JSON.parse(decoded) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Parse error";
      res.status(400).json({
        error: `Invalid args parameter. Must be base64-encoded JSON. ${message}`,
      });
      return;
    }
  }

  // Call the MCP server
  try {
    console.log(
      `getMapImage: Calling MCP tool "${tool}" with args:`,
      JSON.stringify(toolArgs).substring(0, 200)
    );

    const result = await callMcpTool(
      tool,
      toolArgs,
      apiKey,
      mcpUrl,
      process.env.MCP_MAPS_BACKEND || "tomtom-orbis-maps"
    );

    if (!result.imageBase64) {
      res.status(404).json({
        error:
          "The MCP tool did not return an image. Ensure you are calling a map image tool.",
        text: result.text?.substring(0, 500),
      });
      return;
    }

    // Convert base64 to binary buffer
    const imageBuffer = Buffer.from(result.imageBase64, "base64");
    const mimeType = result.imageMimeType || "image/png";

    console.log(
      `getMapImage: Returning image (${imageBuffer.length} bytes, ${mimeType})`
    );

    res
      .status(200)
      .set({
        "Content-Type": mimeType,
        "Content-Length": imageBuffer.length.toString(),
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      })
      .send(imageBuffer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown MCP error";
    console.error(`getMapImage: MCP tool call failed: ${message}`);
    res.status(502).json({ error: `MCP server error: ${message}` });
  }
}

export default getMapImage;
