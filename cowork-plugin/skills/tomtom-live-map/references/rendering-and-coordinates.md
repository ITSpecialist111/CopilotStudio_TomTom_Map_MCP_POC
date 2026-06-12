# Rendering & Coordinates — reference

Companion to `tomtom-live-map`. Detailed argument shapes and worked examples.

## Coordinate conventions

- Always **decimal degrees**, order **`lat, lon`** in this plugin's tool inputs.
- Latitude ∈ [-90, 90], longitude ∈ [-180, 180].
- Examples: Cardiff Castle `51.4816, -3.1791`; London (Charing Cross) `51.5074, -0.1278`;
  Amsterdam Central `52.3676, 4.9041`.
- Note: the underlying TomTom map APIs use GeoJSON `[lon, lat]` internally, but the
  `render_live_map` tool takes `{ lat, lon }` objects — pass `lat` and `lon` explicitly.

## `render_live_map` argument shapes

### Pins (one or more places)

```json
{
  "title": "Coffee near Cardiff Castle",
  "markers": [
    { "lat": 51.4816, "lon": -3.1791, "label": "Cardiff Castle", "category": "Landmark" },
    { "lat": 51.4820, "lon": -3.1770, "label": "The Coffee House", "category": "Cafe", "address": "12 High St" }
  ],
  "zoom": 15,
  "traffic": false
}
```

### Road route (with optional waypoints and live traffic)

```json
{
  "title": "Cardiff → London",
  "route": {
    "origin": { "lat": 51.4816, "lon": -3.1791, "label": "Cardiff" },
    "destination": { "lat": 51.5074, "lon": -0.1278, "label": "London" },
    "waypoints": [ { "lat": 51.4545, "lon": -2.5879, "label": "Bristol" } ],
    "travelMode": "car"
  },
  "traffic": true
}
```

### Traffic-focused map

Put the incident or area centre in `markers` and set `traffic: true` so the live overlay shows:

```json
{
  "title": "Traffic around Cardiff city centre",
  "markers": [ { "lat": 51.4816, "lon": -3.1791, "label": "City centre" } ],
  "zoom": 13,
  "traffic": true
}
```

## Choosing zoom

| Zoom | Scope |
|------|-------|
| 3 | continent |
| 6 | country |
| 10 | city |
| 13 | district |
| 15 | neighbourhood |
| 18 | street |

Omit `zoom` to let the renderer auto-fit to the markers/route.

## When to use `tomtom-dynamic-map` directly

Use the raw `tomtom-dynamic-map` tool only when you need features `render_live_map` doesn't expose:

- `polygons` — custom polygon shapes or circles (e.g. a 1 km radius area).
- multiple independent `routePlans` on one image.
- explicit `bbox` framing instead of `center` + `zoom`.

Otherwise prefer `render_live_map` — it returns both the inline image and the interactive link.
