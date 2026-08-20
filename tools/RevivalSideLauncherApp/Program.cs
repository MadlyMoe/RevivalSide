using System.Diagnostics;
using System.IO.Compression;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using Microsoft.Win32;
using System.Windows.Input;

namespace RevivalSideLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    private static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<LauncherApp>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}

internal sealed class LauncherApp : Application
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
            desktop.MainWindow = new LauncherWindow();
        }
        base.OnFrameworkInitializationCompleted();
    }
}

internal sealed class LauncherWindow : Window
{
    private static readonly HashSet<string> CrossSaveGamePorts = new(StringComparer.OrdinalIgnoreCase)
    {
        "20001",
        "20002",
        "20003",
        "20004",
        "22000",
    };

    private static readonly string[] ManagedPathEnvironmentKeys =
    {
        "CS_COUNTERSIDE_MANAGED_DIR",
        "COUNTERSIDE_MANAGED_DIR",
        "CS_COUNTERSIDE_DIR",
    };

    private static readonly string[] GameplayTableOverrideEnvironmentKeys =
    {
        "CS_GAMEPLAY_TABLES_DIR",
        "CS_STAGE_TABLE_PATH",
        "CS_MAP_TABLE_PATH",
    };

    private readonly string appRoot;
    private readonly string settingsPath;
    private string nodePath = "node.exe";
    private string npmPath = "npm.cmd";
    private string dumpcapPath = "dumpcap.exe";
    private string tsharkPath = "tshark.exe";
    private readonly object processLogLock = new();
    private readonly object cutsceneBackgroundLock = new();
    private Bitmap? launcherBackground;
    private string launcherBackgroundName = "";
    private bool cutsceneBackgroundRefreshRunning;

    private LauncherSettings settings;
    private Process? listenerProcess;
    private ProcessJob? listenerJob;
    private Process? wikiProcess;
    private Image? launcherBackgroundView;
    private Border? launcherBackgroundFallback;
    private TextBlock? launcherBackgroundText;
    private Border? dashboardView;
    private Border? settingsView;
    private Border? crossSaveView;
    private Border? dashboardGameplayProgressPanel;
    private Border? settingsGameplayProgressPanel;
    private readonly List<CrossSaveCaptureProcess> crossSaveCaptureProcesses = new();
    private string? crossSaveCaptureStamp;
    private List<CrossSaveSource> crossSaveSources = new();
    private TrayIcon? trayIcon;
    private System.Windows.Forms.NotifyIcon? windowsTrayIcon;
    private bool isShuttingDown;
    private bool isHiddenInTray;
    private bool startFlowBusy;
    private string verifiedControlledManagedDir = "";
    private string verifiedControlledServerInfoUrl = "";
    private const string StartButtonDefaultText = "START";
    private const int ListenerReadinessTimeoutSeconds = 120;

    private readonly Button dashboardNavButton = new() { Content = "Home", MinWidth = 92, Height = 38 };
    private readonly Button crossSaveNavButton = new() { Content = "Cross Save", MinWidth = 128, Height = 38 };
    private readonly Button settingsNavButton = new() { Content = "Settings", MinWidth = 116, Height = 38 };
    private readonly Button openLogsButton = new() { Content = "Logs", MinWidth = 92, Height = 38 };
    private readonly Button startListenerButton = new() { Content = "START", MinWidth = 244, Height = 58 };
    private readonly Button stopListenerButton = new() { Content = "Stop", MinWidth = 96, Height = 38, IsEnabled = false };
    private readonly Button openUserManagerButton = new() { Content = "User Manager", MinWidth = 158, Height = 38 };
    private readonly Button openWikiButton = new() { Content = "Wiki", MinWidth = 88, Height = 38 };
    private readonly Button browseManagedButton = new() { Content = "Browse", MinWidth = 104, Height = 38 };
    private readonly Button detectManagedButton = new() { Content = "Detect", MinWidth = 104, Height = 38 };
    private readonly Button freezeClientButton = new() { Content = "Freeze", MinWidth = 104, Height = 38 };
    private readonly Button launchFrozenClientButton = new() { Content = "Launch Frozen", MinWidth = 142, Height = 38 };
    private readonly Button saveSettingsButton = new() { Content = "Save Settings", MinWidth = 150, Height = 40 };
    private readonly Button verifyGameplayAssetsButton = new() { Content = "Verify Assets", MinWidth = 138, Height = 40 };
    private readonly Button buildGameplayAssetsButton = new() { Content = "Build Cache", MinWidth = 138, Height = 40 };
    private readonly Button setTimeButton = new() { Content = "Set Time", MinWidth = 126, Height = 40 };
    private readonly Button clearTimeButton = new() { Content = "Clear", MinWidth = 94, Height = 40 };
    private readonly Button browseCrossSaveCaptureButton = new() { Content = "Listen", MinWidth = 104, Height = 40 };
    private readonly Button refreshCrossSaveButton = new() { Content = "Stop", MinWidth = 104, Height = 40, IsEnabled = false };
    private readonly Button importCrossSaveButton = new() { Content = "Extract and Copy", MinWidth = 174, Height = 40 };

    private readonly TextBlock listenerStatusText = new() { Text = "Stopped" };
    private readonly TextBlock clientRoutingStatusText = Muted("Freeze a client to enable verified local routing.", 52);
    private readonly TextBlock gameplayDataStatusText = new() { Text = "Not checked" };
    private readonly ProgressBar dashboardGameplayProgressBar = new() { Minimum = 0, Maximum = 100, Height = 8 };
    private readonly ProgressBar settingsGameplayProgressBar = new() { Minimum = 0, Maximum = 100, Height = 8 };
    private readonly TextBlock dashboardGameplayProgressText = new() { Text = "Gameplay cache pending" };
    private readonly TextBlock settingsGameplayProgressText = new() { Text = "Gameplay cache pending" };
    private readonly TextBlock crossSaveStatusText = new() { Text = "Idle" };
    private readonly TextBlock crossSaveDetailsText = new() { Text = "No live capture yet." };
    private readonly TextBox managedDirBox = new() { IsReadOnly = true };
    private readonly TextBox crossSaveCaptureDirBox = new() { IsReadOnly = true };
    private readonly NumericUpDown portInput = new() { Minimum = 1, Maximum = 65535, Value = 22000, Width = 110 };
    private readonly NumericUpDown httpPortInput = new() { Minimum = 1, Maximum = 65535, Value = 8088, Width = 110 };
    private readonly NumericUpDown wikiPortInput = new() { Minimum = 1, Maximum = 65535, Value = 5174, Width = 110 };
    private readonly TextBox eventDateInput = new() { Width = 150, PlaceholderText = "YYYY-MM-DD" };
    private readonly ComboBox joinLobbyModeInput = new() { Width = 132, ItemsSource = new[] { "auto", "on", "off" } };
    private readonly TextBox advancedEnvInput = new() { AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap };
    private readonly ComboBox crossSaveSourceInput = new() { MinWidth = 460 };
    private readonly CheckBox crossSaveSwitchActiveInput = new() { Content = "Switch active after import", IsChecked = true };
    private readonly CheckBox crossSaveUpdateExistingInput = new() { Content = "Update matching official import", IsChecked = true };
    private readonly CheckBox crossSavePreserveUidInput = new() { Content = "Keep official UID" };
    private readonly CheckBox crossSavePreserveFriendCodeInput = new() { Content = "Keep official friend code" };
    private readonly CheckBox userManagerRemoteInput = new() { Content = "Allow LAN User Manager access" };
    private readonly CheckBox verboseInput = new() { Content = "Verbose listener logs" };
    private readonly CheckBox replayGameFlowInput = new() { Content = "Replay captured game flow" };
    private readonly CheckBox skipTutorialInput = new() { Content = "Skip tutorial to win" };
    private readonly CheckBox resetTutorialInput = new() { Content = "Reset tutorial on login" };
    private readonly CheckBox minimizeToTrayInput = new() { Content = "Minimize to tray on close while server is running" };
    private readonly CheckBox notifyTrayStopInput = new() { Content = "Notify in tray when a service stops unexpectedly" };
    private readonly TextBox serverTimeInput = new() { Width = 210 };
    private readonly TextBox logBox = new()
    {
        AcceptsReturn = true,
        IsReadOnly = true,
        TextWrapping = TextWrapping.NoWrap,
    };
    private readonly TextBox crossSaveResultBox = new()
    {
        AcceptsReturn = true,
        IsReadOnly = true,
        TextWrapping = TextWrapping.NoWrap,
        Height = 150,
    };

    public LauncherWindow()
    {
        appRoot = ResolveAppRoot();
        settingsPath = Path.Combine(appRoot, "launcher-settings.json");
        settings = LoadSettings();
        settings.CounterSideManagedDir = ResolveInitialManagedDir(settings.CounterSideManagedDir);
        RefreshToolPaths();
        (launcherBackground, launcherBackgroundName) = LoadRandomCutsceneBackgroundFromCache();

        Title = "RevivalSide Launcher";
        Width = 1180;
        Height = 680;
        MinWidth = 960;
        MinHeight = 600;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Brushes.Black;
        Content = BuildUi();

        LoadSettingsIntoUi();
        BindEvents();

        AppendLog($"App: {appRoot}");
        AppendLog($"Architecture: {RuntimeInformation.ProcessArchitecture} on {RuntimeInformation.OSArchitecture}");
        AppendLog($"Node: {DescribeExecutable(nodePath)}");
        AppendLog($"npm: {npmPath}");
        AppendLog($"dumpcap: {DescribeExecutable(dumpcapPath)}");
        AppendLog($"tshark: {DescribeExecutable(tsharkPath)}");
        AppendLog(IsManagedDir(settings.CounterSideManagedDir) ? $"CounterSide DLL: {Path.Combine(settings.CounterSideManagedDir, "Assembly-CSharp.dll")}" : "CounterSide DLL: not selected");
        RefreshGameplayAssetStatus(log: true);
        _ = RunStartupDependencyChecksAsync();
    }

    private Control BuildUi()
    {
        StyleControls();
        var root = new Grid();
        launcherBackgroundFallback = new Border
        {
            Background = DiagonalGradient(Color.FromRgb(16, 24, 36), Color.FromRgb(50, 34, 52)),
            IsVisible = launcherBackground == null,
        };
        launcherBackgroundView = new Image
        {
            Source = launcherBackground,
            Stretch = Stretch.UniformToFill,
            IsVisible = launcherBackground != null,
        };
        root.Children.Add(launcherBackgroundFallback);
        root.Children.Add(launcherBackgroundView);
        root.Children.Add(new Border { Background = HorizontalGradient(Color.FromArgb(230, 4, 7, 12), Color.FromArgb(88, 4, 7, 12)) });
        root.Children.Add(new Border { Background = VerticalGradient(Color.FromArgb(0, 4, 7, 12), Color.FromArgb(230, 4, 7, 12)), VerticalAlignment = VerticalAlignment.Bottom, Height = 280 });

        var shell = new Grid
        {
            Margin = new Thickness(30, 22, 30, 24),
            RowDefinitions = new RowDefinitions("Auto,*"),
        };
        shell.Children.Add(BuildHeader());
        var viewHost = new Grid { Margin = new Thickness(0, 16, 0, 0) };
        Grid.SetRow(viewHost, 1);
        dashboardView = BuildDashboardView();
        crossSaveView = BuildCrossSaveView();
        settingsView = BuildSettingsView();
        viewHost.Children.Add(dashboardView);
        viewHost.Children.Add(crossSaveView);
        viewHost.Children.Add(settingsView);
        shell.Children.Add(viewHost);
        root.Children.Add(shell);
        ShowView("dashboard");
        return root;
    }

    private Control BuildHeader()
    {
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,470") };
        var brand = new StackPanel { Spacing = 3 };
        brand.Children.Add(new TextBlock
        {
            Text = "RevivalSide",
            Foreground = Brushes.White,
            FontFamily = "Inter",
            FontSize = 48,
            FontWeight = FontWeight.SemiBold,
            LineHeight = 54,
        });
        brand.Children.Add(new TextBlock
        {
            Text = "Local listener, wiki, and client routing",
            Foreground = Brush(232, 238, 246),
            FontSize = 19,
        });
        launcherBackgroundText = new TextBlock
        {
            Text = DescribeLauncherBackground(),
            Foreground = Brush(184, 196, 214),
            FontSize = 13,
            Margin = new Thickness(0, 6, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        brand.Children.Add(launcherBackgroundText);
        header.Children.Add(brand);

        var nav = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 8, 0, 0),
        };
        nav.Children.Add(dashboardNavButton);
        nav.Children.Add(crossSaveNavButton);
        nav.Children.Add(settingsNavButton);
        nav.Children.Add(openLogsButton);
        Grid.SetColumn(nav, 1);
        header.Children.Add(nav);
        return header;
    }

    private Border BuildDashboardView()
    {
        var view = new Border { Background = Brushes.Transparent };
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("430,*") };

        var left = Glass(new Thickness(22), new Thickness(0, 0, 20, 0));
        var leftLayout = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,Auto,Auto,Auto,Auto,Auto,Auto,*") };
        AddRow(leftLayout, Eyebrow("Listener"), 0);
        listenerStatusText.FontSize = 34;
        listenerStatusText.FontWeight = FontWeight.SemiBold;
        listenerStatusText.Foreground = Brushes.White;
        AddRow(leftLayout, listenerStatusText, 1);
        AddRow(leftLayout, Muted("Start server, open tools.", 32), 2);
        dashboardGameplayProgressPanel = GameplayProgressPanel(dashboardGameplayProgressBar, dashboardGameplayProgressText);
        AddRow(leftLayout, dashboardGameplayProgressPanel, 3);
        AddRow(leftLayout, Row(stopListenerButton, openUserManagerButton, openWikiButton), 4);
        AddRow(leftLayout, Divider(), 5);
        AddRow(leftLayout, Eyebrow("Client Routing"), 6);
        AddRow(leftLayout, clientRoutingStatusText, 7);
        var logs = Glass(new Thickness(12), new Thickness(0, 18, 0, 0), Color.FromArgb(168, 6, 9, 13));
        logs.Child = Scrollable(logBox);
        AddRow(leftLayout, logs, 8);
        left.Child = leftLayout;
        grid.Children.Add(left);

