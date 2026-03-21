import express from "express";
import cors from "cors";
import generateMapCard from "./functions/generateMapCard";
import getMapImage from "./functions/getMapImage";

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

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  const tomtomKey = process.env.TOMTOM_API_KEY ? "set" : "NOT SET";
  const mcpUrl = process.env.MCP_SERVER_URL || "NOT SET";
  const mapUrl = process.env.INTERACTIVE_MAP_URL || "NOT SET";

  console.log(`Map Proxy API server listening on port ${PORT}`);
  console.log(`  TOMTOM_API_KEY:     ${tomtomKey}`);
  console.log(`  MCP_SERVER_URL:     ${mcpUrl}`);
  console.log(`  INTERACTIVE_MAP_URL: ${mapUrl}`);
});
