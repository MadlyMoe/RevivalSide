using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

var relaySecret = Environment.GetEnvironmentVariable("REVIVALSIDE_RELAY_SECRET")?.Trim() ?? "";
if (relaySecret.Length < 32)
    throw new InvalidOperationException("REVIVALSIDE_RELAY_SECRET must contain at least 32 characters.");

var insecureLoopback = Environment.GetEnvironmentVariable("REVIVALSIDE_RELAY_INSECURE_LOOPBACK") == "1";
var port = int.TryParse(Environment.GetEnvironmentVariable("REVIVALSIDE_RELAY_PORT"), out var configuredPort)
    && configuredPort is > 0 and <= 65535 ? configuredPort : 443;
var certificatePath = Environment.GetEnvironmentVariable("REVIVALSIDE_RELAY_CERTIFICATE")?.Trim() ?? "";
var privateKeyPath = Environment.GetEnvironmentVariable("REVIVALSIDE_RELAY_PRIVATE_KEY")?.Trim() ?? "";
if (!insecureLoopback && (!File.Exists(certificatePath) || !File.Exists(privateKeyPath)))
    throw new InvalidOperationException("A PEM certificate and private key are required for the public relay.");

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxConcurrentConnections = 250;
    options.Limits.MaxConcurrentUpgradedConnections = 200;
    options.Limits.MaxRequestBodySize = RelayLimits.MaxBodyBytes;
    options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
    options.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(30);
    if (insecureLoopback)
        options.ListenLocalhost(port);
    else
        options.ListenAnyIP(port, listen => listen.UseHttps(certificatePath, privateKeyPath));
});

var state = new RelayState(relaySecret);
var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

app.MapGet("/health", () => Results.Json(new
{
    ok = true,
    service = "revivalside-relay",
    version = 1,
    tls = !insecureLoopback,
    hosts = state.ActiveHostCount,
    rooms = state.ActiveRoomCount,
    tunnels = state.ActiveTunnelCount,
}));

app.MapPost("/v1/hosts/{hostId}/heartbeat", (HttpContext context, string hostId) =>
{
    if (!state.Authorize(context.Request)) return Results.Unauthorized();
    if (!RelayState.ValidIdentifier(hostId)) return Results.BadRequest(new { error = "invalid host id" });
    return state.TouchHost(hostId)
        ? Results.Json(new { ok = true })
        : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
});

app.MapPost("/v1/rooms", async (HttpContext context) =>
{
    if (!state.Authorize(context.Request)) return Results.Unauthorized();
    var request = await ReadJsonAsync<RegisterRoomRequest>(context.Request, context.RequestAborted);
    if (request is null || !RelayState.ValidIdentifier(request.HostId) || !RelayState.ValidRoomCode(request.Code))
        return Results.BadRequest(new { error = "invalid host id or room code" });
    return state.RegisterRoom(request.HostId, request.Code)
        ? Results.Json(new { ok = true })
        : Results.StatusCode(StatusCodes.Status409Conflict);
});

app.MapGet("/v1/hosts/{hostId}/joins", async (HttpContext context, string hostId) =>
{
    if (!state.Authorize(context.Request)) return Results.Unauthorized();
    if (!RelayState.ValidIdentifier(hostId)) return Results.BadRequest(new { error = "invalid host id" });
    var pending = await state.WaitForHostJoinAsync(hostId, context.RequestAborted);
    return pending is null
        ? Results.NoContent()
        : Results.Json(new
        {
            id = pending.Id,
            code = pending.Code,
            user = pending.User,
            tunnelId = pending.TunnelId,
            hostTunnelToken = pending.HostToken,
        });
});

app.MapPost("/v1/joins/{joinId}/complete", async (HttpContext context, string joinId) =>
{
    if (!state.Authorize(context.Request)) return Results.Unauthorized();
    if (!RelayState.ValidIdentifier(joinId)) return Results.BadRequest(new { error = "invalid join id" });
    var result = await ReadJsonAsync<JoinCompletion>(context.Request, context.RequestAborted);
    if (result is null) return Results.BadRequest(new { error = "invalid completion" });
    return state.CompleteJoin(joinId, result)
        ? Results.Json(new { ok = true })
        : Results.NotFound();
});

app.MapPost("/v1/rooms/{code}/join", async (HttpContext context, string code) =>
{
    if (!state.Authorize(context.Request)) return Results.Unauthorized();
    if (!state.AllowJoin(context.Connection.RemoteIpAddress))
        return Results.StatusCode(StatusCodes.Status429TooManyRequests);
    if (!RelayState.ValidRoomCode(code)) return Results.NotFound();
    var request = await ReadJsonAsync<GuestJoinRequest>(context.Request, context.RequestAborted);
    if (request is null || request.User.ValueKind != JsonValueKind.Object)
        return Results.BadRequest(new { error = "invalid guest profile" });
    var result = await state.RequestJoinAsync(code, request.User, context.RequestAborted);
    return result is null
        ? Results.NotFound()
        : Results.Json(new
        {
            errorCode = result.Completion.ErrorCode,
            accessToken = result.Completion.AccessToken ?? "",
            tunnelId = result.Pending.TunnelId,
            guestTunnelToken = result.Pending.GuestToken,
        });
});