        var hero = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        var startRow = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 0, 26) };
        startRow.Children.Add(startListenerButton);
        AddRow(hero, startRow, 1);
        Grid.SetColumn(hero, 1);
        grid.Children.Add(hero);

        view.Child = grid;
        return view;
    }

    private Border BuildCrossSaveView()
    {
        var card = Glass(new Thickness(24), new Thickness(0), Color.FromArgb(218, 10, 14, 22));
        card.MaxWidth = 1080;
        card.HorizontalAlignment = HorizontalAlignment.Center;
        var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,*,Auto") };

        var heading = new StackPanel { Spacing = 4, Margin = new Thickness(0, 0, 0, 16) };
        heading.Children.Add(Eyebrow("Cross Save"));
        heading.Children.Add(new TextBlock
        {
            Text = "Live all-port packet capture for official profile import.",
            Foreground = Brush(190, 202, 220),
            FontSize = 14,
            TextWrapping = TextWrapping.Wrap,
        });
        AddRow(layout, heading, 0);

        var content = new StackPanel { Spacing = 14 };

        var sourcePanel = new StackPanel { Spacing = 12 };
        sourcePanel.Children.Add(Field("Capture folder", crossSaveCaptureDirBox));
        sourcePanel.Children.Add(Row(browseCrossSaveCaptureButton, refreshCrossSaveButton, importCrossSaveButton));
        content.Children.Add(SettingsSection("Live Capture", sourcePanel));

        var options = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,*"),
            RowDefinitions = new RowDefinitions("Auto,Auto"),
            ColumnSpacing = 18,
            RowSpacing = 8,
        };
        AddCell(options, crossSaveSwitchActiveInput, 0, 0);
        AddCell(options, crossSaveUpdateExistingInput, 1, 0);
        AddCell(options, crossSavePreserveUidInput, 0, 1);
        AddCell(options, crossSavePreserveFriendCodeInput, 1, 1);
        content.Children.Add(SettingsSection("Import Options", options));

        var status = new StackPanel { Spacing = 8 };
        crossSaveStatusText.Foreground = Brush(226, 232, 240);
        crossSaveStatusText.FontSize = 15;
        crossSaveStatusText.FontWeight = FontWeight.SemiBold;
        crossSaveDetailsText.Foreground = Brush(176, 188, 206);
        crossSaveDetailsText.FontSize = 13;
        crossSaveDetailsText.TextWrapping = TextWrapping.Wrap;
        status.Children.Add(crossSaveStatusText);
        status.Children.Add(crossSaveDetailsText);
        crossSaveResultBox.FontFamily = "Cascadia Code, Consolas";
        crossSaveResultBox.FontSize = 12;
        status.Children.Add(crossSaveResultBox);
        content.Children.Add(SettingsSection("Result", status));

        AddRow(layout, Scrollable(content), 1);

        var footer = new TextBlock
        {
            Text = "Uses Wireshark dumpcap/tshark. Npcap is required for live capture.",
            Foreground = Brush(166, 180, 202),
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 12, 0, 0),
        };
        AddRow(layout, footer, 2);

        card.Child = layout;
        return card;
    }

    private Border BuildSettingsView()
    {
        var card = Glass(new Thickness(24), new Thickness(0), Color.FromArgb(218, 10, 14, 22));
        card.MaxWidth = 1080;
        card.HorizontalAlignment = HorizontalAlignment.Center;
        var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,*,Auto") };

        var heading = new StackPanel { Spacing = 4, Margin = new Thickness(0, 0, 0, 16) };
        heading.Children.Add(Eyebrow("Settings"));
        heading.Children.Add(new TextBlock
        {
            Text = "Runtime, routing, profile capture, and server time.",
            Foreground = Brush(190, 202, 220),
            FontSize = 14,
            TextWrapping = TextWrapping.Wrap,
        });
        AddRow(layout, heading, 0);

        var content = new StackPanel { Spacing = 14 };
        content.Children.Add(SettingsSection("Official Client", BuildClientSettings()));
        content.Children.Add(SettingsSection("Listener", BuildListenerSettings()));
        content.Children.Add(SettingsSection("Data & Time", BuildDataTimeSettings()));
        content.Children.Add(SettingsSection("Advanced Environment", BuildAdvancedSettings()));
        var scroll = new ScrollViewer
        {
            Content = content,
            VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        };
        AddRow(layout, scroll, 1);

        var saveRow = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        saveRow.Children.Add(saveSettingsButton);
        AddRow(layout, saveRow, 2);
        card.Child = layout;
        return card;
    }

    private Control BuildClientSettings()
    {
        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,Auto,Auto,Auto"), ColumnSpacing = 10 };
        row.Children.Add(managedDirBox);
        Grid.SetColumn(browseManagedButton, 1);
        row.Children.Add(browseManagedButton);
        Grid.SetColumn(detectManagedButton, 2);
        row.Children.Add(detectManagedButton);
        Grid.SetColumn(freezeClientButton, 3);
        row.Children.Add(freezeClientButton);
        Grid.SetColumn(launchFrozenClientButton, 4);
        row.Children.Add(launchFrozenClientButton);
        return row;
    }

    private Control BuildListenerSettings()
    {
        var layout = new StackPanel { Spacing = 12 };
        var ports = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*,*"), ColumnSpacing = 12 };
        AddColumn(ports, Field("TCP", portInput), 0);
        AddColumn(ports, Field("HTTP", httpPortInput), 1);
        AddColumn(ports, Field("Wiki", wikiPortInput), 2);
        AddColumn(ports, Field("Event date", eventDateInput), 3);
        AddColumn(ports, Field("Lobby ACK", joinLobbyModeInput), 4);
        layout.Children.Add(ports);

        var toggles = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,*"),
            RowDefinitions = new RowDefinitions("Auto,Auto,Auto,Auto"),
            ColumnSpacing = 18,
            RowSpacing = 8,
            Margin = new Thickness(0, 4, 0, 0),
        };
        AddCell(toggles, userManagerRemoteInput, 0, 0);
        AddCell(toggles, verboseInput, 1, 0);
        AddCell(toggles, replayGameFlowInput, 0, 1);
        AddCell(toggles, skipTutorialInput, 1, 1);
        AddCell(toggles, resetTutorialInput, 0, 2);
        AddCell(toggles, minimizeToTrayInput, 0, 3);
        AddCell(toggles, notifyTrayStopInput, 1, 3);
        layout.Children.Add(toggles);
        return layout;
    }

    private Control BuildDataTimeSettings()
    {
        var layout = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*"), ColumnSpacing = 18 };
        var data = new StackPanel { Spacing = 10 };
        data.Children.Add(ValueRow("Gameplay Assets", gameplayDataStatusText));
        settingsGameplayProgressPanel = GameplayProgressPanel(settingsGameplayProgressBar, settingsGameplayProgressText);
        data.Children.Add(settingsGameplayProgressPanel);
        data.Children.Add(Row(verifyGameplayAssetsButton, buildGameplayAssetsButton));

        var time = new StackPanel { Spacing = 10 };
        time.Children.Add(Field("Server time", serverTimeInput));
        time.Children.Add(Row(setTimeButton, clearTimeButton));

        layout.Children.Add(data);
        Grid.SetColumn(time, 1);
        layout.Children.Add(time);
        return layout;
    }

    private Control BuildAdvancedSettings()
    {
        advancedEnvInput.Height = 88;
        return Scrollable(advancedEnvInput);
    }

    private void ShowView(string viewName)
    {
        if (dashboardView != null) dashboardView.IsVisible = viewName == "dashboard";
        if (crossSaveView != null) crossSaveView.IsVisible = viewName == "cross-save";
        if (settingsView != null) settingsView.IsVisible = viewName == "settings";
        StyleNavButton(dashboardNavButton, viewName == "dashboard");
        StyleNavButton(crossSaveNavButton, viewName == "cross-save");
        StyleNavButton(settingsNavButton, viewName == "settings");
    }

    private void StyleControls()
    {
        foreach (var button in new[]
        {
            dashboardNavButton,
            crossSaveNavButton,
            settingsNavButton,
            stopListenerButton,
            openUserManagerButton,
            openWikiButton,
            openLogsButton,
            browseManagedButton,
            detectManagedButton,
            freezeClientButton,
            launchFrozenClientButton,
            browseCrossSaveCaptureButton,
            refreshCrossSaveButton,
            verifyGameplayAssetsButton,
            clearTimeButton,
        })
        {
            StyleButton(button);
        }
        foreach (var button in new[] { startListenerButton, saveSettingsButton, importCrossSaveButton, buildGameplayAssetsButton, setTimeButton })
        {
            StyleButton(button, primary: true);
        }
        startListenerButton.FontSize = 22;
        startListenerButton.FontWeight = FontWeight.Black;

        foreach (var input in new Control[] { managedDirBox, crossSaveCaptureDirBox, portInput, httpPortInput, wikiPortInput, eventDateInput, joinLobbyModeInput, crossSaveSourceInput, advancedEnvInput, serverTimeInput, crossSaveResultBox })
        {
            StyleInput(input);
        }
        advancedEnvInput.FontFamily = "Cascadia Code, Consolas";
        logBox.Background = Brush(8, 11, 16);
        logBox.Foreground = Brush(217, 226, 238);
        logBox.FontFamily = "Cascadia Code, Consolas";
        logBox.FontSize = 13;
        logBox.BorderThickness = new Thickness(0);
        gameplayDataStatusText.Foreground = Brush(226, 232, 240);
        gameplayDataStatusText.VerticalAlignment = VerticalAlignment.Center;
    }

    private static void StyleButton(Button button, bool primary = false)
    {
        button.Background = primary ? Brush(255, 218, 76) : Brush(36, 44, 58);
        button.Foreground = primary ? Brush(18, 22, 28) : Brush(238, 243, 248);
        button.BorderBrush = primary ? Brush(255, 231, 132) : Brush(92, 106, 128);
        button.BorderThickness = new Thickness(1);
        button.CornerRadius = new CornerRadius(primary ? 12 : 4);
        button.Padding = primary ? new Thickness(26, 10) : new Thickness(16, 8);
        button.FontFamily = "Inter";
        button.FontSize = primary ? 16 : 14;
        button.FontWeight = FontWeight.SemiBold;
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        button.VerticalContentAlignment = VerticalAlignment.Center;
    }

    private static void StyleNavButton(Button button, bool active)
    {
        StyleButton(button);
        button.Background = active ? Brush(238, 244, 252) : new SolidColorBrush(Color.FromArgb(128, 12, 16, 23));
        button.Foreground = active ? Brush(18, 22, 28) : Brush(236, 242, 248);
        button.BorderBrush = active ? Brushes.White : new SolidColorBrush(Color.FromArgb(132, 162, 178, 198));
        button.FontSize = 14;
    }

    private static void StyleInput(Control input)
    {
        switch (input)
        {
            case TextBox textBox:
                textBox.Background = Brush(17, 22, 30);
                textBox.Foreground = Brush(236, 242, 248);
                textBox.FontSize = 14;
                break;
            case NumericUpDown numericUpDown:
                numericUpDown.Background = Brush(17, 22, 30);
                numericUpDown.Foreground = Brush(236, 242, 248);
                numericUpDown.FontSize = 14;
                break;
            case ComboBox comboBox:
                comboBox.Background = Brush(17, 22, 30);
                comboBox.Foreground = Brush(236, 242, 248);
                comboBox.FontSize = 14;
                break;
        }
    }

    private static ScrollViewer Scrollable(Control child) => new()
    {
        Content = child,
        VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
        HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
    };

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

    private static TextBlock Muted(string text, double height) => new()
    {
        Text = text,
        Foreground = Brush(190, 202, 220),
        FontSize = 15,
        Height = height,
        TextWrapping = TextWrapping.Wrap,
    };

    private static Border Divider() => new()
    {
        Height = 1,
        Background = new SolidColorBrush(Color.FromArgb(82, 255, 255, 255)),
        Margin = new Thickness(0, 14, 0, 18),
    };

    private static Control SettingsSection(string title, Control content)
    {
        var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,Auto") };
        AddRow(layout, new TextBlock
        {
            Text = title.ToUpperInvariant(),
            Foreground = Brush(255, 218, 87),
            FontSize = 13,
            FontWeight = FontWeight.Bold,
            Margin = new Thickness(0, 0, 0, 8),
        }, 0);
        AddRow(layout, content, 1);
        AddRow(layout, new Border
        {
            Height = 1,
            Background = new SolidColorBrush(Color.FromArgb(66, 255, 255, 255)),
            Margin = new Thickness(0, 14, 0, 0),
        }, 2);
        return layout;
    }

    private static Border GameplayProgressPanel(ProgressBar bar, TextBlock text)
    {
        text.Foreground = Brush(190, 202, 220);
        text.FontSize = 12;
        text.TextTrimming = TextTrimming.CharacterEllipsis;
        bar.Background = new SolidColorBrush(Color.FromArgb(116, 255, 255, 255));
        bar.Foreground = Brush(255, 218, 76);

        var panel = new StackPanel { Spacing = 6 };
        panel.Children.Add(text);
        panel.Children.Add(bar);
        return new Border
        {
            IsVisible = false,
            Margin = new Thickness(0, 2, 0, 8),
            Child = panel,
        };
    }

    private static Control Field(string label, Control control)
    {
        var panel = new StackPanel { Spacing = 6 };
        panel.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(166, 180, 202),
            FontSize = 12,
            FontWeight = FontWeight.Bold,
        });
        panel.Children.Add(control);
        return panel;
    }

    private static Control ValueRow(string label, Control value)
    {
        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), ColumnSpacing = 16 };
        row.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(166, 180, 202),
            FontSize = 13,
            FontWeight = FontWeight.Bold,
            VerticalAlignment = VerticalAlignment.Center,
        });
        Grid.SetColumn(value, 1);
        row.Children.Add(value);
        return row;
    }

    private static Control SettingRow(string title, Control content, params Control[] actions)
    {
        var row = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("140,*,Auto"),
            Margin = new Thickness(0, 15, 0, 0),
            MinHeight = 44,
        };
        row.Children.Add(new TextBlock
        {
            Text = title,
            Foreground = Brush(176, 186, 202),
            FontSize = 15,
            VerticalAlignment = VerticalAlignment.Center,
        });
        Grid.SetColumn(content, 1);
        row.Children.Add(content);
        var buttons = Row(actions);
        Grid.SetColumn(buttons, 2);
        row.Children.Add(buttons);
        return row;
    }

    private static Control Labeled(string label, Control control)
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7, Margin = new Thickness(0, 0, 16, 10) };
        panel.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Brush(176, 186, 202),
            FontSize = 14,
            VerticalAlignment = VerticalAlignment.Center,
        });
        panel.Children.Add(control);
        return panel;
    }

    private static StackPanel Row(params Control[] controls)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 4) };
        foreach (var control in controls) row.Children.Add(control);
        return row;
    }

    private static void AddRow(Grid grid, Control control, int row)
    {
        Grid.SetRow(control, row);
        grid.Children.Add(control);
    }

    private static void AddColumn(Grid grid, Control control, int column)
    {
        Grid.SetColumn(control, column);
        grid.Children.Add(control);
    }

    private static void AddCell(Grid grid, Control control, int column, int row)
    {
        Grid.SetColumn(control, column);
        Grid.SetRow(control, row);
        grid.Children.Add(control);
    }

    private void BindEvents()
    {
        dashboardNavButton.Click += (_, _) => ShowView("dashboard");
        crossSaveNavButton.Click += (_, _) => ShowView("cross-save");
        settingsNavButton.Click += (_, _) => ShowView("settings");
        openLogsButton.Click += (_, _) => OpenLogsDirectory();
        startListenerButton.Click += async (_, _) =>
        {
            if (startFlowBusy) return;
            await RunUiAction(StartListenerAsync);
        };
        stopListenerButton.Click += (_, _) => StopListener();
        openUserManagerButton.Click += (_, _) =>
        {
            SaveSettingsFromUi();
            OpenUrl($"http://127.0.0.1:{settings.HttpPort}/user-manager");
        };
        openWikiButton.Click += async (_, _) => await RunUiAction(OpenWikiAsync);
        browseManagedButton.Click += async (_, _) => await RunUiAction(BrowseManagedAssemblyAsync);
        detectManagedButton.Click += async (_, _) => await RunUiAction(async () => { await DetectManagedAssemblyAsync(showMessage: true); });
        freezeClientButton.Click += async (_, _) => await RunUiAction(FreezeClientAsync);
        launchFrozenClientButton.Click += async (_, _) => await RunUiAction(() => LaunchFrozenClientAsync());
        saveSettingsButton.Click += (_, _) => SaveSettingsFromUi();
        browseCrossSaveCaptureButton.Click += async (_, _) => await RunUiAction(StartCrossSaveCaptureAsync);
        refreshCrossSaveButton.Click += (_, _) => StopCrossSaveCapture();
        importCrossSaveButton.Click += async (_, _) => await RunUiAction(ExtractAndCopyCrossSaveAsync);
        verifyGameplayAssetsButton.Click += async (_, _) => await RunUiAction(VerifyGameplayAssetsAsync);
        buildGameplayAssetsButton.Click += async (_, _) => await RunUiAction(BuildGameplayAssetsAsync);
        setTimeButton.Click += async (_, _) => await RunUiAction(SetServerTimeAsync);
        clearTimeButton.Click += async (_, _) => await RunUiAction(ClearServerTimeAsync);
        Closing += OnWindowClosing;
    }

    private void OnWindowClosing(object? sender, WindowClosingEventArgs e)
    {
        if (isShuttingDown) return;
        if (HasRunningBackgroundServices() && minimizeToTrayInput.IsChecked == true)
        {
            e.Cancel = true;
            MinimizeToTray();
            return;
        }

        isShuttingDown = true;
        StopCrossSaveCapture();
        StopListener();
        StopWiki();
        HideTrayIcon();
    }

    private bool HasRunningBackgroundServices()
    {
        return listenerProcess is { HasExited: false } || wikiProcess is { HasExited: false };
    }

    private void EnsureTrayIcon()
    {
        if (OperatingSystem.IsWindows())
        {
            EnsureWindowsTrayIcon();
            return;
        }

        if (trayIcon != null) return;

        var showItem = new NativeMenuItem("Show RevivalSide");
        showItem.Click += (_, _) => Dispatcher.UIThread.Post(ShowFromTray);

        var stopItem = new NativeMenuItem("Stop Server");
        stopItem.Click += (_, _) => Dispatcher.UIThread.Post(StopBackgroundServicesFromTray);

        var exitItem = new NativeMenuItem("Exit");
        exitItem.Click += (_, _) => Dispatcher.UIThread.Post(ExitApplication);

        trayIcon = new TrayIcon
        {
            Icon = CreateTrayIconImage(),
            ToolTipText = BuildTrayTooltipText(),
            Command = new RelayCommand(ShowFromTray),
            Menu = new NativeMenu
            {
                showItem,
                new NativeMenuItemSeparator(),
                stopItem,
                exitItem,
            },
        };

        TrayIcon.SetIcons(Application.Current, new TrayIcons { trayIcon });
    }

    private void EnsureWindowsTrayIcon()
    {
        if (windowsTrayIcon != null) return;

        windowsTrayIcon = new System.Windows.Forms.NotifyIcon
        {
            Icon = CreateWindowsDrawingIcon(),
            Text = TruncateNotifyIconText(BuildTrayTooltipText()),
            Visible = true,
        };
        windowsTrayIcon.DoubleClick += (_, _) => Dispatcher.UIThread.Post(ShowFromTray);

        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("Show RevivalSide", null, (_, _) => Dispatcher.UIThread.Post(ShowFromTray));
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("Stop Server", null, (_, _) => Dispatcher.UIThread.Post(StopBackgroundServicesFromTray));
        menu.Items.Add("Exit", null, (_, _) => Dispatcher.UIThread.Post(ExitApplication));
        windowsTrayIcon.ContextMenuStrip = menu;
    }

    private void MinimizeToTray()
    {
        if (isHiddenInTray) return;
        EnsureTrayIcon();
        isHiddenInTray = true;
        ShowInTaskbar = false;
        Hide();
        UpdateTrayTooltip();
        AppendLog("Launcher hidden to tray. Server keeps running.");
    }

    private void ShowFromTray()
    {
        isHiddenInTray = false;
        ShowInTaskbar = true;
        Show();
        WindowState = WindowState.Normal;
        Activate();
        Focus();
        UpdateTrayTooltip();
    }

    private void StopBackgroundServicesFromTray()
    {
        StopListener();
        StopWiki();
        UpdateTrayTooltip();
        AppendLog("Background services stopped from tray.");
        if (isHiddenInTray) ShowFromTray();
    }

    private void ExitApplication()
    {
        if (isShuttingDown) return;
        isShuttingDown = true;
        StopCrossSaveCapture();
        StopListener();
        StopWiki();
        HideTrayIcon();
        if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.Shutdown();
        }
    }

    private void HideTrayIcon()
    {
        if (windowsTrayIcon != null)
        {
            windowsTrayIcon.Visible = false;
            windowsTrayIcon.Dispose();
            windowsTrayIcon = null;
        }

        if (trayIcon == null) return;
        TrayIcon.SetIcons(Application.Current, null);
        trayIcon = null;
    }

    private string BuildTrayTooltipText()
    {
        var listenerRunning = listenerProcess is { HasExited: false };
        var wikiRunning = wikiProcess is { HasExited: false };
        return listenerRunning
            ? wikiRunning
                ? "RevivalSide — listener and wiki running"
                : "RevivalSide — listener running"
            : wikiRunning
                ? "RevivalSide — wiki running"
                : "RevivalSide Launcher";
    }

    private void UpdateTrayTooltip()
    {
        var text = BuildTrayTooltipText();
        if (windowsTrayIcon != null)
        {
            windowsTrayIcon.Text = TruncateNotifyIconText(text);
            return;
        }

        if (trayIcon != null) trayIcon.ToolTipText = text;
    }

    private void HandleBackgroundServiceStopped(string serviceName)
    {
        if (isShuttingDown || !isHiddenInTray) return;
        ShowTrayNotification(
            $"{serviceName} stopped",
            "The background service exited while RevivalSide was hidden in the tray.");
    }

    private void ShowTrayNotification(string title, string message)
    {
        if (notifyTrayStopInput.IsChecked != true || !isHiddenInTray) return;

        if (windowsTrayIcon != null)
        {
            try
            {
                windowsTrayIcon.ShowBalloonTip(5000, title, message, System.Windows.Forms.ToolTipIcon.Warning);
                return;
            }
            catch (Exception ex)
            {
                AppendLog($"Tray notification failed: {ex.Message}");
            }
        }

        Dispatcher.UIThread.Post(async () =>
        {
            ShowFromTray();
            await ShowMessageAsync("RevivalSide", $"{title}\n\n{message}");
        });
    }

    private static string TruncateNotifyIconText(string text) => text.Length <= 63 ? text : text[..60] + "...";

    private static WindowIcon CreateTrayIconImage()
    {
        const int size = 32;
        var bitmap = new RenderTargetBitmap(new PixelSize(size, size), new Vector(96, 96));
        using (var context = bitmap.CreateDrawingContext())
        {
            context.FillRectangle(Brush(18, 44, 78), new Rect(0, 0, size, size));
            context.FillRectangle(Brush(96, 168, 255), new Rect(5, 5, size - 10, size - 10));
            context.FillRectangle(Brush(255, 255, 255), new Rect(10, 9, 4, 14));
            context.FillRectangle(Brush(255, 255, 255), new Rect(10, 9, 12, 4));
            context.FillRectangle(Brush(255, 255, 255), new Rect(18, 9, 4, 14));
        }
        return new WindowIcon(bitmap);
    }

    private static System.Drawing.Icon CreateWindowsDrawingIcon()
    {
        const int size = 32;
        using var bitmap = new System.Drawing.Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
        {
            graphics.Clear(System.Drawing.Color.FromArgb(18, 44, 78));
            graphics.FillRectangle(new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(96, 168, 255)), 5, 5, size - 10, size - 10);
            using var white = new System.Drawing.SolidBrush(System.Drawing.Color.White);
            graphics.FillRectangle(white, 10, 9, 4, 14);
            graphics.FillRectangle(white, 10, 9, 12, 4);
            graphics.FillRectangle(white, 18, 9, 4, 14);
        }

        var handle = bitmap.GetHicon();
        try
        {
            using var temp = System.Drawing.Icon.FromHandle(handle);
            return (System.Drawing.Icon)temp.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool DestroyIcon(IntPtr handle);

    private async Task RunUiAction(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            AppendLog($"ERROR: {ex.Message}");
            await ShowMessageAsync("RevivalSide", ex.Message);
        }
        finally
        {
            UpdateButtons();
        }
    }

    private async Task RunStartupDependencyChecksAsync()
    {
        try
        {
            await EnsureNodeAndNpmAsync(required: false);
            await EnsureDotNet8RuntimeAsync(required: false);
            await EnsurePythonAssetStackAsync(required: false);
            await EnsureWiresharkAsync(required: false);
            await EnsureNpcapAsync(required: false);
        }
        catch (Exception ex)
        {
            AppendLog($"Dependency check skipped: {ex.Message}");
        }
        await RefreshCutsceneBackgroundAsync(force: false);
    }

    private async Task EnsureListenerDependenciesAsync()
    {
        await EnsureNodeAndNpmAsync(required: true);
        await EnsureDotNet8RuntimeAsync(required: true);
        await EnsurePythonAssetStackAsync(required: true);
    }

    private async Task EnsureAssetBuildDependenciesAsync()
    {
        await EnsureNodeAndNpmAsync(required: true);
        await EnsurePythonAssetStackAsync(required: true);
    }

    private async Task EnsureCrossSaveCaptureDependenciesAsync()
    {
        await EnsureWiresharkAsync(required: true);
        await EnsureNpcapAsync(required: true);
    }

    private async Task EnsureCrossSaveExtractDependenciesAsync()
    {
        await EnsureNodeAndNpmAsync(required: true);
        await EnsureDotNet8RuntimeAsync(required: true);
        await EnsureWiresharkAsync(required: true);
    }

    private Task<bool> EnsureNodeAndNpmAsync(bool required)
    {
        RefreshToolPaths();
        AppendLog($"Node/npm: using {nodePath}, {npmPath}.");
        return Task.FromResult(true);
    }

    private async Task<bool> EnsureDotNet8RuntimeAsync(bool required)
    {
        if (await HasDotNet8RuntimeAsync())
        {
            AppendLog(".NET 8 Runtime: detected.");
            return true;
        }

        var installer = FindBundledRuntimeInstaller("dotnet", "*.exe", includeCommon: false);
        if (!File.Exists(installer))
        {
            return HandleMissingDependency(required, ".NET 8 Runtime", ".NET 8 Runtime is missing and no bundled .NET installer was found.");
        }

        var installed = await PromptAndRunInstallerAsync(
            "Install .NET 8",
            ".NET 8 Runtime is required by the managed combat/table host fallback. Install the bundled runtime now?",
            "Install",
            "Later",
            installer,
            "/install /passive /norestart",
            elevated: true);
        if (installed && await HasDotNet8RuntimeAsync()) return true;
        return HandleMissingDependency(required, ".NET 8 Runtime", ".NET 8 Runtime is still not available.");
    }

    private Task<bool> EnsurePythonAssetStackAsync(bool required)
    {
        var python = ResolveBundledPythonPath();
        AppendLog(string.IsNullOrWhiteSpace(python)
            ? "Python assets: deferred to asset tools."
            : $"Python assets: using {python}.");
        return Task.FromResult(true);
    }

    private Task<bool> EnsureWiresharkAsync(bool required)
    {
        RefreshToolPaths();
        AppendLog($"Wireshark tools: using {dumpcapPath}, {tsharkPath}.");
        return Task.FromResult(true);
    }

    private async Task<bool> EnsureNpcapAsync(bool required)
    {
        if (HasNpcap())
        {
            AppendLog("Npcap: detected.");
            return true;
        }

        var installer = FindBundledRuntimeInstaller("npcap", "npcap-*.exe", includeCommon: true);
        if (!File.Exists(installer))
        {
            return HandleMissingDependency(required, "Npcap", "Npcap capture driver is missing and no bundled Npcap installer was found.");
        }

        var installed = await PromptAndRunInstallerAsync(
            "Install Npcap",
            "Cross Save live capture needs the Npcap Windows packet capture driver. Install the bundled Npcap driver now?",
            "Install",
            "Later",
            installer,
            "",
            elevated: true);
        if (installed && HasNpcap()) return true;
        return HandleMissingDependency(required, "Npcap", "Npcap capture driver is still not available.");
    }

    private bool HandleMissingDependency(bool required, string name, string message)
    {
        AppendLog($"{name}: {message}");
        if (required) throw new InvalidOperationException(message);
        return false;
    }

    private async Task<bool> PromptAndRunInstallerAsync(
        string title,
        string message,
        string fileName,
        string arguments,
        bool elevated)
    {
        return await PromptAndRunInstallerAsync(title, message, "Install", "Later", fileName, arguments, elevated);
    }

    private async Task<bool> PromptAndRunInstallerAsync(
        string title,
        string message,
        string installLabel,
        string cancelLabel,
        string fileName,
        string arguments,
        bool elevated)
    {
        var shouldInstall = await ShowConfirmAsync(title, message, installLabel, cancelLabel);
        if (!shouldInstall)
        {
            AppendLog($"{title}: skipped.");
            return false;
        }

        AppendLog($"{title}: running {fileName}");
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = true,
            WorkingDirectory = File.Exists(fileName) ? Path.GetDirectoryName(fileName) ?? appRoot : appRoot,
        };
        if (elevated) startInfo.Verb = "runas";
        using var process = Process.Start(startInfo);
        if (process == null) throw new InvalidOperationException($"Could not start installer: {fileName}");
        await process.WaitForExitAsync();
        AppendLog($"{title}: installer exited {process.ExitCode}.");
        RefreshToolPaths();
        return process.ExitCode == 0;
    }

    private async Task<bool> HasDotNet8RuntimeAsync()
    {
        var dotnet = ResolveToolPath("dotnet.exe");
        if (!ToolPathExists(dotnet)) return false;
        var result = await RunToolAsync(dotnet, ["--list-runtimes"], timeoutMs: 15000);
        return result.ExitCode == 0 && result.CombinedOutput.SplitLines().Any(line => line.Contains("Microsoft.NETCore.App 8.", StringComparison.OrdinalIgnoreCase));
    }

    private bool HasWiresharkTools()
    {
        return ToolPathExists(dumpcapPath) && ToolPathExists(tsharkPath);
    }

    private static bool HasNpcap()
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        foreach (var candidate in new[]
        {
            Path.Combine(windows, "System32", "Npcap", "Packet.dll"),
            Path.Combine(windows, "System32", "Npcap", "wpcap.dll"),
            Path.Combine(windows, "SysWOW64", "Npcap", "Packet.dll"),
            Path.Combine(windows, "SysWOW64", "Npcap", "wpcap.dll"),
        })
        {
            if (File.Exists(candidate)) return true;
        }
        return false;
    }

    private async Task<PythonTool?> FindUsablePythonAsync(bool requireAssetPackages)
    {
        foreach (var candidate in EnumeratePythonCandidates())
        {
            var probe = await RunToolAsync(candidate.FileName, candidate.Arguments.Concat(["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"]), timeoutMs: 15000);
            if (probe.ExitCode != 0 || IsPythonStoreAliasOutput(probe.CombinedOutput)) continue;
            if (requireAssetPackages && !await PythonHasAssetPackagesAsync(candidate)) continue;
            return candidate;
        }
        return null;
    }

    private async Task<bool> PythonHasAssetPackagesAsync(PythonTool python)
    {
        var result = await RunToolAsync(python.FileName, python.Arguments.Concat(["-c", "import UnityPy; import PIL"]), timeoutMs: 30000);
        return result.ExitCode == 0;
    }

    private IEnumerable<PythonTool> EnumeratePythonCandidates()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(List<PythonTool> list, PythonTool tool)
        {
            var key = tool.FileName + "\u001f" + string.Join("\u001f", tool.Arguments);
            if (seen.Add(key)) list.Add(tool);
        }

        var candidates = new List<PythonTool>();
        foreach (var path in EnumerateBundledPythonPaths())
        {
            Add(candidates, new PythonTool(path, [], path));
        }
        var pythonPathEnv = Environment.GetEnvironmentVariable("CS_PYTHON_PATH") ?? Environment.GetEnvironmentVariable("PYTHON") ?? "";
        foreach (var configured in pythonPathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (File.Exists(configured)) Add(candidates, new PythonTool(configured, [], configured));
        }
        var py = ResolveToolFromPath("py.exe");
        if (!string.IsNullOrWhiteSpace(py)) Add(candidates, new PythonTool(py, ["-3"], "py -3"));
        foreach (var tool in new[] { "python.exe", "python3.exe" })
        {
            var resolved = ResolveToolFromPath(tool);
            if (!string.IsNullOrWhiteSpace(resolved)) Add(candidates, new PythonTool(resolved, [], resolved));
        }
        foreach (var commonPath in EnumerateCommonPythonInstallPaths())
        {
            if (File.Exists(commonPath)) Add(candidates, new PythonTool(commonPath, [], commonPath));
        }
        return candidates;
    }

    private IEnumerable<string> EnumerateBundledPythonPaths()
    {
        var rid = GetWindowsRid();
        foreach (var relativePath in new[]
        {
            Path.Combine("runtime", "python", "python.exe"),
            Path.Combine("runtime", "python", "python3.exe"),
            Path.Combine("runtime", "python", "Scripts", "python.exe"),
            Path.Combine("runtime-python", rid, "python.exe"),
            Path.Combine("runtime-python", rid, "python3.exe"),
            Path.Combine("runtime-python", rid, "Scripts", "python.exe"),
        })
        {
            foreach (var root in EnumerateToolSearchRoots())
            {
                var path = Path.Combine(root, relativePath);
                if (File.Exists(path)) yield return path;
            }
        }
    }

    private static IEnumerable<string> EnumerateCommonPythonInstallPaths()
    {
        var suffixes = new[] { "Python313", "Python314", "Python312", "Python311", "Python310" };
        foreach (var baseDir in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Python"),
            "C:\\",
        })
        {
            if (string.IsNullOrWhiteSpace(baseDir)) continue;
            foreach (var suffix in suffixes)
            {
                yield return baseDir.Equals("C:\\", StringComparison.OrdinalIgnoreCase)
                    ? Path.Combine(baseDir, suffix, "python.exe")
                    : Path.Combine(baseDir, suffix, "python.exe");
            }
        }
    }

    private string FindBundledRuntimeInstaller(string toolName, string pattern, bool includeCommon)
    {
        foreach (var directory in EnumerateRuntimeInstallerDirectories(toolName, includeCommon))
        {
            if (!Directory.Exists(directory)) continue;
            var match = Directory.EnumerateFiles(directory, pattern, SearchOption.TopDirectoryOnly)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(match)) return match;
        }
        return "";
    }

    private string FindBundledPythonPackageRoot()
    {
        foreach (var directory in EnumerateRuntimeInstallerDirectories("python-packages", includeCommon: false))
        {
            if (Directory.Exists(directory)) return directory;
        }
        return "";
    }

    private IEnumerable<string> EnumerateRuntimeInstallerDirectories(string toolName, bool includeCommon)
    {
        var rid = GetWindowsRid();
        foreach (var root in new[] { appRoot, AppContext.BaseDirectory }.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            yield return Path.Combine(root, "runtime", "installers", toolName, rid);
            if (includeCommon) yield return Path.Combine(root, "runtime", "installers", toolName, "all");
        }
    }

    private static async Task<ToolRunResult> RunToolAsync(string fileName, IEnumerable<string> arguments, int timeoutMs)
    {
        var argumentList = arguments.ToArray();
        var isBatchFile = fileName.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || fileName.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = isBatchFile ? "cmd.exe" : fileName,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        if (isBatchFile)
        {
            process.StartInfo.ArgumentList.Add("/d");
            process.StartInfo.ArgumentList.Add("/s");
            process.StartInfo.ArgumentList.Add("/c");
            process.StartInfo.ArgumentList.Add($"\"\"{fileName}\" {string.Join(" ", argumentList.Select(CommandQuote))}\"");
        }
        else
        {
            foreach (var argument in argumentList) process.StartInfo.ArgumentList.Add(argument);
        }
        var output = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
        try
        {
            if (!process.Start()) return new ToolRunResult(-1, "");
        }
        catch (Exception ex)
        {
            return new ToolRunResult(-1, ex.Message);
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        var waitTask = process.WaitForExitAsync();
        var completed = await Task.WhenAny(waitTask, Task.Delay(timeoutMs));
        if (completed != waitTask)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new ToolRunResult(-1, "timed out");
        }
        process.WaitForExit();
        return new ToolRunResult(process.ExitCode, output.ToString());
    }

    private static bool IsPythonStoreAliasOutput(string output)
    {
        return output.Contains("python was not found", StringComparison.OrdinalIgnoreCase)
            || output.Contains("microsoft store", StringComparison.OrdinalIgnoreCase)
            || output.Contains("app execution aliases", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ToolPathExists(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        if (Path.IsPathFullyQualified(path)) return File.Exists(path);
        return !string.IsNullOrWhiteSpace(ResolveToolFromPath(path));
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

    private static string CommandQuote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

    private void LoadSettingsIntoUi()
    {
        var managedDir = GetConfiguredManagedDir();
        managedDirBox.Text = IsManagedDir(managedDir) ? managedDir : "CounterSide Assembly-CSharp.dll not selected";
        crossSaveCaptureDirBox.Text = CrossSaveCaptureDir();
        portInput.Value = ClampPort(settings.GamePort, 22000);
        httpPortInput.Value = ClampPort(settings.HttpPort, 8088);
        wikiPortInput.Value = ClampPort(settings.WikiPort, 5174);
        eventDateInput.Text = settings.EventDate;
        joinLobbyModeInput.SelectedItem = NormalizeJoinLobbyMode(settings.JoinLobbyAckMode);
        userManagerRemoteInput.IsChecked = settings.UserManagerAllowRemote;
        verboseInput.IsChecked = settings.VerboseCapture;
        replayGameFlowInput.IsChecked = settings.ReplayCapturedGameFlow;
        skipTutorialInput.IsChecked = settings.SkipTutorialToWin;
        resetTutorialInput.IsChecked = settings.ResetTutorialOnLogin;
        minimizeToTrayInput.IsChecked = settings.MinimizeToTrayOnClose;
        notifyTrayStopInput.IsChecked = settings.NotifyTrayWhenServiceStops;
        advancedEnvInput.Text = settings.AdvancedEnvText;
        serverTimeInput.Text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        UpdateButtons();
    }

    private void SaveSettingsFromUi()
    {
        settings.SettingsVersion = LauncherSettings.CurrentVersion;
        settings.GamePort = Convert.ToInt32(portInput.Value ?? 22000);
        settings.HttpPort = Convert.ToInt32(httpPortInput.Value ?? 8088);
        settings.WikiPort = Convert.ToInt32(wikiPortInput.Value ?? 5174);
        settings.EventDate = (eventDateInput.Text ?? "").Trim();
        settings.JoinLobbyAckMode = NormalizeJoinLobbyMode(Convert.ToString(joinLobbyModeInput.SelectedItem) ?? joinLobbyModeInput.Text);
        settings.UserManagerAllowRemote = userManagerRemoteInput.IsChecked == true;
        settings.VerboseCapture = verboseInput.IsChecked == true;
        settings.ReplayCapturedGameFlow = replayGameFlowInput.IsChecked == true;
        settings.SkipTutorialToWin = skipTutorialInput.IsChecked == true;
        settings.ResetTutorialOnLogin = resetTutorialInput.IsChecked == true;
        settings.MinimizeToTrayOnClose = minimizeToTrayInput.IsChecked == true;
        settings.NotifyTrayWhenServiceStops = notifyTrayStopInput.IsChecked == true;
        settings.AdvancedEnvText = advancedEnvInput.Text ?? "";
        settings.CounterSideManagedDir = GetConfiguredManagedDir();
        settings.CrossSaveCaptureDir = (crossSaveCaptureDirBox.Text ?? "").Trim();
        managedDirBox.Text = IsManagedDir(settings.CounterSideManagedDir) ? settings.CounterSideManagedDir : "CounterSide Assembly-CSharp.dll not selected";
        crossSaveCaptureDirBox.Text = CrossSaveCaptureDir();
        SaveSettings();
        AppendLog("Settings saved.");
    }

    private async Task StartListenerAsync()
    {
        if (listenerProcess is { HasExited: false }) return;
        SaveSettingsFromUi();
        RequireControlledFrozenClient();
        SetStartButtonPhase("PATCHING");
        try
        {
            SetStartButtonPhase("STARTING");
            await EnsureListenerDependenciesAsync();
            EnsureRuntimeLayout();
            ValidateListenerRuntimeLayout();
            var gameplayAssets = VerifyGameplayAssetsReady();
            AppendLog($"Gameplay assets ready: {gameplayAssets.Description}");
            gameplayAssets = await EnsureGameplayAssetCacheAsync(force: false);
            AppendLog($"Gameplay asset cache ready: {gameplayAssets.CachedLuaCount:N0} luac files at {gameplayAssets.CacheRoot}");
            await EnsureClientPatchAsync(requireControlledRouting: true);
            var env = BuildListenerEnvironment();
            var logWriter = OpenProcessLog("listener", out var logPath);
            var listenCommand = CreateListenCommand();
            var job = ProcessJob.TryCreateKillOnClose();
            var readiness = new ListenerReadinessGate();
            var process = new Process
            {
                StartInfo = listenCommand.StartInfo,
                EnableRaisingEvents = true,
            };
            foreach (var item in env) process.StartInfo.Environment[item.Key] = item.Value;
            void HandleListenerOutput(string? line)
            {
                if (line == null) return;
                AppendProcessLog(logWriter, line);
                readiness.Observe(line);
            }
            process.OutputDataReceived += (_, e) => HandleListenerOutput(e.Data);
            process.ErrorDataReceived += (_, e) => HandleListenerOutput(e.Data);
            process.Exited += (_, _) =>
            {
                var exitDescription = "before reporting ready";
                try { exitDescription = $"with exit code {process.ExitCode} before reporting ready"; } catch { }
                readiness.Fail($"Listener exited {exitDescription}.");
                Dispatcher.UIThread.Post(() =>
                {
                    if (ReferenceEquals(listenerProcess, process))
                    {
                        listenerProcess = null;
                        listenerJob?.Dispose();
                        listenerJob = null;
                        process.Dispose();
                    }
                    listenerStatusText.Text = "Stopped";
                    UpdateButtons();
                    HandleBackgroundServiceStopped("Listener");
                    AppendProcessLog(logWriter, "Listener stopped.");
                    CloseProcessLog(logWriter);
                });
            };
            if (!process.Start())
            {
                job?.Dispose();
                CloseProcessLog(logWriter);
                throw new InvalidOperationException("Could not start listener.");
            }
            try
            {
                job?.Assign(process);
            }
            catch (Exception ex)
            {
                job?.Dispose();
                job = null;
                AppendLog($"Listener process job unavailable; Stop will use process-tree fallback: {ex.Message}");
            }
            listenerProcess = process;
            listenerJob = job;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            listenerStatusText.Text = "Starting";
            AppendLog($"Listener started: {listenCommand.Display}");
            AppendLog($"Listener log: {logPath}");
            AppendLog("Waiting for game listener, captured mirror, fixture directory, and User Manager readiness...");
            UpdateButtons();
            try
            {
                await readiness.Ready.WaitAsync(TimeSpan.FromSeconds(ListenerReadinessTimeoutSeconds));
            }
            catch (TimeoutException)
            {
                throw new InvalidOperationException(
                    $"Listener did not become ready within {ListenerReadinessTimeoutSeconds} seconds. Missing: {readiness.DescribeMissing()}.");
            }
            if (!ReferenceEquals(listenerProcess, process) || process.HasExited)
            {
                throw new InvalidOperationException("Listener stopped before the frozen client could be launched.");
            }

            listenerStatusText.Text = "Ready";
            AppendLog("Listener ready: game port, captured HTTP mirror, fixture directory, and User Manager are listening.");
            SetStartButtonPhase("LAUNCHING");
            await LaunchFrozenClientAsync(clientPatchAlreadyVerified: true);
        }
        finally
        {
            ClearStartButtonPhase();
        }
    }

    private void SetStartButtonPhase(string label)
    {
        startFlowBusy = true;
        startListenerButton.Content = label;
        startListenerButton.IsEnabled = true;
        startListenerButton.IsHitTestVisible = false;
    }

    private void ClearStartButtonPhase()
    {
        startFlowBusy = false;
        startListenerButton.IsHitTestVisible = true;
        startListenerButton.Content = StartButtonDefaultText;
        UpdateButtons();
    }

    private void StopListener()
    {
        if (listenerProcess == null && listenerJob == null) return;
        var process = listenerProcess;
        var job = listenerJob;
        listenerProcess = null;
        listenerJob = null;
        AppendLog("Stopping listener...");
        try
        {
            job?.Dispose();
            if (process is { HasExited: false } && !process.WaitForExit(1500))
            {
                KillProcessTree(process, "listener");
                process.WaitForExit(5000);
            }
            KillListeningProcessesOnPorts(settings.GamePort, settings.HttpPort);
            AppendLog("Listener stop requested.");
        }
        catch (Exception ex)
        {
            AppendLog($"Stop listener failed: {ex.Message}");
        }
        finally
        {
            process?.Dispose();
            listenerStatusText.Text = "Stopped";
            UpdateButtons();
        }
    }

    private void KillProcessTree(Process process, string name)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            return;
        }
        catch (Exception ex)
        {
            AppendLog($"{name} .NET process-tree stop failed: {ex.Message}");
        }
        if (OperatingSystem.IsWindows()) RunTaskKill(process.Id, name);
    }

    private void KillListeningProcessesOnPorts(params int[] ports)
    {
        if (!OperatingSystem.IsWindows()) return;
        var targetPorts = ports.Where(port => port > 0).Distinct().ToArray();
        if (targetPorts.Length == 0) return;
        foreach (var pid in FindListeningPids(targetPorts))
        {
            if (pid <= 0 || pid == Environment.ProcessId) continue;
            RunTaskKill(pid, "listener port");
        }
    }

    private IEnumerable<int> FindListeningPids(IReadOnlyCollection<int> ports)
    {
        var result = new HashSet<int>();
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "netstat.exe",
                    Arguments = "-ano -p tcp",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
            };
            process.Start();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(3000);
            foreach (var line in output.SplitLines())
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (parts.Length < 5 || !parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                if (!TryParseEndpointPort(parts[1], out var port) || !ports.Contains(port)) continue;
                if (int.TryParse(parts[4], out var pid)) result.Add(pid);
            }
        }
        catch (Exception ex)
        {
            AppendLog($"Listener port cleanup scan failed: {ex.Message}");
        }
        return result;
    }

    private static bool TryParseEndpointPort(string endpoint, out int port)
    {
        port = 0;
        var text = endpoint.Trim();
        var marker = text.LastIndexOf(':');
        if (marker < 0 || marker == text.Length - 1) return false;
        return int.TryParse(text[(marker + 1)..].Trim(']'), out port);
    }

    private void RunTaskKill(int pid, string name)
    {
        try
        {
            using var taskkill = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = $"/PID {pid} /T /F",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
            };
            taskkill.Start();
            taskkill.WaitForExit(5000);
            AppendLog($"{name} taskkill PID {pid}: exit {taskkill.ExitCode}");
        }
        catch (Exception ex)
        {
            AppendLog($"{name} taskkill PID {pid} failed: {ex.Message}");
        }
    }

    private async Task OpenWikiAsync()
    {
        SaveSettingsFromUi();
        await EnsureAssetBuildDependenciesAsync();
        var wikiAssets = await EnsureWikiAssetCacheAsync(force: false);
        AppendLog($"Wiki image cache ready: {wikiAssets.CachedPngCount:N0} PNGs at {wikiAssets.CacheRoot}");
        if (wikiProcess is not { HasExited: false })
        {
            var logWriter = OpenProcessLog("wiki", out var logPath);
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = nodePath,
                    WorkingDirectory = appRoot,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
                EnableRaisingEvents = true,
            };
            process.StartInfo.ArgumentList.Add(Path.Combine(appRoot, "tools", "serve-revivalside-wiki.js"));
            process.StartInfo.ArgumentList.Add("--port");
            process.StartInfo.ArgumentList.Add(settings.WikiPort.ToString());
            process.OutputDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
            process.Exited += (_, _) => Dispatcher.UIThread.Post(() =>
            {
                if (ReferenceEquals(wikiProcess, process))
                {
                    wikiProcess = null;
                    process.Dispose();
                }
                UpdateButtons();
                HandleBackgroundServiceStopped("Wiki");
                AppendProcessLog(logWriter, "Wiki server stopped.");
                CloseProcessLog(logWriter);
            });
            if (!process.Start())
            {
                CloseProcessLog(logWriter);
                throw new InvalidOperationException("Could not start wiki server.");
            }
            wikiProcess = process;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            AppendLog("Wiki server started.");
            AppendLog($"Wiki log: {logPath}");
            await Task.Delay(600);
        }
        OpenUrl($"http://127.0.0.1:{settings.WikiPort}/");
    }

    private void StopWiki()
    {
        try
        {
            if (wikiProcess is { HasExited: false }) wikiProcess.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best effort on close.
        }
        finally
        {
            wikiProcess?.Dispose();
            wikiProcess = null;
        }
    }

    private async Task StartCrossSaveCaptureAsync()
    {
        if (crossSaveCaptureProcesses.Count > 0) throw new InvalidOperationException("Cross Save capture is already listening.");
        SaveSettingsFromUi();
        await EnsureCrossSaveCaptureDependenciesAsync();
        EnsureRuntimeLayout();
        ValidateCrossSaveCaptureTool(dumpcapPath, "dumpcap.exe");

        crossSaveCaptureStamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var interfaces = await ResolveCrossSaveInterfacesAsync();
        if (interfaces.Count == 0) throw new InvalidOperationException("No dumpcap interfaces were found.");

        foreach (var iface in interfaces)
        {
            var safeName = SafeFileName(iface.Name);
            var pcapFile = Path.Combine(CrossSaveCaptureDir(), $"counterside-all-{iface.Id}-{safeName}-{crossSaveCaptureStamp}.pcapng");
            var logFile = Path.Combine(CrossSaveCaptureDir(), $"dumpcap-{iface.Id}-{safeName}-{crossSaveCaptureStamp}.log");
            var writer = new StreamWriter(File.Open(logFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8)
            {
                AutoFlush = true,
            };
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = dumpcapPath,
                    WorkingDirectory = appRoot,
                    UseShellExecute = false,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
                EnableRaisingEvents = true,
            };
            process.StartInfo.ArgumentList.Add("-i");
            process.StartInfo.ArgumentList.Add(iface.Id);
            process.StartInfo.ArgumentList.Add("-s");
            process.StartInfo.ArgumentList.Add("0");
            process.StartInfo.ArgumentList.Add("-w");
            process.StartInfo.ArgumentList.Add(pcapFile);
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null) writer.WriteLine(e.Data);
            };
            if (!process.Start())
            {
                writer.Dispose();
                throw new InvalidOperationException($"Could not start dumpcap on interface {iface.Id}.");
            }
            process.BeginErrorReadLine();
            crossSaveCaptureProcesses.Add(new CrossSaveCaptureProcess(process, writer, pcapFile, logFile, iface));
        }

        crossSaveStatusText.Text = $"Listening on {crossSaveCaptureProcesses.Count:N0} interface(s)";
        crossSaveDetailsText.Text = $"{crossSaveCaptureStamp} | {CrossSaveCaptureDir()}";
        crossSaveResultBox.Text = "";
        AppendLog($"Cross Save live capture listening on {crossSaveCaptureProcesses.Count:N0} interface(s).");
        foreach (var capture in crossSaveCaptureProcesses)
        {
            AppendLog($"  dumpcap PID {capture.Process.Id}: {capture.Interface.Id} {capture.Interface.Name}");
        }
        UpdateButtons();
    }

    private void StopCrossSaveCapture()
    {
        if (crossSaveCaptureProcesses.Count == 0) return;
        AppendLog("Stopping Cross Save live capture...");
        foreach (var capture in crossSaveCaptureProcesses.ToArray())
        {
            try
            {
                if (!capture.Process.HasExited)
                {
                    capture.Process.Kill(entireProcessTree: true);
                    capture.Process.WaitForExit(5000);
                }
            }
            catch (Exception ex)
            {
                AppendLog($"Stop dumpcap PID {capture.Process.Id} failed: {ex.Message}");
            }
            finally
            {
                try { capture.Writer.Dispose(); } catch { }
                try { capture.Process.Dispose(); } catch { }
                crossSaveCaptureProcesses.Remove(capture);
            }
        }

        var files = GetCurrentCrossSaveCaptureFiles()
            .Where(File.Exists)
            .Select(path => new FileInfo(path))
            .ToList();
        crossSaveStatusText.Text = "Stopped";
        crossSaveDetailsText.Text = files.Count == 1
            ? $"{files[0].Name} | {FormatBytes(files[0].Length)}"
            : $"{files.Count:N0} capture file(s) ready";
        foreach (var file in files)
        {
            AppendLog($"  {file.Name} ({file.Length:N0} bytes)");
        }
        UpdateButtons();
    }

    private async Task ExtractAndCopyCrossSaveAsync()
    {
        if (crossSaveCaptureProcesses.Count > 0) throw new InvalidOperationException("Stop Cross Save capture before extracting.");
        SaveSettingsFromUi();
        await EnsureCrossSaveExtractDependenciesAsync();
        EnsureRuntimeLayout();
        ValidateCrossSaveRuntimeLayout();
        ValidateCrossSaveCaptureTool(tsharkPath, "tshark.exe");
        EnsureCompatibleExecutable("node.exe", nodePath);
        if (!IsManagedDir(GetConfiguredManagedDir()) && !await DetectManagedAssemblyAsync(showMessage: false))
        {
            throw new InvalidOperationException("Select CounterSide Data\\Managed\\Assembly-CSharp.dll before extracting Cross Save.");
        }
        var gameplayAssets = await EnsureGameplayAssetCacheAsync(force: false);
        AppendLog($"Cross Save gameplay cache ready: {gameplayAssets.CachedLuaCount:N0} luac files.");

        var pcapFiles = GetCurrentCrossSaveCaptureFiles()
            .Where(File.Exists)
            .Select(path => new FileInfo(path))
            .Where(file => file.Length > 0)
            .OrderByDescending(file => file.Length)
            .ToList();
        if (pcapFiles.Count == 0) throw new InvalidOperationException("No Cross Save capture files were found.");

        using var logWriter = OpenProcessLog("cross-save-extract", out var logPath);
        AppendLog($"Cross Save extract log: {logPath}");
        Directory.CreateDirectory(CrossSaveExtractRootDir());
        foreach (var pcap in pcapFiles)
        {
            AppendProcessLog(logWriter, $"Scanning {pcap.Name}...");
            var streams = await EnumerateCrossSaveCandidateStreamsAsync(pcap.FullName);
            AppendProcessLog(logWriter, $"  {streams.Count:N0} candidate TCP stream(s)");
            for (var index = 0; index < streams.Count; index++)
            {
                var stream = streams[index];
                var logStream = index < 25 || stream.HasGamePort;
                if (logStream) AppendProcessLog(logWriter, $"  stream {stream.Stream}: {stream.TotalBytes:N0} bytes");
                var outputDir = Path.Combine(CrossSaveExtractRootDir(), $"{Path.GetFileNameWithoutExtension(pcap.Name)}-stream-{stream.Stream}");
                var extracted = await TryExtractCrossSaveStreamAsync(pcap.FullName, outputDir, stream.Stream, logStream, logWriter);
                if (!extracted || !ManifestHasJoinLobbyAck(Path.Combine(outputDir, "manifest.json"))) continue;

                var sources = LoadCrossSaveSources(outputDir);
                var source = sources.FirstOrDefault();
                if (source == null) continue;

                var copyPath = Path.Combine(CrossSaveExportsDir(), $"users-{DateTime.Now:yyyyMMdd-HHmmss}.json");
                var result = await RunCrossSaveImportProcessAsync(source, gameplayAssets, outputDir, copyPath);
                await CopyCrossSaveExportToClipboardAsync(copyPath);

                crossSaveSources = sources;
                crossSaveSourceInput.ItemsSource = null;
                crossSaveSourceInput.ItemsSource = crossSaveSources;
                crossSaveSourceInput.SelectedIndex = 0;
                crossSaveStatusText.Text = $"Imported {result.Nickname}";
                crossSaveDetailsText.Text = $"Local UID {result.UserUid} | official UID {result.OfficialUserUid} | copied {copyPath}";
                crossSaveResultBox.Text = result.PrettyJson;
                AppendProcessLog(logWriter, $"Found JOIN_LOBBY_ACK in {pcap.Name} stream {stream.Stream}.");
                AppendProcessLog(logWriter, $"Copied users.json export and clipboard text: {copyPath}");
                if (listenerProcess is { HasExited: false }) await ReloadRunningUserManagerAsync();
                return;
            }
            if (streams.Count > 25) AppendProcessLog(logWriter, $"  scanned {streams.Count - 25:N0} additional lower-priority stream(s)");
        }

        throw new InvalidOperationException("No JOIN_LOBBY_ACK packet was found in the latest Cross Save capture.");
    }

    private async Task<List<CrossSaveCaptureInterface>> ResolveCrossSaveInterfacesAsync()
    {
        var result = await RunCrossSaveProcessAsync(dumpcapPath, new[] { "-D" });
        if (result.ExitCode != 0) throw new InvalidOperationException(FirstNonEmptyLine(result.Error, "dumpcap interface scan failed"));
        var interfaces = new List<CrossSaveCaptureInterface>();
        var regex = new Regex(@"^(\d+)\.\s+(.+?)(?:\s+\((.+)\))?\s*$");
        foreach (var line in result.Output.SplitLines())
        {
            var match = regex.Match(line.Trim());
            if (!match.Success) continue;
            var name = match.Groups[3].Success ? match.Groups[3].Value : match.Groups[2].Value;
            interfaces.Add(new CrossSaveCaptureInterface(match.Groups[1].Value, name));
        }
        return interfaces;
    }

    private async Task<List<CrossSaveStreamInfo>> EnumerateCrossSaveCandidateStreamsAsync(string pcapFile)
    {
        var result = await RunCrossSaveProcessAsync(
            tsharkPath,
            new[]
            {
                "-r",
                pcapFile,
                "-Y",
                "tcp.len > 0",
                "-T",
                "fields",
                "-E",
                "separator=\t",
                "-e",
                "tcp.stream",
                "-e",
                "tcp.srcport",
                "-e",
                "tcp.dstport",
                "-e",
                "tcp.len",
            });
        if (result.ExitCode != 0) throw new InvalidOperationException(FirstNonEmptyLine(result.Error, "tshark stream scan failed"));

        var byStream = new Dictionary<int, CrossSaveStreamInfo>();
        foreach (var line in result.Output.SplitLines())
        {
            var parts = line.Split('\t');
            if (parts.Length < 4 || !int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var streamId)) continue;
            if (!long.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out var length)) length = 0;
            if (!byStream.TryGetValue(streamId, out var stream))
            {
                stream = new CrossSaveStreamInfo(streamId);
                byStream[streamId] = stream;
            }
            stream.TotalBytes += Math.Max(0, length);
            if (CrossSaveGamePorts.Contains(parts[1]) || CrossSaveGamePorts.Contains(parts[2])) stream.HasGamePort = true;
        }

        return byStream.Values
            .Where(stream => stream.TotalBytes >= 64)
            .OrderByDescending(stream => stream.HasGamePort)
            .ThenByDescending(stream => stream.TotalBytes)
            .Take(1000)
            .ToList();
    }

    private async Task<bool> TryExtractCrossSaveStreamAsync(string pcapFile, string outputDir, int stream, bool logFailures, StreamWriter logWriter)
    {
        if (Directory.Exists(outputDir)) Directory.Delete(outputDir, recursive: true);
        Directory.CreateDirectory(outputDir);
        var result = await RunCrossSaveProcessAsync(
            nodePath,
            new[]
            {
                Path.Combine(appRoot, "tools", "extract-cs-pcap-fixtures.js"),
                pcapFile,
                outputDir,
                "game",
                stream.ToString(CultureInfo.InvariantCulture),
            },
            BuildCrossSaveToolEnvironment());
        if (result.ExitCode == 0) return File.Exists(Path.Combine(outputDir, "manifest.json"));
        if (logFailures) AppendProcessLog(logWriter, $"  stream {stream} skipped: {FirstNonEmptyLine(result.Error, "no details")}");
        return false;
    }

    private async Task<CrossSaveProcessResult> RunCrossSaveProcessAsync(
        string fileName,
        IReadOnlyList<string> args,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        EnsureCompatibleExecutable(Path.GetFileName(fileName), fileName);
        using var process = new Process
        {
            StartInfo = CreateHiddenProcessStartInfo(fileName),
        };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        if (environment != null)
        {
            foreach (var item in environment) process.StartInfo.Environment[item.Key] = item.Value;
        }
        if (!process.Start()) throw new InvalidOperationException($"Could not start {Path.GetFileName(fileName)}.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        process.WaitForExit();
        return new CrossSaveProcessResult(process.ExitCode, await stdoutTask, await stderrTask);
    }

    private Dictionary<string, string> BuildCrossSaveToolEnvironment()
    {
        var env = BuildListenerEnvironment();
        env["CS_TSHARK_PATH"] = tsharkPath;
        var managedDir = GetConfiguredManagedDir();
        if (IsManagedDir(managedDir)) env["CS_COUNTERSIDE_MANAGED_DIR"] = managedDir;
        return env;
    }

    private void ValidateCrossSaveCaptureTool(string fileName, string toolName)
    {
        if (!File.Exists(fileName))
        {
            throw new FileNotFoundException($"{toolName} was not found. Install Wireshark with Npcap, or package runtime\\Wireshark with the launcher.", fileName);
        }
        EnsureCompatibleExecutable(toolName, fileName);
    }

    private List<string> GetCurrentCrossSaveCaptureFiles()
    {
        var captureDir = CrossSaveCaptureDir();
        if (!Directory.Exists(captureDir)) return new List<string>();
        var stamp = crossSaveCaptureStamp ?? FindLatestCrossSaveCaptureStamp();
        if (string.IsNullOrWhiteSpace(stamp)) return new List<string>();
        return Directory
            .EnumerateFiles(captureDir, $"counterside-all-*-{stamp}.pcapng")
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private string FindLatestCrossSaveCaptureStamp()
    {
        var captureDir = CrossSaveCaptureDir();
        if (!Directory.Exists(captureDir)) return "";
        var regex = new Regex(@"counterside-all-\d+-.+-(\d{8}-\d{6})\.pcapng$", RegexOptions.IgnoreCase);
        return Directory
            .EnumerateFiles(captureDir, "counterside-all-*.pcapng")
            .Select(path => new { Path = path, Match = regex.Match(Path.GetFileName(path)), LastWrite = File.GetLastWriteTimeUtc(path) })
            .Where(item => item.Match.Success)
            .OrderByDescending(item => item.LastWrite)
            .Select(item => item.Match.Groups[1].Value)
            .FirstOrDefault() ?? "";
    }

    private static bool ManifestHasJoinLobbyAck(string manifestPath)
    {
        if (!File.Exists(manifestPath)) return false;
        using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
        if (!document.RootElement.TryGetProperty("server", out var serverPackets) || serverPackets.ValueKind != JsonValueKind.Array) return false;
        return serverPackets.EnumerateArray().Any(entry => ReadJsonInt(entry, "packetId") == 205);
    }

    private async Task CopyCrossSaveExportToClipboardAsync(string filePath)
    {
        if (!File.Exists(filePath)) return;
        var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
        if (clipboard != null)
        {
            await clipboard.SetTextAsync(File.ReadAllText(filePath, Encoding.UTF8));
        }
    }

    private void RefreshCrossSaveSources()
    {
        try
        {
            EnsureRuntimeLayout();
            crossSaveSources = LoadCrossSaveSources();
            crossSaveSourceInput.ItemsSource = null;
            crossSaveSourceInput.ItemsSource = crossSaveSources;
            crossSaveSourceInput.SelectedIndex = crossSaveSources.Count > 0 ? 0 : -1;
            crossSaveStatusText.Text = crossSaveSources.Count == 1
                ? "1 official lobby packet found"
                : $"{crossSaveSources.Count:N0} official lobby packets found";
            if (crossSaveSources.Count == 0)
            {
                crossSaveDetailsText.Text = $"No JOIN_LOBBY_ACK packets were found in {CrossSaveCaptureDir()}.";
                crossSaveResultBox.Text = "";
            }
            else
            {
                AppendLog($"Cross Save sources refreshed: {crossSaveSources.Count:N0} official lobby packet(s).");
            }
        }
        catch (Exception ex)
        {
            crossSaveSources = new List<CrossSaveSource>();
            crossSaveSourceInput.ItemsSource = null;
            crossSaveStatusText.Text = "Cross Save sources unavailable";
            crossSaveDetailsText.Text = ex.Message;
            crossSaveResultBox.Text = "";
            AppendLog($"Cross Save refresh failed: {ex.Message}");
        }
        UpdateCrossSaveSourceDetails();
    }

    private List<CrossSaveSource> LoadCrossSaveSources()
    {
        return LoadCrossSaveSources(CrossSaveCaptureDir());
    }

    private List<CrossSaveSource> LoadCrossSaveSources(string captureDir)
    {
        captureDir = Path.GetFullPath(captureDir);
        var manifestPath = Path.Combine(captureDir, "manifest.json");
        if (!File.Exists(manifestPath)) return new List<CrossSaveSource>();

        using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
        if (!document.RootElement.TryGetProperty("server", out var serverPackets) || serverPackets.ValueKind != JsonValueKind.Array)
        {
            return new List<CrossSaveSource>();
        }

        var sources = new List<CrossSaveSource>();
        var index = 0;
        foreach (var entry in serverPackets.EnumerateArray())
        {
            index += 1;
            if (ReadJsonInt(entry, "packetId") != 205) continue;
            var payloadFile = ReadJsonString(entry, "payloadFile");
            if (string.IsNullOrWhiteSpace(payloadFile)) continue;
            var payloadPath = Path.GetFullPath(Path.Combine(captureDir, payloadFile));
            if (!IsPathInside(captureDir, payloadPath) || !File.Exists(payloadPath)) continue;
            var payloadSize = ReadJsonLong(entry, "payloadSize");
            if (payloadSize <= 0) payloadSize = new FileInfo(payloadPath).Length;
            sources.Add(new CrossSaveSource(
                Id: $"server:{index}",
                Index: index,
                PayloadFile: payloadFile,
                PayloadSizeBytes: payloadSize,
                Compressed: ReadJsonBool(entry, "compressed"),
                Stream: ReadJsonInt(entry, "stream"),
                Frame: ReadJsonInt(entry, "frame"),
                CaptureTimeSeconds: ReadJsonDouble(entry, "time"),
                Sha256: ReadJsonString(entry, "sha256")));
        }

        sources.Sort((left, right) => right.Index.CompareTo(left.Index));
        return sources;
    }

    private void UpdateCrossSaveSourceDetails()
    {
        var source = crossSaveSourceInput.SelectedItem as CrossSaveSource;
        importCrossSaveButton.IsEnabled = source != null;
        if (source == null)
        {
            if (crossSaveSources.Count > 0) crossSaveDetailsText.Text = "Select a JOIN_LOBBY_ACK source to import.";
            return;
        }
        crossSaveStatusText.Text = $"Selected {source.Id}";
        crossSaveDetailsText.Text =
            $"{source.PayloadFile} | {FormatBytes(source.PayloadSizeBytes)} | frame {source.Frame} | {FormatCaptureTime(source.CaptureTimeSeconds)} | {ShortHash(source.Sha256)}";
    }

    private async Task ImportCrossSaveProfileAsync()
    {
        SaveSettingsFromUi();
        EnsureRuntimeLayout();
        ValidateCrossSaveRuntimeLayout();
        if (crossSaveSources.Count == 0) RefreshCrossSaveSources();
        var source = crossSaveSourceInput.SelectedItem as CrossSaveSource ?? crossSaveSources.FirstOrDefault();
        if (source == null) throw new InvalidOperationException("No captured official JOIN_LOBBY_ACK source is available.");
        if (!IsManagedDir(GetConfiguredManagedDir()) && !await DetectManagedAssemblyAsync(showMessage: false))
        {
            throw new InvalidOperationException("Select CounterSide Data\\Managed\\Assembly-CSharp.dll before importing Cross Save.");
        }
        var gameplayAssets = await EnsureGameplayAssetCacheAsync(force: false);
        AppendLog($"Cross Save gameplay cache ready: {gameplayAssets.CachedLuaCount:N0} luac files.");
        var result = await RunCrossSaveImportProcessAsync(source, gameplayAssets, CrossSaveCaptureDir(), "");
        crossSaveResultBox.Text = result.PrettyJson;
        crossSaveStatusText.Text = $"Imported {result.Nickname}";
        crossSaveDetailsText.Text = $"Local UID {result.UserUid} | official UID {result.OfficialUserUid} | active {result.ActiveUserUid}";
        AppendLog($"Cross Save imported {result.Nickname} as local UID {result.UserUid}.");
        if (listenerProcess is { HasExited: false }) await ReloadRunningUserManagerAsync();
    }

    private async Task<CrossSaveImportResult> RunCrossSaveImportProcessAsync(CrossSaveSource source, GameplayAssetStatus gameplayAssets, string captureDir, string copyToPath)
    {
        using var logWriter = OpenProcessLog("cross-save-import", out var logPath);
        AppendLog($"Cross Save import started from {source.Id}.");
        AppendLog($"Cross Save log: {logPath}");
        var process = new Process
        {
            StartInfo = CreateCrossSaveImportStartInfo(source, gameplayAssets, captureDir, copyToPath),
        };
        foreach (var item in BuildListenerEnvironment()) process.StartInfo.Environment[item.Key] = item.Value;
        process.StartInfo.Environment["CS_COUNTERSIDE_MANAGED_DIR"] = gameplayAssets.ManagedDir;
        process.StartInfo.Environment["CS_GAMEPLAY_TABLES_DIR"] = gameplayAssets.CacheRoot;
        process.StartInfo.Environment["CS_TSHARK_PATH"] = tsharkPath;

        if (!process.Start()) throw new InvalidOperationException("Could not start Cross Save importer.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        process.WaitForExit();
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        WriteProcessOutput(logWriter, stderr);
        WriteProcessOutput(logWriter, stdout);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Cross Save import failed with exit code {process.ExitCode}. See {logPath}");
        }
        return ParseCrossSaveImportResult(stdout);
    }

    private ProcessStartInfo CreateCrossSaveImportStartInfo(CrossSaveSource source, GameplayAssetStatus gameplayAssets, string captureDir, string copyToPath)
    {
        var script = Path.Combine(appRoot, "tools", "import-official-join-lobby-profile.js");
        var usersPath = Path.Combine(appRoot, "server-data", "users.json");
        var startInfo = CreateHiddenProcessStartInfo(nodePath);
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("--capture-dir");
        startInfo.ArgumentList.Add(captureDir);
        startInfo.ArgumentList.Add("--user-db");
        startInfo.ArgumentList.Add(usersPath);
        if (!string.IsNullOrWhiteSpace(copyToPath))
        {
            startInfo.ArgumentList.Add("--copy-to");
            startInfo.ArgumentList.Add(copyToPath);
        }
        startInfo.ArgumentList.Add("--managed-dir");
        startInfo.ArgumentList.Add(gameplayAssets.ManagedDir);
        startInfo.ArgumentList.Add("--gameplay-tables-dir");
        startInfo.ArgumentList.Add(gameplayAssets.CacheRoot);
        startInfo.ArgumentList.Add("--source-id");
        startInfo.ArgumentList.Add(source.Id);
        if (crossSaveSwitchActiveInput.IsChecked == true) startInfo.ArgumentList.Add("--switch-active");
        if (crossSaveUpdateExistingInput.IsChecked == true) startInfo.ArgumentList.Add("--update-existing");
        if (crossSavePreserveUidInput.IsChecked == true) startInfo.ArgumentList.Add("--preserve-official-uid");
        if (crossSavePreserveFriendCodeInput.IsChecked == true) startInfo.ArgumentList.Add("--preserve-official-friend-code");
        var combatHost = ResolveCrossSaveCombatHostPath();
        if (!string.IsNullOrWhiteSpace(combatHost))
        {
            startInfo.ArgumentList.Add("--combat-host");
            startInfo.ArgumentList.Add(combatHost);
        }
        return startInfo;
    }

    private void ValidateCrossSaveRuntimeLayout()
    {
        RequireRuntimeFile(Path.Combine("tools", "extract-cs-pcap-fixtures.js"), "pcap extract helper");
        RequireRuntimeFile(Path.Combine("tools", "import-official-join-lobby-profile.js"), "official profile import helper");
        RequireRuntimeFile(Path.Combine("server", "userManager.js"), "user manager profile helper");
        RequireRuntimeDirectory(Path.Combine("modules", "official-profile-import"), "official profile import module");
        RequireRuntimeDirectory("combat-handler", "combat handler");
        if (!File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.exe")) && !File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.dll")) && !File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.csproj")))
        {
            throw new DirectoryNotFoundException($"combat-host was not found under {Path.Combine(appRoot, "combat-host")}");
        }
    }

    private string ResolveCrossSaveCombatHostPath()
    {
        var candidates = new[]
        {
            Path.Combine(appRoot, "combat-host", "CombatHost.exe"),
            Path.Combine(appRoot, "combat-host", "CombatHost.dll"),
        };
        return candidates.FirstOrDefault(File.Exists) ?? "";
    }

    private CrossSaveImportResult ParseCrossSaveImportResult(string stdout)
    {
        using var document = JsonDocument.Parse(ExtractJsonObject(stdout));
        var pretty = JsonSerializer.Serialize(document.RootElement, new JsonSerializerOptions { WriteIndented = true });
        var user = document.RootElement.TryGetProperty("user", out var userElement) ? userElement : default;
        return new CrossSaveImportResult(
            PrettyJson: pretty,
            UserUid: ReadJsonString(user, "userUid"),
            OfficialUserUid: ReadJsonString(user, "officialUserUid"),
            Nickname: ReadJsonString(user, "nickname") is { Length: > 0 } nickname ? nickname : "official profile",
            ActiveUserUid: ReadJsonString(document.RootElement, "activeUserUid"));
    }

    private static string ExtractJsonObject(string text)
    {
        var trimmed = (text ?? "").Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) throw new InvalidOperationException("Cross Save importer did not return JSON.");
        if (IsValidJsonObject(trimmed)) return trimmed;

        string? best = null;
        for (var start = 0; start < trimmed.Length; start++)
        {
            if (trimmed[start] != '{') continue;
            var end = FindJsonObjectEnd(trimmed, start);
            if (end <= start) continue;
            var candidate = trimmed[start..(end + 1)];
            if (IsValidJsonObject(candidate)) best = candidate;
        }

        return best ?? throw new InvalidOperationException("Cross Save importer did not return JSON.");
    }

    private static bool IsValidJsonObject(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static int FindJsonObjectEnd(string text, int start)
    {
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var index = start; index < text.Length; index++)
        {
            var ch = text[index];
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (inString)
            {
                if (ch == '\\') escaped = true;
                else if (ch == '"') inString = false;
                continue;
            }
            if (ch == '"')
            {
                inString = true;
                continue;
            }
            if (ch == '{')
            {
                depth += 1;
                continue;
            }
            if (ch != '}') continue;
            depth -= 1;
            if (depth == 0) return index;
        }
        return -1;
    }

    private async Task ReloadRunningUserManagerAsync()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            await client.PostAsync($"http://127.0.0.1:{settings.HttpPort}/user-manager/api/reload", new StringContent("{}", Encoding.UTF8, "application/json"));
            AppendLog("Running listener profile database reloaded.");
        }
        catch (Exception ex)
        {
            AppendLog($"Running listener reload skipped: {ex.Message}");
        }
    }

    private void WriteProcessOutput(StreamWriter writer, string text)
    {
        foreach (var line in (text ?? "").SplitLines())
        {
            WriteProcessLog(writer, line);
            AppendLog(line);
        }
    }

    private string CrossSaveCaptureDir()
    {
        var configured = (crossSaveCaptureDirBox.Text ?? settings.CrossSaveCaptureDir ?? "").Trim();
        if (string.IsNullOrWhiteSpace(configured) || IsLegacyCrossSaveSourceDir(configured)) return DefaultCrossSaveCaptureDir();
        var expanded = Environment.ExpandEnvironmentVariables(configured.Trim('"')).Replace('/', Path.DirectorySeparatorChar);
        return Path.GetFullPath(Path.IsPathFullyQualified(expanded) ? expanded : Path.Combine(appRoot, expanded));
    }

    private string DefaultCrossSaveCaptureDir() => Path.Combine(appRoot, "captures");

    private string CrossSaveExtractRootDir() => Path.Combine(appRoot, "server-data", "capture-extracts");

    private string CrossSaveExportsDir() => Path.Combine(appRoot, "exports");

    private bool IsLegacyCrossSaveSourceDir(string directory)
    {
        try
        {
            var fullPath = Path.GetFullPath(Path.IsPathFullyQualified(directory) ? directory : Path.Combine(appRoot, directory));
            return fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .EndsWith(Path.Combine("server-data", "captured-game-flow"), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private async Task EnsureClientPatchAsync(bool requireControlledRouting = false)
    {
        var managedDir = RequireConfiguredManagedDir();
        var frozenClient = IsFrozenManagedDir(managedDir);
        if (requireControlledRouting && !frozenClient)
        {
            throw new InvalidOperationException("The selected CounterSide client is not frozen. Use Freeze before starting RevivalSide.");
        }

        using var logWriter = OpenProcessLog("client-patch", out var logPath);
        AppendLog("Checking CounterSide client patch...");
        AppendLog($"Client patch log: {logPath}");

        try
        {
            await RunClientPatchProcessAsync(CreateClientPatchStartInfo(managedDir), managedDir, logWriter, "patch");
            if (frozenClient)
            {
                var statusStartInfo = CreateClientPatchStartInfo(managedDir);
                statusStartInfo.ArgumentList.Add("--status");
                var statusOutput = await RunClientPatchProcessAsync(statusStartInfo, managedDir, logWriter, "status audit");
                ValidateControlledClientPatchStatus(statusOutput);
                verifiedControlledManagedDir = Path.GetFullPath(managedDir);
                verifiedControlledServerInfoUrl = GetFrozenServerInfoUrl();
                UpdateClientRoutingStatus();
                AppendLog($"Controlled client routing verified: {verifiedControlledServerInfoUrl}");
            }
            AppendLog("CounterSide client patch ready.");
        }
        catch
        {
            verifiedControlledManagedDir = "";
            verifiedControlledServerInfoUrl = "";
            UpdateClientRoutingStatus(failed: frozenClient);
            throw;
        }
    }

    private async Task<string> RunClientPatchProcessAsync(
        ProcessStartInfo startInfo,
        string managedDir,
        StreamWriter logWriter,
        string action)
    {
        using var process = new Process { StartInfo = startInfo };
        foreach (var item in BuildListenerEnvironment()) process.StartInfo.Environment[item.Key] = item.Value;
        process.StartInfo.Environment["CS_COUNTERSIDE_MANAGED_DIR"] = managedDir;
        var outputLines = new List<string>();
        var outputLock = new object();
        void Capture(string? line)
        {
            if (line == null) return;
            lock (outputLock) outputLines.Add(line);
            AppendProcessLog(logWriter, line);
        }

        process.OutputDataReceived += (_, e) => Capture(e.Data);
        process.ErrorDataReceived += (_, e) => Capture(e.Data);
        if (!process.Start()) throw new InvalidOperationException($"Could not start CounterSide client patcher {action}.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        await process.WaitForExitAsync();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"CounterSide client patcher {action} failed with exit code {process.ExitCode}. Close CounterSide and retry. See the client patch log.");
        }
        lock (outputLock) return string.Join(Environment.NewLine, outputLines);
    }

    private static void ValidateControlledClientPatchStatus(string output)
    {
        var required = new[]
        {
            "mod-runtime-loader=True",
            "mod-string-loader=True",
            "mod-asset-bundle-loader=True",
            "mod-episode-ui=True",
            "friendly-pvp-ui-fix=True",
            "steam-local-login=True",
            "steam-standalone=True",
            "steam-runtime-isolated=True",
            "steam-interop-callsites=0",
            "frozen-official-update-bypass=True",
            "external-endpoint-references=0",
        };
        var missing = required.Where(value => !output.Contains(value, StringComparison.Ordinal)).ToArray();
        if (missing.Length == 0) return;
        throw new InvalidOperationException(
            "Frozen client routing verification failed. Missing status: " + string.Join(", ", missing));
    }

    private ProcessStartInfo CreateClientPatchStartInfo(string managedDir)
    {
        var packagedPatcher = Path.Combine(appRoot, "tools", "CounterPassClientPatcher", "CounterPassClientPatcher.exe");
        if (File.Exists(packagedPatcher))
        {
            var startInfo = CreateHiddenProcessStartInfo(packagedPatcher);
            AddClientPatchArguments(startInfo, managedDir);
            return startInfo;
        }

        var sourceProject = Path.Combine(appRoot, "tools", "CounterPassClientPatcher", "CounterPassClientPatcher.csproj");
        if (File.Exists(sourceProject))
        {
            var startInfo = CreateHiddenProcessStartInfo("dotnet");
            startInfo.ArgumentList.Add("run");
            startInfo.ArgumentList.Add("--project");
            startInfo.ArgumentList.Add(sourceProject);
            startInfo.ArgumentList.Add("--");
            AddClientPatchArguments(startInfo, managedDir);
            return startInfo;
        }

        throw new FileNotFoundException("CounterSide client patcher was not found.", packagedPatcher);
    }

    private void AddClientPatchArguments(ProcessStartInfo startInfo, string managedDir)
    {
        startInfo.ArgumentList.Add("--managed-dir");
        startInfo.ArgumentList.Add(managedDir);
        startInfo.ArgumentList.Add("--include-steam-local-login");
        if (!IsFrozenManagedDir(managedDir)) return;

        startInfo.ArgumentList.Add("--include-frozen-official-update-bypass");
        startInfo.ArgumentList.Add("--frozen-server-info-url");
        startInfo.ArgumentList.Add(GetFrozenServerInfoUrl());
    }

    private bool IsFrozenManagedDir(string managedDir)
    {
        if (!IsManagedDir(managedDir)) return false;
        var root = FindCounterSideRootDirFromManaged(managedDir);
        return !string.IsNullOrWhiteSpace(root) && IsFrozenClientRoot(root);
    }

    private string RequireControlledFrozenClient()
    {
        var managedDir = RequireConfiguredManagedDir();
        if (!IsFrozenManagedDir(managedDir))
        {
            throw new InvalidOperationException("Freeze the selected CounterSide installation before starting RevivalSide. Direct local routing is applied only to the frozen copy.");
        }
        return managedDir;
    }

    private string GetFrozenServerInfoUrl()
    {
        var httpPort = Convert.ToInt32(ClampPort(settings.HttpPort, 8088));
        return $"http://127.0.0.1:{httpPort.ToString(CultureInfo.InvariantCulture)}/server_config/live/ServerInfo_V2.json";
    }

    private ProcessStartInfo CreateHiddenProcessStartInfo(string fileName) => new()
    {
        FileName = fileName,
        WorkingDirectory = appRoot,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };

    private async Task SetServerTimeAsync()
    {
        if (!DateTime.TryParse(serverTimeInput.Text, out var serverTime))
        {
            throw new InvalidOperationException("Server time must look like yyyy-MM-dd HH:mm:ss.");
        }
        WriteManualServerTime(serverTime);
        if (listenerProcess is { HasExited: false }) await PostServerTimeAsync(serverTime);
        AppendLog($"Server time set to {serverTime:yyyy-MM-dd HH:mm:ss}.");
    }

    private async Task ClearServerTimeAsync()
    {
        var statePath = ServerTimeStatePath();
        Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
        File.WriteAllText(statePath, "{}\n", Encoding.UTF8);
        if (listenerProcess is { HasExited: false }) await PostClearServerTimeAsync();
        AppendLog("Manual server time cleared.");
    }

    private void WriteManualServerTime(DateTime serverTime)
    {
        var now = DateTime.Now;
        var serverUtc = serverTime.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(serverTime, DateTimeKind.Local).ToUniversalTime() : serverTime.ToUniversalTime();
        var localUtc = now.ToUniversalTime();
        var state = new Dictionary<string, object?>
        {
            ["version"] = 1,
            ["eventDateKey"] = serverUtc.ToString("yyyy-MM-dd"),
            ["anchorServerDateKey"] = serverUtc.ToString("yyyy-MM-dd"),
            ["anchorLocalDayKey"] = now.ToString("yyyy-MM-dd"),
            ["lastLocalDayKey"] = now.ToString("yyyy-MM-dd"),
            ["lastServerDateKey"] = serverUtc.ToString("yyyy-MM-dd"),
            ["manualServerIso"] = serverUtc.ToString("O"),
            ["manualLocalIso"] = localUtc.ToString("O"),
            ["manualSetAt"] = DateTime.UtcNow.ToString("O"),
            ["updatedAt"] = DateTime.UtcNow.ToString("O"),
        };
        var statePath = ServerTimeStatePath();
        Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
        File.WriteAllText(statePath, JsonSerializer.Serialize(state, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine, Encoding.UTF8);
    }

    private async Task PostServerTimeAsync(DateTime serverTime)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var body = JsonSerializer.Serialize(new { iso = serverTime.ToUniversalTime().ToString("O") });
        await client.PostAsync($"http://127.0.0.1:{settings.HttpPort}/launcher/api/server-time", new StringContent(body, Encoding.UTF8, "application/json"));
    }

    private async Task PostClearServerTimeAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        await client.PostAsync($"http://127.0.0.1:{settings.HttpPort}/launcher/api/server-time/clear", new StringContent("{}", Encoding.UTF8, "application/json"));
    }

    private Dictionary<string, string> BuildListenerEnvironment()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        PrependPath(env, Path.GetDirectoryName(npmPath));
        PrependPath(env, Path.GetDirectoryName(nodePath));
        var bundledPython = ResolveBundledPythonPath();
        if (!string.IsNullOrWhiteSpace(bundledPython))
        {
            env["CS_PYTHON_PATH"] = bundledPython;
            PrependPath(env, Path.GetDirectoryName(bundledPython));
        }

        env["CS_PORT"] = settings.GamePort.ToString(CultureInfo.InvariantCulture);
        env["CS_HTTP_MIRROR_PORT"] = settings.HttpPort.ToString(CultureInfo.InvariantCulture);
        env["CS_EVENT_DATE"] = settings.EventDate.Trim();
        if (!string.IsNullOrWhiteSpace(settings.EventDate)) env["CS_EVENT_MANAGER"] = "auto";
        env["CS_USE_LOCAL_JOIN_LOBBY_ACK"] = NormalizeJoinLobbyMode(settings.JoinLobbyAckMode);
        env["CS_USER_MANAGER_ALLOW_REMOTE"] = settings.UserManagerAllowRemote ? "1" : "0";
        env["CS_VERBOSE_CAPTURE"] = settings.VerboseCapture ? "1" : "0";
        env["CS_REPLAY_CAPTURED_GAME_FLOW"] = settings.ReplayCapturedGameFlow ? "1" : "0";
        env["CS_SKIP_TUTORIAL_TO_WIN"] = settings.SkipTutorialToWin ? "1" : "0";
        env["CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN"] = settings.ResetTutorialOnLogin ? "1" : "0";

        var packagedCombatHost = Path.Combine(appRoot, "combat-host", "CombatHost.exe");
        var sourceCombatProject = Path.Combine(appRoot, "combat-host", "CombatHost.csproj");
        if (File.Exists(packagedCombatHost) && !File.Exists(sourceCombatProject))
        {
            env["CS_CSHARP_COMBAT_HOST_DLL"] = packagedCombatHost;
            env["CS_COMBAT_HOST_PATH"] = packagedCombatHost;
        }
        ApplyAdvancedEnvironment(env, settings.AdvancedEnvText);
        ApplyAuthoritativeManagedEnvironment(env);
        env["CS_REQUIRE_FROZEN_CLIENT_PATCH"] = "1";
        if (IsManagedDir(GetConfiguredManagedDir()))
        {
            env["CS_GAMEPLAY_TABLES_DIR"] = GameplayLuaCacheDir();
        }
        return env;
    }

    private ListenCommand CreateListenCommand()
    {
        if (!File.Exists(npmPath))
        {
            throw new FileNotFoundException("npm.cmd was not found. The launcher must run the same command as the CLI listener: npm run listen.", npmPath);
        }
        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/d /s /c \"\"{npmPath}\" run listen\"",
            WorkingDirectory = appRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        return new ListenCommand(startInfo, "npm run listen");
    }

    private static void PrependPath(Dictionary<string, string> env, string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return;
        var pathKey = OperatingSystem.IsWindows() ? "Path" : "PATH";
        var current = env.TryGetValue(pathKey, out var existing)
            ? existing
            : Environment.GetEnvironmentVariable(pathKey) ?? Environment.GetEnvironmentVariable("PATH") ?? "";
        var prefix = directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var alreadyPresent = current
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(item => item.Trim('"').TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Equals(prefix, StringComparison.OrdinalIgnoreCase));
        if (alreadyPresent) return;
        env[pathKey] = string.IsNullOrWhiteSpace(current) ? prefix : $"{prefix}{Path.PathSeparator}{current}";
    }

    private void EnsureRuntimeLayout()
    {
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data"));
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data", "captured-flows"));
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data", "captured-tcp"));
        Directory.CreateDirectory(Path.Combine(appRoot, "server-data", "captured-game-flow"));
        Directory.CreateDirectory(CrossSaveCaptureDir());
        Directory.CreateDirectory(CrossSaveExtractRootDir());
        Directory.CreateDirectory(CrossSaveExportsDir());
        Directory.CreateDirectory(LogsDir());
        var usersPath = Path.Combine(appRoot, "server-data", "users.json");
        if (!File.Exists(usersPath))
        {
            var starterPath = Path.Combine(appRoot, "server-data", "starter-users.json");
            if (File.Exists(starterPath))
            {
                File.Copy(starterPath, usersPath, overwrite: false);
                AppendLog("Starter profile seed installed.");
            }
            else
            {
                File.WriteAllText(usersPath, "{\n  \"schemaVersion\": 1,\n  \"nextUserUid\": \"1000000001\",\n  \"nextFriendCode\": \"10000001\",\n  \"activeUserUid\": \"\",\n  \"users\": {}\n}\n", Encoding.UTF8);
            }
        }
    }

    private void ValidateListenerRuntimeLayout()
    {
        RequireRuntimeFile("cs-listener.js", "listener entry");
        RequireRuntimeFile("package.json", "npm package manifest");
        RequireRuntimeFile("packet-schema.json", "packet schema");
        RequireRuntimeFile(Path.Combine("tools", "ensure-gameplay-assets.js"), "gameplay asset cache helper");
        RequireRuntimeFile(Path.Combine("tools", "ensure-wiki-assets.js"), "wiki image asset cache helper");
        RequireRuntimeFile(Path.Combine("tools", "cs_asset_decrypt.py"), "CounterSide asset decrypt helper");
        RequireRuntimeFile(Path.Combine("tools", "cs_extract_decrypted_assets.py"), "CounterSide asset extract helper");
        RequireRuntimeFile(Path.Combine("server-data", "captured-flows", "manifest.json"), "HTTP captured mirror manifest");
        RequireRuntimeDirectory("server", "listener server");
        RequireRuntimeDirectory("packet-handlers", "packet handlers");
        RequireRuntimeDirectory("modules", "listener modules");
        RequireRuntimeDirectory("combat-handler", "combat handler");
        if (!File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.exe")) && !File.Exists(Path.Combine(appRoot, "combat-host", "CombatHost.csproj")))
        {
            throw new DirectoryNotFoundException($"combat-host was not found under {Path.Combine(appRoot, "combat-host")}");
        }
        AppendLog("Runtime layout ready: mirror manifest, schema, handlers, modules, and combat host found.");
    }

    private void RequireRuntimeFile(string relativePath, string name)
    {
        var path = Path.Combine(appRoot, relativePath);
        if (!File.Exists(path)) throw new FileNotFoundException($"{name} was not found.", path);
    }

    private void RequireRuntimeDirectory(string relativePath, string name)
    {
        var path = Path.Combine(appRoot, relativePath);
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"{name} was not found: {path}");
    }

    private async Task VerifyGameplayAssetsAsync()
    {
        SaveSettingsFromUi();
        await EnsureAssetBuildDependenciesAsync();
        var status = await Task.Run(VerifyGameplayAssetsReady);
        AppendLog($"Gameplay assets verified: {status.Description}");
    }

    private async Task BuildGameplayAssetsAsync()
    {
        SaveSettingsFromUi();
        await EnsureAssetBuildDependenciesAsync();
        if (!IsManagedDir(GetConfiguredManagedDir()) && !await DetectManagedAssemblyAsync(showMessage: false))
        {
            throw new InvalidOperationException("Select CounterSide Data\\Managed\\Assembly-CSharp.dll before building the gameplay asset cache.");
        }
        var status = await EnsureGameplayAssetCacheAsync(force: true);
        AppendLog($"Gameplay asset cache rebuilt: {status.CachedLuaCount:N0} luac files at {status.CacheRoot}");
    }

    private void RefreshGameplayAssetStatus(bool log)
    {
        try
        {
            var status = VerifyGameplayAssetsReady();
            if (log) AppendLog($"Gameplay assets: {status.Description}");
        }
        catch (Exception ex)
        {
            SetGameplayAssetStatus("Needs CounterSide");
            if (log) AppendLog($"Gameplay assets not ready: {ex.Message}");
        }
    }

    private GameplayAssetStatus VerifyGameplayAssetsReady()
    {
        var managedDir = RequireConfiguredManagedDir();
        var scriptRoots = FindCounterSideScriptBundleRoots(managedDir);
        var scriptBundleCount = scriptRoots.Sum(CountScriptBundles);
        if (scriptBundleCount <= 0)
        {
            throw new DirectoryNotFoundException($"No encrypted ab_script bundles were found from {managedDir}.");
        }
        var cacheRoot = GameplayLuaCacheDir();
        var cachedLuaCount = CountLuaCacheFiles(cacheRoot);
        var cacheText = cachedLuaCount > 0 ? $"{cachedLuaCount:N0} luac" : "cache pending";
        var statusText = $"{scriptBundleCount:N0} bundles / {cacheText}";
        SetGameplayAssetStatus(statusText);
        return new GameplayAssetStatus(managedDir, scriptBundleCount, cacheRoot, cachedLuaCount, statusText);
    }

    private async Task<GameplayAssetStatus> EnsureGameplayAssetCacheAsync(bool force)
    {
        var status = VerifyGameplayAssetsReady();
        var script = Path.Combine(appRoot, "tools", "ensure-gameplay-assets.js");
        if (!File.Exists(script)) throw new FileNotFoundException("Gameplay asset cache helper was not found.", script);
        if (Path.IsPathFullyQualified(nodePath) && !File.Exists(nodePath)) throw new FileNotFoundException("node.exe was not found.", nodePath);

        var logWriter = OpenProcessLog("gameplay-assets", out var logPath);
        AppendLog(force ? "Rebuilding gameplay asset cache from installed encrypted assets..." : "Checking gameplay asset cache from installed encrypted assets...");
        AppendLog($"Gameplay asset log: {logPath}");
        SetGameplayAssetProgress("Checking installed gameplay assets...", 0, 1, indeterminate: true);
        Exception? lastError = null;
        var attemptForce = force;
        try
        {
            for (var attempt = 1; attempt <= 2; attempt++)
            {
                try
                {
                    await RunGameplayAssetCacheHelperAsync(script, status, attemptForce, logWriter);
                    lastError = null;
                    break;
                }
                catch (Exception ex) when (attempt == 1)
                {
                    lastError = ex;
                    AppendProcessLog(logWriter, $"Gameplay asset cache helper failed once: {ex.Message}");
                    if (!ClearGameplayAssetCacheForRetry(logWriter)) throw;
                    attemptForce = true;
                    SetGameplayAssetProgress("Rebuilding gameplay cache after stale cache cleanup...", 0, 1, indeterminate: true);
                    AppendProcessLog(logWriter, "Retrying gameplay asset cache helper after deleting stale cache.");
                }
            }
            if (lastError != null) throw lastError;
        }
        catch
        {
            SetGameplayAssetProgress("Gameplay cache failed. See logs.", 0, 1, indeterminate: false);
            throw;
        }
        finally
        {
            CloseProcessLog(logWriter);
        }
        var verified = VerifyGameplayAssetsReady();
        SetGameplayAssetProgress($"Gameplay cache ready: {verified.CachedLuaCount:N0} luac files", 1, 1, indeterminate: false);
        return verified;
    }

    private async Task RunGameplayAssetCacheHelperAsync(string script, GameplayAssetStatus status, bool force, StreamWriter logWriter)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                WorkingDirectory = appRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.ArgumentList.Add("--managed-dir");
        process.StartInfo.ArgumentList.Add(status.ManagedDir);
        process.StartInfo.ArgumentList.Add("--progress-json");
        if (force) process.StartInfo.ArgumentList.Add("--force");
        foreach (var item in BuildListenerEnvironment()) process.StartInfo.Environment[item.Key] = item.Value;
        process.OutputDataReceived += (_, e) => { if (e.Data != null) HandleGameplayAssetOutput(logWriter, e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) HandleGameplayAssetOutput(logWriter, e.Data); };
        if (!process.Start()) throw new InvalidOperationException("Could not start gameplay asset cache helper.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        await process.WaitForExitAsync();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Gameplay asset cache helper failed with exit code {process.ExitCode}.");
        }
    }

    private async Task<WikiAssetStatus> EnsureWikiAssetCacheAsync(bool force)
    {
        var managedDir = RequireConfiguredManagedDir();
        var script = Path.Combine(appRoot, "tools", "ensure-wiki-assets.js");
        if (!File.Exists(script)) throw new FileNotFoundException("Wiki image asset cache helper was not found.", script);
        if (Path.IsPathFullyQualified(nodePath) && !File.Exists(nodePath)) throw new FileNotFoundException("node.exe was not found.", nodePath);

        var logWriter = OpenProcessLog("wiki-assets", out var logPath);
        AppendLog(force ? "Rebuilding wiki image cache from installed encrypted assets..." : "Checking wiki image cache from installed encrypted assets...");
        AppendLog($"Wiki image asset log: {logPath}");
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                WorkingDirectory = appRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.ArgumentList.Add("--managed-dir");
        process.StartInfo.ArgumentList.Add(managedDir);
        if (force) process.StartInfo.ArgumentList.Add("--force");
        foreach (var item in BuildListenerEnvironment()) process.StartInfo.Environment[item.Key] = item.Value;
        process.OutputDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendProcessLog(logWriter, e.Data); };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Could not start wiki image asset cache helper.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException($"Wiki image asset cache helper failed with exit code {process.ExitCode}. See {logPath}");
            }
        }
        finally
        {
            CloseProcessLog(logWriter);
        }
        return VerifyWikiAssetsReady();
    }

    private WikiAssetStatus VerifyWikiAssetsReady()
    {
        var cacheRoot = WikiAssetCacheDir();
        return new WikiAssetStatus(cacheRoot, CountPngFiles(cacheRoot));
    }

    private void SetGameplayAssetStatus(string text)
    {
        Dispatcher.UIThread.Post(() => gameplayDataStatusText.Text = text);
    }

    private bool ClearGameplayAssetCacheForRetry(StreamWriter writer)
    {
        try
        {
            var cacheRoot = GameplayLuaCacheDir();
            if (!IsPathUnderAppRoot(cacheRoot)) throw new InvalidOperationException($"Refusing to delete cache outside app root: {cacheRoot}");
            DeleteDirectoryIfExists(cacheRoot);

            var parent = Path.GetDirectoryName(cacheRoot) ?? "";
            var baseName = Path.GetFileName(cacheRoot);
            if (Directory.Exists(parent) && IsPathUnderAppRoot(parent))
            {
                foreach (var directory in Directory.EnumerateDirectories(parent, $".{baseName}.*", SearchOption.TopDirectoryOnly))
                {
                    if (IsPathUnderAppRoot(directory)) DeleteDirectoryIfExists(directory);
                }
            }
            AppendProcessLog(writer, $"Deleted stale gameplay asset cache: {cacheRoot}");
            return true;
        }
        catch (Exception ex)
        {
            AppendProcessLog(writer, $"Could not delete stale gameplay asset cache: {ex.Message}");
            return false;
        }
    }

    private void DeleteDirectoryIfExists(string directory)
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private bool IsPathUnderAppRoot(string path)
    {
        var root = Path.GetFullPath(appRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        return fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    private void HandleGameplayAssetOutput(StreamWriter writer, string text)
    {
        if (TryParseGameplayAssetProgress(text, out var progress))
        {
            WriteProcessLog(writer, text);
            SetGameplayAssetProgress(progress);
            return;
        }
        AppendProcessLog(writer, text);
    }

    private void SetGameplayAssetProgress(GameplayCacheProgress progress)
    {
        var current = Math.Max(0, progress.Current);
        var total = Math.Max(0, progress.Total);
        var message = string.IsNullOrWhiteSpace(progress.Message) ? "Building gameplay cache..." : progress.Message;
        var label = total > 1 ? $"{message} ({current:N0}/{total:N0})" : message;
        var value = total > 0 ? Math.Min(100, Math.Max(0, current * 100d / total)) : 0;
        SetGameplayAssetProgress(label, value, 100, indeterminate: total <= 0);
    }

    private void SetGameplayAssetProgress(string message, double current, double total, bool indeterminate)
    {
        var value = total > 0 ? Math.Min(100, Math.Max(0, current * 100d / total)) : 0;
        Dispatcher.UIThread.Post(() =>
        {
            ApplyGameplayAssetProgress(dashboardGameplayProgressPanel, dashboardGameplayProgressBar, dashboardGameplayProgressText, message, value, indeterminate);
            ApplyGameplayAssetProgress(settingsGameplayProgressPanel, settingsGameplayProgressBar, settingsGameplayProgressText, message, value, indeterminate);
        });
    }

    private static void ApplyGameplayAssetProgress(Border? panel, ProgressBar bar, TextBlock text, string message, double value, bool indeterminate)
    {
        if (panel != null) panel.IsVisible = true;
        text.Text = message;
        bar.IsIndeterminate = indeterminate;
        bar.Value = indeterminate ? 0 : value;
    }

    private static bool TryParseGameplayAssetProgress(string text, out GameplayCacheProgress progress)
    {
        const string Prefix = "[gameplay-assets:progress] ";
        progress = new GameplayCacheProgress("", 0, 0, "");
        if (!text.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        try
        {
            using var document = JsonDocument.Parse(text[Prefix.Length..]);
            var root = document.RootElement;
            progress = new GameplayCacheProgress(
                TryGetJsonString(root, "phase"),
                TryGetJsonInt(root, "current"),
                TryGetJsonInt(root, "total"),
                TryGetJsonString(root, "message"));
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string TryGetJsonString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() ?? "" : "";
    }

    private static int TryGetJsonInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var property)) return 0;
        return property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out var value) ? value : 0;
    }

    private string GameplayLuaCacheDir() => Path.Combine(appRoot, ".cache", "gameplay-luac");

    private string WikiAssetCacheDir() => Path.Combine(appRoot, ".cache", "wiki-assets", "all");

    private static IReadOnlyList<string> FindCounterSideScriptBundleRoots(string managedDir)
    {
        var dataDir = FindCounterSideDataDirFromManaged(managedDir);
        var streamingAssets = string.IsNullOrWhiteSpace(dataDir) ? "" : Path.Combine(dataDir, "StreamingAssets");
        var candidates = new[]
        {
            streamingAssets,
            string.IsNullOrWhiteSpace(streamingAssets) ? "" : Path.Combine(streamingAssets, "Assetbundles"),
            string.IsNullOrWhiteSpace(dataDir) ? "" : Path.Combine(dataDir, "Assetbundles"),
        };
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate) || !Directory.Exists(candidate) || CountScriptBundles(candidate) <= 0) continue;
            var full = Path.GetFullPath(candidate);
            if (seen.Add(full)) result.Add(full);
        }
        return result;
    }

    private static string FindCounterSideDataDirFromManaged(string managedDir)
    {
        var parent = Directory.GetParent(managedDir)?.FullName ?? "";
        if (Path.GetFileName(managedDir).Equals("Managed", StringComparison.OrdinalIgnoreCase)
            && Path.GetFileName(parent).Equals("Data", StringComparison.OrdinalIgnoreCase))
        {
            return parent;
        }
        var siblingData = string.IsNullOrWhiteSpace(parent) ? "" : Path.Combine(parent, "Data");
        if (!string.IsNullOrWhiteSpace(siblingData) && Directory.Exists(siblingData)) return siblingData;
        return parent;
    }

    private static string FindCounterSideRootDirFromManaged(string managedDir)
    {
        var dataDir = FindCounterSideDataDirFromManaged(managedDir);
        if (string.IsNullOrWhiteSpace(dataDir)) return "";
        if (Path.GetFileName(dataDir).Equals("Data", StringComparison.OrdinalIgnoreCase))
        {
            return Directory.GetParent(dataDir)?.FullName ?? "";
        }
        return dataDir;
    }

    private static int CountScriptBundles(string directory)
    {
        try
        {
            return Directory.EnumerateFiles(directory, "ab_script*", SearchOption.TopDirectoryOnly).Count();
        }
        catch
        {
            return 0;
        }
    }

    private static int CountLuaCacheFiles(string directory)
    {
        try
        {
            return Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*.luac", SearchOption.AllDirectories).Count() : 0;
        }
        catch
        {
            return 0;
        }
    }

    private static int CountPngFiles(string directory)
    {
        try
        {
            return Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*.png", SearchOption.AllDirectories).Count() : 0;
        }
        catch
        {
            return 0;
        }
    }

    private async Task BrowseManagedAssemblyAsync()
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null) return;
        var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Select CounterSide Assembly-CSharp.dll",
            AllowMultiple = false,
            FileTypeFilter = new[]
            {
                new FilePickerFileType("Assembly-CSharp.dll") { Patterns = new[] { "Assembly-CSharp.dll" } },
                new FilePickerFileType("DLL files") { Patterns = new[] { "*.dll" } },
            },
        });
        var file = files.FirstOrDefault()?.TryGetLocalPath();
        if (string.IsNullOrWhiteSpace(file)) return;
        var normalized = NormalizeManagedDir(file);
        if (!IsManagedDir(normalized))
        {
            await ShowMessageAsync("RevivalSide", "That file is not CounterSide Data\\Managed\\Assembly-CSharp.dll.");
            return;
        }
        settings.CounterSideManagedDir = normalized;
        managedDirBox.Text = normalized;
        SaveSettings();
        AppendLog($"CounterSide DLL selected: {normalized}");
        RefreshGameplayAssetStatus(log: true);
        _ = RefreshCutsceneBackgroundAsync(force: false);
    }

    private async Task<bool> DetectManagedAssemblyAsync(bool showMessage)
    {
        var detected = FindCounterSideManagedDir();
        if (IsManagedDir(detected))
        {
            settings.CounterSideManagedDir = detected;
            managedDirBox.Text = detected;
            SaveSettings();
            AppendLog($"CounterSide DLL detected: {detected}");
            RefreshGameplayAssetStatus(log: true);
            _ = RefreshCutsceneBackgroundAsync(force: false);
            return true;
        }
        if (showMessage)
        {
            await ShowMessageAsync("RevivalSide", "CounterSide Data\\Managed\\Assembly-CSharp.dll was not found automatically. Click Browse and select it from the installed game folder.");
        }
        return false;
    }

    private async Task FreezeClientAsync()
    {
        var managedDir = GetConfiguredManagedDir();
        if (!IsManagedDir(managedDir) && !await DetectManagedAssemblyAsync(showMessage: false))
        {
            throw new InvalidOperationException("Select or detect CounterSide Data\\Managed\\Assembly-CSharp.dll before freezing the client.");
        }

        managedDir = RequireConfiguredManagedDir();
        var sourceRoot = FindCounterSideRootDirFromManaged(managedDir);
        if (!IsCounterSideGameRoot(sourceRoot))
        {
            throw new InvalidOperationException($"CounterSide game root could not be resolved from {managedDir}.");
        }

        var archiveRoot = FrozenClientArchiveRoot();
        if (IsSamePathOrInside(archiveRoot, sourceRoot))
        {
            await ShowMessageAsync("RevivalSide", $"This client is already frozen:\n{sourceRoot}");
            return;
        }
        if (IsSamePathOrInside(sourceRoot, appRoot))
        {
            throw new InvalidOperationException($"Refusing to archive into a folder below the source game root: {sourceRoot}");
        }

        var targetRoot = Path.Combine(archiveRoot, $"CounterSide-{DateTime.Now:yyyyMMdd-HHmmss}");
        var confirmed = await ShowConfirmAsync(
            "Freeze CounterSide Client",
            $"Copy the current CounterSide install into RevivalSide's frozen archive and switch RevivalSide to that copy?\n\nSource:\n{sourceRoot}\n\nArchive:\n{targetRoot}\n\nSteam updates will not touch the archived copy.",
            "Freeze",
            "Cancel");
        if (!confirmed) return;

        AppendLog($"Freezing CounterSide client from {sourceRoot}");
        var lastProgressLog = DateTime.MinValue;
        var progress = new Progress<FrozenClientCopyProgress>(copyProgress =>
        {
            if ((DateTime.Now - lastProgressLog).TotalSeconds < 3 && copyProgress.FileCount % 500 != 0) return;
            lastProgressLog = DateTime.Now;
            AppendLog($"Freeze copy: {copyProgress.FileCount:N0} files, {FormatBytes(copyProgress.ByteCount)}");
        });

        var archive = await Task.Run(() => CopyFrozenClientArchive(sourceRoot, managedDir, targetRoot, progress));
        settings.CounterSideManagedDir = archive.ManagedDir;
        managedDirBox.Text = archive.ManagedDir;
        SaveSettings();
        AppendLog($"Frozen client selected: {archive.ManagedDir}");
        AppendLog($"Frozen Assembly-CSharp SHA256: {archive.AssemblySha256}");
        RefreshGameplayAssetStatus(log: true);
        _ = RefreshCutsceneBackgroundAsync(force: false);

        await EnsureClientPatchAsync(requireControlledRouting: true);
        var isolatedSteamFiles = IsolateFrozenSteamRuntime(archive.RootDir);
        var patchedAssemblySha256 = HashFile(Path.Combine(archive.ManagedDir, "Assembly-CSharp.dll"));
        UpdateFrozenClientPatchedManifest(archive.RootDir, patchedAssemblySha256, steamRuntimeIsolated: true);
        AppendLog($"Patched frozen Assembly-CSharp SHA256: {patchedAssemblySha256}");
        AppendLog($"Steam runtime isolated in frozen client: {isolatedSteamFiles} native files quarantined.");

        await ShowMessageAsync(
            "RevivalSide",
            $"Frozen client ready.\n\nArchive:\n{archive.RootDir}\n\nRevivalSide now patches and reads:\n{archive.ManagedDir}");
    }

    private FrozenClientArchive CopyFrozenClientArchive(
        string sourceRoot,
        string sourceManagedDir,
        string targetRoot,
        IProgress<FrozenClientCopyProgress>? progress)
    {
        sourceRoot = Path.GetFullPath(sourceRoot);
        sourceManagedDir = Path.GetFullPath(sourceManagedDir);
        targetRoot = Path.GetFullPath(targetRoot);
        if (!IsCounterSideGameRoot(sourceRoot)) throw new InvalidOperationException($"Source is not a CounterSide game root: {sourceRoot}");
        if (!IsSamePathOrInside(sourceRoot, sourceManagedDir)) throw new InvalidOperationException($"Managed directory is not inside the game root: {sourceManagedDir}");
        if (Directory.Exists(targetRoot)) throw new IOException($"Frozen client archive already exists: {targetRoot}");

        Directory.CreateDirectory(targetRoot);
        var fileCount = 0;
        var byteCount = 0L;
        foreach (var directory in Directory.EnumerateDirectories(sourceRoot, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(targetRoot, Path.GetRelativePath(sourceRoot, directory)));
        }

        foreach (var sourceFile in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(sourceRoot, sourceFile);
            var targetFile = Path.Combine(targetRoot, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(targetFile) ?? targetRoot);
            File.Copy(sourceFile, targetFile, overwrite: false);
            try { File.SetLastWriteTimeUtc(targetFile, File.GetLastWriteTimeUtc(sourceFile)); } catch { }
            fileCount++;
            byteCount += new FileInfo(targetFile).Length;
            if (fileCount % 100 == 0) progress?.Report(new FrozenClientCopyProgress(fileCount, byteCount));
        }

        var relativeManagedDir = Path.GetRelativePath(sourceRoot, sourceManagedDir);
        var targetManagedDir = Path.Combine(targetRoot, relativeManagedDir);
        if (!IsManagedDir(targetManagedDir))
        {
            throw new InvalidOperationException($"Frozen client copy is missing Assembly-CSharp.dll: {targetManagedDir}");
        }

        var assemblyPath = Path.Combine(targetManagedDir, "Assembly-CSharp.dll");
        var assemblySha256 = HashFile(assemblyPath);
        WriteFrozenClientLaunchFiles(targetRoot);
        var manifest = new FrozenClientManifest
        {
            ArchivedAtUtc = DateTime.UtcNow,
            SourceRoot = sourceRoot,
            RootDir = targetRoot,
            ManagedDir = targetManagedDir,
            FileCount = fileCount,
            ByteCount = byteCount,
            AssemblySha256 = assemblySha256,
        };
        File.WriteAllText(
            Path.Combine(targetRoot, "revivalside-frozen-client.json"),
            JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine,
            Encoding.UTF8);

        progress?.Report(new FrozenClientCopyProgress(fileCount, byteCount));
        return new FrozenClientArchive(targetRoot, targetManagedDir, fileCount, byteCount, assemblySha256);
    }

    private static void WriteFrozenClientLaunchFiles(string targetRoot)
    {
        var legacyAppId = Path.Combine(targetRoot, "steam_appid.txt");
        if (File.Exists(legacyAppId)) File.Delete(legacyAppId);
        File.WriteAllText(
            Path.Combine(targetRoot, "Launch Offline CounterSide.bat"),
            "@echo off\r\ncd /d \"%~dp0\"\r\nstart \"\" \"%~dp0CounterSide.exe\"\r\n",
            Encoding.ASCII);
    }

    private static int IsolateFrozenSteamRuntime(string frozenRoot)
    {
        frozenRoot = Path.GetFullPath(frozenRoot);
        var disabledRoot = Path.Combine(frozenRoot, "revivalside-disabled", "steam-runtime");
        var quarantined = 0;

        foreach (var appIdPath in Directory.EnumerateFiles(frozenRoot, "steam_appid.txt", SearchOption.AllDirectories).ToArray())
        {
            if (IsSamePathOrInside(disabledRoot, appIdPath)) continue;
            File.Delete(appIdPath);
        }

        foreach (var steamApiPath in Directory
            .EnumerateFiles(frozenRoot, "steam_api*.dll", SearchOption.AllDirectories)
            .Where(path => !IsSamePathOrInside(disabledRoot, path))
            .ToArray())
        {
            var relative = Path.GetRelativePath(frozenRoot, steamApiPath);
            var destination = Path.Combine(disabledRoot, relative + ".revivalside-disabled");
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Move(steamApiPath, destination, overwrite: true);
            quarantined++;
        }

        ValidateFrozenSteamRuntimeIsolation(frozenRoot);
        return quarantined;
    }

    private static void ValidateFrozenSteamRuntimeIsolation(string frozenRoot)
    {
        var disabledRoot = Path.Combine(frozenRoot, "revivalside-disabled", "steam-runtime");
        var activeAppIds = Directory
            .EnumerateFiles(frozenRoot, "steam_appid.txt", SearchOption.AllDirectories)
            .Where(path => !IsSamePathOrInside(disabledRoot, path))
            .ToArray();
        var activeSteamApis = Directory
            .EnumerateFiles(frozenRoot, "steam_api*.dll", SearchOption.AllDirectories)
            .Where(path => !IsSamePathOrInside(disabledRoot, path))
            .ToArray();
        if (activeAppIds.Length > 0 || activeSteamApis.Length > 0)
        {
            throw new InvalidOperationException("Frozen client Steam runtime isolation failed; active Steam bootstrap files remain.");
        }

        var executable = Path.Combine(frozenRoot, "CounterSide.exe");
        var executableText = Encoding.ASCII.GetString(File.ReadAllBytes(executable));
        var nativeSteamMarkers = new[] { "steam_api.dll", "steam_api64.dll", "SteamAPI_RestartAppIfNecessary", "steam://run/" };
        var marker = nativeSteamMarkers.FirstOrDefault(value => executableText.Contains(value, StringComparison.OrdinalIgnoreCase));
        if (marker != null)
        {
            throw new InvalidOperationException($"Frozen CounterSide.exe contains a native Steam bootstrap marker: {marker}");
        }
    }

    private async Task LaunchFrozenClientAsync(bool clientPatchAlreadyVerified = false)
    {
        if (listenerProcess is not { HasExited: false })
        {
            throw new InvalidOperationException("Start the RevivalSide listener before launching the frozen client.");
        }

        var frozenRoot = ResolveFrozenClientRoot();
        if (string.IsNullOrWhiteSpace(frozenRoot))
        {
            throw new InvalidOperationException("No frozen CounterSide archive was found. Use Freeze first.");
        }

        if (!IsFrozenClientRoot(frozenRoot))
        {
            throw new InvalidOperationException($"Refusing to launch a non-frozen CounterSide path: {frozenRoot}");
        }

        var executable = Path.Combine(frozenRoot, "CounterSide.exe");
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException("Frozen CounterSide.exe was not found.", executable);
        }

        WriteFrozenClientLaunchFiles(frozenRoot);
        var managedDir = Path.Combine(frozenRoot, "Data", "Managed");
        if (IsManagedDir(managedDir) && !managedDir.Equals(settings.CounterSideManagedDir, StringComparison.OrdinalIgnoreCase))
        {
            settings.CounterSideManagedDir = managedDir;
            managedDirBox.Text = managedDir;
            SaveSettings();
            RefreshGameplayAssetStatus(log: true);
        }

        if (!clientPatchAlreadyVerified)
        {
            await EnsureClientPatchAsync(requireControlledRouting: true);
        }
        else
        {
            var expectedManagedDir = Path.GetFullPath(managedDir);
            if (!expectedManagedDir.Equals(verifiedControlledManagedDir, StringComparison.OrdinalIgnoreCase)
                || !GetFrozenServerInfoUrl().Equals(verifiedControlledServerInfoUrl, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("The frozen client patch verification changed before launch. Stop and press Start again.");
            }
        }
        var isolatedSteamFiles = IsolateFrozenSteamRuntime(frozenRoot);
        var patchedAssemblySha256 = HashFile(Path.Combine(managedDir, "Assembly-CSharp.dll"));
        UpdateFrozenClientPatchedManifest(frozenRoot, patchedAssemblySha256, steamRuntimeIsolated: true);

        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = frozenRoot,
            UseShellExecute = false,
        };
        foreach (var key in new[] { "SteamAppId", "SteamGameId", "SteamClientLaunch", "SteamEnv", "SteamPath" })
        {
            startInfo.Environment.Remove(key);
        }
        var modRuntimeDir = Path.Combine(appRoot, "mods", ".runtime", "current");
        if (File.Exists(Path.Combine(modRuntimeDir, "mod-set.json")))
        {
            startInfo.Environment["CS_MOD_TABLES_DIR"] = modRuntimeDir;
            startInfo.Environment["CS_MOD_STRINGS_DIR"] = Path.Combine(modRuntimeDir, "Strings");
            startInfo.Environment["CS_MOD_ASSET_BUNDLES_DIR"] = Path.Combine(modRuntimeDir, "ClientAssetBundles");
        }
        else
        {
            startInfo.Environment.Remove("CS_MOD_TABLES_DIR");
            startInfo.Environment.Remove("CS_MOD_STRINGS_DIR");
            startInfo.Environment.Remove("CS_MOD_ASSET_BUNDLES_DIR");
        }
        Process.Start(startInfo);
        AppendLog($"Launched Steam-isolated frozen CounterSide: {executable} ({isolatedSteamFiles} native files newly quarantined)");
    }

    private string ResolveFrozenClientRoot()
    {
        var managedDir = GetConfiguredManagedDir();
        if (IsManagedDir(managedDir))
        {
            var selectedRoot = FindCounterSideRootDirFromManaged(managedDir);
            if (IsFrozenClientRoot(selectedRoot)) return selectedRoot;
        }

        var archiveRoot = FrozenClientArchiveRoot();
        if (!Directory.Exists(archiveRoot)) return "";
        try
        {
            foreach (var directory in Directory.EnumerateDirectories(archiveRoot)
                         .OrderByDescending(Directory.GetLastWriteTimeUtc))
            {
                if (IsFrozenClientRoot(directory)) return directory;
            }
        }
        catch
        {
            return "";
        }
        return "";
    }

    private bool IsFrozenClientRoot(string directory)
    {
        if (!IsCounterSideGameRoot(directory)) return false;
        if (!File.Exists(Path.Combine(directory, "CounterSide.exe"))) return false;
        return IsSamePathOrInside(FrozenClientArchiveRoot(), directory);
    }

    private static void UpdateFrozenClientPatchedManifest(string rootDir, string patchedAssemblySha256, bool steamRuntimeIsolated)
    {
        var manifestPath = Path.Combine(rootDir, "revivalside-frozen-client.json");
        var manifest = File.Exists(manifestPath)
            ? JsonSerializer.Deserialize<FrozenClientManifest>(File.ReadAllText(manifestPath)) ?? new FrozenClientManifest()
            : new FrozenClientManifest { RootDir = rootDir };
        manifest.PatchedAtUtc = DateTime.UtcNow;
        manifest.PatchedAssemblySha256 = patchedAssemblySha256;
        manifest.SteamRuntimeIsolated = steamRuntimeIsolated;
        File.WriteAllText(
            manifestPath,
            JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine,
            Encoding.UTF8);
    }

    private string FrozenClientArchiveRoot() => Path.Combine(appRoot, "frozen-client");

    private static bool IsCounterSideGameRoot(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory)) return false;
        return File.Exists(Path.Combine(directory, "Data", "Managed", "Assembly-CSharp.dll"));
    }

    private LauncherSettings LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath))
            {
                var fresh = new LauncherSettings();
                ApplyDotEnvDefaults(fresh);
                return fresh;
            }
            var loaded = JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(settingsPath)) ?? new LauncherSettings();
            if (loaded.SettingsVersion < LauncherSettings.CurrentVersion) loaded.SettingsVersion = LauncherSettings.CurrentVersion;
            ApplyDotEnvDefaults(loaded);
            loaded.JoinLobbyAckMode = NormalizeJoinLobbyMode(loaded.JoinLobbyAckMode);
            return loaded;
        }
        catch
        {
            var fallback = new LauncherSettings();
            ApplyDotEnvDefaults(fallback);
            return fallback;
        }
    }

    private void ApplyDotEnvDefaults(LauncherSettings target)
    {
        var values = ReadDotEnvFile(Path.Combine(appRoot, ".env"));
        if (values.Count == 0) return;
        if (TryReadPort(values, "CS_PORT", out var gamePort)) target.GamePort = gamePort;
        if (TryReadPort(values, "CS_HTTP_MIRROR_PORT", out var httpPort)) target.HttpPort = httpPort;
        if (values.TryGetValue("CS_EVENT_DATE", out var eventDate)) target.EventDate = eventDate.Trim();
        if (values.TryGetValue("CS_USE_LOCAL_JOIN_LOBBY_ACK", out var joinLobbyMode)) target.JoinLobbyAckMode = NormalizeJoinLobbyMode(joinLobbyMode);
        target.UserManagerAllowRemote = ReadEnvBool(values, "CS_USER_MANAGER_ALLOW_REMOTE", target.UserManagerAllowRemote);
        target.VerboseCapture = ReadEnvBool(values, "CS_VERBOSE_CAPTURE", target.VerboseCapture);
        target.ReplayCapturedGameFlow = ReadEnvBool(values, "CS_REPLAY_CAPTURED_GAME_FLOW", target.ReplayCapturedGameFlow);
        target.SkipTutorialToWin = ReadEnvBool(values, "CS_SKIP_TUTORIAL_TO_WIN", target.SkipTutorialToWin);
        target.ResetTutorialOnLogin = ReadEnvBool(values, "CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN", target.ResetTutorialOnLogin);
    }

    private static Dictionary<string, string> ReadDotEnvFile(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return values;
        foreach (var rawLine in File.ReadAllLines(path))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (line.StartsWith("export ", StringComparison.OrdinalIgnoreCase)) line = line[7..].TrimStart();
            var separator = line.IndexOf('=');
            if (separator <= 0) continue;
            var key = line[..separator].Trim();
            if (!Regex.IsMatch(key, "^[A-Za-z_][A-Za-z0-9_]*$")) continue;
            values[key] = UnquoteEnvValue(line[(separator + 1)..].Trim());
        }
        return values;
    }

    private static bool TryReadPort(IReadOnlyDictionary<string, string> values, string key, out int port)
    {
        port = 0;
        return values.TryGetValue(key, out var raw) && int.TryParse(raw, out port) && port >= 1 && port <= 65535;
    }

    private static bool ReadEnvBool(IReadOnlyDictionary<string, string> values, string key, bool fallback)
    {
        if (!values.TryGetValue(key, out var raw)) return fallback;
        return ParseEnvBool(raw, fallback);
    }

    private static bool ParseEnvBool(string raw, bool fallback)
    {
        var value = raw.Trim().ToLowerInvariant();
        return value switch
        {
            "1" or "true" or "on" or "yes" => true,
            "0" or "false" or "off" or "no" => false,
            _ => fallback,
        };
    }

    private static string NormalizeJoinLobbyMode(string? value)
    {
        var mode = (value ?? "auto").Trim().ToLowerInvariant();
        return mode switch
        {
            "1" or "true" or "on" or "local" => "on",
            "0" or "false" or "off" or "official" => "off",
            _ => "auto",
        };
    }

    private static void ApplyAdvancedEnvironment(Dictionary<string, string> env, string text)
    {
        foreach (var rawLine in (text ?? "").Replace("\r", "").Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (line.StartsWith("export ", StringComparison.OrdinalIgnoreCase)) line = line[7..].TrimStart();
            var separator = line.IndexOf('=');
            if (separator <= 0) throw new InvalidOperationException($"Invalid advanced env line: {rawLine}");
            var key = line[..separator].Trim();
            if (!Regex.IsMatch(key, "^[A-Za-z_][A-Za-z0-9_]*$")) throw new InvalidOperationException($"Invalid advanced env key: {key}");
            env[key] = UnquoteEnvValue(line[(separator + 1)..].Trim());
        }
    }

    private void ApplyAuthoritativeManagedEnvironment(Dictionary<string, string> env)
    {
        foreach (var key in ManagedPathEnvironmentKeys) env[key] = "";
        foreach (var key in GameplayTableOverrideEnvironmentKeys) env[key] = "";

        var managedDir = GetConfiguredManagedDir();
        if (!IsManagedDir(managedDir)) return;

        env["CS_COUNTERSIDE_MANAGED_DIR"] = managedDir;
        env["COUNTERSIDE_MANAGED_DIR"] = managedDir;

        var gameRoot = FindCounterSideRootDirFromManaged(managedDir);
        env["CS_COUNTERSIDE_DIR"] = string.IsNullOrWhiteSpace(gameRoot) ? managedDir : gameRoot;
    }

    private string GetConfiguredManagedDir()
    {
        var normalized = NormalizeManagedDir(settings.CounterSideManagedDir);
        if (!IsManagedDir(normalized)) return "";
        settings.CounterSideManagedDir = normalized;
        return normalized;
    }

    private string RequireConfiguredManagedDir()
    {
        var managedDir = GetConfiguredManagedDir();
        if (!IsManagedDir(managedDir))
        {
            throw new InvalidOperationException("CounterSide Data\\Managed\\Assembly-CSharp.dll is not selected.");
        }
        return Path.GetFullPath(managedDir);
    }

    private static string UnquoteEnvValue(string value)
    {
        if (value.Length >= 2 && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\''))) return value[1..^1];
        return value;
    }

    private void SaveSettings()
    {
        Directory.CreateDirectory(appRoot);
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine, Encoding.UTF8);
    }

    private string ResolveInitialManagedDir(string saved)
    {
        foreach (var candidate in new[]
        {
            saved,
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_DIR"),
            FindCounterSideManagedDir(),
        })
        {
            var normalized = NormalizeManagedDir(candidate);
            if (IsManagedDir(normalized)) return normalized;
        }
        return "";
    }

    private static bool IsManagedDir(string? directory) => !string.IsNullOrWhiteSpace(directory) && File.Exists(Path.Combine(directory, "Assembly-CSharp.dll"));

    private static string NormalizeManagedDir(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        try
        {
            var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim().Trim('"')).Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(full)) full = Path.GetFileName(full).Equals("Assembly-CSharp.dll", StringComparison.OrdinalIgnoreCase) ? Path.GetDirectoryName(full) ?? "" : Path.GetDirectoryName(full) ?? full;
            foreach (var candidate in new[] { full, Path.Combine(full, "Data", "Managed"), Path.Combine(full, "Managed") })
            {
                if (IsManagedDir(candidate)) return candidate;
            }
            return full;
        }
        catch
        {
            return "";
        }
    }

    private static string FindCounterSideManagedDir()
    {
        foreach (var candidate in FindCounterSideManagedDirCandidates())
        {
            var normalized = NormalizeManagedDir(candidate);
            if (IsManagedDir(normalized)) return normalized;
        }
        return "";
    }

    private static IEnumerable<string> FindCounterSideManagedDirCandidates()
    {
        foreach (var candidate in new[]
        {
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
            Environment.GetEnvironmentVariable("CS_COUNTERSIDE_DIR"),
            Path.Combine("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam", "steamapps", "common", "CounterSide"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam", "steamapps", "common", "CounterSide"),
        })
        {
            if (!string.IsNullOrWhiteSpace(candidate)) yield return candidate;
        }
        foreach (var library in FindSteamLibraryRoots())
        {
            var common = Path.Combine(library, "steamapps", "common");
            foreach (var known in new[] { "CounterSide", "CounterSide Global", "COUNTER SIDE" }) yield return Path.Combine(common, known);
            if (!Directory.Exists(common)) continue;
            IEnumerable<string> dirs;
            try
            {
                dirs = Directory.EnumerateDirectories(common).Where(dir => Path.GetFileName(dir).Replace(" ", "", StringComparison.OrdinalIgnoreCase).Contains("CounterSide", StringComparison.OrdinalIgnoreCase)).ToList();
            }
            catch
            {
                dirs = Array.Empty<string>();
            }
            foreach (var dir in dirs) yield return dir;
        }
    }

    private static IEnumerable<string> FindSteamLibraryRoots()
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var steamRoot in FindSteamInstallRoots())
        {
            AddDirectory(roots, steamRoot);
            var libraryFile = Path.Combine(steamRoot, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(libraryFile)) continue;
            string text;
            try { text = File.ReadAllText(libraryFile); } catch { continue; }
            foreach (Match match in Regex.Matches(text, "\"path\"\\s+\"([^\"]+)\"", RegexOptions.IgnoreCase)) AddDirectory(roots, UnescapeSteamPath(match.Groups[1].Value));
        }
        return roots;
    }

    private static IEnumerable<string> FindSteamInstallRoots()
    {
        foreach (var candidate in new[]
        {
            ReadRegistryString(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath"),
            ReadRegistryString(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
            ReadRegistryString(@"HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam", "InstallPath"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam"),
            @"C:\Steam", @"D:\Steam", @"E:\Steam",
        })
        {
            if (!string.IsNullOrWhiteSpace(candidate)) yield return UnescapeSteamPath(candidate);
        }
    }

    private static string ReadRegistryString(string keyName, string valueName)
    {
        if (!OperatingSystem.IsWindows()) return "";
        try { return Registry.GetValue(keyName, valueName, null) as string ?? ""; } catch { return ""; }
    }

    private static void AddDirectory(HashSet<string> roots, string value)
    {
        try
        {
            var full = Path.GetFullPath(UnescapeSteamPath(value));
            if (Directory.Exists(full)) roots.Add(full);
        }
        catch { }
    }

    private static string UnescapeSteamPath(string value) => Environment.ExpandEnvironmentVariables(StringValue(value).Trim().Trim('"')).Replace("\\\\", "\\").Replace('/', Path.DirectorySeparatorChar);

    private void UpdateButtons()
    {
        var listenerRunning = listenerProcess is { HasExited: false };
        var crossSaveCaptureRunning = crossSaveCaptureProcesses.Count > 0;
        if (!startFlowBusy)
        {
            startListenerButton.Content = StartButtonDefaultText;
            startListenerButton.IsEnabled = !listenerRunning;
        }
        browseCrossSaveCaptureButton.IsEnabled = !crossSaveCaptureRunning;
        refreshCrossSaveButton.IsEnabled = crossSaveCaptureRunning;
        importCrossSaveButton.IsEnabled = !crossSaveCaptureRunning;
        stopListenerButton.IsEnabled = listenerRunning;
        freezeClientButton.IsEnabled = !listenerRunning && !crossSaveCaptureRunning;
        launchFrozenClientButton.IsEnabled = !startFlowBusy && listenerRunning && !string.IsNullOrWhiteSpace(ResolveFrozenClientRoot());
        UpdateClientRoutingStatus();
        UpdateTrayTooltip();
    }

    private void UpdateClientRoutingStatus(bool failed = false)
    {
        var managedDir = GetConfiguredManagedDir();
        if (!IsFrozenManagedDir(managedDir))
        {
            clientRoutingStatusText.Text = "Freeze required. RevivalSide will not redirect the Steam-managed client.";
            clientRoutingStatusText.Foreground = Brush(255, 202, 87);
            return;
        }

        var normalizedManagedDir = Path.GetFullPath(managedDir);
        var expectedUrl = GetFrozenServerInfoUrl();
        if (failed)
        {
            clientRoutingStatusText.Text = "Routing verification failed. The frozen client will not be launched.";
            clientRoutingStatusText.Foreground = Brush(255, 112, 112);
            return;
        }
        if (normalizedManagedDir.Equals(verifiedControlledManagedDir, StringComparison.OrdinalIgnoreCase)
            && expectedUrl.Equals(verifiedControlledServerInfoUrl, StringComparison.Ordinal))
        {
            clientRoutingStatusText.Text = $"Verified offline: Steam isolated and all client HTTP endpoints route to {expectedUrl}";
            clientRoutingStatusText.Foreground = Brush(112, 232, 167);
            return;
        }

        clientRoutingStatusText.Text = "Frozen client selected. START will isolate Steam, freeze updates, and verify every HTTP endpoint.";
        clientRoutingStatusText.Foreground = Brush(190, 202, 220);
    }

    private string ServerTimeStatePath() => Path.Combine(appRoot, "server-data", "server-time.json");

    private static decimal ClampPort(int value, int fallback) => Math.Clamp(value <= 0 ? fallback : value, 1, 65535);

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    private async Task RefreshCutsceneBackgroundAsync(bool force)
    {
        var managedDir = GetConfiguredManagedDir();
        if (!IsManagedDir(managedDir)) return;
        var script = Path.Combine(appRoot, "tools", "ensure-cutscene-backgrounds.js");
        if (!File.Exists(script)) return;
        lock (cutsceneBackgroundLock)
        {
            if (cutsceneBackgroundRefreshRunning) return;
            cutsceneBackgroundRefreshRunning = true;
        }

        StreamWriter? logWriter = null;
        try
        {
            logWriter = OpenProcessLog("cutscene-assets", out var logPath);
            AppendLog("Checking launcher cutscene background cache from installed encrypted assets...");
            AppendLog($"Cutscene asset log: {logPath}");
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = nodePath,
                    WorkingDirectory = appRoot,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
            };
            process.StartInfo.ArgumentList.Add(script);
            process.StartInfo.ArgumentList.Add("--managed-dir");
            process.StartInfo.ArgumentList.Add(managedDir);
            process.StartInfo.ArgumentList.Add("--max-bundles");
            process.StartInfo.ArgumentList.Add("24");
            if (force) process.StartInfo.ArgumentList.Add("--force");
            foreach (var item in BuildListenerEnvironment()) process.StartInfo.Environment[item.Key] = item.Value;
            process.OutputDataReceived += (_, e) => { if (e.Data != null && logWriter != null) AppendProcessLog(logWriter, e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data != null && logWriter != null) AppendProcessLog(logWriter, e.Data); };
            if (!process.Start()) return;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                AppendLog($"Cutscene background cache skipped: helper exited {process.ExitCode}.");
                return;
            }
            var loaded = LoadRandomCutsceneBackgroundFromCache();
            if (loaded.Image != null)
            {
                Dispatcher.UIThread.Post(() => SetLauncherBackground(loaded.Image, loaded.Name));
            }
        }
        catch (Exception ex)
        {
            AppendLog($"Cutscene background cache skipped: {ex.Message}");
        }
        finally
        {
            if (logWriter != null) CloseProcessLog(logWriter);
            lock (cutsceneBackgroundLock) cutsceneBackgroundRefreshRunning = false;
        }
    }

    private void SetLauncherBackground(Bitmap image, string name)
    {
        var old = launcherBackground;
        launcherBackground = image;
        launcherBackgroundName = name;
        if (launcherBackgroundView != null)
        {
            launcherBackgroundView.Source = image;
            launcherBackgroundView.IsVisible = true;
        }
        if (launcherBackgroundFallback != null) launcherBackgroundFallback.IsVisible = false;
        if (launcherBackgroundText != null) launcherBackgroundText.Text = DescribeLauncherBackground();
        old?.Dispose();
    }

    private (Bitmap? Image, string Name) LoadRandomCutsceneBackgroundFromCache()
    {
        try
        {
            var cacheDir = CutsceneBackgroundCacheDir();
            if (!Directory.Exists(cacheDir)) return (null, "");
            var files = Directory.EnumerateFiles(cacheDir, "*.png", SearchOption.TopDirectoryOnly)
                .Where(file => File.Exists(file) && new FileInfo(file).Length > 100_000)
                .Take(2000)
                .ToArray();
            if (files.Length == 0) return (null, "");
            var selected = files[Random.Shared.Next(files.Length)];
            using var stream = File.OpenRead(selected);
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            memory.Position = 0;
            return (new Bitmap(memory), Path.GetFileNameWithoutExtension(selected));
        }
        catch
        {
            return (null, "");
        }
    }

    private string DescribeLauncherBackground() =>
        string.IsNullOrWhiteSpace(launcherBackgroundName)
            ? "Story background: encrypted CounterSide assets"
            : $"Story background: {launcherBackgroundName}";

    private string CutsceneBackgroundCacheDir() => Path.Combine(appRoot, ".cache", "cutscene-bg-16x9", "backgrounds");

    private static string ResolveAppRoot()
    {
        foreach (var seed in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var packagedRoot = ResolvePackagedPayloadAppRoot(seed);
            if (!string.IsNullOrWhiteSpace(packagedRoot)) return packagedRoot;

            var directory = new DirectoryInfo(seed);
            while (directory != null)
            {
                if (IsAppRoot(directory.FullName)) return directory.FullName;
                directory = directory.Parent;
            }
        }
        return AppContext.BaseDirectory;
    }

    private static string ResolvePackagedPayloadAppRoot(string seed)
    {
        var directory = new DirectoryInfo(seed);
        while (directory != null)
        {
            DirectoryInfo? payloadDirectory = null;
            if (directory.Name.Equals("runtime-apps", StringComparison.OrdinalIgnoreCase))
            {
                payloadDirectory = directory.Parent;
            }
            else if (directory.Parent?.Name.Equals("runtime-apps", StringComparison.OrdinalIgnoreCase) == true)
            {
                payloadDirectory = directory.Parent.Parent;
            }
            if (payloadDirectory != null)
            {
                var appRoot = Path.Combine(payloadDirectory.FullName, "app");
                if (IsAppRoot(appRoot)) return appRoot;
            }
            directory = directory.Parent;
        }
        return "";
    }

    private static bool IsAppRoot(string directory)
    {
        return File.Exists(Path.Combine(directory, "cs-listener.js")) && File.Exists(Path.Combine(directory, "package.json"));
    }

    private void RefreshToolPaths()
    {
        var rid = GetWindowsRid();
        nodePath = ResolveToolPath("node.exe", Path.Combine("runtime", "node", "node.exe"), Path.Combine("runtime-node", rid, "node.exe"));
        npmPath = ResolveToolPath("npm.cmd", Path.Combine("runtime", "node", "npm.cmd"), Path.Combine("runtime-node", rid, "npm.cmd"));
        dumpcapPath = ResolveToolPath(
            "dumpcap.exe",
            Path.Combine("runtime", "Wireshark", "dumpcap.exe"),
            Path.Combine("runtime", "wireshark", "dumpcap.exe"),
            Path.Combine("runtime-wireshark", rid, "dumpcap.exe"),
            Path.Combine("wireshark", rid, "dumpcap.exe"),
            Path.Combine("Wireshark", "dumpcap.exe"));
        tsharkPath = ResolveToolPath(
            "tshark.exe",
            Path.Combine("runtime", "Wireshark", "tshark.exe"),
            Path.Combine("runtime", "wireshark", "tshark.exe"),
            Path.Combine("runtime-wireshark", rid, "tshark.exe"),
            Path.Combine("wireshark", rid, "tshark.exe"),
            Path.Combine("Wireshark", "tshark.exe"));
    }

    private static string ResolveToolPath(string toolName, params string[] bundledRelativePaths)
    {
        var searchRoots = EnumerateToolSearchRoots().Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        foreach (var relativePath in bundledRelativePaths)
        {
            foreach (var root in searchRoots)
            {
                var candidate = Path.Combine(root, relativePath);
                if (File.Exists(candidate)) return candidate;
            }
        }
        var pathTool = ResolveToolFromPath(toolName);
        if (!string.IsNullOrWhiteSpace(pathTool)) return pathTool;
        if (toolName.Equals("node.exe", StringComparison.OrdinalIgnoreCase) || toolName.Equals("npm.cmd", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var baseDir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
            {
                if (string.IsNullOrWhiteSpace(baseDir)) continue;
                var nodePath = Path.Combine(baseDir, "nodejs", toolName);
                if (File.Exists(nodePath)) return nodePath;
            }
        }
        if (toolName.Equals("dumpcap.exe", StringComparison.OrdinalIgnoreCase) || toolName.Equals("tshark.exe", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var baseDir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
            {
                if (string.IsNullOrWhiteSpace(baseDir)) continue;
                var wiresharkPath = Path.Combine(baseDir, "Wireshark", toolName);
                if (File.Exists(wiresharkPath)) return wiresharkPath;
            }
        }
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

    private static IEnumerable<string> EnumerateToolSearchRoots()
    {
        foreach (var root in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory, ResolveAppRoot() })
        {
            if (!string.IsNullOrWhiteSpace(root)) yield return root;
            var payloadRoot = ResolvePackagedPayloadRoot(root);
            if (!string.IsNullOrWhiteSpace(payloadRoot)) yield return payloadRoot;
        }
        var installedRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSide");
        if (Directory.Exists(installedRoot)) yield return installedRoot;
        foreach (var payloadRoot in EnumerateCachedPayloadRoots()) yield return payloadRoot;
    }

    private static IEnumerable<string> EnumerateCachedPayloadRoots()
    {
        var cacheRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSideSetup", "payload-cache");
        if (!Directory.Exists(cacheRoot)) yield break;
        IEnumerable<string> cacheDirectories;
        try
        {
            cacheDirectories = Directory.EnumerateDirectories(cacheRoot)
                .OrderByDescending(path => Directory.GetLastWriteTimeUtc(path))
                .ToArray();
        }
        catch
        {
            yield break;
        }

        foreach (var cacheDirectory in cacheDirectories)
        {
            var payloadRoot = Path.Combine(cacheDirectory, "extract", "payload");
            if (Directory.Exists(payloadRoot)) yield return payloadRoot;
        }
    }

    private static string ResolvePackagedPayloadRoot(string seed)
    {
        var directory = new DirectoryInfo(seed);
        while (directory != null)
        {
            if (directory.Name.Equals("payload", StringComparison.OrdinalIgnoreCase) &&
                IsAppRoot(Path.Combine(directory.FullName, "app")))
            {
                return directory.FullName;
            }
            if (directory.Name.Equals("runtime-apps", StringComparison.OrdinalIgnoreCase))
            {
                return directory.Parent?.FullName ?? "";
            }
            if (directory.Parent?.Name.Equals("runtime-apps", StringComparison.OrdinalIgnoreCase) == true)
            {
                return directory.Parent.Parent?.FullName ?? "";
            }
            if (IsAppRoot(directory.FullName) && directory.Parent?.Name.Equals("payload", StringComparison.OrdinalIgnoreCase) == true)
            {
                return directory.Parent.FullName;
            }
            directory = directory.Parent;
        }
        return "";
    }

    private static string ResolveToolFromPath(string toolName)
    {
        if (Path.IsPathFullyQualified(toolName) && File.Exists(toolName)) return toolName;
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

    private string ResolveBundledPythonPath()
    {
        foreach (var path in EnumerateBundledPythonPaths())
        {
            if (File.Exists(path)) return path;
        }
        var configured = Environment.GetEnvironmentVariable("CS_PYTHON_PATH") ?? Environment.GetEnvironmentVariable("PYTHON") ?? "";
        foreach (var path in configured.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (File.Exists(path)) return path;
        }
        var py = ResolveToolFromPath("py.exe");
        if (!string.IsNullOrWhiteSpace(py)) return py;
        foreach (var tool in new[] { "python.exe", "python3.exe" })
        {
            var resolved = ResolveToolFromPath(tool);
            if (!string.IsNullOrWhiteSpace(resolved)) return resolved;
        }
        foreach (var path in EnumerateCommonPythonInstallPaths())
        {
            if (File.Exists(path)) return path;
        }
        return "";
    }

    private static string DescribeExecutable(string fileName)
    {
        try { return File.Exists(fileName) ? $"{fileName} ({ReadPortableExecutableMachine(fileName)})" : fileName; }
        catch { return fileName; }
    }

    private static void EnsureCompatibleExecutable(string toolName, string fileName)
    {
        if (!OperatingSystem.IsWindows() || !toolName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return;
        if (!File.Exists(fileName) || !Path.IsPathFullyQualified(fileName)) return;
        var machine = ReadPortableExecutableMachine(fileName);
        var arch = RuntimeInformation.ProcessArchitecture;
        var compatible = machine switch
        {
            "x64" => arch is Architecture.X64 or Architecture.Arm64,
            "x86" => true,
            "arm64" => arch == Architecture.Arm64,
            _ => true,
        };
        if (!compatible) throw new InvalidOperationException($"{Path.GetFileName(fileName)} is {machine}, but this launcher is running as {arch}: {fileName}");
    }

    private static string ReadPortableExecutableMachine(string fileName)
    {
        using var stream = File.OpenRead(fileName);
        Span<byte> header = stackalloc byte[64];
        if (stream.Read(header) < 64 || header[0] != 'M' || header[1] != 'Z') return "unknown";
        stream.Position = BitConverter.ToInt32(header.Slice(0x3C, 4));
        Span<byte> pe = stackalloc byte[6];
        if (stream.Read(pe) < 6) return "unknown";
        var machine = BitConverter.ToUInt16(pe.Slice(4, 2));
        return machine switch
        {
            0x014c => "x86",
            0x8664 => "x64",
            0xaa64 => "arm64",
            _ => $"0x{machine:x}",
        };
    }

    private StreamWriter OpenProcessLog(string prefix, out string logPath)
    {
        Directory.CreateDirectory(LogsDir());
        logPath = Path.Combine(LogsDir(), $"{prefix}-{DateTime.Now:yyyyMMdd-HHmmss}.log");
        var writer = new StreamWriter(File.Open(logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8)
        {
            AutoFlush = true,
        };
        writer.WriteLine($"# Started {DateTime.Now:O}");
        return writer;
    }

    private void AppendProcessLog(StreamWriter writer, string text)
    {
        WriteProcessLog(writer, text);
        AppendLog(text);
    }

    private void WriteProcessLog(StreamWriter writer, string text)
    {
        lock (processLogLock)
        {
            try { writer.WriteLine($"[{DateTime.Now:O}] {text}"); } catch { }
        }
    }

    private void CloseProcessLog(StreamWriter writer)
    {
        lock (processLogLock)
        {
            try { writer.Dispose(); } catch { }
        }
    }

    private void OpenLogsDirectory()
    {
        Directory.CreateDirectory(LogsDir());
        Process.Start(new ProcessStartInfo { FileName = LogsDir(), UseShellExecute = true });
    }

    private string LogsDir() => Path.Combine(appRoot, "logs");

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
        var ok = new Button { Content = "OK", MinWidth = 96, Height = 38, HorizontalAlignment = HorizontalAlignment.Right };
        StyleButton(ok, primary: true);
        var window = new Window
        {
            Title = title,
            Width = 460,
            SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = Brush(17, 22, 30),
            Content = new Border
            {
                Padding = new Thickness(22),
                Child = new StackPanel
                {
                    Spacing = 16,
                    Children =
                    {
                        new TextBlock { Text = message, Foreground = Brush(236, 242, 248), TextWrapping = TextWrapping.Wrap, FontSize = 15 },
                        ok,
                    },
                },
            },
        };
        ok.Click += (_, _) => window.Close();
        await window.ShowDialog(this);
    }

    private async Task<bool> ShowConfirmAsync(string title, string message, string confirmLabel, string cancelLabel)
    {
        var confirm = new Button { Content = confirmLabel, MinWidth = 104, Height = 38 };
        var cancel = new Button { Content = cancelLabel, MinWidth = 96, Height = 38 };
        StyleButton(confirm, primary: true);
        StyleButton(cancel);
        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            HorizontalAlignment = HorizontalAlignment.Right,
            Children = { cancel, confirm },
        };
        var window = new Window
        {
            Title = title,
            Width = 500,
            SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = Brush(17, 22, 30),
            Content = new Border
            {
                Padding = new Thickness(22),
                Child = new StackPanel
                {
                    Spacing = 16,
                    Children =
                    {
                        new TextBlock { Text = message, Foreground = Brush(236, 242, 248), TextWrapping = TextWrapping.Wrap, FontSize = 15 },
                        buttons,
                    },
                },
            },
        };
        confirm.Click += (_, _) => window.Close(true);
        cancel.Click += (_, _) => window.Close(false);
        var result = await window.ShowDialog<bool?>(this);
        return result == true;
    }

    private static IBrush Brush(byte r, byte g, byte b) => new SolidColorBrush(Color.FromRgb(r, g, b));
    private static IBrush HorizontalGradient(Color left, Color right) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 0, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(left, 0), new(right, 1) },
    };
    private static IBrush DiagonalGradient(Color start, Color end) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(start, 0), new(end, 1) },
    };
    private static IBrush VerticalGradient(Color top, Color bottom) => new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(0, 1, RelativeUnit.Relative),
        GradientStops = new GradientStops { new(top, 0), new(bottom, 1) },
    };
    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
    private static string StringValue(object? value) => value == null ? "" : Convert.ToString(value) ?? "";

    private static bool IsPathInside(string root, string target)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(target));
        return relative.Length > 0 && !relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathFullyQualified(relative);
    }

    private static bool IsSamePathOrInside(string root, string target)
    {
        var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var targetFull = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return targetFull.Equals(rootFull, StringComparison.OrdinalIgnoreCase) || IsPathInside(rootFull, targetFull);
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string ReadJsonString(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value)) return "";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.ToString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        };
    }

    private static int ReadJsonInt(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value)) return 0;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
        return int.TryParse(ReadJsonString(element, name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static long ReadJsonLong(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value)) return 0;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)) return number;
        return long.TryParse(ReadJsonString(element, name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static double ReadJsonDouble(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value)) return 0;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)) return number;
        return double.TryParse(ReadJsonString(element, name), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static bool ReadJsonBool(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value)) return false;
        if (value.ValueKind == JsonValueKind.True) return true;
        if (value.ValueKind == JsonValueKind.False) return false;
        return bool.TryParse(ReadJsonString(element, name), out var parsed) && parsed;
    }

    private static string FormatBytes(long value)
    {
        if (value < 1024) return $"{value:N0} B";
        if (value < 1024 * 1024) return $"{value / 1024.0:N1} KB";
        return $"{value / 1024.0 / 1024.0:N1} MB";
    }

    private static string FormatCaptureTime(double seconds) => seconds > 0 ? $"{seconds:N1}s" : "time unknown";

    private static string ShortHash(string value)
    {
        var text = value.Trim();
        return text.Length > 16 ? text[..16] : text;
    }

    private static string SafeFileName(string value)
    {
        var safe = Regex.Replace(value, @"[^A-Za-z0-9._-]+", "_").Trim('_');
        return string.IsNullOrWhiteSpace(safe) ? "interface" : safe;
    }

    private static string FirstNonEmptyLine(string value, string fallback) =>
        (value ?? "").SplitLines().FirstOrDefault(line => !string.IsNullOrWhiteSpace(line)) ?? fallback;
}

