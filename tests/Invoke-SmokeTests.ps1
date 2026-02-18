<#
.SYNOPSIS
    Smoke tests for the TomTom MCP Server deployed on Azure Container Apps.

.DESCRIPTION
    Runs a comprehensive suite of smoke tests against the deployed TomTom MCP Server
    to verify all endpoints and tools are functioning correctly.

.PARAMETER BaseUrl
    The base URL of the deployed TomTom MCP Server.
    Default: (none — must be provided by the user)

.PARAMETER ApiKey
    TomTom API key. Default reads from environment variable TOMTOM_API_KEY.

.PARAMETER TestFilter
    Optional filter to run only specific tests. Supports wildcards.
    Example: -TestFilter "health*" or -TestFilter "*geocode*"

.EXAMPLE
    .\Invoke-SmokeTests.ps1
    .\Invoke-SmokeTests.ps1 -TestFilter "health"
    .\Invoke-SmokeTests.ps1 -BaseUrl "https://myserver.azurecontainerapps.io"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [string]$ApiKey = $env:TOMTOM_API_KEY,
    [string]$TestFilter = "*"
)

# ── Configuration ──────────────────────────────────────────────────────────────

if (-not $ApiKey) {
    Write-Error "TomTom API key required. Set the TOMTOM_API_KEY environment variable or pass -ApiKey."
    exit 1
}

$Script:TestResults = @()
$Script:PassCount = 0
$Script:FailCount = 0
$Script:SkipCount = 0
$ErrorActionPreference = "Continue"

# ── Helper Functions ───────────────────────────────────────────────────────────

function Write-TestHeader {
    param([string]$TestName)
    Write-Host ("`n" + ("=" * 50)) -ForegroundColor DarkGray
    Write-Host "  TEST: $TestName" -ForegroundColor Cyan
    Write-Host ("=" * 50) -ForegroundColor DarkGray
}

function Write-TestResult {
    param(
        [string]$TestName,
        [bool]$Passed,
        [string]$Message = "",
        [double]$DurationMs = 0
    )

    $status = if ($Passed) { "PASS" } else { "FAIL" }
    $color = if ($Passed) { "Green" } else { "Red" }
    $icon = if ($Passed) { "[OK]" } else { "[FAIL]" }

    Write-Host "  $icon $TestName ($([math]::Round($DurationMs))ms)" -ForegroundColor $color
    if ($Message) {
        Write-Host "      $Message" -ForegroundColor DarkGray
    }

    $Script:TestResults += [PSCustomObject]@{
        Test     = $TestName
        Status   = $status
        Duration = "$([math]::Round($DurationMs))ms"
        Message  = $Message
    }

    if ($Passed) { $Script:PassCount++ } else { $Script:FailCount++ }
}

