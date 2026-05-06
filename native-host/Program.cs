using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

const int ServerPort = 17829;

var hostDir = AppContext.BaseDirectory;
var root = LocateRoot(hostDir);
var exePath = Path.Combine(root, "vendor", "waifu2x-ncnn-vulkan", "waifu2x-ncnn-vulkan.exe");
var vendorPath = Path.Combine(root, "vendor", "waifu2x-ncnn-vulkan");
var outputRoot = Path.Combine(Path.GetTempPath(), "waifu2x-chrome-output");

if (args.Length > 0 && args[0] == "--server")
{
    await RunServer(outputRoot);
    return;
}

await RunNativeHost();

async Task RunNativeHost()
{
    var stdin = Console.OpenStandardInput();
    var stdout = Console.OpenStandardOutput();

    while (true)
    {
        var header = await ReadExactly(stdin, 4);
        if (header.Length == 0)
        {
            return;
        }

        if (header.Length < 4)
        {
            await Send(stdout, new { ok = false, error = "Native message header is incomplete." });
            return;
        }

        var length = BitConverter.ToUInt32(header, 0);
        var body = await ReadExactly(stdin, checked((int)length));
        if (body.Length < length)
        {
            await Send(stdout, new { ok = false, error = "Native message body is incomplete." });
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var response = await HandleMessage(document.RootElement);
            await Send(stdout, response);
        }
        catch (Exception ex)
        {
            await Send(stdout, new { ok = false, error = ex.Message });
        }
    }
}

async Task<object> HandleMessage(JsonElement message)
{
    if (!message.TryGetProperty("type", out var type) || type.GetString() != "upscale")
    {
        return new { ok = false, error = "未知请求。" };
    }

    if (!File.Exists(exePath))
    {
        return new { ok = false, error = $"找不到 waifu2x：{exePath}" };
    }

    var dataUrl = message.GetProperty("imageDataUrl").GetString() ?? "";
    var comma = dataUrl.IndexOf(',');
    if (!dataUrl.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase) || comma < 0)
    {
        return new { ok = false, error = "输入图片不是 data URL。" };
    }

    Directory.CreateDirectory(outputRoot);
    var workDir = Directory.CreateTempSubdirectory("waifu2x-chrome-").FullName;
    var inputPath = Path.Combine(workDir, "input.png");
    var outputName = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{RandomNumberGenerator.GetHexString(8).ToLowerInvariant()}.png";
    var outputPath = Path.Combine(outputRoot, outputName);

    await File.WriteAllBytesAsync(inputPath, Convert.FromBase64String(dataUrl[(comma + 1)..]));

    var scale = Clamp(GetInt(message, "scale", 2), 2, 4);
    var noise = Clamp(GetInt(message, "noise", 2), -1, 3);
    var tileSize = Clamp(GetInt(message, "tileSize", 256), 64, 512);
    var modelName = GetString(message, "model", "models-cunet");
    var modelsPath = ResolveModelPath(modelName);
    if (modelsPath is null)
    {
        return new { ok = false, error = $"找不到模型：{modelName}" };
    }

    var process = Process.Start(new ProcessStartInfo
    {
        FileName = exePath,
        WorkingDirectory = Path.GetDirectoryName(exePath)!,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardError = true,
        RedirectStandardOutput = true,
        ArgumentList =
        {
            "-i", inputPath,
            "-o", outputPath,
            "-n", noise.ToString(),
            "-s", scale.ToString(),
            "-m", modelsPath,
            "-t", tileSize.ToString()
        }
    });

    if (process is null)
    {
        return new { ok = false, error = "无法启动 waifu2x。" };
    }

    var stderrTask = process.StandardError.ReadToEndAsync();
    var stdoutTask = process.StandardOutput.ReadToEndAsync();
    using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
    await process.WaitForExitAsync(cts.Token);

    if (process.ExitCode != 0)
    {
        var error = await stderrTask;
        var output = await stdoutTask;
        return new { ok = false, error = string.IsNullOrWhiteSpace(error) ? output : error };
    }

    await EnsureServer();

    try
    {
        Directory.Delete(workDir, true);
    }
    catch
    {
        // Best effort temp cleanup.
    }

    return new
    {
        ok = true,
        engine = "waifu2x-ncnn-vulkan",
        url = $"http://127.0.0.1:{ServerPort}/{outputName}",
        scale,
        noise,
        tileSize,
        model = Path.GetFileName(modelsPath),
        outputBytes = new FileInfo(outputPath).Length
    };
}

