namespace TomTomGraphConnector;

/// <summary>
/// Represents a location item to be indexed into Microsoft Search via Graph Connector.
/// </summary>
public class LocationItem
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Address { get; set; } = "";
    public string Street { get; set; } = "";
    public string City { get; set; } = "";
    public string Country { get; set; } = "";
    public string CountryCode { get; set; } = "";
    public string PostalCode { get; set; } = "";
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public string Type { get; set; } = ""; // Office, POI, Landmark
    public string Category { get; set; } = ""; // Restaurant, Hotel, Parking, etc.
    public string Phone { get; set; } = "";
    public string Url { get; set; } = "";
    public string Source { get; set; } = "";
    public DateTime LastUpdated { get; set; } = DateTime.UtcNow;
    public string NearestOffice { get; set; } = ""; // Which office this POI is near
    public string EvConnectorTypes { get; set; } = ""; // Comma-separated EV connector types
    public string EvPowerKw { get; set; } = ""; // EV charging power in kW
    public string EvAvailability { get; set; } = ""; // Real-time EV availability status
}