internal sealed class RelayCommand : ICommand
{
    private readonly Action execute;

    public RelayCommand(Action execute) => this.execute = execute;

    public event EventHandler? CanExecuteChanged;

    public bool CanExecute(object? parameter) => true;

    public void Execute(object? parameter) => execute();
}

internal sealed class LauncherSettings
{
    public const int CurrentVersion = 3;
    public int SettingsVersion { get; set; } = CurrentVersion;
    public int GamePort { get; set; } = 22000;
    public int HttpPort { get; set; } = 8088;
    public int WikiPort { get; set; } = 5174;
    public string CounterSideManagedDir { get; set; } = "";
    public string CrossSaveCaptureDir { get; set; } = "";
    public string EventDate { get; set; } = "";
    public string JoinLobbyAckMode { get; set; } = "auto";
    public bool UserManagerAllowRemote { get; set; }
    public bool VerboseCapture { get; set; }
    public bool ReplayCapturedGameFlow { get; set; } = true;
    public bool SkipTutorialToWin { get; set; }
    public bool ResetTutorialOnLogin { get; set; }
    public bool MinimizeToTrayOnClose { get; set; } = true;
    public bool NotifyTrayWhenServiceStops { get; set; } = true;
    public string AdvancedEnvText { get; set; } = "";
}

