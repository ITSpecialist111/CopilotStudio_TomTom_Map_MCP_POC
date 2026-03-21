# Teams Interactive Maps Setup Guide

## Overview

This guide walks through embedding TomTom interactive maps directly inside Microsoft Teams using:
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
MCP Server (TomTom Orbis Maps) --> Returns text + data
        |
        v
Power Automate Flow
        |
        v
Adaptive Card with:
  1. Static map image (inline preview)
  2. "View Interactive Map" button (opens Stage View inside Teams)
  3. "Open in Browser" button (full portal)
```

---

## Step 1: Register Teams App

The Teams App allows your interactive map to open inside Teams via Stage View.

### 1a. Create App in Teams Admin Center

1. Go to **Teams Admin Center** → https://admin.teams.microsoft.com
2. Navigate to **Teams apps** → **Manage apps** → **+ Upload new app**
3. Before uploading, prepare the manifest:

### 1b. Prepare the Manifest

1. Open `teams-app/manifest.json`
2. Replace `{{TEAMS_APP_ID}}` with a new GUID. Generate one:
   ```powershell
   [guid]::NewGuid().ToString()
   ```
3. Replace `{{TOMTOM_API_KEY}}` with: `KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA`
4. Save the file

### 1c. Create App Package (ZIP)

The Teams app package is a ZIP file containing:
- `manifest.json`
- `color.png` (192x192 color icon)
- `outline.png` (32x32 outline icon)

For the icons, convert the SVG files to PNG:
- Use any SVG-to-PNG converter for `color.svg` → `color.png` (192x192)
- And `outline.svg` → `outline.png` (32x32)

Then create the ZIP:
```powershell
cd teams-app
Compress-Archive -Path manifest.json, color.png, outline.png -DestinationPath TomTomMaps.zip
```

### 1d. Upload to Teams

1. In Teams Admin Center, upload `TomTomMaps.zip`
2. Or in Teams client: **Apps** → **Manage your apps** → **Upload a custom app**
3. Note the **App ID** after upload — you'll need this for Stage View URLs

### 1e. Alternative: Sideload for Testing

1. Open Microsoft Teams
2. Go to **Apps** → **Manage your apps** → **Upload a custom app** → **Upload for me or my teams**
3. Select the ZIP file
4. The app will appear in your personal apps

---

## Step 2: Configure Static Map Image URL

The TomTom Static Image API generates map PNG images via URL. No server-side code needed — the URL itself generates the image.

### URL Format

```
https://api.tomtom.com/map/1/staticimage?
  layer=basic
  &style=main
  &format=png
  &zoom={zoom}
  &center={longitude},{latitude}
  &width=600
  &height=300
  &key={API_KEY}
```

### Example

```
https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&format=png&zoom=14&center=-2.5311,51.7262&width=600&height=300&key=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA
```

**Note**: `center` parameter uses **longitude,latitude** order (opposite of typical lat,lon).

---

## Step 3: Configure Stage View Deep Link

Stage View opens a web page inside Teams in a modal panel. The URL format:

```
https://teams.microsoft.com/l/stage/{APP_ID}/0?context={encoded_context}
```

Where `context` is URL-encoded JSON:
```json
{
  "contentUrl": "https://thankful-sky-03359db03.2.azurestaticapps.net/?apiKey=KEY&center=LAT,LON&zoom=14",
  "websiteUrl": "https://thankful-sky-03359db03.2.azurestaticapps.net/",
  "name": "TomTom Map"
}
```

### Building the Deep Link in Power Automate

Use a Compose action with this expression:

```
concat(
  'https://teams.microsoft.com/l/stage/',
  '{YOUR_APP_ID}',
  '/0?context=',
  encodeUriComponent(
    concat(
      '{"contentUrl":"https://thankful-sky-03359db03.2.azurestaticapps.net/?apiKey=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA&center=',
      variables('latitude'), ',', variables('longitude'),
      '&zoom=14","websiteUrl":"https://thankful-sky-03359db03.2.azurestaticapps.net/","name":"TomTom Map"}'
    )
  )
)
```

---

## Step 4: Power Automate Flow Configuration

### Flow Structure

```
Trigger: When an agent calls the flow
  Input: text (String) - Agent's response text with location data
    |
    v
Compose: Build Adaptive Card
    |
    v
