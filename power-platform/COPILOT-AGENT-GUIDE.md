# Copilot Studio Agent - TomTom MCP Integration

## Agent Instructions (paste into Copilot Studio → Settings → Generative AI → Instructions)

```
You are a geospatial assistant powered by TomTom location services. You can help users with:

- Finding addresses and converting them to coordinates (geocoding)
- Looking up what's at a specific location (reverse geocoding)
- Searching for places, businesses, and points of interest
- Calculating driving, walking, or cycling routes between locations
- Planning multi-stop trips with optimised waypoint ordering
- Checking real-time traffic incidents and road conditions
- Determining how far someone can travel within a time or distance budget
- Generating map images showing locations, routes, and areas

When a user asks about a location, address, or place:
1. Use the tomtom-geocode tool to convert addresses to coordinates
2. Use tomtom-fuzzy-search for general queries like "restaurants near Cardiff"
3. Use tomtom-poi-search when looking for specific business categories

When a user asks for directions or routes:
1. First geocode the origin and destination to get coordinates
2. Then use tomtom-routing for point-to-point routes
3. Use tomtom-waypoint-routing for multi-stop journeys
4. Always include traffic=true for real-time accuracy
5. Report the distance in km/miles and estimated travel time

When a user asks about traffic:
1. First geocode the area to get a bounding box
2. Use tomtom-traffic with the bbox parameter
3. Summarise incidents by type (accidents, roadworks, closures)

When a user asks "what's nearby" or "find things near me":
1. Use tomtom-nearby with their coordinates and a sensible radius
2. Common category IDs: 7315 (restaurants), 7309 (petrol stations), 7311 (hotels), 9663 (EV charging), 9376 (parking)

When a user asks about reachable areas or "how far can I go":
1. Use tomtom-reachable-range with their origin and a time budget in seconds (e.g. 1800 for 30 minutes)

Always present results in a clear, concise format. Include addresses, distances, and travel times where relevant. When listing multiple results, use numbered lists. Offer to show routes on a map or find more details when appropriate.

All tool calls go through the TomTom MCP connector using the CallMcpTool action with method "tools/call".
```

## How to Wire Up in Copilot Studio

### Option A: As a Plugin Action
1. Go to your Copilot → **Actions** → **+ Add an action**
2. Select **Custom connector** → choose **TomTom MCP**
3. Add the **CallMcpTool** action
4. The agent will automatically use it based on the instructions above

### Option B: As a Topic with Adaptive Card
1. Create a new Topic triggered by phrases like "find", "route", "directions", "nearby", "traffic"
2. Add a **Call an action** node → select **TomTom MCP** → **CallMcpTool**
3. Build the JSON body dynamically from user input
4. Parse the response and display in an Adaptive Card

---

## Sample Prompts to Test Your Agent

### Address & Location Queries
- "Where is Cardiff Castle?"
- "What's the address at coordinates 51.48, -3.18?"
- "Find the coordinates for 10 Downing Street, London"
- "Where is the Millennium Stadium in Cardiff?"
- "What's near latitude 51.5074 longitude -0.1278?"

### Search & Discovery
- "Find restaurants near Cardiff Bay"
- "Are there any EV charging stations near Swansea?"
- "Show me hotels within 2km of Cardiff Central Station"
- "Find parking near the Principality Stadium"
- "What coffee shops are near the Wales Millennium Centre?"
- "Find petrol stations along the M4 near Newport"

### Routing & Directions
- "How do I drive from Cardiff to London?"
- "What's the fastest route from Swansea to Bristol?"
- "Give me walking directions from Cardiff Castle to Cardiff Bay"
- "How long does it take to drive from Cardiff to Manchester?"
- "Plan a road trip from Cardiff to Tenby via Swansea and Carmarthen"
- "What's the shortest route from Cardiff Airport to the city centre?"
- "Route from Edinburgh to London avoiding motorways"

### Multi-Stop Planning
- "Plan a delivery route visiting Cardiff, Newport, Bristol, and Bath"
- "What's the best order to visit Swansea, Brecon, Abergavenny, and Monmouth from Cardiff?"
- "I need to visit 5 clients: one in Penarth, Barry, Bridgend, Neath, and Llanelli. What's the optimal route?"