async Task EnsureServer()
{
    if (await CanConnect())
    {
        return;
    }

    Process.Start(new ProcessStartInfo
    {
        FileName = Environment.ProcessPath!,
        UseShellExecute = true,
        WindowStyle = ProcessWindowStyle.Hidden,
        ArgumentList = { "--server" }
    });

    var deadline = DateTimeOffset.UtcNow.AddSeconds(4);
    while (DateTimeOffset.UtcNow < deadline)
    {
        if (await CanConnect())
        {
            return;
        }

        await Task.Delay(120);
    }

    throw new InvalidOperationException("本地图片服务启动失败。");
}

async Task<bool> CanConnect()
{
    try
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, ServerPort).WaitAsync(TimeSpan.FromMilliseconds(350));
        return true;
    }
    catch
    {
        return false;
    }
}

async Task RunServer(string imageRoot)
{
    Directory.CreateDirectory(imageRoot);
    var listener = new TcpListener(IPAddress.Loopback, ServerPort);
    listener.Start();

    while (true)
    {
        var client = await listener.AcceptTcpClientAsync();
        _ = Task.Run(() => HandleHttpClient(client, imageRoot));
    }
}

async Task HandleHttpClient(TcpClient client, string imageRoot)
{
    await using var stream = client.GetStream();
    using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
    var requestLine = await reader.ReadLineAsync() ?? "";
    while (!string.IsNullOrEmpty(await reader.ReadLineAsync()))
    {
    }

    var parts = requestLine.Split(' ');
    var name = parts.Length > 1 ? Path.GetFileName(Uri.UnescapeDataString(parts[1].TrimStart('/'))) : "";
    var filePath = Path.Combine(imageRoot, name);

    if (!name.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || !File.Exists(filePath))
    {
        await WriteHttp(stream, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("not found"));
        return;
    }

    await WriteHttp(stream, "200 OK", "image/png", await File.ReadAllBytesAsync(filePath));
}

async Task WriteHttp(Stream stream, string status, string contentType, byte[] body)
{
    var header = Encoding.ASCII.GetBytes(
        $"HTTP/1.1 {status}\r\n" +
        "Access-Control-Allow-Origin: *\r\n" +
        "Access-Control-Allow-Private-Network: true\r\n" +
        "Cache-Control: no-store\r\n" +
        $"Content-Type: {contentType}\r\n" +
        $"Content-Length: {body.Length}\r\n" +
        "Connection: close\r\n\r\n");
    await stream.WriteAsync(header);
    await stream.WriteAsync(body);
}

async Task<byte[]> ReadExactly(Stream stream, int length)
{
    var buffer = new byte[length];
    var offset = 0;
    while (offset < length)
    {
        var read = await stream.ReadAsync(buffer.AsMemory(offset, length - offset));
        if (read == 0)
        {
            break;
        }
        offset += read;
    }

    return offset == length ? buffer : buffer[..offset];
}

async Task Send(Stream stdout, object message)
{
    var json = JsonSerializer.SerializeToUtf8Bytes(message);
    var header = BitConverter.GetBytes((uint)json.Length);
    await stdout.WriteAsync(header);
    await stdout.WriteAsync(json);
    await stdout.FlushAsync();
}

int GetInt(JsonElement element, string name, int fallback)
{
    return element.TryGetProperty(name, out var property) && property.TryGetInt32(out var value) ? value : fallback;
}

string GetString(JsonElement element, string name, string fallback)
{
    return element.TryGetProperty(name, out var property) ? property.GetString() ?? fallback : fallback;
}

int Clamp(int value, int min, int max)
{
    return Math.Max(min, Math.Min(max, value));
}

string? ResolveModelPath(string modelName)
{
    var allowedModels = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "models-cunet",
        "models-upconv_7_anime_style_art_rgb",
        "models-upconv_7_photo"
    };

    if (!allowedModels.Contains(modelName))
    {
        modelName = "models-cunet";
    }

    var path = Path.Combine(vendorPath, modelName);
    return Directory.Exists(path) ? path : null;
}

string LocateRoot(string start)
{
    var directory = new DirectoryInfo(start);
    while (directory is not null)
    {
        var manifest = Path.Combine(directory.FullName, "manifest.json");
        var waifu2x = Path.Combine(directory.FullName, "vendor", "waifu2x-ncnn-vulkan", "waifu2x-ncnn-vulkan.exe");
        if (File.Exists(manifest) && File.Exists(waifu2x))
        {
            return directory.FullName;
        }

        directory = directory.Parent;
    }

    return Path.GetFullPath(Path.Combine(start, "..", "..", "..", "..", ".."));
}