internal sealed class ProcessJob : IDisposable
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private IntPtr handle;

    private ProcessJob(IntPtr handle) => this.handle = handle;

    public static ProcessJob? TryCreateKillOnClose()
    {
        if (!OperatingSystem.IsWindows()) return null;
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return null;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
        };
        var length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, pointer, fDeleteOld: false);
            if (!SetInformationJobObject(handle, JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation, pointer, (uint)length))
            {
                CloseHandle(handle);
                return null;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return new ProcessJob(handle);
    }

    public void Assign(Process process)
    {
        if (handle == IntPtr.Zero) return;
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            throw new InvalidOperationException($"AssignProcessToJobObject failed with Win32 error {Marshal.GetLastWin32Error()}.");
        }
    }

    public void Dispose()
    {
        var current = Interlocked.Exchange(ref handle, IntPtr.Zero);
        if (current != IntPtr.Zero) CloseHandle(current);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, JOBOBJECTINFOCLASS jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private enum JOBOBJECTINFOCLASS
    {
        JobObjectExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}

internal static class StringExtensions
{
    public static IEnumerable<string> SplitLines(this string value) => value.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
}

internal sealed class ListenerReadinessGate
{
    private static readonly (string Name, string Marker)[] Signals =
    {
        ("game listener", "[+] Listening on port "),
        ("captured HTTP mirror", "[+] Captured HTTP mirror listening on "),
        ("captured fixture directory", "[+] Captured HTTP mirror fixtureDir="),
        ("User Manager", "[+] User manager listening on "),
    };

    private readonly object sync = new();
    private readonly HashSet<string> observed = new(StringComparer.Ordinal);
    private readonly TaskCompletionSource<bool> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task Ready => ready.Task;

    public void Observe(string line)
    {
        lock (sync)
        {
            foreach (var signal in Signals)
            {
                if (line.Contains(signal.Marker, StringComparison.Ordinal)) observed.Add(signal.Name);
            }
            if (Signals.All(signal => observed.Contains(signal.Name))) ready.TrySetResult(true);
        }
    }

    public void Fail(string message) => ready.TrySetException(new InvalidOperationException(message));

    public string DescribeMissing()
    {
        lock (sync)
        {
            var missing = Signals.Where(signal => !observed.Contains(signal.Name)).Select(signal => signal.Name).ToArray();
            return missing.Length == 0 ? "none" : string.Join(", ", missing);
        }
    }
}

internal sealed record ListenCommand(ProcessStartInfo StartInfo, string Display);
internal sealed record FrozenClientArchive(string RootDir, string ManagedDir, int FileCount, long ByteCount, string AssemblySha256);
internal sealed record FrozenClientCopyProgress(int FileCount, long ByteCount);
internal sealed class FrozenClientManifest
{
    public DateTime ArchivedAtUtc { get; set; }
    public string SourceRoot { get; set; } = "";
    public string RootDir { get; set; } = "";
    public string ManagedDir { get; set; } = "";
    public int FileCount { get; set; }
    public long ByteCount { get; set; }
    public string AssemblySha256 { get; set; } = "";
    public DateTime? PatchedAtUtc { get; set; }
    public string PatchedAssemblySha256 { get; set; } = "";
    public bool SteamRuntimeIsolated { get; set; }
}
internal sealed record GameplayAssetStatus(string ManagedDir, int ScriptBundleCount, string CacheRoot, int CachedLuaCount, string Description);
internal sealed record GameplayCacheProgress(string Phase, int Current, int Total, string Message);
internal sealed record WikiAssetStatus(string CacheRoot, int CachedPngCount);
internal sealed record PythonTool(string FileName, string[] Arguments, string Display);
internal sealed record ToolRunResult(int ExitCode, string CombinedOutput);
internal sealed record CrossSaveCaptureInterface(string Id, string Name);
internal sealed record CrossSaveCaptureProcess(Process Process, StreamWriter Writer, string PcapFile, string LogFile, CrossSaveCaptureInterface Interface);
internal sealed class CrossSaveStreamInfo(int stream)
{
    public int Stream { get; } = stream;
    public long TotalBytes { get; set; }
    public bool HasGamePort { get; set; }
}

internal sealed record CrossSaveSource(
    string Id,
    int Index,
    string PayloadFile,
    long PayloadSizeBytes,
    bool Compressed,
    int Stream,
    int Frame,
    double CaptureTimeSeconds,
    string Sha256)
{
    public override string ToString() => $"{Id} | frame {Frame} | {PayloadFile}";
}

internal sealed record CrossSaveImportResult(string PrettyJson, string UserUid, string OfficialUserUid, string Nickname, string ActiveUserUid);
internal sealed record CrossSaveProcessResult(int ExitCode, string Output, string Error);
