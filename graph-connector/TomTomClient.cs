using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TomTomGraphConnector;

/// <summary>
/// Client for calling TomTom APIs to fetch location data for indexing.
/// </summary>
public class TomTomClient
{
    private readonly HttpClient _http;
    private readonly string _apiKey;
    private readonly string _mcpBaseUrl;

    public TomTomClient(string apiKey, string mcpBaseUrl)
    {
        _apiKey = apiKey;
        _mcpBaseUrl = mcpBaseUrl.TrimEnd('/');
        _http = new HttpClient();
        _http.DefaultRequestHeaders.Add("tomtom-api-key", apiKey);
        _http.DefaultRequestHeaders.Add("Accept", "application/json,text/event-stream");
    }

    public async Task<List<LocationItem>> GeocodeAsync(string query, int limit = 3)
    {
        var response = await CallMcpToolAsync("tomtom-geocode", new { query, limit });
        var results = new List<LocationItem>();

        if (response?.Results == null) return results;

        foreach (var r in response.Results)
        {
            results.Add(new LocationItem
            {
                Id = r.Id ?? Guid.NewGuid().ToString("N"),
                Name = r.Address?.FreeformAddress ?? query,
                Address = r.Address?.FreeformAddress ?? "",
                Street = r.Address?.StreetName ?? "",
                City = r.Address?.Municipality ?? "",
                Country = r.Address?.Country ?? "",
                CountryCode = r.Address?.CountryCode ?? "",
                PostalCode = r.Address?.PostalCode ?? "",
                Latitude = r.Position?.Lat ?? 0,
                Longitude = r.Position?.Lon ?? 0,
                Type = "Office",
                Source = "TomTom Geocode",
                LastUpdated = DateTime.UtcNow
            });
        }

        return results;
    }

    public async Task<List<LocationItem>> SearchNearbyAsync(double lat, double lon, string category, int radius = 2000, int limit = 5)
    {
        var response = await CallMcpToolAsync("tomtom-nearby", new
        {
            lat,
            lon,
            categorySet = category,
            radius,
            limit
        });

        var results = new List<LocationItem>();
        if (response?.Results == null) return results;

        foreach (var r in response.Results)
        {
            var poiName = r.Poi?.Name ?? r.Address?.FreeformAddress ?? "Unknown";
            results.Add(new LocationItem
            {
                Id = r.Id ?? Guid.NewGuid().ToString("N"),
                Name = poiName,
                Address = r.Address?.FreeformAddress ?? "",
                Street = r.Address?.StreetName ?? "",
                City = r.Address?.Municipality ?? "",
                Country = r.Address?.Country ?? "",
                CountryCode = r.Address?.CountryCode ?? "",
                PostalCode = r.Address?.PostalCode ?? "",
                Latitude = r.Position?.Lat ?? 0,
                Longitude = r.Position?.Lon ?? 0,
                Type = "POI",
                Category = r.Poi?.CategorySet?.FirstOrDefault()?.Name ?? category,
                Phone = r.Poi?.Phone ?? "",
                Url = r.Poi?.Url ?? "",
                Source = "TomTom Nearby",
                LastUpdated = DateTime.UtcNow
            });
        }

        return results;
    }

    public async Task<List<LocationItem>> FuzzySearchAsync(string query, int limit = 5)
    {
        var response = await CallMcpToolAsync("tomtom-fuzzy-search", new { query, limit });
        var results = new List<LocationItem>();
        if (response?.Results == null) return results;

        foreach (var r in response.Results)
        {
            var name = r.Poi?.Name ?? r.Address?.FreeformAddress ?? query;
            results.Add(new LocationItem
            {
                Id = r.Id ?? Guid.NewGuid().ToString("N"),
                Name = name,
                Address = r.Address?.FreeformAddress ?? "",
                Street = r.Address?.StreetName ?? "",
                City = r.Address?.Municipality ?? "",
                Country = r.Address?.Country ?? "",
                CountryCode = r.Address?.CountryCode ?? "",
                PostalCode = r.Address?.PostalCode ?? "",
                Latitude = r.Position?.Lat ?? 0,
                Longitude = r.Position?.Lon ?? 0,
                Type = r.Type ?? "Location",
                Category = r.Poi?.CategorySet?.FirstOrDefault()?.Name ?? "",
                Source = "TomTom Search",
                LastUpdated = DateTime.UtcNow
            });
        }

        return results;
    }

