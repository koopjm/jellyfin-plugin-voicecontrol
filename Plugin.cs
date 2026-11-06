using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Whisper.net;
using Whisper.net.Ggml;

namespace Jellyfin.Plugin.VoiceControl;

public class Plugin : BasePlugin<BasePluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
    }

    public override string Name => "Voice Control";

    public override Guid Id => Guid.Parse("b29e4c32-7d51-4f0b-9c23-02e1f5a8b202");

    public override string Description => "Adds a Microphone button to the top toolbar (Legacy & Modern UI) with local Whisper.net fallback for Tesla/Firefox/Chromium voice commands.";
}

public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<WhisperTranscriber>();
        serviceCollection.AddTransient<IStartupFilter, VoiceControlStartupFilter>();
    }
}

public sealed class WhisperTranscriber : IDisposable
{
    private readonly IApplicationPaths _appPaths;
    private readonly IMediaEncoder _mediaEncoder;
    private readonly ILogger<WhisperTranscriber> _logger;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private WhisperFactory? _factory;
    private bool _nativeLoaded;

    public WhisperTranscriber(
        IApplicationPaths appPaths,
        IMediaEncoder mediaEncoder,
        ILogger<WhisperTranscriber> logger)
    {
        _appPaths = appPaths;
        _mediaEncoder = mediaEncoder;
        _logger = logger;
    }

    private void EnsureNativeLibrariesLoaded()
    {
        if (_nativeLoaded)
        {
            return;
        }

        var pluginDir = Path.GetDirectoryName(typeof(Plugin).Assembly.Location) ?? string.Empty;
        var gompPath = Path.Combine(pluginDir, "runtimes", "linux-x64", "libgomp.so.1");
        if (File.Exists(gompPath))
        {
            NativeLibrary.Load(gompPath);
        }

        // Load from noavx/linux-x64 if CPU lacks AVX, otherwise linux-x64
        bool hasAvx = System.Runtime.Intrinsics.X86.Avx.IsSupported && System.Runtime.Intrinsics.X86.Avx2.IsSupported;
        var nativeDir = !hasAvx && Directory.Exists(Path.Combine(pluginDir, "runtimes", "noavx", "linux-x64"))
            ? Path.Combine(pluginDir, "runtimes", "noavx", "linux-x64")
            : Path.Combine(pluginDir, "runtimes", "linux-x64");

        if (Directory.Exists(nativeDir))
        {
            string[] libs =
            [
                "libggml-base-whisper.so",
                "libggml-cpu-whisper.so",
                "libggml-whisper.so",
                "libwhisper.so"
            ];
            foreach (var lib in libs)
            {
                var fullPath = Path.Combine(nativeDir, lib);
                if (File.Exists(fullPath))
                {
                    NativeLibrary.Load(fullPath);
                }
            }
        }

        _nativeLoaded = true;
    }

    private async Task<WhisperFactory> GetFactoryAsync(CancellationToken ct)
    {
        if (_factory is not null)
        {
            return _factory;
        }

        await _initLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_factory is not null)
            {
                return _factory;
            }

            EnsureNativeLibrariesLoaded();

            var modelDir = Path.Combine(_appPaths.DataPath, "voicecontrol");
            Directory.CreateDirectory(modelDir);
            var modelPath = Path.Combine(modelDir, "ggml-tiny.en.bin");

            if (!File.Exists(modelPath) || new FileInfo(modelPath).Length < 10_000_000)
            {
                _logger.LogInformation("[VoiceControl] Downloading Whisper ggml-tiny.en model to {Path}...", modelPath);
                var tmpPath = modelPath + ".tmp";
                await using (var modelStream = await WhisperGgmlDownloader.GetGgmlModelAsync(GgmlType.TinyEn, cancellationToken: ct).ConfigureAwait(false))
                await using (var fileStream = File.Create(tmpPath))
                {
                    await modelStream.CopyToAsync(fileStream, ct).ConfigureAwait(false);
                }

                File.Move(tmpPath, modelPath, true);
                _logger.LogInformation("[VoiceControl] Whisper ggml-tiny.en model ready.");
            }

