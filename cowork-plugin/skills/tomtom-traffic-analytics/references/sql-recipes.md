# SQL recipes for TomTom Traffic Analytics

Companion to `tomtom-traffic-analytics`. Every analytics tool takes a `sql_queries` object whose
values are DuckDB SQL run server-side against the tool's tables. Always project only the columns you
need and constrain rows with `ORDER BY ... LIMIT`. Check each tool's description for its exact table
and column names; the snippets below are templates to adapt.

## Junction analysis

Find junctions by name/status:

```json
{ "sql_queries": { "find": "SELECT id, name, status FROM junctions WHERE name ILIKE '%cardiff%' LIMIT 20" } }
```

Top approaches by delay (live or archive):

```json
{
  "junctionIds": ["<id>"],
  "sql_queries": { "top_delays": "SELECT approach_id, delay_sec FROM approaches ORDER BY delay_sec DESC LIMIT 5" }
}
```

Hourly average delay (rush-hour pattern):

```json
{
  "junctionIds": ["<id>"],
  "sql_queries": { "by_hour": "SELECT hour, AVG(delay_sec) AS avg_delay, COUNT(*) AS samples FROM approaches GROUP BY hour ORDER BY hour" }
}
```

## Route monitoring

Find monitored routes by delay:

```json
{ "sql_queries": { "find": "SELECT id, name, current_delay_sec FROM routes ORDER BY current_delay_sec DESC LIMIT 10" } }
```

Segment-level worst spots:

```json
{
  "routeIds": ["<id>"],
  "sql_queries": { "worst_segments": "SELECT segment_id, length_m, speed_kmh, delay_sec FROM segments ORDER BY delay_sec DESC LIMIT 10" }
}
```

## Area analytics

Average speed by hour in an area:

```json
{ "sql_queries": { "speed_by_hour": "SELECT hour, AVG(speed_kmh) AS avg_speed FROM area_stats GROUP BY hour ORDER BY hour" } }
```

Compare two periods (e.g. this week vs last):

```json
{ "sql_queries": { "compare": "SELECT period, AVG(delay_sec) AS avg_delay FROM area_stats WHERE period IN ('this_week','last_week') GROUP BY period" } }
```

## Live flow / incidents (TomTom Developer tier)

Current flow at a point:

```json
{ "lat": 51.4816, "lon": -3.1791, "sql_queries": { "flow": "SELECT road_name, current_speed_kmh, free_flow_kmh, ROUND(100.0*current_speed_kmh/free_flow_kmh) AS pct_free FROM flow" } }
```

Incidents in an area by severity:

```json
{ "bbox": [-3.25, 51.45, -3.10, 51.52], "sql_queries": { "incidents": "SELECT type, road, severity, delay_sec FROM incidents ORDER BY severity DESC, delay_sec DESC LIMIT 20" } }
```

## Guidelines

- Keep projections small; always `LIMIT` exploratory queries.
- Aggregate (`AVG`, `COUNT`, `GROUP BY`) rather than returning raw rows for trend questions.
- Two-step pattern: search tool (get IDs) → detail tool (analyse those IDs).
- Column/table names vary per tool — read the tool description and adjust these templates.
