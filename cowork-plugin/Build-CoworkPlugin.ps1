<#
.SYNOPSIS
    Validates and packages the TomTom Cowork plugin into an uploadable .zip.

.DESCRIPTION
    1. Validates manifest.json against the key Cowork rules (skill folders exist, each has a
       SKILL.md whose frontmatter `name` matches the folder and is kebab-case, and connector
       rules: HTTPS MCP URL, and no referenceId when auth type is None).
    2. Optionally overrides the connector gateway URL, app id, developer name, and policy URLs.
    3. Generates icons if missing.
    4. Produces dist/<package>-<version>.zip with manifest.json, icons, and skills/ at the root.

.PARAMETER GatewayUrl
    Overrides the connector's remote MCP server URL (the deployed gateway, .../api/mcp).

.EXAMPLE
    ./Build-CoworkPlugin.ps1

.EXAMPLE
    ./Build-CoworkPlugin.ps1 -GatewayUrl "https://ca-tomtom-map-proxy.<region>.azurecontainerapps.io/api/mcp"
#>
[CmdletBinding()]
param(
    [string]$GatewayUrl,
    [string]$AppId,
    [string]$DeveloperName,
    [string]$WebsiteUrl,
    [string]$PrivacyUrl,
    [string]$TermsUrl,
    [string]$Version,
    [string]$Root = $PSScriptRoot,
    [string]$OutputDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"
$failures = @()
function Fail($msg) { $script:failures += $msg; Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Pass($msg) { Write-Host "  [ ok ] $msg" -ForegroundColor Green }

Write-Host "TomTom Cowork plugin — validate & package" -ForegroundColor Cyan
Write-Host "Root: $Root"

# --- Load manifest --------------------------------------------------------
$manifestPath = Join-Path $Root "manifest.json"
if (-not (Test-Path $manifestPath)) { throw "manifest.json not found at $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

# --- Apply overrides ------------------------------------------------------
if ($GatewayUrl)  { $manifest.agentConnectors[0].toolSource.remoteMcpServer.mcpServerUrl = $GatewayUrl }
if ($AppId)       { $manifest.id = $AppId }
if ($DeveloperName) { $manifest.developer.name = $DeveloperName }
if ($WebsiteUrl)  { $manifest.developer.websiteUrl = $WebsiteUrl }
if ($PrivacyUrl)  { $manifest.developer.privacyUrl = $PrivacyUrl }
if ($TermsUrl)    { $manifest.developer.termsOfUseUrl = $TermsUrl }
if ($Version)     { $manifest.version = $Version }

# --- Validate manifest basics --------------------------------------------
Write-Host "`nValidating manifest..."
if ($manifest.manifestVersion) { Pass "manifestVersion = $($manifest.manifestVersion)" } else { Fail "missing manifestVersion" }
if ($manifest.id -match '^[0-9a-fA-F-]{36}$') { Pass "id is a GUID" } else { Fail "id must be a GUID" }
if ($manifest.icons.color -and (Test-Path (Join-Path $Root $manifest.icons.color))) { Pass "color icon present" } else { Fail "color icon missing" }
if ($manifest.icons.outline -and (Test-Path (Join-Path $Root $manifest.icons.outline))) { Pass "outline icon present" } else { Fail "outline icon missing" }

# --- Validate skills ------------------------------------------------------
Write-Host "`nValidating skills..."
$kebab = '^[a-z0-9]+(-[a-z0-9]+)*$'
if (-not $manifest.agentSkills -or $manifest.agentSkills.Count -eq 0) { Fail "no agentSkills declared" }
if ($manifest.agentSkills.Count -gt 20) { Fail "more than 20 skills (ASKILL-M002)" }
$seen = @{}
foreach ($s in $manifest.agentSkills) {
    $folderRel = $s.folder
    if (-not $folderRel) { Fail "agentSkills entry missing 'folder'"; continue }
    if ($seen.ContainsKey($folderRel)) { Fail "duplicate skill folder: $folderRel" }
    $seen[$folderRel] = $true
    $folderPath = Join-Path $Root ($folderRel -replace '^\./', '')
    $leaf = Split-Path $folderPath -Leaf
    if (-not (Test-Path $folderPath)) { Fail "skill folder missing: $folderRel"; continue }
    $skillMd = Join-Path $folderPath "SKILL.md"
    if (-not (Test-Path $skillMd)) { Fail "SKILL.md missing in $folderRel"; continue }

    # Parse frontmatter
    $lines = Get-Content $skillMd
    if ($lines[0].Trim() -ne '---') { Fail "${folderRel}/SKILL.md: frontmatter must start with ---"; continue }
    $fmName = $null; $hasDesc = $false; $i = 1
    while ($i -lt $lines.Count -and $lines[$i].Trim() -ne '---') {
        if ($lines[$i] -match '^name:\s*(.+?)\s*$') { $fmName = $Matches[1].Trim('"').Trim("'") }
        if ($lines[$i] -match '^description:\s*\S') { $hasDesc = $true }
        if ($lines[$i] -match '^description:\s*\|') { $hasDesc = $true }
        $i++
    }
    if (-not $fmName) { Fail "${folderRel}: frontmatter missing name" }
    elseif ($fmName -ne $leaf) { Fail "${folderRel}: name '$fmName' != folder '$leaf' (ASKILL-P006)" }
    elseif ($fmName -notmatch $kebab) { Fail "${folderRel}: name '$fmName' not kebab-case (ASKILL-P007)" }
    else { Pass "$leaf (name matches, kebab-case)" }
    if (-not $hasDesc) { Fail "${folderRel}: frontmatter missing description (ASKILL-P005)" }

    # Companion file count (<= 20, excluding SKILL.md)
    $companions = Get-ChildItem $folderPath -Recurse -File | Where-Object { $_.Name -ne 'SKILL.md' }
    if ($companions.Count -gt 20) { Fail "${folderRel}: more than 20 companion files" }
}

# --- Validate connectors --------------------------------------------------
Write-Host "`nValidating connectors..."
foreach ($c in $manifest.agentConnectors) {
    if (-not $c.id) { Fail "connector missing id" }
    if (-not $c.displayName) { Fail "connector '$($c.id)' missing displayName" }
    $rms = $c.toolSource.remoteMcpServer
    if (-not $rms) { Fail "connector '$($c.id)' missing remoteMcpServer" ; continue }
    if ($rms.mcpServerUrl -match '^https://') { Pass "connector '$($c.id)' MCP URL is HTTPS" } else { Fail "connector '$($c.id)' mcpServerUrl must be HTTPS" }
    $authType = $rms.authorization.type
    if ($authType -eq 'None' -and $rms.authorization.PSObject.Properties.Name -contains 'referenceId') {
        Fail "connector '$($c.id)': referenceId must NOT be present when type is None"
    } elseif ($authType -ne 'None' -and -not $rms.authorization.referenceId) {
        Fail "connector '$($c.id)': referenceId required when type is $authType"
    } else { Pass "connector '$($c.id)' auth = $authType" }

    # mcpToolDescription is required by the v1.28 schema; the referenced file
    # must exist and contain a valid { "tools": [...] } definition.
    $toolDescFile = $rms.mcpToolDescription.file
    if (-not $toolDescFile) {
        Fail "connector '$($c.id)': remoteMcpServer.mcpToolDescription.file is required"
    } else {
        $tdPath = Join-Path $Root $toolDescFile
        if (-not (Test-Path $tdPath)) {
            Fail "connector '$($c.id)': tool description file missing: $toolDescFile"
        } else {
            try {
                $td = Get-Content $tdPath -Raw | ConvertFrom-Json
                if ($td.tools -and $td.tools.Count -gt 0) {
                    Pass "connector '$($c.id)' tool description: $($td.tools.Count) tools ($toolDescFile)"
                    if ($td.tools.name -contains 'tomtom-get-api-key') { Fail "tool description leaks tomtom-get-api-key" }
                } else { Fail "connector '$($c.id)': $toolDescFile has no tools array" }
            } catch { Fail "connector '$($c.id)': $toolDescFile is not valid JSON" }
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host "`nValidation FAILED with $($failures.Count) error(s)." -ForegroundColor Red
    throw "Validation failed."
}
Write-Host "`nValidation PASSED." -ForegroundColor Green

# --- Ensure icons exist ---------------------------------------------------
$iconScript = Join-Path $Root "New-Icons.ps1"
if ((Test-Path $iconScript) -and (-not (Test-Path (Join-Path $Root $manifest.icons.color)))) {
    Write-Host "Generating icons..."
    & $iconScript -OutputDir $Root | Out-Null
}

# --- Stage and package ----------------------------------------------------
if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }
$staging = Join-Path $OutputDir "_staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

# Write the (possibly overridden) manifest into staging
$manifest | ConvertTo-Json -Depth 25 | Set-Content -Path (Join-Path $staging "manifest.json") -Encoding utf8
Copy-Item (Join-Path $Root $manifest.icons.color)   (Join-Path $staging $manifest.icons.color)
Copy-Item (Join-Path $Root $manifest.icons.outline) (Join-Path $staging $manifest.icons.outline)
Copy-Item (Join-Path $Root "skills") (Join-Path $staging "skills") -Recurse

# Copy each connector's tool description file (required by the v1.28 schema)
foreach ($c in $manifest.agentConnectors) {
    $tdf = $c.toolSource.remoteMcpServer.mcpToolDescription.file
    if ($tdf) {
        $src = Join-Path $Root $tdf
        if (Test-Path $src) { Copy-Item $src (Join-Path $staging $tdf) }
    }
}

$pkgName = "tomtom-cowork-plugin-$($manifest.version).zip"
$zipPath = Join-Path $OutputDir $pkgName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath
Remove-Item $staging -Recurse -Force

Write-Host "`nPackaged: $zipPath" -ForegroundColor Cyan
Write-Host "Connector MCP URL: $($manifest.agentConnectors[0].toolSource.remoteMcpServer.mcpServerUrl)"
Write-Host "Upload via: M365 Admin Center > (Copilot > Agents > All agents > Add agent) or Manage Apps > Upload custom app."
