using Serilog;

namespace TomTomGraphConnector;

/// <summary>
/// Main program: Creates the Graph external connection, crawls TomTom data,
/// and pushes it into Microsoft Search for M365 Copilot.
/// </summary>
public class Program
{
    public static async Task Main(string[] args)
    {
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Information()
            .WriteTo.Console()
            .CreateLogger();

        try
        {
            var configPath = args.Length > 0 ? args[0] : "appsettings.json";
            Log.Information("Loading configuration from {Path}", configPath);
            var config = ConnectorConfig.Load(configPath);

            if (args.Contains("--delete"))
            {
                var svc = new GraphConnectorService(config);
                await svc.DeleteConnectionAsync();
                return;
            }

            Log.Information("=== TomTom Graph Connector ===");
            Log.Information("Tenant: {TenantId}", config.TenantId);
            Log.Information("Connection: {ConnectionId}", config.ConnectionId);
            Log.Information("MCP Server: {McpBaseUrl}", config.McpBaseUrl);

            // Step 1: Create the external connection in Microsoft Graph
            var graphService = new GraphConnectorService(config);
            await graphService.CreateConnectionAsync();

            // Step 2: Register the schema
            await graphService.RegisterSchemaAsync();

            // Step 3: Crawl TomTom data and push items
            var tomtom = new TomTomClient(config.TomTomApiKey, config.McpBaseUrl);
            var allItems = new List<LocationItem>();

            // 3a: Geocode and index office locations
            Log.Information("--- Indexing office locations ---");
            foreach (var office in config.Offices)
            {
                Log.Information("Geocoding office: {Name} ({Address})", office.Name, office.Address);
                var results = await tomtom.GeocodeAsync(office.Address, limit: 1);
                foreach (var item in results)
                {
                    item.Name = office.Name;
                    item.Type = "Office";
                    item.NearestOffice = office.Name;
                    allItems.Add(item);
                }

                // 3b: Find POIs near each office
                if (results.Count > 0)
                {
                    var officeLocation = results[0];
                    foreach (var (categoryName, categoryId) in config.PoiCategories)
                    {
                        Log.Information("  Searching {Category} near {Office}...", categoryName, office.Name);
                        var pois = await tomtom.SearchNearbyAsync(
                            officeLocation.Latitude,
                            officeLocation.Longitude,
                            categoryId,
                            config.PoiSearchRadius,
                            config.PoiLimitPerCategory);

                        foreach (var poi in pois)
                        {
                            poi.NearestOffice = office.Name;
                            poi.Category = categoryName;
                            allItems.Add(poi);
                        }

                        await Task.Delay(500); // Rate limit courtesy
                    }
                }

                await Task.Delay(500);
            }

            // 3c: Index key landmarks
            Log.Information("--- Indexing landmarks ---");
            foreach (var landmark in config.Landmarks)
            {
                Log.Information("Searching landmark: {Landmark}", landmark);
                var results = await tomtom.FuzzySearchAsync(landmark, limit: 1);
                foreach (var item in results)
                {
                    item.Type = "Landmark";
                    allItems.Add(item);
                }
                await Task.Delay(500);
            }

            // Step 4: If enabled, search for EV charging stations near each office
            if (config.IncludeEvCharging)
            {
                Log.Information("--- Indexing EV charging stations ---");
                foreach (var office in config.Offices)
                {
                    // Find the office location from previously geocoded items
                    var officeItem = allItems.FirstOrDefault(i => i.Name == office.Name && i.Type == "Office");
                    if (officeItem == null)
                    {
                        Log.Warning("  Skipping EV search for {Office} - office location not found", office.Name);
                        continue;
                    }

                    Log.Information("  Searching EV charging stations near {Office}...", office.Name);
                    var evStations = await tomtom.SearchEvChargingAsync(
                        officeItem.Latitude,
                        officeItem.Longitude,
                        config.EvSearchRadius);

                    foreach (var ev in evStations)
                    {
                        ev.NearestOffice = office.Name;
                        allItems.Add(ev);
                    }

                    await Task.Delay(500); // Rate limit courtesy
                }
            }

            // Step 5: Push all items to Microsoft Graph
            Log.Information("--- Pushing {Count} items to Microsoft Search ---", allItems.Count);
            int success = 0, errors = 0;

            foreach (var item in allItems)
            {
                try
                {
                    await graphService.PushItemAsync(item);
                    success++;
                    await Task.Delay(200); // Rate limit
                }
                catch (Exception ex)
                {
                    errors++;
                    Log.Error("  Failed to index {Name}: {Error}", item.Name, ex.Message);
                }
            }

            Log.Information("=== Indexing Complete ===");
            Log.Information("Total items: {Total}", allItems.Count);
            Log.Information("Succeeded: {Success}", success);
            Log.Information("Failed: {Errors}", errors);
        }
        catch (Exception ex)
        {
            Log.Fatal(ex, "Fatal error in Graph Connector");
            throw;
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }
}