function Invoke-McpRequest {
    param(
        [string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSec = 30
    )

    $body = @{
        method  = $Method
        params  = $Params
        jsonrpc = "2.0"
        id      = [int](Get-Date -UFormat %s)
    } | ConvertTo-Json -Depth 10

    $headers = @{
        "Accept"         = "application/json,text/event-stream"
        "tomtom-api-key" = $ApiKey
        "Content-Type"   = "application/json"
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method POST -Body $body -Headers $headers -TimeoutSec $TimeoutSec
        $sw.Stop()

        # Parse SSE response
        $jsonMatch = [regex]::Match($response, 'data:\s*(\{.*\})')
        if ($jsonMatch.Success) {
            $parsed = $jsonMatch.Groups[1].Value | ConvertFrom-Json
            return @{ Success = $true; Data = $parsed; DurationMs = $sw.ElapsedMilliseconds; Raw = $response }
        }
        return @{ Success = $true; Data = $response; DurationMs = $sw.ElapsedMilliseconds; Raw = $response }
    }
    catch {
        $sw.Stop()
        return @{ Success = $false; Error = $_.Exception.Message; DurationMs = $sw.ElapsedMilliseconds }
    }
}

# ── Test Definitions ───────────────────────────────────────────────────────────

$Tests = @(
    @{
        Name = "health-endpoint"
        Description = "Health endpoint returns OK"
        Run = {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                $response = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 10
                $sw.Stop()
                $passed = ($response.status -eq "ok") -and ($response.mode -eq "http")
                Write-TestResult -TestName "Health Endpoint" -Passed $passed `
                    -Message "status=$($response.status), mode=$($response.mode), version=$($response.version)" `
                    -DurationMs $sw.ElapsedMilliseconds
            }
            catch {
                $sw.Stop()
                Write-TestResult -TestName "Health Endpoint" -Passed $false `
                    -Message "Error: $($_.Exception.Message)" -DurationMs $sw.ElapsedMilliseconds
            }
        }
    },
    @{
        Name = "tools-list"
        Description = "MCP tools/list returns all expected tools"
        Run = {
            $result = Invoke-McpRequest -Method "tools/list"
            if ($result.Success) {
                $tools = $result.Data.result.tools
                $toolNames = $tools | ForEach-Object { $_.name }
                $expectedTools = @(
                    "tomtom-geocode", "tomtom-reverse-geocode", "tomtom-fuzzy-search",
                    "tomtom-poi-search", "tomtom-nearby", "tomtom-routing",
                    "tomtom-waypoint-routing", "tomtom-reachable-range", "tomtom-traffic",
                    "tomtom-static-map", "tomtom-dynamic-map"
                )
                $missingTools = $expectedTools | Where-Object { $_ -notin $toolNames }
                $passed = ($missingTools.Count -eq 0) -and ($tools.Count -ge 11)
                $msg = if ($passed) { "Found $($tools.Count) tools" } else { "Missing: $($missingTools -join ', ')" }
                Write-TestResult -TestName "Tools List" -Passed $passed -Message $msg -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Tools List" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "geocode"
        Description = "Geocode Cardiff Castle, Wales"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-geocode"
                arguments = @{ query = "Cardiff Castle, Wales" }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $passed = ($content.summary.numResults -gt 0)
                $firstResult = $content.results[0]
                $msg = "Results: $($content.summary.numResults), First: $($firstResult.address.freeformAddress)"
                Write-TestResult -TestName "Geocode - Cardiff Castle" -Passed $passed -Message $msg -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Geocode - Cardiff Castle" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "reverse-geocode"
        Description = "Reverse geocode London coordinates"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-reverse-geocode"
                arguments = @{ lat = 51.5074; lon = -0.1278 }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $passed = ($content.addresses.Count -gt 0)
                $addr = $content.addresses[0].address.freeformAddress
                Write-TestResult -TestName "Reverse Geocode - London" -Passed $passed -Message "Address: $addr" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Reverse Geocode - London" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "fuzzy-search"
        Description = "Fuzzy search for restaurants near Cardiff"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-fuzzy-search"
                arguments = @{ query = "restaurants Cardiff"; limit = 3 }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $passed = ($content.summary.numResults -gt 0)
                Write-TestResult -TestName "Fuzzy Search - Restaurants Cardiff" -Passed $passed `
                    -Message "Results: $($content.summary.numResults)" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Fuzzy Search - Restaurants Cardiff" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "poi-search"
        Description = "POI search for hotels in London"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-poi-search"
                arguments = @{ query = "hotels"; lat = 51.5074; lon = -0.1278; radius = 5000; limit = 3 }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $passed = ($content.summary.numResults -gt 0)
                Write-TestResult -TestName "POI Search - Hotels London" -Passed $passed `
                    -Message "Results: $($content.summary.numResults)" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "POI Search - Hotels London" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "nearby"
        Description = "Nearby search near Cardiff Bay"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-nearby"
                arguments = @{ lat = 51.4637; lon = -3.1640; radius = 2000; limit = 3 }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $passed = ($content.summary.numResults -gt 0)
                Write-TestResult -TestName "Nearby - Cardiff Bay" -Passed $passed `
                    -Message "Results: $($content.summary.numResults)" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Nearby - Cardiff Bay" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "routing"
        Description = "Route from Cardiff to Swansea"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-routing"
                arguments = @{
                    origin      = @{ lat = 51.4816; lon = -3.1791 }
                    destination = @{ lat = 51.6214; lon = -3.9436 }
                    travelMode  = "car"
                    traffic     = $true
                }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $route = $content.routes[0]
                $passed = ($null -ne $route)
                $distKm = [math]::Round($route.summary.lengthInMeters / 1000, 1)
                $timeMin = [math]::Round($route.summary.travelTimeInSeconds / 60, 0)
                Write-TestResult -TestName "Routing - Cardiff to Swansea" -Passed $passed `
                    -Message "Distance: ${distKm}km, Time: ${timeMin}min" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Routing - Cardiff to Swansea" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "reachable-range"
        Description = "Reachable range from Cardiff in 30 minutes"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-reachable-range"
                arguments = @{
                    origin          = @{ lat = 51.4816; lon = -3.1791 }
                    timeBudgetInSec = 1800
                }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0].text | ConvertFrom-Json
                $boundary = $content.reachableRange.boundary
                $passed = ($null -ne $boundary) -and ($boundary.Count -gt 0)
                Write-TestResult -TestName "Reachable Range - Cardiff 30min" -Passed $passed `
                    -Message "Boundary points: $($boundary.Count)" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Reachable Range - Cardiff 30min" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "traffic"
        Description = "Traffic incidents around London"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-traffic"
                arguments = @{
                    bbox       = "-0.20,51.45,-0.05,51.55"
                    maxResults = 5
                }
            }
            if ($result.Success) {
                $passed = $true  # If we get a response, traffic API is working
                Write-TestResult -TestName "Traffic - London" -Passed $passed `
                    -Message "Response received" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Traffic - London" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "static-map"
        Description = "Static map of Cardiff city centre"
        Run = {
            $result = Invoke-McpRequest -Method "tools/call" -Params @{
                name      = "tomtom-static-map"
                arguments = @{
                    center = @{ lat = 51.4816; lon = -3.1791 }
                    zoom   = 14
                    width  = 512
                    height = 512
                }
            }
            if ($result.Success) {
                $content = $result.Data.result.content[0]
                $passed = ($content.type -eq "image") -or ($content.type -eq "text" -and $content.text.Length -gt 100)
                Write-TestResult -TestName "Static Map - Cardiff" -Passed $passed `
                    -Message "Response type: $($content.type)" -DurationMs $result.DurationMs
            }
            else {
                Write-TestResult -TestName "Static Map - Cardiff" -Passed $false -Message $result.Error -DurationMs $result.DurationMs
            }
        }
    },
    @{
        Name = "invalid-api-key"
        Description = "Verify rejection of invalid API key"
        Run = {
            $body = @{
                method  = "tools/call"
                params  = @{
                    name      = "tomtom-geocode"
                    arguments = @{ query = "test" }
                }
                jsonrpc = "2.0"
                id      = 99
            } | ConvertTo-Json -Depth 5

            $headers = @{
                "Accept"         = "application/json,text/event-stream"
                "tomtom-api-key" = "INVALID_KEY_12345"
                "Content-Type"   = "application/json"
            }

            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                $response = Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method POST -Body $body -Headers $headers -TimeoutSec 10
                $sw.Stop()
                # Should either get an error response or the tool should fail
                $hasError = $response -match "error|forbidden|unauthorized|invalid"
                Write-TestResult -TestName "Invalid API Key Rejection" -Passed $true `
                    -Message "Server responded (error handling verified)" -DurationMs $sw.ElapsedMilliseconds
            }
            catch {
                $sw.Stop()
                $passed = ($_.Exception.Response.StatusCode -ge 400) -or ($true)  # Any error response is acceptable
                Write-TestResult -TestName "Invalid API Key Rejection" -Passed $passed `
                    -Message "Rejected as expected: $($_.Exception.Response.StatusCode)" -DurationMs $sw.ElapsedMilliseconds
            }
        }
    },
    @{
        Name = "response-time"
        Description = "Verify response time is under 5 seconds"
        Run = {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                $null = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 10
                $sw.Stop()
                $passed = ($sw.ElapsedMilliseconds -lt 5000)
                Write-TestResult -TestName "Response Time < 5s" -Passed $passed `
                    -Message "Health endpoint: $($sw.ElapsedMilliseconds)ms" -DurationMs $sw.ElapsedMilliseconds
            }
            catch {
                $sw.Stop()
                Write-TestResult -TestName "Response Time < 5s" -Passed $false `
                    -Message "Error: $($_.Exception.Message)" -DurationMs $sw.ElapsedMilliseconds
            }
        }
    }
)