Return value to agent: card JSON
```

### Compose Action - Adaptive Card with Static Map

Paste this in the Compose action's Inputs field. Replace:
- `{APP_ID}` with your Teams App ID
- The coordinates in the static map URL and interactive URL with dynamic expressions if available

```json
{
  "type": "AdaptiveCard",
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.5",
  "body": [
    {
      "type": "TextBlock",
      "text": "TomTom Map",
      "size": "Large",
      "weight": "Bolder",
      "wrap": true
    },
    {
      "type": "Image",
      "url": "https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&format=png&zoom=13&center=-0.1278,51.5074&width=600&height=300&key=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA",
      "size": "Stretch",
      "altText": "Map preview"
    },
    {
      "type": "TextBlock",
      "text": "@{triggerBody()?['text']}",
      "wrap": true,
      "spacing": "Small"
    }
  ],
  "actions": [
    {
      "type": "Action.OpenUrl",
      "title": "View Interactive Map",
      "url": "https://thankful-sky-03359db03.2.azurestaticapps.net/?apiKey=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA&center=51.5074,-0.1278&zoom=13",
      "style": "positive"
    }
  ]
}
```

### For Dynamic Coordinates

If you want to extract coordinates from the agent's text dynamically, you have two options:

**Option A: Pass coordinates as separate flow inputs**

Add inputs to the flow trigger:
- `text` (String) - Description text
- `latitude` (String) - Latitude value
- `longitude` (String) - Longitude value
- `zoom` (String) - Zoom level (default "13")

Then use expressions in the Compose:
```
Static map URL: https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&format=png&zoom=@{coalesce(triggerBody()?['text_3'],'13')}&center=@{triggerBody()?['text_2']},@{triggerBody()?['text_1']}&width=600&height=300&key=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA

Interactive map URL: https://thankful-sky-03359db03.2.azurestaticapps.net/?apiKey=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA&center=@{triggerBody()?['text_1']},@{triggerBody()?['text_2']}&zoom=@{coalesce(triggerBody()?['text_3'],'13')}
```

**Option B: Use a fixed default map with the text overlay**

Use the simple version from Step 4 above with a default London center. The text description from the agent gives context, and the "View Interactive Map" button lets users explore.

---

## Step 5: Copilot Studio Agent Configuration

### Agent Instructions

Add this to your Copilot Studio agent instructions:

```
When the user asks about locations, maps, routes, or places:
1. Use the TomTom MCP tools to get the information
2. After getting results, call the "Generate Map Card" flow with the result text
3. Present the Adaptive Card response to the user

Always include coordinates when describing locations so they can be mapped.
```

### Topic Configuration

1. Create a topic "Map Results" or add to your existing Generative AI topic
2. After the MCP tool responds, add a "Call an action" node
3. Select your Power Automate flow
4. Pass the `Activity.Text` or MCP response as the `text` input
5. Add a "Send a message" node after the flow
6. In the message, select "Adaptive Card" and use the flow output

---

## Step 6: Deploy Updated Interactive Map

The interactive map has been updated with Microsoft Teams SDK integration. Redeploy to Azure Static Web Apps:

```bash
cd interactive-map-app
npx @azure/static-web-apps-cli deploy . \
  --deployment-token YOUR_SWA_DEPLOYMENT_TOKEN \
  --env production
```

---

## Testing

### Test 1: Static Map Image
Open this URL in a browser to verify the static map API works:
```
https://api.tomtom.com/map/1/staticimage?layer=basic&style=main&format=png&zoom=14&center=-2.5311,51.7262&width=600&height=300&key=KTdUeJdXaeQS4ymsVFYlm7SnpJDF4yBA
```

### Test 2: Interactive Map in Teams
1. Open Teams
2. Send yourself the Adaptive Card via the bot
3. Click "View Interactive Map"
4. Verify it opens inside Teams (Stage View) or in a new tab

### Test 3: End-to-End
1. In Teams, ask the Copilot agent: "Show me EV chargers near Lydney"
2. Verify you see:
   - Text response with locations
   - Static map image inline
   - "View Interactive Map" button
   - Interactive map opens inside Teams when clicked

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Static map image not showing | Check API key is valid. Verify `center` uses lon,lat order |
| Stage View not opening | Ensure Teams App is installed and App ID matches |
| "This app cannot be found" | App hasn't been approved in Teams Admin Center |
| Map blank in Teams iframe | Check CSP headers allow `frame-ancestors` from Teams domains |
| Interactive map loads but no tiles | API key may be expired or rate-limited |
