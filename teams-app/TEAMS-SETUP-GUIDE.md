# Teams Interactive Maps Setup Guide

## Overview

This guide walks through embedding TomTom interactive maps inside Microsoft Teams using:
- **Static map images** inline in Adaptive Cards (always visible in chat)
- **Stage View** to open the full interactive map inside Teams (no browser redirect)
- **Personal Tab** for a persistent map view in Teams

## Architecture

```
User asks question in Teams
        |
        v
Copilot Studio Agent
        |
        v
MCP Server (TomTom Orbis Maps) --> Returns geocode/search results
        |
        v
Power Automate Flow (5 Compose actions)
        |
        v
Adaptive Card with:
  1. Static map image (inline preview, tap to expand)
  2. "View Interactive Map" button (opens Stage View inside Teams)
  3. "Open in Browser" button (full portal)
```

---

## Step 1: Register Teams App

The Teams App allows your interactive map to open inside Teams via Stage View.

### 1a. Prepare the Manifest

1. Open `teams-app/manifest.json`
2. The manifest is pre-configured with:
   - **App ID**: `b67c70f7-a0ce-46b4-88e5-e7f137ba2970`
   - **Schema**: v1.16 (broadest client compatibility)
   - **Scope**: Personal static tab only
3. If creating a new app, generate a new GUID:
   ```powershell
   [guid]::NewGuid().ToString()
   ```

### 1b. Create App Package (ZIP)

The Teams app package is a ZIP file containing:
- `manifest.json`
- `color.png` (192x192 color icon)
- `outline.png` (32x32 outline icon)

```powershell
cd teams-app
Compress-Archive -Path manifest.json, color.png, outline.png -DestinationPath TomTomMaps.zip
```

### 1c. Upload to Teams

