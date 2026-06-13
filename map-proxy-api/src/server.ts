import express from "express";
import cors from "cors";
import generateMapCard from "./functions/generateMapCard";
import getMapImage from "./functions/getMapImage";
import getMapAnimation from "./functions/getMapAnimation";
import { mcpGateway, mcpGatewayProbe, mcpDiag } from "./functions/mcpGateway";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Map card generation (POST)
app.post("/api/generate-map-card", generateMapCard);

// Map image proxy (GET)
app.get("/api/get-map-image", getMapImage);

// Animated map proxy — returns a looping GIF fly-in (GET)
app.get("/api/get-map-animation", getMapAnimation);

// MCP gateway for Microsoft Copilot Cowork (Streamable HTTP, JSON-RPC 2.0)
app.post("/api/mcp", mcpGateway);
app.get("/api/mcp", mcpGatewayProbe);

// Diagnostic beacon for the Cowork widget (logs to server console).
app.get("/api/diag", mcpDiag);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  const tomtomKey = process.env.TOMTOM_API_KEY ? "set" : "NOT SET";
  const mcpUrl = process.env.MCP_SERVER_URL || "NOT SET";
  const mapUrl = process.env.INTERACTIVE_MAP_URL || "NOT SET";
  const publicBase = process.env.PUBLIC_BASE_URL || "(derived from request)";
  const mapsBackend = process.env.MCP_MAPS_BACKEND || "tomtom-orbis-maps";

  console.log(`Map Proxy API server listening on port ${PORT}`);
  console.log(`  TOMTOM_API_KEY:      ${tomtomKey}`);
  console.log(`  MCP_SERVER_URL:      ${mcpUrl}`);
  console.log(`  MCP_MAPS_BACKEND:    ${mapsBackend}`);
  console.log(`  INTERACTIVE_MAP_URL: ${mapUrl}`);
  console.log(`  PUBLIC_BASE_URL:     ${publicBase}`);
  console.log(`  Cowork MCP gateway:  POST /api/mcp`);
});
