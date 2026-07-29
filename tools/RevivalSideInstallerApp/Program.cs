using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;

namespace RevivalSideInstaller;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    private static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<SetupApp>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}

internal sealed class SetupApp : Application
{
    public override void Initialize()
    {
        Styles.Add(new FluentTheme());
        RequestedThemeVariant = ThemeVariant.Dark;
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new InstallerWindow();
        }
        base.OnFrameworkInitializationCompleted();
    }
}

internal sealed class InstallerWindow : Window
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private readonly string localPayloadRoot = Path.Combine(AppContext.BaseDirectory, "payload");
    private string payloadRoot = Path.Combine(AppContext.BaseDirectory, "payload");
    private string downloadedPayloadCacheRoot = "";
    private readonly Bitmap? backgroundImage;
    private readonly string backgroundName;

    private readonly TextBox targetBox = new() { MinWidth = 360 };
    private readonly CheckBox removeSetupFilesInput = new() { Content = "Remove setup files after install", IsChecked = true };
    private readonly Button browseButton = new() { Content = "Browse", MinWidth = 96, Height = 36 };
    private readonly Button installButton = new() { Content = "Install", MinWidth = 150, Height = 46 };
    private readonly Button launchButton = new() { Content = "Launch", MinWidth = 108, Height = 38, IsEnabled = false };
    private readonly ProgressBar progress = new() { Height = 7, Minimum = 0, Maximum = 100, Value = 0 };
    private readonly TextBlock statusText = new() { Text = "Ready" };
    private readonly TextBlock architectureText = new();
    private readonly TextBlock payloadText = new();
    private readonly TextBlock gameplayText = new() { Text = "Not checked" };
    private readonly TextBox logBox = new()
    {
        AcceptsReturn = true,
        IsReadOnly = true,
        TextWrapping = TextWrapping.NoWrap,
    };

    public InstallerWindow()
    {
        backgroundImage = null;
        backgroundName = "";
        Title = "RevivalSide Setup";
        Width = 940;
        Height = 620;
        MinWidth = 760;
        MinHeight = 520;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Brushes.Black;

        targetBox.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSide");
        architectureText.Text = GetWindowsRid();
        payloadText.Text = Directory.Exists(payloadRoot) ? "Detected" : "Missing";
        Content = BuildUi();
        BindEvents();

        AppendLog($"Detected: {GetWindowsRid()}");
        AppendLog($"Payload: {localPayloadRoot}");
        CheckPayloadSummary();
    }

    private Control BuildUi()
    {
        StyleControls();

        var root = new Grid();
        if (backgroundImage != null)
        {
            root.Children.Add(new Image { Source = backgroundImage, Stretch = Stretch.UniformToFill });
        }
        else
        {
            root.Children.Add(new Border { Background = DiagonalGradient(Color.FromRgb(12, 18, 30), Color.FromRgb(55, 38, 58)) });
        }
        root.Children.Add(new Border { Background = HorizontalGradient(Color.FromArgb(236, 5, 8, 14), Color.FromArgb(132, 5, 8, 14)) });
        root.Children.Add(new Border { Background = VerticalGradient(Color.FromArgb(0, 5, 8, 14), Color.FromArgb(236, 5, 8, 14)), VerticalAlignment = VerticalAlignment.Bottom, Height = 240 });

        var shell = new Grid
        {
            Margin = new Thickness(24, 20, 24, 24),
            MaxWidth = 980,
            HorizontalAlignment = HorizontalAlignment.Center,
            RowDefinitions = new RowDefinitions("Auto,*"),
        };
        shell.Children.Add(BuildHeader());

        var body = new Grid { Margin = new Thickness(0, 18, 0, 0) };
        Grid.SetRow(body, 1);
        body.Children.Add(BuildInstallCard());
        shell.Children.Add(body);
        root.Children.Add(shell);
        return root;
    }

    private Control BuildHeader()
    {
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var brand = new StackPanel { Spacing = 3 };
        brand.Children.Add(new TextBlock
        {
            Text = "RevivalSide Setup",
            Foreground = Brushes.White,
            FontSize = 34,
            FontWeight = FontWeight.SemiBold,
            LineHeight = 40,
        });
        brand.Children.Add(new TextBlock
        {
            Text = "Install the launcher and local listener runtime",
            Foreground = Brush(232, 238, 246),
            FontSize = 15,
        });
        brand.Children.Add(new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(backgroundName) ? "Story background unavailable" : $"Story background: {backgroundName}",
            Foreground = Brush(184, 196, 214),
            FontSize = 12,
            Margin = new Thickness(0, 4, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        header.Children.Add(brand);

        var status = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(190, 10, 14, 22)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(128, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(16, 8),
            VerticalAlignment = VerticalAlignment.Top,
            Child = statusText,
        };
        statusText.FontSize = 14;
        statusText.FontWeight = FontWeight.SemiBold;
        statusText.Foreground = Brush(255, 218, 76);
        Grid.SetColumn(status, 1);
        header.Children.Add(status);
        return header;
    }

    private Control BuildInstallCard()
    {
        var card = Glass(new Thickness(22), new Thickness(0), Color.FromArgb(216, 9, 13, 21));
        var layout = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,Auto,Auto,Auto,Auto,Auto,*"),
        };

        var titleRow = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        titleRow.Children.Add(Eyebrow("Install"));
        var note = new TextBlock
        {
            Text = "Existing profiles and local settings are preserved.",
            Foreground = Brush(194, 206, 224),
            FontSize = 13,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(note, 1);
        titleRow.Children.Add(note);
        AddRow(layout, titleRow, 0);
        AddRow(layout, BuildPackageStrip(), 1);

        var pathRow = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,Auto"),
            Margin = new Thickness(0, 18, 0, 12),
        };
        pathRow.Children.Add(targetBox);
        browseButton.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(browseButton, 1);
        pathRow.Children.Add(browseButton);
        AddRow(layout, pathRow, 2);

        removeSetupFilesInput.Margin = new Thickness(0, 0, 0, 12);
        AddRow(layout, removeSetupFilesInput, 3);

        var buttonRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 10,
            Margin = new Thickness(0, 0, 0, 14),
        };
        buttonRow.Children.Add(installButton);
        buttonRow.Children.Add(launchButton);
        AddRow(layout, buttonRow, 4);
        AddRow(layout, progress, 5);

        var logCard = Glass(new Thickness(12), new Thickness(0, 16, 0, 0), Color.FromArgb(170, 5, 8, 13));
        logCard.Child = Scrollable(logBox);
        AddRow(layout, logCard, 6);

        card.Child = layout;
        return card;
    }

    private Control BuildPackageStrip()
    {
        var strip = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,*,*"),
            ColumnSpacing = 10,
            Margin = new Thickness(0, 8, 0, 0),
        };
        var architecture = InfoChip("Architecture", architectureText);
        var payload = InfoChip("Payload", payloadText);
        var gameplay = InfoChip("Asset Mode", gameplayText);
        strip.Children.Add(architecture);
        Grid.SetColumn(payload, 1);
        strip.Children.Add(payload);
        Grid.SetColumn(gameplay, 2);
        strip.Children.Add(gameplay);
        return strip;
    }

    private static Control InfoChip(string label, TextBlock value)
    {
        value.Foreground = Brush(235, 242, 248);
        value.FontSize = 14;
        value.FontWeight = FontWeight.SemiBold;
        value.TextWrapping = TextWrapping.NoWrap;
        value.TextTrimming = TextTrimming.CharacterEllipsis;

        var layout = new StackPanel { Spacing = 3 };
        layout.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(166, 180, 200),
            FontSize = 11,
            FontWeight = FontWeight.Bold,
        });
        layout.Children.Add(value);

        return new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(126, 12, 17, 26)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(72, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 10),
            MinHeight = 58,
            Child = layout,
        };
    }

    private void StyleControls()
    {
        StyleButton(browseButton);
        StyleButton(launchButton);
        StyleButton(installButton, primary: true);
        targetBox.Background = Brush(16, 21, 30);
        targetBox.Foreground = Brush(235, 242, 248);
        targetBox.BorderBrush = new SolidColorBrush(Color.FromArgb(126, 170, 186, 210));
        targetBox.FontSize = 14;
        targetBox.Height = 36;
        targetBox.VerticalContentAlignment = VerticalAlignment.Center;
        targetBox.TextWrapping = TextWrapping.NoWrap;

        removeSetupFilesInput.Foreground = Brush(218, 228, 240);
        removeSetupFilesInput.FontSize = 13;

        logBox.Background = Brush(6, 9, 14);
        logBox.Foreground = Brush(218, 228, 240);
        logBox.FontFamily = "Cascadia Code, Consolas";
        logBox.FontSize = 12;
        logBox.BorderThickness = new Thickness(0);

        progress.Foreground = Brush(255, 218, 76);
        progress.Background = new SolidColorBrush(Color.FromArgb(120, 255, 255, 255));
    }

    private static void StyleButton(Button button, bool primary = false)
    {
        button.Background = primary ? Brush(255, 218, 76) : Brush(34, 42, 56);
        button.Foreground = primary ? Brush(18, 22, 28) : Brush(238, 243, 248);
        button.BorderBrush = primary ? Brush(255, 231, 132) : Brush(92, 106, 128);
        button.BorderThickness = new Thickness(1);
        button.CornerRadius = new CornerRadius(primary ? 12 : 5);
        button.Padding = primary ? new Thickness(24, 9) : new Thickness(16, 7);
        button.FontSize = primary ? 15 : 13;
        button.FontWeight = FontWeight.SemiBold;
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        button.VerticalContentAlignment = VerticalAlignment.Center;
    }

    private void BindEvents()
    {
        browseButton.Click += async (_, _) => await BrowseTargetAsync();
        installButton.Click += async (_, _) => await InstallAsync();
        launchButton.Click += (_, _) => LaunchInstalled();
    }

    private async Task BrowseTargetAsync()
    {
        var topLevel = GetTopLevel(this);
        if (topLevel == null) return;
        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Choose RevivalSide install folder",
            AllowMultiple = false,
            SuggestedStartLocation = await GetSuggestedStartLocationAsync(topLevel),
        });
        var path = folders.FirstOrDefault()?.TryGetLocalPath();
        if (!string.IsNullOrWhiteSpace(path)) targetBox.Text = path;
    }

    private async Task<IStorageFolder?> GetSuggestedStartLocationAsync(TopLevel topLevel)
    {
        var target = targetBox.Text ?? "";
        var initial = Directory.Exists(target)
            ? target
            : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        try { return await topLevel.StorageProvider.TryGetFolderFromPathAsync(initial); }
        catch { return null; }
    }

    private async Task InstallAsync()
    {
        installButton.IsEnabled = false;
        launchButton.IsEnabled = false;
        browseButton.IsEnabled = false;
        removeSetupFilesInput.IsEnabled = false;
        progress.Value = 0;
        progress.IsIndeterminate = true;
        SetStatus("Installing");

        var target = NormalizeTargetPath(targetBox.Text ?? "");
        var removeSetupFiles = removeSetupFilesInput.IsChecked == true;
        try
        {
            downloadedPayloadCacheRoot = "";
            payloadRoot = await EnsurePayloadReadyAsync();
            await Task.Run(() => InstallCore(target));
            if (removeSetupFiles)
            {
                await Task.Run(CleanupSetupFilesAfterInstall);
            }
            var canLaunch = await PromptInstallDotNet8IfMissingAsync(target);
            progress.IsIndeterminate = false;
            progress.Value = 100;
            launchButton.IsEnabled = canLaunch;
            SetStatus("Complete");
            AppendLog("Install complete.");
            if (canLaunch)
            {
                LaunchInstalled(target);
            }
            else
            {
                AppendLog("Launch skipped until .NET 8 Runtime is installed.");
            }
        }
        catch (Exception ex)
        {
            progress.IsIndeterminate = false;
            progress.Value = 0;
            SetStatus("Error");
            AppendLog($"ERROR: {ex.Message}");
            await ShowMessageAsync("RevivalSide Setup", ex.Message);
        }
        finally
        {
            installButton.IsEnabled = true;
            browseButton.IsEnabled = true;
            removeSetupFilesInput.IsEnabled = true;
        }
    }

    private void InstallCore(string target)
    {
        var rid = GetWindowsRid();
        var appPayload = Path.Combine(payloadRoot, "app");
        var runtimePayload = Path.Combine(payloadRoot, "runtime-apps", rid);
        var nodePayload = Path.Combine(payloadRoot, "runtime-node", rid);
        var pythonPayload = Path.Combine(payloadRoot, "runtime-python", rid);
        var wiresharkPayload = Path.Combine(payloadRoot, "runtime-wireshark", rid);
        var dotnetInstallerPayload = Path.Combine(payloadRoot, "runtime-installers", "dotnet", rid);

        SetStatus("Checking package");
        RequireDirectory(appPayload, "app payload");
        RequireDirectory(runtimePayload, $"runtime payload {rid}");
        RequireFile(Path.Combine(nodePayload, "node.exe"), $"node.exe for {rid}");
        RequireFile(Path.Combine(nodePayload, "npm.cmd"), $"npm.cmd for {rid}");
        RequireFile(Path.Combine(pythonPayload, "python.exe"), $"python.exe for {rid}");
        RequireFile(Path.Combine(wiresharkPayload, "dumpcap.exe"), $"dumpcap.exe for {rid}");
        RequireFile(Path.Combine(wiresharkPayload, "tshark.exe"), $"tshark.exe for {rid}");
        RequireDirectory(dotnetInstallerPayload, $".NET runtime installer for {rid}");
        var payloadApp = ValidateAppPayload(appPayload, "app payload");
        SetGameplayStatus("Client luac");
        AppendLog($"App payload ready: {payloadApp.FileCount:N0} files; gameplay tables load from the user's installed CounterSide assets.");

        SetStatus("Copying files");
        AppendLog($"Installing {rid} to {target}");
        Directory.CreateDirectory(target);

        CopyDirectory(appPayload, target, preserveUserData: true);
        CopyDirectory(runtimePayload, target, preserveUserData: false);
        CopyDirectory(nodePayload, Path.Combine(target, "runtime", "node"), preserveUserData: false);
        CopyDirectory(pythonPayload, Path.Combine(target, "runtime", "python"), preserveUserData: false);
        CopyDirectory(wiresharkPayload, Path.Combine(target, "runtime", "Wireshark"), preserveUserData: false);
        CopyDirectory(dotnetInstallerPayload, Path.Combine(target, "runtime", "installers", "dotnet", rid), preserveUserData: false);
        var legacyNpcapInstaller = Path.Combine(target, "runtime", "installers", "npcap");
        if (Directory.Exists(legacyNpcapInstaller)) Directory.Delete(legacyNpcapInstaller, recursive: true);
        var managedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CollectManagedFiles(managedFiles, appPayload, "", preserveUserData: true);
        CollectManagedFiles(managedFiles, runtimePayload, "", preserveUserData: false);
        CollectManagedFiles(managedFiles, nodePayload, Path.Combine("runtime", "node"), preserveUserData: false);
        CollectManagedFiles(managedFiles, pythonPayload, Path.Combine("runtime", "python"), preserveUserData: false);
        CollectManagedFiles(managedFiles, wiresharkPayload, Path.Combine("runtime", "Wireshark"), preserveUserData: false);
        CollectManagedFiles(managedFiles, dotnetInstallerPayload, Path.Combine("runtime", "installers", "dotnet", rid), preserveUserData: false);
        UpdateInstalledFileReceipt(target, managedFiles);
        AppendLog("Bundled Node, Python, and Wireshark binaries staged; .NET 8 installers staged. Npcap is installed separately from npcap.com when Cross Save capture is needed.");
        ClearRuntimeCaches(target);

        EnsureCleanUserDbSeed(target);
        var installedApp = ValidateAppPayload(target, "installed app");
        RequireFile(Path.Combine(target, "RevivalSideLauncher.exe"), "installed launcher");
        RequireDirectory(Path.Combine(target, "combat-host"), "installed combat host");
        RequireFile(Path.Combine(target, "tools", "CounterPassClientPatcher", "CounterPassClientPatcher.exe"), "installed client patcher");
        RequireFile(Path.Combine(target, "runtime", "node", "node.exe"), "installed node.exe");
        RequireFile(Path.Combine(target, "runtime", "node", "npm.cmd"), "installed npm.cmd");
        RequireFile(Path.Combine(target, "runtime", "python", "python.exe"), "installed python.exe");
        RequireFile(Path.Combine(target, "runtime", "Wireshark", "dumpcap.exe"), "installed dumpcap.exe");
        RequireFile(Path.Combine(target, "runtime", "Wireshark", "tshark.exe"), "installed tshark.exe");
        RequireDirectory(Path.Combine(target, "runtime", "installers", "dotnet", rid), $"installed .NET runtime installer for {rid}");
        SetGameplayStatus("Built on launch");
        AppendLog($"Installed app ready: {installedApp.FileCount:N0} files; no gameplay JSON dump was installed.");
        CreateDesktopShortcut(target);
    }

    private async Task<string> EnsurePayloadReadyAsync()
    {
        if (IsReleasePayloadReady(localPayloadRoot))
        {
            SetStatus("Using local payload");
            return localPayloadRoot;
        }

        var manifestUrl = ResolveReleaseManifestUrl();
        if (string.IsNullOrWhiteSpace(manifestUrl))
        {
            throw new InvalidOperationException("Payload folder is missing and this setup exe does not include a GitHub release manifest URL.");
        }

        return await DownloadReleasePayloadAsync(manifestUrl);
    }

    private async Task<string> DownloadReleasePayloadAsync(string manifestUrl)
    {
        SetStatus("Fetching manifest");
        progress.IsIndeterminate = true;
        payloadText.Text = "Downloading";
        AppendLog($"Release manifest: {manifestUrl}");

        var manifestUri = new Uri(manifestUrl);
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(20) };
        using var manifestResponse = await client.GetAsync(manifestUri);
        manifestResponse.EnsureSuccessStatusCode();
        var manifestJson = await manifestResponse.Content.ReadAsStringAsync();
        var manifest = JsonSerializer.Deserialize<ReleasePayloadManifest>(manifestJson, JsonOptions)
            ?? throw new InvalidOperationException("Release payload manifest was empty or invalid.");
        manifest.Validate();

        if (manifest.SchemaVersion == 2)
        {
            return await DownloadComponentPayloadAsync(client, manifestUri, manifest);
        }

        var archiveHashToken = manifest.ArchiveSha256[..Math.Min(16, manifest.ArchiveSha256.Length)];
        var manifestPayloadId = string.IsNullOrWhiteSpace(manifest.PayloadId) ? "payload" : manifest.PayloadId;
        if (!manifestPayloadId.Contains(archiveHashToken[..Math.Min(12, archiveHashToken.Length)], StringComparison.OrdinalIgnoreCase))
        {
            manifestPayloadId = $"{manifestPayloadId}-{archiveHashToken}";
        }
        var payloadId = SanitizeFileName(manifestPayloadId);
        var cacheRoot = Path.Combine(GetSetupPayloadCacheRoot(), payloadId);
        downloadedPayloadCacheRoot = cacheRoot;
        var extractedPayloadRoot = Path.Combine(cacheRoot, "extract", "payload");
        if (IsReleasePayloadReady(extractedPayloadRoot))
        {
            SetStatus("Using cached payload");
            payloadText.Text = "Cached";
            AppendLog($"Payload cache: {extractedPayloadRoot}");
            return extractedPayloadRoot;
        }

        Directory.CreateDirectory(cacheRoot);
        var archivePath = Path.Combine(cacheRoot, manifest.ArchiveName);
        await DownloadPayloadChunksAsync(client, manifestUri, manifest, cacheRoot);
        if (ManifestUsesSingleArchiveAsset(manifest))
        {
            AppendLog($"Payload archive cached: {manifest.ArchiveName}");
        }
        else
        {
            await CombinePayloadArchiveAsync(manifest, cacheRoot, archivePath);
        }
        VerifyFileHash(archivePath, manifest.ArchiveSha256, "payload archive");

        SetStatus("Extracting payload");
        progress.IsIndeterminate = true;
        var extractRoot = Path.Combine(cacheRoot, "extract");
        if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, recursive: true);
        Directory.CreateDirectory(extractRoot);
        ExtractZipToDirectory(archivePath, extractRoot);
        if (!IsReleasePayloadReady(extractedPayloadRoot))
        {
            throw new InvalidOperationException("Downloaded payload archive did not contain a valid payload folder.");
        }

        payloadText.Text = "Downloaded";
        AppendLog($"Payload ready: {extractedPayloadRoot}");
        return extractedPayloadRoot;
    }

    private async Task<string> DownloadComponentPayloadAsync(HttpClient client, Uri manifestUri, ReleasePayloadManifest manifest)
    {
        var rid = GetWindowsRid();
        if (!manifest.Components.TryGetValue("common", out var common) ||
            !manifest.Components.TryGetValue(rid, out var platform))
        {
            throw new InvalidOperationException($"Release manifest does not support {rid}.");
        }

        var components = common.Concat(platform).OrderBy(component => component.Id, StringComparer.OrdinalIgnoreCase).ToList();
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join("\n", components.Select(component => $"{component.Id}:{component.Sha256}"))))).ToLowerInvariant()[..16];
        var payloadId = SanitizeFileName($"{manifest.PayloadId}-{rid}-{fingerprint}");
        var cacheRoot = Path.Combine(GetSetupPayloadCacheRoot(), "assembled", payloadId);
        downloadedPayloadCacheRoot = cacheRoot;
        var extractRoot = Path.Combine(cacheRoot, "extract");
        var extractedPayloadRoot = Path.Combine(extractRoot, "payload");
        if (IsReleasePayloadReady(extractedPayloadRoot))
        {
            SetStatus("Using cached payload");
            payloadText.Text = "Cached";
            AppendLog($"Payload cache: {extractedPayloadRoot}");
            return extractedPayloadRoot;
        }

        var componentCache = Path.Combine(GetSetupPayloadCacheRoot(), "components");
        Directory.CreateDirectory(componentCache);
        progress.IsIndeterminate = false;
        long downloadedBytes = 0;
        var totalBytes = components.Sum(component => component.Size);
        var archives = new List<string>();
        for (var index = 0; index < components.Count; index++)
        {
            var component = components[index];
            var archivePath = Path.Combine(componentCache, $"{component.Sha256[..16]}-{component.Name}");
            archives.Add(archivePath);
            if (File.Exists(archivePath) && HashFile(archivePath).Equals(component.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                downloadedBytes += component.Size;
                UpdateDownloadProgress(downloadedBytes, totalBytes);
                AppendLog($"Component cached: {component.Id}");
                continue;
            }

            SetStatus($"Downloading {index + 1}/{components.Count}");
            var componentUri = ResolvePayloadAssetUri(manifestUri, component);
            AppendLog($"Downloading {component.Id}");
            using var response = await client.GetAsync(componentUri, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            await using var source = await response.Content.ReadAsStreamAsync();
            await using var destination = File.Open(archivePath, FileMode.Create, FileAccess.Write, FileShare.None);
            var buffer = new byte[1024 * 1024];
            int read;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, read));
                downloadedBytes += read;
                UpdateDownloadProgress(downloadedBytes, totalBytes);
            }
            destination.Close();
            VerifyFileHash(archivePath, component.Sha256, component.Id);
        }

        SetStatus("Extracting components");
        progress.IsIndeterminate = true;
        if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, recursive: true);
        Directory.CreateDirectory(extractRoot);
        foreach (var archive in archives) ExtractZipToDirectory(archive, extractRoot);
        if (!IsReleasePayloadReady(extractedPayloadRoot))
        {
            throw new InvalidOperationException("Downloaded components did not assemble a valid payload folder.");
        }

        payloadText.Text = "Downloaded";
        AppendLog($"Payload ready: {extractedPayloadRoot}");
        return extractedPayloadRoot;
    }

    private async Task DownloadPayloadChunksAsync(HttpClient client, Uri manifestUri, ReleasePayloadManifest manifest, string cacheRoot)
    {
        progress.IsIndeterminate = false;
        long downloadedBytes = 0;
        var totalBytes = manifest.Chunks.Sum(chunk => chunk.Size);
        for (var index = 0; index < manifest.Chunks.Count; index++)
        {
            var chunk = manifest.Chunks[index];
            var chunkPath = Path.Combine(cacheRoot, chunk.Name);
            if (File.Exists(chunkPath) && HashFile(chunkPath).Equals(chunk.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                downloadedBytes += chunk.Size;
                UpdateDownloadProgress(downloadedBytes, totalBytes);
                AppendLog($"Chunk cached: {chunk.Name}");
                continue;
            }

            SetStatus($"Downloading {index + 1}/{manifest.Chunks.Count}");
            var chunkUri = ResolvePayloadAssetUri(manifestUri, chunk);
            AppendLog($"Downloading {chunk.Name}");
            using var response = await client.GetAsync(chunkUri, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            await using var source = await response.Content.ReadAsStreamAsync();
            await using var destination = File.Open(chunkPath, FileMode.Create, FileAccess.Write, FileShare.None);
            var buffer = new byte[1024 * 1024];
            int read;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, read));
                downloadedBytes += read;
                UpdateDownloadProgress(downloadedBytes, totalBytes);
            }
            destination.Close();
            VerifyFileHash(chunkPath, chunk.Sha256, chunk.Name);
        }
    }

    private static bool ManifestUsesSingleArchiveAsset(ReleasePayloadManifest manifest)
    {
        return manifest.Chunks.Count == 1
            && manifest.Chunks[0].Name.Equals(manifest.ArchiveName, StringComparison.OrdinalIgnoreCase);
    }

    private async Task CombinePayloadArchiveAsync(ReleasePayloadManifest manifest, string cacheRoot, string archivePath)
    {
        SetStatus("Combining payload");
        await using var archive = File.Open(archivePath, FileMode.Create, FileAccess.Write, FileShare.None);
        foreach (var chunk in manifest.Chunks)
        {
            var chunkPath = Path.Combine(cacheRoot, chunk.Name);
            await using var source = File.OpenRead(chunkPath);
            await source.CopyToAsync(archive);
        }
    }

    private void UpdateDownloadProgress(long downloadedBytes, long totalBytes)
    {
        if (totalBytes <= 0) return;
        var percent = Math.Clamp((double)downloadedBytes / totalBytes * 100.0, 0, 100);
        Dispatcher.UIThread.Post(() => progress.Value = percent);
    }

    private void CheckPayloadSummary()
    {
        try
        {
            var status = ValidateReleasePayload(localPayloadRoot);
            gameplayText.Text = "Client luac";
            payloadText.Text = "Ready";
            AppendLog($"Local payload ready: {status.AppFileCount:N0} app files; gameplay tables build from CounterSide assets on first launch.");
        }
        catch (Exception ex)
        {
            var releaseUrl = ResolveReleaseManifestUrl();
            payloadText.Text = string.IsNullOrWhiteSpace(releaseUrl) ? "Missing" : "Download";
            gameplayText.Text = string.IsNullOrWhiteSpace(releaseUrl) ? "Not ready" : "Client luac";
            AppendLog(string.IsNullOrWhiteSpace(releaseUrl) ? $"Payload check: {ex.Message}" : "Payload will download from the configured release manifest.");
        }
    }

    private static Uri ResolvePayloadAssetUri(Uri manifestUri, ReleasePayloadChunk asset)
    {
        if (!string.IsNullOrWhiteSpace(asset.Url)) return new Uri(asset.Url, UriKind.Absolute);
        if (manifestUri.AbsolutePath.TrimEnd('/').EndsWith("/manifest", StringComparison.OrdinalIgnoreCase))
        {
            return new Uri(manifestUri, $"assets/{Uri.EscapeDataString(asset.Name)}");
        }

        return new Uri(manifestUri, Uri.EscapeDataString(asset.Name));
    }

    private async Task<bool> PromptInstallDotNet8IfMissingAsync(string target)
    {
        if (HasDotNet8Runtime())
        {
            AppendLog(".NET 8 Runtime detected.");
            return true;
        }

        var installer = FindInstalledDotNetInstaller(target);
        if (!File.Exists(installer))
        {
            AppendLog(".NET 8 Runtime is missing and no bundled installer was found.");
            await ShowMessageAsync("RevivalSide Setup", ".NET 8 Runtime is required to launch RevivalSide, but the bundled installer was not found.");
            return false;
        }

        var shouldInstall = await ShowConfirmAsync(
            "Install .NET 8",
            ".NET 8 Runtime is required to launch RevivalSide. Install the bundled runtime now?",
            "Install",
            "Later");
        if (!shouldInstall)
        {
            AppendLog(".NET 8 Runtime install skipped.");
            return false;
        }

        AppendLog($"Running .NET 8 Runtime installer: {Path.GetFileName(installer)}");
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = installer,
            Arguments = "/install /passive /norestart",
            WorkingDirectory = Path.GetDirectoryName(installer),
            UseShellExecute = true,
            Verb = "runas",
        });
        if (process == null) throw new InvalidOperationException("Could not start .NET 8 Runtime installer.");
        await process.WaitForExitAsync();
        AppendLog($".NET 8 Runtime installer exited {process.ExitCode}.");
        if (HasDotNet8Runtime())
        {
            AppendLog(".NET 8 Runtime detected after install.");
            return true;
        }
        await ShowMessageAsync("RevivalSide Setup", ".NET 8 Runtime is still not detected. Run the bundled installer from runtime\\installers\\dotnet and then launch RevivalSide.");
        return false;
    }

    private static string FindInstalledDotNetInstaller(string target)
    {
        var rid = GetWindowsRid();
        var directory = Path.Combine(target, "runtime", "installers", "dotnet", rid);
        if (!Directory.Exists(directory)) return "";
        return Directory.EnumerateFiles(directory, "*.exe", SearchOption.TopDirectoryOnly)
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault() ?? "";
    }

    private static bool HasDotNet8Runtime()
    {
        var dotnet = ResolveToolPath("dotnet.exe");
        if (string.IsNullOrWhiteSpace(dotnet)) return false;
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = dotnet,
                    Arguments = "--list-runtimes",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
            };
            var output = new StringBuilder();
            process.OutputDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
            if (!process.Start()) return false;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (!process.WaitForExit(15000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return false;
            }
            return process.ExitCode == 0
                && output.ToString().Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries)
                    .Any(line => line.Contains("Microsoft.NETCore.App 8.", StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            return false;
        }
    }

    private static string ResolveToolPath(string toolName)
    {
        var fromPath = ResolveToolFromPath(toolName);
        if (!string.IsNullOrWhiteSpace(fromPath)) return fromPath;
        if (toolName.Equals("dotnet.exe", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var dotnetPath in new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", "dotnet.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", "x64", "dotnet.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "dotnet", "dotnet.exe"),
            })
            {
                if (File.Exists(dotnetPath)) return dotnetPath;
            }
        }
        return toolName;
    }

    private static string ResolveToolFromPath(string toolName)
    {
        var pathVariable = Environment.GetEnvironmentVariable("PATH") ?? "";
        var extensions = Path.HasExtension(toolName)
            ? new[] { "" }
            : (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            foreach (var extension in extensions)
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim('"'), toolName + extension);
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // Ignore malformed PATH entries.
                }
            }
        }
        return "";
    }

    private void LaunchInstalled()
    {
        LaunchInstalled(NormalizeTargetPath(targetBox.Text ?? ""));
    }

    private void LaunchInstalled(string target)
    {
        var launcher = Path.Combine(target, "RevivalSideLauncher.exe");
        if (!File.Exists(launcher))
        {
            _ = ShowMessageAsync("RevivalSide Setup", "RevivalSideLauncher.exe was not found in the install folder.");
            return;
        }
        Process.Start(new ProcessStartInfo { FileName = launcher, WorkingDirectory = Path.GetDirectoryName(launcher), UseShellExecute = true });
    }

    private void CopyDirectory(string source, string destination, bool preserveUserData)
    {
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, directory);
            if (ShouldNeverInstallPayloadPath(relative)) continue;
            if (preserveUserData && ShouldSkipUserDataPath(relative, isDirectory: true)) continue;
            Directory.CreateDirectory(Path.Combine(destination, relative));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            if (ShouldNeverInstallPayloadPath(relative)) continue;
            if (preserveUserData && ShouldSkipUserDataPath(relative, isDirectory: false) && File.Exists(Path.Combine(destination, relative))) continue;
            CopyFile(file, Path.Combine(destination, relative));
        }
    }

    private static void CollectManagedFiles(HashSet<string> files, string source, string destinationPrefix, bool preserveUserData)
    {
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            if (ShouldNeverInstallPayloadPath(relative)) continue;
            if (preserveUserData && ShouldSkipUserDataPath(relative, isDirectory: false)) continue;
            files.Add(string.IsNullOrEmpty(destinationPrefix) ? relative : Path.Combine(destinationPrefix, relative));
        }
    }

    private void UpdateInstalledFileReceipt(string target, HashSet<string> managedFiles)
    {
        var receiptPath = Path.Combine(target, ".revivalside-install.json");
        if (File.Exists(receiptPath))
        {
            try
            {
                var oldReceipt = JsonSerializer.Deserialize<InstalledPayloadReceipt>(File.ReadAllText(receiptPath), JsonOptions);
                foreach (var relative in oldReceipt?.Files ?? [])
                {
                    if (managedFiles.Contains(relative)) continue;
                    var stalePath = Path.GetFullPath(Path.Combine(target, relative));
                    if (IsChildPath(target, stalePath) && File.Exists(stalePath)) File.Delete(stalePath);
                }
            }
            catch (Exception ex)
            {
                AppendLog($"Old install receipt ignored: {ex.Message}");
            }
        }

        var receipt = new InstalledPayloadReceipt { Files = managedFiles.Order(StringComparer.OrdinalIgnoreCase).ToList() };
        var temporaryPath = $"{receiptPath}.tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true }), Encoding.UTF8);
        File.Move(temporaryPath, receiptPath, overwrite: true);
    }

    private static bool ShouldNeverInstallPayloadPath(string relativePath)
    {
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        return normalized.Equals(".env", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals(".cache", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith(".cache/", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ShouldSkipUserDataPath(string relativePath, bool isDirectory)
    {
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        if (normalized.Length == 0) return false;
        if (isDirectory)
        {
            return normalized is "captures" or "exports" or "logs"
                || normalized.StartsWith("server-data/capture-extracts", StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith("server-data/users.backups", StringComparison.OrdinalIgnoreCase);
        }

        return normalized is "launcher-settings.json"
            or "server-data/users.json"
            or "server-data/server-time.json"
            || normalized.EndsWith(".pcap", StringComparison.OrdinalIgnoreCase)
            || normalized.EndsWith(".pcapng", StringComparison.OrdinalIgnoreCase);
    }

    private void ClearRuntimeCaches(string target)
    {
        var cacheDir = Path.Combine(target, ".cache");
        if (!Directory.Exists(cacheDir)) return;
        try
        {
            Directory.Delete(cacheDir, recursive: true);
            AppendLog("Removed stale runtime cache; caches will rebuild from the installed CounterSide client.");
        }
        catch (Exception ex)
        {
            AppendLog($"Runtime cache cleanup skipped: {ex.Message}");
        }
    }

    private void CleanupSetupFilesAfterInstall()
    {
        if (string.IsNullOrWhiteSpace(downloadedPayloadCacheRoot))
        {
            AppendLog("No downloaded setup files to remove.");
            return;
        }

        var cacheRoot = Path.GetFullPath(downloadedPayloadCacheRoot);
        var setupPayloadCacheRoot = Path.GetFullPath(GetSetupPayloadCacheRoot());
        if (!IsChildPath(setupPayloadCacheRoot, cacheRoot))
        {
            AppendLog($"Setup file cleanup skipped for unexpected path: {cacheRoot}");
            return;
        }

        SetStatus("Cleaning setup files");
        try
        {
            if (Directory.Exists(cacheRoot))
            {
                Directory.Delete(cacheRoot, recursive: true);
                AppendLog("Removed downloaded setup payload cache.");
            }
            else
            {
                AppendLog("Downloaded setup payload cache was already removed.");
            }

            DeleteDirectoryIfEmpty(setupPayloadCacheRoot);
            DeleteDirectoryIfEmpty(Path.GetDirectoryName(setupPayloadCacheRoot) ?? "");
        }
        catch (Exception ex)
        {
            AppendLog($"Setup file cleanup skipped: {ex.Message}");
        }
    }

    private static string GetSetupPayloadCacheRoot()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSideSetup", "payload-cache");
    }

    private static bool IsChildPath(string parentPath, string childPath)
    {
        var parent = Path.GetFullPath(parentPath)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var child = Path.GetFullPath(childPath)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        return child.StartsWith(parent, StringComparison.OrdinalIgnoreCase);
    }

    private static void DeleteDirectoryIfEmpty(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
        if (Directory.EnumerateFileSystemEntries(path).Any()) return;
        Directory.Delete(path);
    }

    private void EnsureCleanUserDbSeed(string target)
    {
        Directory.CreateDirectory(Path.Combine(target, "server-data"));
        var usersPath = Path.Combine(target, "server-data", "users.json");
        if (File.Exists(usersPath)) return;

        var starterPath = Path.Combine(target, "server-data", "starter-users.json");
        if (File.Exists(starterPath))
        {
            File.Copy(starterPath, usersPath, overwrite: false);
            AppendLog("Starter profile seed installed.");
            return;
        }

        File.WriteAllText(usersPath, "{\n  \"schemaVersion\": 1,\n  \"nextUserUid\": \"1000000001\",\n  \"nextFriendCode\": \"10000001\",\n  \"activeUserUid\": \"\",\n  \"users\": {}\n}\n", Encoding.UTF8);
    }

    private void CreateDesktopShortcut(string target)
    {
        try
        {
            var shortcutPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "RevivalSide Launcher.lnk");
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = Path.Combine(target, "RevivalSideLauncher.exe");
            shortcut.WorkingDirectory = target;
            shortcut.IconLocation = Path.Combine(target, "RevivalSideLauncher.exe");
            shortcut.Save();
            AppendLog($"Shortcut: {shortcutPath}");
        }
        catch (Exception ex)
        {
            AppendLog($"Shortcut skipped: {ex.Message}");
        }
    }

    private static void CopyFile(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Copy(source, destination, overwrite: true);
    }

    private static void ExtractZipToDirectory(string archivePath, string destination)
    {
        var root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(archivePath);
        foreach (var entry in archive.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(destination, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Archive entry escapes the payload folder: {entry.FullName}");
            }
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using var source = entry.Open();
            using var output = File.Open(target, FileMode.Create, FileAccess.Write, FileShare.None);
            source.CopyTo(output);
        }
    }

    private static string NormalizeTargetPath(string value)
    {
        var target = string.IsNullOrWhiteSpace(value)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSide")
            : value;
        return Path.GetFullPath(Environment.ExpandEnvironmentVariables(target.Trim().Trim('"')));
    }

    private string? ResolveReleaseManifestUrl()
    {
        var envUrl = Environment.GetEnvironmentVariable("REVIVALSIDE_RELEASE_MANIFEST_URL");
        if (!string.IsNullOrWhiteSpace(envUrl)) return envUrl.Trim();

        foreach (var fileName in new[] { "RevivalSideSetup.release.json", "release.json" })
        {
            var path = Path.Combine(AppContext.BaseDirectory, fileName);
            if (!File.Exists(path)) continue;
            try
            {
                var config = JsonSerializer.Deserialize<ReleaseInstallerConfig>(File.ReadAllText(path), JsonOptions);
                if (!string.IsNullOrWhiteSpace(config?.ManifestUrl)) return config.ManifestUrl.Trim();
            }
            catch (Exception ex)
            {
                AppendLog($"Release config ignored: {ex.Message}");
            }
        }

        return Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key.Equals("RevivalSideReleaseManifestUrl", StringComparison.OrdinalIgnoreCase))
            ?.Value;
    }

    private static bool IsReleasePayloadReady(string root)
    {
        try
        {
            ValidateReleasePayload(root);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void VerifyFileHash(string path, string expectedSha256, string name)
    {
        var actual = HashFile(path);
        if (!actual.Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"{name} SHA256 mismatch. Expected {expectedSha256}, got {actual}.");
        }
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        var hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string SanitizeFileName(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(invalid.Contains(character) ? '-' : character);
        }
        return builder.ToString();
    }

    private static string GetWindowsRid()
    {
        return RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "win-arm64",
            Architecture.X86 => "win-x86",
            _ => "win-x64",
        };
    }

    private static void RequireDirectory(string path, string name)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"{name} was not found: {path}");
    }

    private static void RequireFile(string path, string name)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"{name} was not found.", path);
    }

    private static ReleasePayloadStatus ValidateReleasePayload(string root)
    {
        RequireDirectory(root, "release payload");
        RequireDirectory(Path.Combine(root, "app"), "app payload");
        RequireDirectory(Path.Combine(root, "runtime-apps"), "runtime payloads");
        var rid = GetWindowsRid();
        RequireFile(Path.Combine(root, "runtime-node", rid, "node.exe"), $"node.exe for {rid}");
        RequireFile(Path.Combine(root, "runtime-node", rid, "npm.cmd"), $"npm.cmd for {rid}");
        RequireFile(Path.Combine(root, "runtime-python", rid, "python.exe"), $"python.exe for {rid}");
        RequireFile(Path.Combine(root, "runtime-wireshark", rid, "dumpcap.exe"), $"dumpcap.exe for {rid}");
        RequireFile(Path.Combine(root, "runtime-wireshark", rid, "tshark.exe"), $"tshark.exe for {rid}");
        RequireDirectory(Path.Combine(root, "runtime-installers", "dotnet"), ".NET runtime installers");
        var app = ValidateAppPayload(Path.Combine(root, "app"), "app payload");
        return new ReleasePayloadStatus(root, app.FileCount);
    }

    private static AppPayloadStatus ValidateAppPayload(string root, string name)
    {
        RequireDirectory(root, name);
        foreach (var directory in new[] { "server", "modules", "packet-handlers", "combat-handler", "tools", "server-data" })
        {
            RequireDirectory(Path.Combine(root, directory), $"{name} {directory}");
        }
        foreach (var file in new[]
        {
            "cs-listener.js",
            "package.json",
            "packet-schema.json",
            Path.Combine("modules", "gameplay-jsons", "index.js"),
            Path.Combine("modules", "counterside-install", "index.js"),
            Path.Combine("tools", "ensure-gameplay-assets.js"),
            Path.Combine("tools", "ensure-cutscene-backgrounds.js"),
            Path.Combine("tools", "cs_asset_decrypt.py"),
            Path.Combine("tools", "cs_extract_decrypted_assets.py"),
            Path.Combine("server-data", "captured-flows", "manifest.json"),
        })
        {
            RequireFile(Path.Combine(root, file), $"{name} {file}");
        }
        return new AppPayloadStatus(root, CountFiles(root));
    }

    private static int CountFiles(string directory)
    {
        var count = 0;
        foreach (var _ in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)) count++;
        return count;
    }

    private void SetStatus(string text)
    {
        Dispatcher.UIThread.Post(() => statusText.Text = text);
    }

    private void SetGameplayStatus(string text)
    {
        Dispatcher.UIThread.Post(() => gameplayText.Text = text);
    }

    private void AppendLog(string text)
    {
        Dispatcher.UIThread.Post(() =>
        {
            var next = $"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}";
            logBox.Text = (logBox.Text ?? "") + next;
            logBox.CaretIndex = logBox.Text.Length;
        });
    }

    private async Task ShowMessageAsync(string title, string message)
    {
        var ok = new Button { Content = "OK", MinWidth = 92, Height = 36 };
        StyleButton(ok, primary: true);
        var window = new Window
        {
            Title = title,
            Width = 460,
            Height = 220,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = Brush(12, 16, 23),
            Content = new Border
            {
                Padding = new Thickness(22),
                Child = new Grid
                {
                    RowDefinitions = new RowDefinitions("*,Auto"),
                    Children =
                    {
                        new TextBlock { Text = message, Foreground = Brush(236, 242, 248), TextWrapping = TextWrapping.Wrap, FontSize = 15 },
                        ok,
                    },
                },
            },
        };
        Grid.SetRow(ok, 1);
        ok.HorizontalAlignment = HorizontalAlignment.Right;
        ok.Click += (_, _) => window.Close();
        await window.ShowDialog(this);
    }

    private async Task<bool> ShowConfirmAsync(string title, string message, string confirmLabel, string cancelLabel)
    {
        var confirm = new Button { Content = confirmLabel, MinWidth = 104, Height = 36 };
        var cancel = new Button { Content = cancelLabel, MinWidth = 92, Height = 36 };
        StyleButton(confirm, primary: true);
        StyleButton(cancel, primary: false);
        var window = new Window
        {
            Title = title,
            Width = 460,
            Height = 230,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = Brush(12, 16, 23),
            Content = new Border
            {
                Padding = new Thickness(22),
                Child = new Grid
                {
                    RowDefinitions = new RowDefinitions("*,Auto"),
                    Children =
                    {
                        new TextBlock { Text = message, Foreground = Brush(236, 242, 248), TextWrapping = TextWrapping.Wrap, FontSize = 15 },
                        new StackPanel
                        {
                            Orientation = Orientation.Horizontal,
                            HorizontalAlignment = HorizontalAlignment.Right,
                            Spacing = 10,
                            Children = { cancel, confirm },
                        },
                    },
                },
            },
        };
        var buttons = ((Grid)((Border)window.Content!).Child!).Children[1];
        Grid.SetRow(buttons, 1);
        var accepted = false;
        confirm.Click += (_, _) => { accepted = true; window.Close(); };
        cancel.Click += (_, _) => window.Close();
        await window.ShowDialog(this);
        return accepted;
    }

    private static Border Glass(Thickness padding, Thickness margin, Color? fill = null)
    {
        return new Border
        {
            Padding = padding,
            Margin = margin,
            CornerRadius = new CornerRadius(18),
            Background = new SolidColorBrush(fill ?? Color.FromArgb(204, 12, 16, 23)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(96, 255, 255, 255)),
            BorderThickness = new Thickness(1),
        };
    }

    private static TextBlock Eyebrow(string text) => new()
    {
        Text = text.ToUpperInvariant(),
        Foreground = Brush(255, 218, 87),
        FontSize = 15,
        FontWeight = FontWeight.Bold,
        Margin = new Thickness(0, 0, 0, 8),
    };

    private static ScrollViewer Scrollable(Control child) => new()
    {
        Content = child,
        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
    };

    private static void AddRow(Grid grid, Control control, int row)
    {
        Grid.SetRow(control, row);
        grid.Children.Add(control);
    }

    private static IBrush Brush(byte r, byte g, byte b) => new SolidColorBrush(Color.FromRgb(r, g, b));
    private static IBrush DiagonalGradient(Color start, Color end) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(start, 0), new(end, 1) },
    };
    private static IBrush HorizontalGradient(Color left, Color right) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 0, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(left, 0), new(right, 1) },
    };
    private static IBrush VerticalGradient(Color top, Color bottom) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(top, 0), new(bottom, 1) },
    };
}