1. In Teams Admin Center (https://admin.teams.microsoft.com), upload `TomTomMaps.zip`
2. Or in Teams client: **Apps** > **Manage your apps** > **Upload a custom app**
3. Note the **App ID** after upload

---

## Step 2: Power Automate Flow Configuration

This is the recommended flow structure with 5 Compose actions that build fully dynamic Adaptive Cards.

### Flow Structure

```
Trigger: "When an agent calls the flow"
  Inputs (5):
    - text    = Description (auto-fill from geocode freeformAddress)
    - text_1  = Latitude (auto-fill from position.lat)
    - text_2  = Longitude (auto-fill from position.lon)
    - text_3  = Zoom level (auto-fill, default 13)
    - text_4  = Title (auto-fill from street name or location)
        |
        v
Compose: StaticMapUrl (expression)
        |
        v
Compose: InteractiveMapUrl (expression)
        |
        v
Compose: StageViewUrl (expression)
        |
        v
Compose: AdaptiveCard (JSON with @{outputs(...)} references)
        |
        v
"Respond to the agent": output = AdaptiveCard
```

### Flow Input Descriptions

**Critical**: Add these descriptions to each trigger input so the agent auto-fills them from the MCP tool results. The phrase **"Auto-fill, never ask the user"** prevents the agent from prompting the user for each value.

| Input | Display Name | Description |
|-------|-------------|-------------|
| `text` | Description | Brief description of the location. Auto-fill from the geocode or search result address. |
| `text_1` | Latitude | The latitude from the geocode/search position.lat field. Auto-fill, never ask the user. |
| `text_2` | Longitude | The longitude from the geocode/search position.lon field. Auto-fill, never ask the user. |
| `text_3` | Zoom | Map zoom level, default 13. Auto-fill, never ask the user. |
| `text_4` | Title | Short title for the card, e.g. the street name or location name. Auto-fill, never ask the user. |

### Compose 1: StaticMapUrl

Use the **expression editor** (`fx` button) and paste this single expression:

```
concat('https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&format=png&zoom=',coalesce(triggerBody()?['text_3'],'13'),'&center=',triggerBody()?['text_2'],',',triggerBody()?['text_1'],'&width=600&height=300&key=YOUR_TOMTOM_API_KEY')
```

**Note**: The Static Image API uses `center=longitude,latitude` order.

### Compose 2: InteractiveMapUrl

Expression:

```
concat('https://thankful-sky-03359db03.2.azurestaticapps.net/?apiKey=YOUR_TOMTOM_API_KEY&center=',triggerBody()?['text_1'],',',triggerBody()?['text_2'],'&zoom=',coalesce(triggerBody()?['text_3'],'13'))
```

**Note**: The interactive map app uses `center=latitude,longitude` order.

### Compose 3: StageViewUrl

Expression:

```
concat('https://teams.microsoft.com/l/stage/b67c70f7-a0ce-46b4-88e5-e7f137ba2970/0?context=',encodeUriComponent(concat('{"contentUrl":"',outputs('InteractiveMapUrl'),'","websiteUrl":"https://thankful-sky-03359db03.2.azurestaticapps.net/","name":"TomTom Map"}')))
```

Replace `b67c70f7-a0ce-46b4-88e5-e7f137ba2970` with your Teams App ID if different.

### Compose 4: AdaptiveCard

Paste this JSON directly into the **Inputs text field** (NOT the expression editor). The `@{...}` expressions resolve at runtime:

```json
{
  "type": "AdaptiveCard",
  "$schema": "https://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.5",
  "body": [
    {
      "type": "ColumnSet",
      "columns": [
        {
          "type": "Column",
          "width": "auto",
          "items": [
            {
              "type": "Icon",
              "name": "Location",
              "size": "Large",
              "color": "Accent",
              "style": "Filled"
            }
          ],
          "verticalContentAlignment": "Center"
        },
        {
          "type": "Column",
          "width": "stretch",
          "items": [
            {
              "type": "TextBlock",
              "text": "@{coalesce(triggerBody()?['text_4'], 'Map Result')}",
              "size": "Large",
              "weight": "Bolder",
              "wrap": true
            }
          ]
        }
      ]
    },
    {
      "type": "Image",
      "url": "@{outputs('StaticMapUrl')}",
      "size": "Stretch",
      "altText": "Map preview",
      "msTeams": {
        "allowExpand": true
      }
    },
    {
      "type": "TextBlock",
      "text": "@{triggerBody()?['text']}",
      "wrap": true,
      "spacing": "Small"
    },
    {
      "type": "FactSet",
      "facts": [
        {
          "title": "Coordinates",
          "value": "@{triggerBody()?['text_1']}, @{triggerBody()?['text_2']}"
        }
      ]
    }
  ],
  "actions": [
    {
      "type": "Action.OpenUrl",
      "title": "View Interactive Map",
      "url": "@{outputs('StageViewUrl')}",
      "iconUrl": "icon:Map,filled"
    },
    {
      "type": "Action.OpenUrl",
      "title": "Open in Browser",
      "url": "@{outputs('InteractiveMapUrl')}",
      "iconUrl": "icon:Globe,filled"
    }
  ]
}
```

### Compose 5: Respond to the agent

Set the output to `@{outputs('AdaptiveCard')}`.

---

## Step 3: Copilot Studio Agent Configuration

### Agent Instructions

Add this to your Copilot Studio agent's system instructions:

```
When the user asks about locations, maps, routes, or places:
1. First call tomtom-geocode or tomtom-search to get the location data
2. Then automatically call the Generate Map Card flow with ALL inputs filled from the tool results:
   - text: the freeformAddress from the result
   - text_1: position.lat from the result
   - text_2: position.lon from the result
   - text_3: 13 (default zoom)
   - text_4: the street name or municipality from the result
3. NEVER ask the user for coordinates, zoom, or title - always fill them from the geocode results
4. Do NOT call the flow more than once per request
```

### Topic Configuration

1. After the MCP tool responds, add a **"Call an action"** node → select your Power Automate flow
2. Map the inputs from the MCP tool results (the agent orchestrator handles this based on the instructions above)
3. After the flow returns, add a **"Send a message"** node
4. Select **Adaptive Card** as the format and use the flow output variable

**Important**: Remove any hardcoded Adaptive Card templates from the topic. The card should come entirely from the Power Automate flow output.

---

## Step 4: Deploy Interactive Map App

The interactive map uses MapLibre GL JS with TomTom vector tiles and Teams SDK integration.

### Deploy to Azure Static Web Apps

```bash
cd interactive-map-app
npx @azure/static-web-apps-cli deploy . \
  --deployment-token YOUR_SWA_DEPLOYMENT_TOKEN \
  --env production
```

### Key Technical Details

- **MapLibre GL JS** renders the map (TomTom SDK v5 has iframe sandbox issues in Teams)
- **Vector style URL**: `https://api.tomtom.com/style/1/style/22.2.1-*?map=2/basic_street-light&poi=2/poi_light&key={key}`
  - Traffic layers (`traffic_flow`, `traffic_incidents`) cause 404 when included — use map+POI only
- **CSP header**: `frame-ancestors *` required for Teams iframe embedding
- **Cache-Control**: `no-cache, no-store, must-revalidate` to prevent stale CSP caching
- **Teams SDK v2.31.1**: 3-second timeout race on `initialize()`, calls `notifyAppLoaded()` immediately

---

## Step 5: Testing

### Test 1: Static Map Image

Open this URL in a browser (replace coordinates and key):
```
https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&format=png&zoom=14&center={lon},{lat}&width=600&height=300&key=YOUR_TOMTOM_API_KEY
```

### Test 2: Interactive Map in Teams

1. Open Teams
2. Go to **Apps** > find **TomTom Maps** > open the personal tab
3. Verify the map loads with vector tiles, POIs, and pan/zoom

### Test 3: End-to-End Flow

1. In Teams, ask the Copilot agent: "Show me a map of Lydney, England"
2. Verify you see:
   - Adaptive Card with location icon and title
   - Static map image inline (tap to expand)
   - Description text and coordinates
   - "View Interactive Map" button (opens Stage View inside Teams)
   - "Open in Browser" button (opens external browser)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Static map image not showing | Check API key is valid. Verify `center` uses lon,lat order |
| Stage View not opening | Ensure Teams App is installed and App ID matches in StageViewUrl |
| "This app cannot be found" | App hasn't been approved in Teams Admin Center |
| Map blank in Teams iframe | Check CSP headers: `frame-ancestors *` must be set |
| Interactive map loads but no tiles | API key may be expired or rate-limited |
| Agent asks for coordinates | Add "Auto-fill, never ask the user" to flow input descriptions |
| Card shows `{Topic.VariableName}` as literal text | Use flow output directly, don't put variable placeholders in Copilot Studio card editor |
| Cardiff Castle showing in results | Remove hardcoded Adaptive Card template from Copilot Studio topic |
| Cached old CSP blocking iframe | Clear browser cache or wait; headers are set to `no-cache` |
| Flow called multiple times | Add instruction to agent: "Do NOT call the flow more than once per request" |

---

## Adaptive Card Features Reference

The Adaptive Card uses these Teams-supported elements:

| Element | Purpose |
|---------|---------|
| `Icon` (Fluent) | Location pin icon in card header |
| `Image` with `msTeams.allowExpand` | Static map preview, tap to expand full-screen |
| `FactSet` | Display coordinates |
| `Action.OpenUrl` with `iconUrl` | Buttons with Map and Globe Fluent icons |

### Additional Adaptive Card elements available in Teams

| Element | Description |
|---------|-------------|
| `Carousel` (v1.6) | Swipeable pages — useful for multi-result cards |
| `Chart.Donut/Line/Bar/Pie` | Inline data visualization charts |
| `CodeBlock` | Syntax-highlighted code (desktop/web only) |
| `Rating` / `Input.Rating` | Star ratings |
| `Badge` | Compact colored labels |
| `CompoundButton` | Buttons with icon + title + description |
| `Layout.AreaGrid` | CSS Grid-style responsive layout |

**Note**: Adaptive Cards cannot embed interactive web content (no iframes, HTML, or JavaScript). The interactive map must be opened via Stage View or browser link.

---

## Roadmap

### Phase 1: PCF Code Component (Power Apps interactive map)

Build a Power Apps Component Framework (PCF) control that renders a full interactive TomTom map using MapLibre GL JS. Unlike Adaptive Cards (which are static JSON with no JavaScript), PCF controls execute TypeScript/JavaScript with full HTML/CSS rendering inside the Power Platform runtime.

**Why**: PCF is the only place in the Microsoft Power Platform stack where custom interactive web content (maps, charts, 3D) can run natively. This replaces the current workaround of linking out to an external Static Web App via Stage View.

**Architecture**:
```
Copilot Studio Agent → MCP Server (geocode/search)
        |
        v
Adaptive Card with "Open Map App" button
        |
        v
Power App (Canvas or Model-driven) with PCF Map Component
  - MapLibre GL JS + TomTom vector tiles
  - Full interactivity (pan, zoom, markers, routes)
  - Runs inside Teams as an embedded Power App tab
  - Reads/writes to Dataverse (save locations, routes, history)
```

**Features**:
- Interactive TomTom map with vector tiles, POIs, traffic overlays
- Input properties: `latitude`, `longitude`, `zoom`, `apiKey`, `markers` (JSON)
- Output properties: selected coordinates, bounds (for Dataverse write-back)
- Drag-and-drop into any canvas app or model-driven form
- Native Power Platform governance (DLP, environments, admin controls)

**Advantages over current SWA approach**:

| Feature | SWA + Stage View | PCF in Power App |
|---------|-----------------|------------------|
| Interactive map in Teams | Via Stage View modal | Via embedded Power App tab |
| Data persistence | URL parameters only | Dataverse (save/share maps) |
| User auth | None | Power Platform auth (AAD) |
| Collaboration | Requires Live Share | Native Power Apps sharing |
| Admin control | SWA deployment | Power Platform governance |
| Offline | No | Power Apps offline mode |
| Reusable | Single web app | Any canvas/model-driven app |

**Implementation steps**:
1. Scaffold PCF project with `pac pcf init --namespace TomTom --name MapControl --template field`
2. Add MapLibre GL JS and TomTom vector tile style
3. Define input/output properties in `ControlManifest.Input.xml`
4. Build map rendering in `index.ts` with marker/route support
5. Package and deploy to Power Platform environment
6. Embed in a canvas app, publish as Teams tab

See: https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview

---

### Phase 2: Live Share SDK (collaborative maps in meetings)

Integrate `@microsoft/live-share` into the interactive map for collaborative multi-user map viewing in Teams meetings and chats:
- **Shared pan/zoom** (`LiveState`) — presenter controls everyone's map view
- **Presence indicators** (`LivePresence`) — see who's viewing and where
- **Follow mode** (`LiveFollowMode`) — attendees follow the presenter
- **Annotations** (`LiveCanvas`) — draw and point on the map together

Requires Teams manifest update for meeting contexts (`meetingStage`, `sidePanel`).

Can be implemented in either the SWA or the PCF component.

See: https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-overview

---

### Phase 3: TomTom Assets API (custom map styling)

Use the TomTom Assets API for:
- **Style switching** — dark mode, satellite view, custom themes
- **Custom sprites** — custom marker icons for different POI types (EV chargers, restaurants, etc.)
- **Font customization** — custom map label rendering

Applies to both the SWA and PCF map implementations.

See: https://developer.tomtom.com/assets-api/api-explorer

---

### Interactive Maps Across Platforms — Reference

Current state of interactive map support across Microsoft and AI platforms:

| Platform | Interactive Map? | Method |
|----------|-----------------|--------|
| **Claude Desktop** | Yes | MCP Apps protocol — renders HTML/JS in webview |
| **VS Code + Claude** | Yes | MCP Apps protocol — renders in panel |
| **Power Apps (PCF)** | Yes | PCF code components execute TypeScript/JS |
| **Power BI** | Yes | Azure Maps visual, ArcGIS, built-in map visuals |
| **Teams Tab** | Yes | Embed any web app (SWA, Power App) as iframe |
| **Teams Stage View** | Yes | Open web content in modal panel (current approach) |
| **Teams Collaborative StageView** | Yes | Stage View with side chat — ideal for sharing |
| **Teams Meeting Stage** | Yes | Share web app to meeting (combine with Live Share) |
| **SharePoint** | Yes | Embed web part or Power BI report |
| **Adaptive Cards** | **No** | Static images only — no iframes, HTML, or JavaScript |
| **Copilot Studio (inline)** | **No** | Returns Adaptive Cards only |
| **Microsoft 365 Copilot** | **No** | Adaptive Cards only |
| **GitHub Copilot CLI** | **No** | Text terminal — no rendering |
| **Outlook** | **No** | Adaptive Cards (more limited than Teams) |

**Key insight**: There is no way to render an interactive map *inline in a Teams chat message*. Every option requires a tab, dialog, stage view, or separate app surface. The Adaptive Card with static map preview + button to open interactive view is the standard pattern used across the Microsoft ecosystem.