app.Map("/v1/tunnels/{tunnelId}", async (HttpContext context, string tunnelId) =>
{
    if (!context.WebSockets.IsWebSocketRequest || !RelayState.ValidIdentifier(tunnelId))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await state.RunTunnelEndpointAsync(tunnelId, socket, context.RequestAborted);
});

_ = state.RunCleanupLoopAsync(app.Lifetime.ApplicationStopping);
await app.RunAsync();

static async Task<T?> ReadJsonAsync<T>(HttpRequest request, CancellationToken cancellationToken)
{
    if (request.ContentLength is > RelayLimits.MaxBodyBytes) return default;
    try
    {
        return await JsonSerializer.DeserializeAsync<T>(request.Body, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            MaxDepth = 64,
        }, cancellationToken);
    }
    catch (JsonException)
    {
        return default;
    }
}

sealed class RelayState(string relaySecret)
{
    private static readonly TimeSpan HostTtl = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan RoomTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan JoinTtl = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan TunnelTtl = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan TunnelLifetime = TimeSpan.FromHours(6);
    private static readonly TimeSpan TunnelIdleTimeout = TimeSpan.FromMinutes(2);
    private readonly byte[] secretBytes = Encoding.UTF8.GetBytes(relaySecret);
    private readonly ConcurrentDictionary<string, HostState> hosts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, RoomState> rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, PendingJoin> joins = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, TunnelState> tunnels = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Queue<DateTimeOffset>> joinRates = new(StringComparer.Ordinal);

    public int ActiveHostCount => hosts.Count;
    public int ActiveRoomCount => rooms.Count;
    public int ActiveTunnelCount => tunnels.Count;

    public static bool ValidIdentifier(string? value) => value is { Length: >= 8 and <= 80 }
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
    public static bool ValidRoomCode(string? value) => value is { Length: 8 and <= 16 }
        && value.All(char.IsAsciiLetterOrDigit);

    public bool Authorize(HttpRequest request)
    {
        const string prefix = "Bearer ";
        var value = request.Headers.Authorization.ToString();
        return value.StartsWith(prefix, StringComparison.Ordinal)
            && FixedEquals(Encoding.UTF8.GetBytes(value[prefix.Length..]), secretBytes);
    }

    public bool TouchHost(string hostId)
    {
        if (!hosts.TryGetValue(hostId, out var host))
        {
            if (hosts.Count >= RelayLimits.MaxHosts) return false;
            host = hosts.GetOrAdd(hostId, static id => new HostState(id));
        }
        host.LastSeen = DateTimeOffset.UtcNow;
        return true;
    }

    public bool RegisterRoom(string hostId, string code)
    {
        if (!TouchHost(hostId)) return false;
        var host = hosts[hostId];
        var normalizedCode = code.ToUpperInvariant();
        if (!rooms.ContainsKey(normalizedCode) && host.Rooms.Count >= RelayLimits.MaxRoomsPerHost) return false;
        var room = new RoomState(normalizedCode, hostId, DateTimeOffset.UtcNow);
        rooms.AddOrUpdate(normalizedCode, room, (_, existing) => existing.HostId == hostId ? room : existing);
        var stored = rooms[normalizedCode];
        if (stored.HostId != hostId) return false;
        host.Rooms[normalizedCode] = 0;
        return true;
    }

    public async Task<PendingJoin?> WaitForHostJoinAsync(string hostId, CancellationToken cancellationToken)
    {
        if (!TouchHost(hostId)) return null;
        var host = hosts[hostId];
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        try { return await host.Pending.Reader.ReadAsync(timeout.Token); }
        catch (OperationCanceledException) { return null; }
    }

