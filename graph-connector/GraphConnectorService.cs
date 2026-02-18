using Azure.Identity;
using Microsoft.Graph;
using Microsoft.Graph.Models.ExternalConnectors;
using Serilog;

namespace TomTomGraphConnector;

/// <summary>
/// Manages the Microsoft Graph External Connection — creates the connection,
/// defines schema, and pushes items into Microsoft Search.
/// </summary>
public class GraphConnectorService
{
    private readonly GraphServiceClient _graphClient;
    private readonly ConnectorConfig _config;

    public GraphConnectorService(ConnectorConfig config)
    {
        _config = config;

        var credential = new ClientSecretCredential(
            config.TenantId,
            config.ClientId,
            config.ClientSecret);

        _graphClient = new GraphServiceClient(credential, new[] { "https://graph.microsoft.com/.default" });
    }

    /// <summary>
    /// Create the external connection if it doesn't exist.
    /// </summary>
    public async Task CreateConnectionAsync()
    {
        Log.Information("Creating external connection: {ConnectionId}", _config.ConnectionId);

        try
        {
            var existing = await _graphClient.External.Connections[_config.ConnectionId].GetAsync();
            if (existing != null)
            {
                Log.Information("Connection already exists: {ConnectionId}", _config.ConnectionId);
                return;
            }
        }
        catch (Exception)
        {
            // Connection doesn't exist, create it
        }

        var connection = new ExternalConnection
        {
            Id = _config.ConnectionId,
            Name = _config.ConnectionName,
            Description = _config.ConnectionDescription,
        };

        await _graphClient.External.Connections.PostAsync(connection);
        Log.Information("External connection created: {ConnectionId}", _config.ConnectionId);
    }

    /// <summary>
    /// Register the schema for location items.
    /// </summary>
    public async Task RegisterSchemaAsync()
    {
        Log.Information("Registering schema for connection: {ConnectionId}", _config.ConnectionId);

        try
        {
            // Check if schema already exists
            var existing = await _graphClient.External.Connections[_config.ConnectionId].Schema.GetAsync();
            if (existing?.Properties?.Count > 0)
            {
                Log.Information("Schema already exists with {Count} properties, skipping registration", existing.Properties.Count);
                return;
            }
        }
        catch (Exception)
        {
            // Schema doesn't exist yet, proceed to create
        }

        var schema = new Schema
        {
            BaseType = "microsoft.graph.externalItem",
            Properties = new List<Property>
            {
                new() { Name = "name", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true,
                    Labels = new List<Label?> { Label.Title } },
                new() { Name = "address", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true },
                new() { Name = "street", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true },
                new() { Name = "city", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true },
                new() { Name = "country", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true },
                new() { Name = "countryCode", Type = PropertyType.String, IsRetrievable = true },
                new() { Name = "postalCode", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true },
                new() { Name = "latitude", Type = PropertyType.Double, IsRetrievable = true, IsQueryable = true },
                new() { Name = "longitude", Type = PropertyType.Double, IsRetrievable = true, IsQueryable = true },
                new() { Name = "locationType", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true },
                new() { Name = "category", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true },
                new() { Name = "phone", Type = PropertyType.String, IsRetrievable = true },
                new() { Name = "url", Type = PropertyType.String, IsRetrievable = true,
                    Labels = new List<Label?> { Label.Url } },
                new() { Name = "source", Type = PropertyType.String, IsRetrievable = true },
                new() { Name = "nearestOffice", Type = PropertyType.String, IsSearchable = true, IsRetrievable = true, IsQueryable = true },
                new() { Name = "lastUpdated", Type = PropertyType.DateTime, IsRetrievable = true, IsQueryable = true },
            }
        };

        await _graphClient.External.Connections[_config.ConnectionId].Schema.PatchAsync(schema);
        Log.Information("Schema registration initiated. This may take several minutes to provision.");

        // Wait for schema provisioning
        await WaitForSchemaProvisioningAsync();
    }

