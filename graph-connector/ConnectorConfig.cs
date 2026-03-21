using System.Text.Json;

namespace TomTomGraphConnector;

/// <summary>
/// Configuration for the Graph Connector - loaded from appsettings.json
/// </summary>
public class ConnectorConfig
{
    public string TenantId { get; set; } = "";
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
    public string TomTomApiKey { get; set; } = "";
    public string McpBaseUrl { get; set; } = "";
    public string ConnectionId { get; set; } = "TomTomLocations";
    public string ConnectionName { get; set; } = "TomTom Locations";
    public string ConnectionDescription { get; set; } = "Office locations, landmarks, and nearby points of interest from TomTom";

    /// <summary>
    /// Office addresses to geocode and index, plus find nearby POIs.
    /// </summary>
    public List<OfficeEntry> Offices { get; set; } = new();

    /// <summary>
    /// Key landmarks and cities to index.
    /// </summary>
    public List<string> Landmarks { get; set; } = new();

    /// <summary>
    /// POI category IDs to search near each office.
    /// </summary>
    public Dictionary<string, string> PoiCategories { get; set; } = new();

    /// <summary>
    /// Radius in meters to search for POIs near each office.
    /// </summary>
    public int PoiSearchRadius { get; set; } = 2000;

    /// <summary>
    /// Max POIs per category per office.
    /// </summary>
    public int PoiLimitPerCategory { get; set; } = 5;

    /// <summary>
    /// Whether to index EV charging stations near each office.
    /// </summary>
    public bool IncludeEvCharging { get; set; } = true;

    /// <summary>
    /// Radius in meters to search for EV charging stations near each office.
    /// </summary>
    public int EvSearchRadius { get; set; } = 5000;

    public static ConnectorConfig Load(string path = "appsettings.json")
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"Config file not found: {path}");

        var json = File.ReadAllText(path);
        var config = JsonSerializer.Deserialize<ConnectorConfig>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        return config ?? throw new InvalidOperationException("Failed to parse config");
    }
}

public class OfficeEntry
{
    public string Name { get; set; } = "";
    public string Address { get; set; } = "";
}