internal sealed class ReleaseInstallerConfig
{
    public string ManifestUrl { get; set; } = "";
}

internal sealed class ReleasePayloadManifest
{
    public int SchemaVersion { get; set; } = 1;
    public string PayloadId { get; set; } = "";
    public string ArchiveName { get; set; } = "RevivalSidePayload.zip";
    public long ArchiveSize { get; set; }
    public string ArchiveSha256 { get; set; } = "";
    public List<ReleasePayloadChunk> Chunks { get; set; } = [];
    public Dictionary<string, List<ReleasePayloadChunk>> Components { get; set; } = [];

    public void Validate()
    {
        if (SchemaVersion == 2)
        {
            if (string.IsNullOrWhiteSpace(PayloadId)) throw new InvalidOperationException("Component manifest is missing payloadId.");
            if (!Components.ContainsKey("common")) throw new InvalidOperationException("Component manifest is missing the common component group.");
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (group, components) in Components)
            {
                if (group != "common" && group is not ("win-x64" or "win-x86" or "win-arm64"))
                    throw new InvalidOperationException($"Unsupported component group: {group}.");
                if (components.Count == 0) throw new InvalidOperationException($"Component group {group} is empty.");
                foreach (var component in components)
                {
                    component.Validate(requireId: true);
                    if (!ids.Add(component.Id)) throw new InvalidOperationException($"Duplicate component id: {component.Id}.");
                }
            }
            return;
        }
        if (SchemaVersion != 1) throw new InvalidOperationException($"Unsupported payload manifest schema version: {SchemaVersion}.");
        if (string.IsNullOrWhiteSpace(ArchiveName)) throw new InvalidOperationException("Payload manifest is missing archiveName.");
        if (string.IsNullOrWhiteSpace(ArchiveSha256) || ArchiveSha256.Length < 16) throw new InvalidOperationException("Payload manifest is missing archiveSha256.");
        if (ArchiveSize <= 0) throw new InvalidOperationException("Payload manifest archiveSize must be positive.");
        if (Chunks.Count == 0) throw new InvalidOperationException("Payload manifest has no chunks.");
        foreach (var chunk in Chunks) chunk.Validate(requireId: false);
    }
}