    public async Task<List<LocationItem>> SearchEvChargingAsync(double lat, double lon, int radius = 5000)
    {
        var response = await CallMcpToolAsync("tomtom-ev-search", new { lat, lon, radius });
        var results = new List<LocationItem>();
        if (response?.Results == null) return results;

        foreach (var r in response.Results)
        {
            var name = r.Poi?.Name ?? r.Address?.FreeformAddress ?? "EV Charging Station";
            results.Add(new LocationItem
            {
                Id = r.Id ?? Guid.NewGuid().ToString("N"),
                Name = name,
                Address = r.Address?.FreeformAddress ?? "",
                Street = r.Address?.StreetName ?? "",
                City = r.Address?.Municipality ?? "",
                Country = r.Address?.Country ?? "",
                CountryCode = r.Address?.CountryCode ?? "",
                PostalCode = r.Address?.PostalCode ?? "",
                Latitude = r.Position?.Lat ?? 0,
                Longitude = r.Position?.Lon ?? 0,
                Type = "EV Charging",
                Category = "EV Charging Station",
                Phone = r.Poi?.Phone ?? "",
                Url = r.Poi?.Url ?? "",
                EvConnectorTypes = r.ChargingPark?.ConnectorTypes ?? "",
                EvPowerKw = r.ChargingPark?.PowerKw ?? "",
                EvAvailability = r.ChargingPark?.Availability ?? "",
                Source = "TomTom EV Search",
                LastUpdated = DateTime.UtcNow
            });
        }

        return results;
    }

    public async Task<List<LocationItem>> SearchAlongRouteAsync(string origin, string destination, string query, int maxDetourTime = 600)
    {
        var response = await CallMcpToolAsync("tomtom-search-along-route", new
        {
            origin,
            destination,
            query,
            maxDetourTime
        });

        var results = new List<LocationItem>();
        if (response?.Results == null) return results;

        foreach (var r in response.Results)
        {
            var name = r.Poi?.Name ?? r.Address?.FreeformAddress ?? query;
            results.Add(new LocationItem
            {
                Id = r.Id ?? Guid.NewGuid().ToString("N"),
                Name = name,
                Address = r.Address?.FreeformAddress ?? "",
                Street = r.Address?.StreetName ?? "",
                City = r.Address?.Municipality ?? "",
                Country = r.Address?.Country ?? "",
                CountryCode = r.Address?.CountryCode ?? "",
                PostalCode = r.Address?.PostalCode ?? "",
                Latitude = r.Position?.Lat ?? 0,
                Longitude = r.Position?.Lon ?? 0,
                Type = "POI",
                Category = r.Poi?.CategorySet?.FirstOrDefault()?.Name ?? query,
                Phone = r.Poi?.Phone ?? "",
                Url = r.Poi?.Url ?? "",
                Source = "TomTom Search Along Route",
                LastUpdated = DateTime.UtcNow
            });
        }

        return results;
    }