### Traffic
- "Is there any traffic on the M4 near Cardiff?"
- "Are there any road closures around central London?"
- "What traffic incidents are there around the M25?"
- "Check traffic conditions near the Severn Bridge"

### Reachable Range
- "How far can I drive from Cardiff in 30 minutes?"
- "Show me everywhere I can reach within an hour from Swansea"
- "What area can I cover in a 20-minute drive from Newport?"
- "If I have 45 minutes, how far can I get from Bristol?"

### Maps
- "Show me a map of Cardiff city centre"
- "Generate a map showing the route from Cardiff to Swansea"
- "Create a map with markers for all the restaurants you found"

---

## Example JSON Bodies for Each Tool

### Geocode
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-geocode",
    "arguments": { "query": "Cardiff Castle, Wales", "limit": 5 }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Reverse Geocode
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-reverse-geocode",
    "arguments": { "lat": 51.4816, "lon": -3.1791 }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Fuzzy Search
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-fuzzy-search",
    "arguments": { "query": "restaurants Cardiff Bay", "limit": 10 }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### POI Search
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-poi-search",
    "arguments": {
      "query": "hotels",
      "lat": 51.4816,
      "lon": -3.1791,
      "radius": 5000,
      "limit": 10
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Nearby Search
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-nearby",
    "arguments": {
      "lat": 51.4637,
      "lon": -3.1640,
      "radius": 2000,
      "categorySet": "7315",
      "limit": 10
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Routing (Point to Point)
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-routing",
    "arguments": {
      "origin": { "lat": 51.4816, "lon": -3.1791 },
      "destination": { "lat": 51.5074, "lon": -0.1278 },
      "travelMode": "car",
      "traffic": true,
      "instructionsType": "text",
      "language": "en-GB"
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Waypoint Routing (Multi-Stop)
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-waypoint-routing",
    "arguments": {
      "waypoints": [
        { "lat": 51.4816, "lon": -3.1791 },
        { "lat": 51.6214, "lon": -3.9436 },
        { "lat": 51.4545, "lon": -2.5879 },
        { "lat": 51.3811, "lon": -2.3590 }
      ],
      "travelMode": "car",
      "traffic": true,
      "computeBestOrder": true
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Reachable Range
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-reachable-range",
    "arguments": {
      "origin": { "lat": 51.4816, "lon": -3.1791 },
      "timeBudgetInSec": 1800
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Traffic
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-traffic",
    "arguments": {
      "bbox": "-3.25,51.43,-3.10,51.53",
      "maxResults": 20,
      "language": "en-GB"
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Static Map
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-static-map",
    "arguments": {
      "center": { "lat": 51.4816, "lon": -3.1791 },
      "zoom": 14,
      "width": 800,
      "height": 600,
      "style": "main"
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### Dynamic Map (with markers and route)
```json
{
  "method": "tools/call",
  "params": {
    "name": "tomtom-dynamic-map",
    "arguments": {
      "origin": { "lat": 51.4816, "lon": -3.1791, "label": "Cardiff" },
      "destination": { "lat": 51.6214, "lon": -3.9436, "label": "Swansea" },
      "markers": [
        { "lat": 51.4816, "lon": -3.1791, "label": "Cardiff Castle", "color": "#FF0000" },
        { "lat": 51.6214, "lon": -3.9436, "label": "Swansea Marina", "color": "#0000FF" }
      ],
      "showLabels": true,
      "width": 1200,
      "height": 800
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

---

## Common POI Category IDs

| Category ID | Description |
|-------------|-------------|
| 7309 | Petrol/Gas Station |
| 7311 | Hotel/Motel |
| 7315 | Restaurant |
| 7321 | Shopping Centre |
| 7326 | Pharmacy |
| 7327 | Supermarket |
| 7328 | Museum |
| 7332 | Hospital |
| 7339 | Bank |
| 7372 | ATM |
| 7376 | Parking |
| 9361 | Airport |
| 9362 | Train Station |
| 9663 | EV Charging Station |
| 9932 | Coffee Shop |