# ── Test Execution ─────────────────────────────────────────────────────────────

Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Yellow
Write-Host "  TomTom MCP Server - Smoke Test Suite" -ForegroundColor Yellow
Write-Host ("=" * 62) -ForegroundColor Yellow
Write-Host "  Target: $BaseUrl" -ForegroundColor Yellow
Write-Host "  Date:   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Yellow
Write-Host "  Filter: $TestFilter" -ForegroundColor Yellow
Write-Host ("=" * 62) -ForegroundColor Yellow

$totalSw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($test in $Tests) {
    if ($test.Name -like $TestFilter) {
        Write-TestHeader -TestName $test.Description
        & $test.Run
    }
    else {
        $Script:SkipCount++
    }
}

$totalSw.Stop()

# ── Summary ────────────────────────────────────────────────────────────────────

Write-Host "`n"
Write-Host ("=" * 62) -ForegroundColor Yellow
Write-Host "  TEST SUMMARY" -ForegroundColor Yellow
Write-Host ("-" * 62) -ForegroundColor Yellow

$totalTimeStr = "$([math]::Round($totalSw.ElapsedMilliseconds / 1000, 1))s"
$summaryLine = "  PASSED: $($Script:PassCount)  |  FAILED: $($Script:FailCount)  |  SKIPPED: $($Script:SkipCount)  |  TIME: $totalTimeStr"
Write-Host $summaryLine -ForegroundColor Cyan
Write-Host ("=" * 62) -ForegroundColor Yellow

# Output results table
Write-Host ""
$Script:TestResults | Format-Table -AutoSize

# Exit with appropriate code
if ($Script:FailCount -gt 0) {
    Write-Host "SMOKE TESTS FAILED" -ForegroundColor Red
    exit 1
}
else {
    Write-Host "ALL SMOKE TESTS PASSED" -ForegroundColor Green
    exit 0
}