    public async Task<List<LocationItem>> AreaSearchAsync(string bbox, string query, int limit = 10)
    {
        var response = await CallMcpToolAsync("tomtom-area-search", new { bbox, query, limit });
        var results = new List<LocationItem>();
        if (response?.Results == null) return results;

        foreach (var r in response.Results)
        {
            var name = r.Poi?.Name ?? r.Address?.FreeformAddress ?? query;
            results.Add(new LocationItem
            {
                Id = r.Id ?? Guid.NewGuid().ToString("N"),
                Name = name,
                Address = r.Address?.FreeformAddress ?? "",
                Street = r.Address?.StreetName ?? "",
                City = r.Address?.Municipality ?? "",
                Country = r.Address?.Country ?? "",
                CountryCode = r.Address?.CountryCode ?? "",
                PostalCode = r.Address?.PostalCode ?? "",
                Latitude = r.Position?.Lat ?? 0,
                Longitude = r.Position?.Lon ?? 0,
                Type = "POI",
                Category = r.Poi?.CategorySet?.FirstOrDefault()?.Name ?? query,
                Phone = r.Poi?.Phone ?? "",
                Url = r.Poi?.Url ?? "",
                Source = "TomTom Area Search",
                LastUpdated = DateTime.UtcNow
            });
        }

        return results;
    }

    private async Task<TomTomSearchResponse?> CallMcpToolAsync(string toolName, object arguments)
    {
        var body = new
        {
            method = "tools/call",
            @params = new { name = toolName, arguments },
            jsonrpc = "2.0",
            id = 1
        };

        var jsonBody = JsonSerializer.Serialize(body);
        var content = new StringContent(jsonBody, System.Text.Encoding.UTF8, "application/json");

        var response = await _http.PostAsync($"{_mcpBaseUrl}/mcp", content);
        var responseText = await response.Content.ReadAsStringAsync();

        // Parse SSE response: "event: message\ndata: {json}\n\n"
        var dataPrefix = "data: ";
        var dataIndex = responseText.IndexOf(dataPrefix);
        if (dataIndex < 0) return null;

        var jsonStart = dataIndex + dataPrefix.Length;
        var jsonStr = responseText[jsonStart..].Trim();

        var rpcResponse = JsonSerializer.Deserialize<JsonElement>(jsonStr);
        var resultContent = rpcResponse.GetProperty("result").GetProperty("content");
        var textContent = resultContent[0].GetProperty("text").GetString();

        if (string.IsNullOrEmpty(textContent)) return null;

        return JsonSerializer.Deserialize<TomTomSearchResponse>(textContent, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });
    }
}

// --- TomTom API Response Models ---

public class TomTomSearchResponse
{
    public TomTomSummary? Summary { get; set; }
    public List<TomTomResult>? Results { get; set; }
    // For reverse geocode
    public List<TomTomReverseResult>? Addresses { get; set; }
}

public class TomTomSummary
{
    public int NumResults { get; set; }
    public int TotalResults { get; set; }
}

public class TomTomResult
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public double Score { get; set; }
    public TomTomAddress? Address { get; set; }
    public TomTomPosition? Position { get; set; }
    public TomTomPoi? Poi { get; set; }
    public TomTomChargingPark? ChargingPark { get; set; }
}

public class TomTomReverseResult
{
    public TomTomAddress? Address { get; set; }
    public string? Position { get; set; }
}

public class TomTomAddress
{
    public string? StreetName { get; set; }
    public string? Municipality { get; set; }
    public string? MunicipalitySubdivision { get; set; }
    public string? CountrySubdivision { get; set; }
    public string? CountrySubdivisionName { get; set; }
    public string? PostalCode { get; set; }
    public string? CountryCode { get; set; }
    public string? Country { get; set; }
    public string? FreeformAddress { get; set; }
}

public class TomTomPosition
{
    public double Lat { get; set; }
    public double Lon { get; set; }
}

public class TomTomPoi
{
    public string? Name { get; set; }
    public string? Phone { get; set; }
    public string? Url { get; set; }
    public List<TomTomCategory>? CategorySet { get; set; }
}

public class TomTomCategory
{
    public int Id { get; set; }
    public string? Name { get; set; }
}

public class TomTomChargingPark
{
    public string? ConnectorTypes { get; set; }
    public string? PowerKw { get; set; }
    public string? Availability { get; set; }
}