            _factory = WhisperFactory.FromPath(modelPath);
            return _factory;
        }
        finally
        {
            _initLock.Release();
        }
    }

    public async Task<string> TranscribeAsync(Stream audioStream, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var inputPath = Path.Combine(Path.GetTempPath(), $"jf_vc_{id}.audio");
        var wavPath = Path.Combine(Path.GetTempPath(), $"jf_vc_{id}.wav");

        try
        {
            await using (var fs = File.Create(inputPath))
            {
                await audioStream.CopyToAsync(fs, ct).ConfigureAwait(false);
            }

            if (new FileInfo(inputPath).Length == 0)
            {
                return string.Empty;
            }

            var ffmpeg = !string.IsNullOrEmpty(_mediaEncoder.EncoderPath) && File.Exists(_mediaEncoder.EncoderPath)
                ? _mediaEncoder.EncoderPath
                : "/usr/lib/jellyfin-ffmpeg/ffmpeg";

            var psi = new ProcessStartInfo
            {
                FileName = ffmpeg,
                Arguments = $"-y -i \"{inputPath}\" -ar 16000 -ac 1 -c:a pcm_s16le \"{wavPath}\"",
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using (var proc = Process.Start(psi))
            {
                if (proc is not null)
                {
                    await proc.WaitForExitAsync(ct).ConfigureAwait(false);
                }
            }

            if (!File.Exists(wavPath))
            {
                _logger.LogWarning("[VoiceControl] FFmpeg failed to convert input audio to 16kHz WAV.");
                return string.Empty;
            }

            var factory = await GetFactoryAsync(ct).ConfigureAwait(false);
            using var processor = factory.CreateBuilder()
                .WithLanguage("en")
                .WithNoContext()
                .Build();

            var sb = new StringBuilder();
            await using var wavStream = File.OpenRead(wavPath);
            await foreach (var segment in processor.ProcessAsync(wavStream, ct).ConfigureAwait(false))
            {
                if (!string.IsNullOrWhiteSpace(segment.Text))
                {
                    sb.Append(segment.Text).Append(' ');
                }
            }

            // Strip non-speech annotations like [BLANK_AUDIO] or (music)
            var cleaned = Regex.Replace(sb.ToString(), @"\[.*?\]|\(.*?\)", string.Empty).Trim();
            cleaned = Regex.Replace(cleaned, @"[.,?!]+$", string.Empty).Trim().ToLowerInvariant();
            _logger.LogInformation("[VoiceControl] Whisper transcribed: \"{Text}\"", cleaned);
            return cleaned;
        }
        finally
        {
            try { if (File.Exists(inputPath)) File.Delete(inputPath); } catch { }
            try { if (File.Exists(wavPath)) File.Delete(wavPath); } catch { }
        }
    }

    public void Dispose()
    {
        _factory?.Dispose();
        _initLock.Dispose();
    }
}

public sealed class VoiceControlStartupFilter : IStartupFilter
{
    private const string ScriptRoute = "/web/plugins/voicecontrol.js";
    private const string TranscribeRoute = "/VoiceControl/Transcribe";
    private const string PluginWindowKey = "voiceControlPlugin";
    private const string ResourceName = "Jellyfin.Plugin.VoiceControl.Web.voicecontrol.js";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(async (context, nextMiddleware) =>
            {
                var path = context.Request.Path.Value ?? string.Empty;

                if (path.EndsWith(ScriptRoute, StringComparison.OrdinalIgnoreCase))
                {
                    context.Response.ContentType = "application/javascript; charset=utf-8";
                    context.Response.Headers.CacheControl = "no-cache";
                    await using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName);
                    if (stream is not null)
                    {
                        await stream.CopyToAsync(context.Response.Body).ConfigureAwait(false);
                    }
                    return;
                }

                if (path.EndsWith(TranscribeRoute, StringComparison.OrdinalIgnoreCase)
                    && HttpMethods.IsPost(context.Request.Method))
                {
                    context.Response.ContentType = "application/json; charset=utf-8";
                    try
                    {
                        var transcriber = context.RequestServices.GetRequiredService<WhisperTranscriber>();
                        var text = await transcriber.TranscribeAsync(context.Request.Body, context.RequestAborted).ConfigureAwait(false);
                        var json = JsonSerializer.Serialize(new { text });
                        await context.Response.WriteAsync(json, context.RequestAborted).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        context.Response.StatusCode = 500;
                        var json = JsonSerializer.Serialize(new { error = ex.Message });
                        await context.Response.WriteAsync(json, context.RequestAborted).ConfigureAwait(false);
                    }
                    return;
                }

                bool isIndexHtml = path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase);
                bool isConfigJson = path.EndsWith("/web/config.json", StringComparison.OrdinalIgnoreCase);

                if (!isIndexHtml && !isConfigJson)
                {
                    await nextMiddleware().ConfigureAwait(false);
                    return;
                }

                context.Request.Headers.Remove("Accept-Encoding");
                var originalBody = context.Response.Body;
                using var memStream = new MemoryStream();
                context.Response.Body = memStream;

                await nextMiddleware().ConfigureAwait(false);

                memStream.Position = 0;
                var content = await new StreamReader(memStream, Encoding.UTF8).ReadToEndAsync().ConfigureAwait(false);

                if (context.Response.StatusCode == 200 && !string.IsNullOrEmpty(content))
                {
                    if (isIndexHtml && content.Contains("</body>", StringComparison.OrdinalIgnoreCase))
                    {
                        var scriptTag = "<script src=\"plugins/voicecontrol.js\"></script></body>";
                        content = content.Replace("</body>", scriptTag, StringComparison.OrdinalIgnoreCase);
                    }
                    else if (isConfigJson)
                    {
                        try
                        {
                            var node = JsonNode.Parse(content);
                            if (node?["plugins"] is JsonArray pluginsArray &&
                                !pluginsArray.Any(p => p?.GetValue<string>() == PluginWindowKey))
                            {
                                pluginsArray.Add(PluginWindowKey);
                                content = node.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
                            }
                        }
                        catch
                        {
                        }
                    }
                }

                var bytes = Encoding.UTF8.GetBytes(content);
                context.Response.ContentLength = bytes.Length;
                context.Response.Body = originalBody;
                await originalBody.WriteAsync(bytes).ConfigureAwait(false);
            });

            next(app);
        };
    }
}