    public async Task<CompletedJoin?> RequestJoinAsync(string code, JsonElement user, CancellationToken cancellationToken)
    {
        var normalized = code.ToUpperInvariant();
        if (!rooms.TryGetValue(normalized, out var room) || DateTimeOffset.UtcNow - room.UpdatedAt > RoomTtl) return null;
        if (!hosts.TryGetValue(room.HostId, out var host) || DateTimeOffset.UtcNow - host.LastSeen > HostTtl) return null;
        var id = Token(18);
        var tunnelId = Token(18);
        var pending = new PendingJoin(id, normalized, room.HostId, user.Clone(), tunnelId, Token(24), Token(24), DateTimeOffset.UtcNow);
        joins[id] = pending;
        tunnels[tunnelId] = new TunnelState(tunnelId, pending.HostToken, pending.GuestToken, pending.CreatedAt);
        if (!host.Pending.Writer.TryWrite(pending))
        {
            joins.TryRemove(id, out _);
            tunnels.TryRemove(tunnelId, out _);
            return null;
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(JoinTtl);
        try
        {
            var completion = await pending.Completion.Task.WaitAsync(timeout.Token);
            if (completion.ErrorCode != 0) tunnels.TryRemove(tunnelId, out _);
            return new CompletedJoin(pending, completion);
        }
        catch (OperationCanceledException)
        {
            joins.TryRemove(id, out _);
            tunnels.TryRemove(tunnelId, out _);
            return null;
        }
    }

    public bool CompleteJoin(string joinId, JoinCompletion completion)
    {
        if (!joins.TryRemove(joinId, out var pending)) return false;
        if (completion.ErrorCode == 0 && string.IsNullOrWhiteSpace(completion.AccessToken)) return false;
        return pending.Completion.TrySetResult(completion);
    }

    public bool AllowJoin(IPAddress? address)
    {
        var key = address?.ToString() ?? "unknown";
        var now = DateTimeOffset.UtcNow;
        var queue = joinRates.GetOrAdd(key, static _ => new Queue<DateTimeOffset>());
        lock (queue)
        {
            while (queue.TryPeek(out var first) && now - first > TimeSpan.FromMinutes(1)) queue.Dequeue();
            if (queue.Count >= RelayLimits.MaxJoinsPerMinutePerIp) return false;
            queue.Enqueue(now);
            return true;
        }
    }

    public async Task RunTunnelEndpointAsync(string tunnelId, WebSocket socket, CancellationToken requestAborted)
    {
        if (!tunnels.TryGetValue(tunnelId, out var tunnel))
        {
            await CloseAsync(socket, WebSocketCloseStatus.PolicyViolation, "unknown tunnel");
            return;
        }
        using var authenticationTimeout = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
        authenticationTimeout.CancelAfter(TimeSpan.FromSeconds(5));
        WsMessage? hello = null;
        try { hello = await ReceiveMessageAsync(socket, 8192, authenticationTimeout.Token); }
        catch (OperationCanceledException) { }
        TunnelHello? authentication = null;
        try
        {
            if (hello is not null && !hello.Binary)
                authentication = JsonSerializer.Deserialize<TunnelHello>(hello.Data, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (JsonException) { }
        if (authentication is null || !FixedEquals(Encoding.UTF8.GetBytes(authentication.Secret ?? ""), secretBytes)
            || !tunnel.Attach(authentication.Role, authentication.Token, socket))
        {
            await CloseAsync(socket, WebSocketCloseStatus.PolicyViolation, "authentication failed");
            return;
        }
        try
        {
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
            lifetime.CancelAfter(TunnelLifetime);
            await tunnel.Paired.Task.WaitAsync(TunnelTtl, lifetime.Token);
            var peer = tunnel.Peer(socket);
            if (peer is null) return;
            while (socket.State == WebSocketState.Open && peer.State == WebSocketState.Open)
            {
                var message = await ReceiveMessageWithIdleTimeoutAsync(socket, RelayLimits.MaxWebSocketMessageBytes, TunnelIdleTimeout, lifetime.Token);
                if (message is null) break;
                await peer.SendAsync(message.Data, message.Binary ? WebSocketMessageType.Binary : WebSocketMessageType.Text, true, lifetime.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally
        {
            tunnels.TryRemove(tunnelId, out _);
            await tunnel.CloseBothAsync();
        }
    }

    public async Task RunCleanupLoopAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        try
        {
            while (await timer.WaitForNextTickAsync(stopping))
            {
                var now = DateTimeOffset.UtcNow;
                foreach (var (id, pending) in joins)
                    if (now - pending.CreatedAt > JoinTtl && joins.TryRemove(id, out var removed)) removed.Completion.TrySetCanceled();
                foreach (var (id, tunnel) in tunnels)
                    if (now - tunnel.CreatedAt > TunnelLifetime || (!tunnel.IsPaired && now - tunnel.CreatedAt > TunnelTtl)) tunnels.TryRemove(id, out _);
                foreach (var (code, room) in rooms)
                    if (now - room.UpdatedAt > RoomTtl || !hosts.ContainsKey(room.HostId)) rooms.TryRemove(code, out _);
                foreach (var (id, host) in hosts)
                {
                    if (now - host.LastSeen <= HostTtl) continue;
                    hosts.TryRemove(id, out _);
                    foreach (var code in host.Rooms.Keys) rooms.TryRemove(code, out _);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task<WsMessage?> ReceiveMessageWithIdleTimeoutAsync(WebSocket socket, int maximumBytes, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        idle.CancelAfter(timeout);
        return await ReceiveMessageAsync(socket, maximumBytes, idle.Token);
    }

    private static async Task<WsMessage?> ReceiveMessageAsync(WebSocket socket, int maximumBytes, CancellationToken cancellationToken)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[Math.Min(64 * 1024, maximumBytes)];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            if (stream.Length + result.Count > maximumBytes) throw new WebSocketException("message too large");
            await stream.WriteAsync(buffer.AsMemory(0, result.Count), cancellationToken);
        } while (!result.EndOfMessage);
        return new WsMessage(stream.ToArray(), result.MessageType == WebSocketMessageType.Binary);
    }

    private static async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived)) return;
        try { await socket.CloseAsync(status, reason, CancellationToken.None); }
        catch (WebSocketException) { }
    }

    private static bool FixedEquals(ReadOnlySpan<byte> left, ReadOnlySpan<byte> right) => left.Length == right.Length
        && CryptographicOperations.FixedTimeEquals(left, right);
    private static string Token(int bytes) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();

    internal sealed class HostState(string id)
    {
        public string Id { get; } = id;
        public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
        public ConcurrentDictionary<string, byte> Rooms { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Channel<PendingJoin> Pending { get; } = Channel.CreateBounded<PendingJoin>(new BoundedChannelOptions(RelayLimits.MaxPendingJoinsPerHost)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = false,
            SingleWriter = false,
        });
    }

    internal sealed class TunnelState(string id, string hostToken, string guestToken, DateTimeOffset createdAt)
    {
        private readonly object gate = new();
        private WebSocket? host;
        private WebSocket? guest;
        public string Id { get; } = id;
        public string HostToken { get; } = hostToken;
        public string GuestToken { get; } = guestToken;
        public DateTimeOffset CreatedAt { get; } = createdAt;
        public TaskCompletionSource Paired { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool IsPaired { get { lock (gate) return host is not null && guest is not null; } }

        public bool Attach(string? role, string? token, WebSocket socket)
        {
            lock (gate)
            {
                if (role == "host" && host is null && FixedEquals(Encoding.UTF8.GetBytes(token ?? ""), Encoding.UTF8.GetBytes(HostToken))) host = socket;
                else if (role == "guest" && guest is null && FixedEquals(Encoding.UTF8.GetBytes(token ?? ""), Encoding.UTF8.GetBytes(GuestToken))) guest = socket;
                else return false;
                if (host is not null && guest is not null) Paired.TrySetResult();
                return true;
            }
        }

        public WebSocket? Peer(WebSocket socket)
        {
            lock (gate) return ReferenceEquals(socket, host) ? guest : ReferenceEquals(socket, guest) ? host : null;
        }

        public async Task CloseBothAsync()
        {
            WebSocket? first;
            WebSocket? second;
            lock (gate) { first = host; second = guest; }
            if (first is not null) await CloseAsync(first, WebSocketCloseStatus.NormalClosure, "tunnel closed");
            if (second is not null) await CloseAsync(second, WebSocketCloseStatus.NormalClosure, "tunnel closed");
        }
    }
}

static class RelayLimits
{
    public const int MaxBodyBytes = 2 * 1024 * 1024;
    public const int MaxWebSocketMessageBytes = 1024 * 1024;
    public const int MaxHosts = 128;
    public const int MaxRoomsPerHost = 32;
    public const int MaxPendingJoinsPerHost = 32;
    public const int MaxJoinsPerMinutePerIp = 20;
}

sealed record RegisterRoomRequest(string HostId, string Code);
sealed record GuestJoinRequest(JsonElement User);
sealed record JoinCompletion(int ErrorCode, string? AccessToken);
sealed record CompletedJoin(PendingJoin Pending, JoinCompletion Completion);
sealed record TunnelHello(string? Secret, string? Role, string? Token);
sealed record WsMessage(byte[] Data, bool Binary);
sealed class PendingJoin(string id, string code, string hostId, JsonElement user, string tunnelId, string hostToken, string guestToken, DateTimeOffset createdAt)
{
    public string Id { get; } = id;
    public string Code { get; } = code;
    public string HostId { get; } = hostId;
    public JsonElement User { get; } = user;
    public string TunnelId { get; } = tunnelId;
    public string HostToken { get; } = hostToken;
    public string GuestToken { get; } = guestToken;
    public DateTimeOffset CreatedAt { get; } = createdAt;
    public TaskCompletionSource<JoinCompletion> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}
sealed record RoomState(string Code, string HostId, DateTimeOffset UpdatedAt);