internal sealed class ReleasePayloadChunk
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
    public string Url { get; set; } = "";

    public void Validate(bool requireId)
    {
        if (requireId && string.IsNullOrWhiteSpace(Id)) throw new InvalidOperationException("Payload component is missing an id.");
        if (string.IsNullOrWhiteSpace(Name)) throw new InvalidOperationException("Payload manifest contains a chunk without a name.");
        if (Name.Contains('/') || Name.Contains('\\')) throw new InvalidOperationException($"Payload chunk name must not contain a path: {Name}");
        if (Size <= 0) throw new InvalidOperationException($"Payload chunk {Name} has an invalid size.");
        if (string.IsNullOrWhiteSpace(Sha256) || Sha256.Length < 16) throw new InvalidOperationException($"Payload chunk {Name} is missing sha256.");
        if (!string.IsNullOrWhiteSpace(Url) && (!Uri.TryCreate(Url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidOperationException($"Payload component {Name} has an invalid HTTPS URL.");
    }
}

internal sealed class InstalledPayloadReceipt
{
    public int SchemaVersion { get; set; } = 1;
    public List<string> Files { get; set; } = [];
}

internal sealed record AppPayloadStatus(string Path, int FileCount);
internal sealed record ReleasePayloadStatus(string Path, int AppFileCount);