    private async Task WaitForSchemaProvisioningAsync()
    {
        Log.Information("Waiting for schema provisioning...");
        for (int i = 0; i < 30; i++) // Wait up to 5 minutes
        {
            await Task.Delay(10000); // 10 seconds

            try
            {
                var schema = await _graphClient.External.Connections[_config.ConnectionId].Schema.GetAsync();
                if (schema?.BaseType != null)
                {
                    Log.Information("Schema provisioned successfully");
                    return;
                }
            }
            catch (Exception ex)
            {
                Log.Debug("Schema not ready yet: {Message}", ex.Message);
            }
        }

        Log.Warning("Schema provisioning may still be in progress. Continuing...");
    }

    /// <summary>
    /// Push a location item into Microsoft Search.
    /// </summary>
    public async Task PushItemAsync(LocationItem item)
    {
        // Generate a stable, valid external item ID (6-356 chars, alphanumeric + limited special)
        var sanitizedId = GenerateItemId(item);

        var properties = new Dictionary<string, object>();
        if (!string.IsNullOrEmpty(item.Name)) properties["name"] = item.Name;
        if (!string.IsNullOrEmpty(item.Address)) properties["address"] = item.Address;
        if (!string.IsNullOrEmpty(item.Street)) properties["street"] = item.Street;
        if (!string.IsNullOrEmpty(item.City)) properties["city"] = item.City;
        if (!string.IsNullOrEmpty(item.Country)) properties["country"] = item.Country;
        if (!string.IsNullOrEmpty(item.CountryCode)) properties["countryCode"] = item.CountryCode;
        if (!string.IsNullOrEmpty(item.PostalCode)) properties["postalCode"] = item.PostalCode;
        properties["latitude"] = item.Latitude;
        properties["longitude"] = item.Longitude;
        if (!string.IsNullOrEmpty(item.Type)) properties["locationType"] = item.Type;
        if (!string.IsNullOrEmpty(item.Category)) properties["category"] = item.Category;
        if (!string.IsNullOrEmpty(item.Phone)) properties["phone"] = item.Phone;
        if (!string.IsNullOrEmpty(item.Url)) properties["url"] = item.Url;
        if (!string.IsNullOrEmpty(item.Source)) properties["source"] = item.Source;
        if (!string.IsNullOrEmpty(item.NearestOffice)) properties["nearestOffice"] = item.NearestOffice;
        properties["lastUpdated"] = item.LastUpdated;

        var externalItem = new ExternalItem
        {
            Id = sanitizedId,
            Properties = new Properties
            {
                AdditionalData = properties
            },
            Content = new ExternalItemContent
            {
                Type = ExternalItemContentType.Text,
                Value = $"{item.Name} - {item.Address}. Type: {item.Type}. Category: {item.Category}. Near: {item.NearestOffice}."
            },
            Acl = new List<Acl>
            {
                new()
                {
                    AccessType = AccessType.Grant,
                    Type = AclType.Everyone,
                    Value = "everyone"
                }
            }
        };

        await _graphClient.External.Connections[_config.ConnectionId].Items[sanitizedId].PutAsync(externalItem);
        Log.Information("  Indexed: {Name} ({Type}) [{Id}]", item.Name, item.Type, sanitizedId);
    }

    /// <summary>
    /// Delete the external connection and all its data.
    /// </summary>
    public async Task DeleteConnectionAsync()
    {
        Log.Information("Deleting external connection: {ConnectionId}", _config.ConnectionId);
        await _graphClient.External.Connections[_config.ConnectionId].DeleteAsync();
        Log.Information("Connection deleted");
    }

    private static string GenerateItemId(LocationItem item)
    {
        // Create a deterministic, unique ID from the item's key properties
        var raw = $"{item.Name}-{item.Latitude:F4}-{item.Longitude:F4}-{item.Type}";
        // Hash it for a stable, safe ID
        var bytes = System.Text.Encoding.UTF8.GetBytes(raw);
        var hash = System.Security.Cryptography.SHA256.HashData(bytes);
        return Convert.ToHexString(hash)[..32].ToLowerInvariant();
    }
}
