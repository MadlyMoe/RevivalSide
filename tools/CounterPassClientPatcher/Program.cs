using Mono.Cecil;
using Mono.Cecil.Cil;

if (args.Length == 0 || args.Any(arg => arg.Equals("--repair-frozen-content-version", StringComparison.OrdinalIgnoreCase)))
{
    var result = RepairFrozenClientContentVersions(args);
    if (args.Length == 0 && !Console.IsInputRedirected)
    {
        Console.WriteLine();
        Console.Write("Press Enter to close...");
        Console.ReadLine();
    }
    return result;
}

LoadDotEnv(ResolveEnvFile(args));

var managedDir = ResolveManagedDir(args);
var assemblyPath = Path.Combine(managedDir, "Assembly-CSharp.dll");
if (!File.Exists(assemblyPath))
{
    Console.Error.WriteLine($"Assembly-CSharp.dll was not found in {managedDir}");
    return 2;
}

var backupPath = assemblyPath + ".revivalside-counterpass.bak";
var options = PatchOptions.Parse(args);

if (args.Any(arg => arg.Equals("--inspect-updater", StringComparison.OrdinalIgnoreCase)))
{
    return PrintUpdaterInspection(assemblyPath);
}

if (args.Any(arg => arg.Equals("--inspect-updater-il", StringComparison.OrdinalIgnoreCase)))
{
    return PrintUpdaterIl(assemblyPath);
}

if (args.Any(arg => arg.Equals("--inspect-contents-version-il", StringComparison.OrdinalIgnoreCase)))
{
    return PrintContentsVersionIl(assemblyPath);
}

if (options.Status)
{
    return PrintStatus(assemblyPath, backupPath);
}

if (options.Restore)
{
    return RestoreBackup(assemblyPath, backupPath, requireBackup: true);
}

if (options.DisabledByEnv)
{
    Console.WriteLine("[counter-pass-patch] disabled by CS_PATCH_COUNTER_PASS_CLIENT=0");
    return RestoreBackup(assemblyPath, backupPath, requireBackup: false);
}

if (options.RestoreFirst)
{
    var prepared = PrepareOriginalAssembly(assemblyPath, backupPath);
    if (prepared != 0) return prepared;
}
else if (!File.Exists(backupPath))
{
    File.Copy(assemblyPath, backupPath);
    Console.WriteLine($"[counter-pass-patch] backup={backupPath}");
}

var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(managedDir);
resolver.AddSearchDirectory(AppContext.BaseDirectory);

var reader = new ReaderParameters
{
    AssemblyResolver = resolver,
    ReadWrite = true,
    InMemory = true,
};

using var module = ModuleDefinition.ReadModule(assemblyPath, reader);
var patches = new List<string>();
if (options.ApplyContentUnlock && PatchCounterPassUnlock(module)) patches.Add("content-unlock");
if (options.ApplyEventPassTimeGate && PatchEventPassTimeGate(module)) patches.Add("event-pass-time-gate");
if (options.ApplyEventPassTempletFallback && PatchEventPassTempletFallback(module)) patches.Add("event-pass-templet-fallback");
if (options.ApplyLobbyEventPassSelfActivation && PatchLobbyEventPassSelfActivation(module)) patches.Add("lobby-event-pass-self-activation");
if (options.ApplyLobbyCounterPassFallbackRegistration && PatchLobbyCounterPassFallbackRegistration(module)) patches.Add("lobby-counter-pass-fallback-registration");
if (!options.ApplyLobbyEventPassLayout && RemoveLobbyEventPassLayoutPatch(module)) patches.Add("lobby-event-pass-layout-removed");
if (options.ApplyLobbyEventPassLayout && PatchLobbyEventPassLayout(module)) patches.Add("lobby-event-pass-layout");
if (options.ApplyWorldMapRaidRefresh && PatchWorldMapRaidRefresh(module)) patches.Add("world-map-raid-refresh");
if (options.ApplyGearPresetSelectionFix && PatchGearPresetSelectionFix(module)) patches.Add("gear-preset-selection-fix");
if (options.ApplyGearInventoryOkBindFix && PatchGearInventoryOkBindFix(module)) patches.Add("gear-inventory-ok-bind-fix");
if (options.ApplyGearInventoryStateRepair && PatchGearInventoryStateRepair(module)) patches.Add("gear-inventory-state-repair");
if (options.ApplyEpisodeProgressDifficultyFix && PatchEpisodeProgressDifficultyFix(module)) patches.Add("episode-progress-difficulty-fix");
if (options.ApplyOperatorContractCategoryFix && PatchOperatorContractCategoryFix(module)) patches.Add("operator-contract-category-fix");
if (options.ApplySteamLocalLogin && PatchSteamLocalLogin(module)) patches.Add("steam-local-login");
if (options.ApplyFrozenOfficialUpdateBypass && PatchFrozenOfficialUpdateBypass(module, options.FrozenServerInfoUrl)) patches.Add("frozen-official-update-bypass");
var changed = patches.Count > 0;
if (!changed)
{
    Console.WriteLine("[counter-pass-patch] already patched");
    return 0;
}

module.Write(assemblyPath);
Console.WriteLine($"[counter-pass-patch] patched={assemblyPath} patches={string.Join(",", patches)}");
return 0;

static int PrepareOriginalAssembly(string assemblyPath, string backupPath)
{
    if (File.Exists(backupPath))
    {
        File.Copy(backupPath, assemblyPath, overwrite: true);
        Console.WriteLine($"[counter-pass-patch] restored={assemblyPath} backup={backupPath}");
        return 0;
    }

    File.Copy(assemblyPath, backupPath);
    Console.WriteLine($"[counter-pass-patch] backup={backupPath}");
    return 0;
}

static int RestoreBackup(string assemblyPath, string backupPath, bool requireBackup)
{
    if (!File.Exists(backupPath))
    {
        if (!requireBackup)
        {
            Console.WriteLine("[counter-pass-patch] no backup found; leaving current Assembly-CSharp.dll unchanged");
            return 0;
        }

        Console.Error.WriteLine($"[counter-pass-patch] backup not found: {backupPath}");
        Console.Error.WriteLine("[counter-pass-patch] Verify the game files in Steam to restore a clean Assembly-CSharp.dll.");
        return 2;
    }

    File.Copy(backupPath, assemblyPath, overwrite: true);
    Console.WriteLine($"[counter-pass-patch] restored={assemblyPath} backup={backupPath}");
    return 0;
}

static int RepairFrozenClientContentVersions(string[] args)
{
    var configuredRoot = ReadRepairArgValue(args, "--frozen-client-root");
    var frozenRoot = string.IsNullOrWhiteSpace(configuredRoot)
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevivalSide", "frozen-client")
        : Path.GetFullPath(configuredRoot);
    Console.WriteLine("RevivalSide frozen-client content-version repair");
    Console.WriteLine($"Scanning: {frozenRoot}");
    if (!Directory.Exists(frozenRoot))
    {
        Console.Error.WriteLine("No RevivalSide frozen-client folder was found.");
        return 2;
    }

    var clientRoots = new List<string>();
    if (IsMarkedFrozenClientRoot(frozenRoot)) clientRoots.Add(frozenRoot);
    clientRoots.AddRange(Directory.GetDirectories(frozenRoot)
        .Where(IsMarkedFrozenClientRoot)
        .OrderBy(path => path, StringComparer.OrdinalIgnoreCase));
    if (clientRoots.Count == 0)
    {
        Console.Error.WriteLine("No marked RevivalSide frozen clients were found. The Steam installation was not touched.");
        return 2;
    }

    var repaired = 0;
    var current = 0;
    var failed = 0;
    foreach (var clientRoot in clientRoots.Distinct(StringComparer.OrdinalIgnoreCase))
    {
        var managedDir = Path.Combine(clientRoot, "Data", "Managed");
        var assemblyPath = Path.Combine(managedDir, "Assembly-CSharp.dll");
        try
        {
            var resolver = new DefaultAssemblyResolver();
            resolver.AddSearchDirectory(managedDir);
            resolver.AddSearchDirectory(AppContext.BaseDirectory);
            using var module = ModuleDefinition.ReadModule(assemblyPath, new ReaderParameters
            {
                AssemblyResolver = resolver,
                ReadWrite = true,
                InMemory = true,
            });
            if (HasFrozenContentsVersionIsolation(module))
            {
                Console.WriteLine($"Already fixed: {clientRoot}");
                current += 1;
                continue;
            }

            var backupPath = assemblyPath + ".revivalside-content-version-fix.bak";
            if (!File.Exists(backupPath)) File.Copy(assemblyPath, backupPath);
            if (!PatchFrozenContentsVersionIsolation(module) || !HasFrozenContentsVersionIsolation(module))
            {
                throw new InvalidOperationException("The content-version check could not be patched safely.");
            }
            module.Write(assemblyPath);
            Console.WriteLine($"Fixed: {clientRoot}");
            repaired += 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Failed: {clientRoot}");
            Console.Error.WriteLine($"  {error.Message}");
            failed += 1;
        }
    }

    Console.WriteLine();
    Console.WriteLine($"Complete. Fixed: {repaired}; already fixed: {current}; failed: {failed}.");
    return failed == 0 ? 0 : 1;
}

static bool IsMarkedFrozenClientRoot(string root)
{
    return File.Exists(Path.Combine(root, "revivalside-frozen-client.json"))
        && File.Exists(Path.Combine(root, "Data", "Managed", "Assembly-CSharp.dll"));
}

static string? ReadRepairArgValue(string[] args, string name)
{
    for (var index = 0; index < args.Length; index += 1)
    {
        if (!args[index].Equals(name, StringComparison.OrdinalIgnoreCase)) continue;
        if (index + 1 >= args.Length) throw new ArgumentException($"{name} requires a path.");
        return args[index + 1];
    }
    return null;
}

static int PrintStatus(string assemblyPath, string backupPath)
{
    var resolver = new DefaultAssemblyResolver();
    var managedDir = Path.GetDirectoryName(assemblyPath)!;
    resolver.AddSearchDirectory(managedDir);
    resolver.AddSearchDirectory(AppContext.BaseDirectory);

    using var module = ModuleDefinition.ReadModule(assemblyPath, new ReaderParameters
    {
        AssemblyResolver = resolver,
        InMemory = true,
    });

    Console.WriteLine($"[counter-pass-patch] assembly={assemblyPath}");
    Console.WriteLine($"[counter-pass-patch] backup={(File.Exists(backupPath) ? backupPath : "(missing)")}");
    Console.WriteLine($"[counter-pass-patch] env CS_PATCH_COUNTER_PASS_CLIENT={Environment.GetEnvironmentVariable("CS_PATCH_COUNTER_PASS_CLIENT") ?? "(unset)"}");
    Console.WriteLine($"[counter-pass-patch] content-unlock={HasCounterPassUnlockPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] event-pass-time-gate={HasEventPassTimeGatePatch(module)}");
    Console.WriteLine($"[counter-pass-patch] event-pass-templet-fallback={HasEventPassTempletFallbackPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] lobby-event-pass-self-activation={HasLobbyEventPassSelfActivationPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] lobby-counter-pass-fallback-registration={HasLobbyCounterPassFallbackRegistrationPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] lobby-event-pass-layout={HasLobbyEventPassLayoutPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] world-map-raid-refresh={HasWorldMapRaidRefreshPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] gear-preset-selection-fix={HasGearPresetSelectionFix(module)}");
    Console.WriteLine($"[counter-pass-patch] gear-inventory-ok-bind-fix={HasGearInventoryOkBindFix(module)}");
    Console.WriteLine($"[counter-pass-patch] gear-inventory-state-repair={HasGearInventoryStateRepair(module)}");
    Console.WriteLine($"[counter-pass-patch] episode-progress-difficulty-fix={HasEpisodeProgressDifficultyFix(module)}");
    Console.WriteLine($"[counter-pass-patch] operator-contract-category-fix={HasOperatorContractCategoryFix(module)}");
    Console.WriteLine($"[counter-pass-patch] steam-local-login={HasSteamLocalLoginPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] steam-standalone={HasSteamStandalonePatch(module)}");
    Console.WriteLine($"[counter-pass-patch] steam-runtime-isolated={HasSteamRuntimeIsolationPatch(module)}");
    var steamInteropCallsites = FindSteamInteropCallsites(module);
    Console.WriteLine($"[counter-pass-patch] steam-interop-callsites={steamInteropCallsites.Count}");
    foreach (var callsite in steamInteropCallsites.Take(100))
    {
        Console.WriteLine($"[counter-pass-patch] steam-interop-callsite={callsite}");
    }
    Console.WriteLine($"[counter-pass-patch] frozen-official-update-bypass={HasFrozenOfficialUpdateBypassPatch(module)}");
    Console.WriteLine($"[counter-pass-patch] frozen-patch-download-bypass={HasFrozenPatchDownloadBypass(module)}");
    Console.WriteLine($"[counter-pass-patch] frozen-contents-version-isolation={HasFrozenContentsVersionIsolation(module)}");
    Console.WriteLine($"[counter-pass-patch] frozen-login-contents-reconciliation={HasFrozenLoginContentsReconciliation(module)}");
    var externalEndpoints = FindExternalEndpointStrings(module);
    Console.WriteLine($"[counter-pass-patch] external-endpoint-references={externalEndpoints.Count}");
    foreach (var endpoint in externalEndpoints.Take(20))
    {
        Console.WriteLine($"[counter-pass-patch] external-endpoint={endpoint}");
    }
    return 0;
}

static int PrintUpdaterInspection(string assemblyPath)
{
    using var module = ModuleDefinition.ReadModule(assemblyPath, new ReaderParameters { InMemory = true });
    var terms = new[] { "patch", "download", "version", "integrity", "assetbundle", "asset_bundle" };
    var matchingTypes = AllTypes(module)
        .Where(type => terms.Any(term => type.FullName.Contains(term, StringComparison.OrdinalIgnoreCase)))
        .OrderBy(type => type.FullName)
        .ToArray();

    foreach (var type in matchingTypes)
    {
        Console.WriteLine($"[updater-inspect] type={type.FullName}");
        foreach (var field in type.Fields)
        {
            var constant = field.HasConstant ? $" value={field.Constant}" : string.Empty;
            Console.WriteLine($"[updater-inspect] field={field.FieldType.FullName} {field.Name}{constant}");
        }
        foreach (var method in type.Methods)
        {
            var parameters = string.Join(",", method.Parameters.Select(parameter => parameter.ParameterType.FullName));
            Console.WriteLine($"[updater-inspect] method={method.ReturnType.FullName} {method.Name}({parameters})");
        }
    }

    foreach (var type in AllTypes(module))
    {
        foreach (var method in type.Methods.Where(method => method.HasBody))
        {
            var literals = method.Body.Instructions
                .Where(instruction => instruction.OpCode == OpCodes.Ldstr && instruction.Operand is string)
                .Select(instruction => (string)instruction.Operand)
                .Where(value => terms.Any(term => value.Contains(term, StringComparison.OrdinalIgnoreCase)))
                .Distinct()
                .Take(12)
                .ToArray();
            if (literals.Length == 0) continue;
            Console.WriteLine($"[updater-inspect] strings={type.FullName}::{method.Name} => {string.Join(" | ", literals)}");
        }
    }
    return 0;
}

static int PrintUpdaterIl(string assemblyPath)
{
    using var module = ModuleDefinition.ReadModule(assemblyPath, new ReaderParameters { InMemory = true });
    var targets = new[]
    {
        "NKC.Patcher.NKCPatchUtility::IsPatchSkip",
        "NKC.NKCDefineManager::DEFINE_PATCH_SKIP",
        "NKC.Patcher.NKCPatchDownloader::SetUpdatedForSkipPatch",
        "NKC.Patcher.NKCPatchDownloader::HasNoDownloadedFiles",
        "NKC.Patcher.NKCPatchDownloader::ClearFileDownloadContainer",
        "NKC.Patcher.NKCPatchUtility::SaveDownloadType",
        "NKC.Patcher.NKCPatchUtility::BackgroundPatchEnabled",
        "NKC.NKCPatcherManager::CheckCanStartPatch",
        "NKC.NKCPatcherManager::SetState",
        "NKC.NKCPatcherManager::OnEnter",
        "NKC.NKCPatcherManager::OnExit",
        "NKC.NKCPatcherManager/<WaitForDownloadTypeSelect>d__57::MoveNext",
        "NKC.UI.NKCPopupDownloadTypeSelection::",
        "NKC.Patcher.NKCPatchChecker::RegisterPatchProcess",
        "NKC.Patcher.NKCPatchChecker/<ProcessPatch>d__18::MoveNext",
        "NKC.Patcher.WaitForUnityEditorPatchSkip/<GetEnumerator>d__8::MoveNext",
        "NKC.Patcher.WaitForDownLoaderInitialization/<GetEnumerator>d__8::MoveNext",
        "NKC.Patcher.WaitForInternetConnection/<GetEnumerator>d__8::MoveNext",
        "NKC.Patcher.WaitForCheckVersion/<GetEnumerator>d__9::MoveNext",
        "NKC.Patcher.WaitForAppVersionCheckStatus/<GetEnumerator>d__8::MoveNext",
        "NKC.Patcher.WaitForTouch/<GetEnumerator>d__9::MoveNext",
        "NKC.Patcher.WaitForDownloadStatus/<GetEnumerator>d__8::MoveNext",
        "NKC.Patcher.WaitForAssetBundleInitialize/<GetEnumerator>d__4::MoveNext",
        "NKC.Patcher.NKCPatchManifestManager/<MakeDownloadList>d__28::MoveNext",
        "NKC.Patcher.PatchManifestManager/<GetDownloadList>",
        "NKC.NKCPatcherManager/<PatcherProcess>d__28::MoveNext",
        "NKC.Patcher.WaitForAssetBundleVersionCheckStatus/<GetEnumerator>d__8::MoveNext",
        "NKC.Patcher.NKCPatchDownloader/<GetDownloadFiles>d__107::MoveNext",
    };

    var methods = AllTypes(module)
        .SelectMany(type => type.Methods)
        .Where(method => targets.Any(target => method.FullName.Contains(target, StringComparison.Ordinal)))
        .OrderBy(method => method.FullName)
        .ToArray();

    foreach (var method in methods)
    {
        PrintMethodIl(method);
    }

    var calledTargets = new[]
    {
        "NKC.Patcher.NKCPatchUtility::IsPatchSkip",
        "NKC.NKCDefineManager::DEFINE_PATCH_SKIP",
        "NKC.Patcher.NKCPatchDownloader::SetUpdatedForSkipPatch",
        "NKC.Patcher.NKCPatchDownloader::HasNoDownloadedFiles",
        "NKC.Patcher.NKCPatchDownloader::ClearFileDownloadContainer",
    };
    foreach (var method in AllTypes(module).SelectMany(type => type.Methods).Where(method => method.HasBody))
    {
        foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.Operand is not MethodReference calledMethod
                || !calledTargets.Any(target => calledMethod.FullName.Contains(target, StringComparison.Ordinal)))
            {
                continue;
            }
            Console.WriteLine($"[updater-il] caller={method.FullName} offset=IL_{instruction.Offset:x4} target={calledMethod.FullName}");
        }
    }
    return 0;
}

static int PrintContentsVersionIl(string assemblyPath)
{
    using var module = ModuleDefinition.ReadModule(assemblyPath, new ReaderParameters { InMemory = true });
    var targets = new[]
    {
        "NKM.NKMContentsVersionManager",
        "NKC.NKCContentsVersionManager",
        "NKC.NKCMain::NKCInitLocalContentsVersion",
        "NKC.NKCScenManager/<_VersionCheckAndReconnect>",
        "NKC.NKCScenManager::ShowNeedUpdateAfterTutorial",
        "NKC.PacketHandler.NKCPacketHandlersLogin::OnLoginSuccess",
        "Cs.Engine.Util.ContentsVersionChecker",
    };

    var methods = AllTypes(module)
        .SelectMany(type => type.Methods)
        .Where(method => targets.Any(target => method.FullName.Contains(target, StringComparison.Ordinal)))
        .OrderBy(method => method.FullName)
        .ToArray();

    foreach (var method in methods)
    {
        PrintMethodIl(method);
    }
    foreach (var method in AllTypes(module).SelectMany(type => type.Methods).Where(method => method.HasBody))
    {
        foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.Operand is MethodReference calledMethod
                && calledMethod.FullName.Contains("get_GET_STRING_CONTENTS_VERSION_CHANGE", StringComparison.Ordinal))
            {
                Console.WriteLine($"[contents-version-il] popup-caller={method.FullName} offset=IL_{instruction.Offset:x4}");
            }
        }
    }
    return 0;
}

static void PrintMethodIl(MethodDefinition method)
{
    Console.WriteLine($"[updater-il] method={method.FullName}");
    if (!method.HasBody)
    {
        Console.WriteLine("[updater-il] no-body");
        return;
    }
    foreach (var instruction in method.Body.Instructions)
    {
        var operand = instruction.Operand switch
        {
            Instruction target => $"IL_{target.Offset:x4}",
            Instruction[] targets => string.Join(",", targets.Select(target => $"IL_{target.Offset:x4}")),
            _ => instruction.Operand?.ToString() ?? string.Empty,
        };
        Console.WriteLine($"[updater-il] IL_{instruction.Offset:x4}: {instruction.OpCode} {operand}");
    }
}

static IEnumerable<TypeDefinition> AllTypes(ModuleDefinition module)
{
    var stack = new Stack<TypeDefinition>(module.Types.Reverse());
    while (stack.Count > 0)
    {
        var type = stack.Pop();
        yield return type;
        for (var index = type.NestedTypes.Count - 1; index >= 0; index -= 1)
        {
            stack.Push(type.NestedTypes[index]);
        }
    }
}

static string? ResolveEnvFile(string[] args)
{
    for (var index = 0; index < args.Length; index += 1)
    {
        if (args[index] is "--env-file")
        {
            if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} requires a path.");
            return Path.GetFullPath(args[index + 1]);
        }
    }

    var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (directory != null)
    {
        var candidate = Path.Combine(directory.FullName, ".env");
        if (File.Exists(candidate)) return candidate;
        directory = directory.Parent;
    }
    return null;
}

static void LoadDotEnv(string? filePath)
{
    try
    {
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return;
        foreach (var rawLine in File.ReadAllLines(filePath))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (line.StartsWith("export ", StringComparison.Ordinal)) line = line["export ".Length..].Trim();
            var equals = line.IndexOf('=');
            if (equals <= 0) continue;
            var key = line[..equals].Trim();
            if (!IsValidEnvKey(key) || Environment.GetEnvironmentVariable(key) != null) continue;
            var value = line[(equals + 1)..].Trim();
            if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0])
            {
                value = value[1..^1];
            }
            else
            {
                var comment = value.IndexOf(" #", StringComparison.Ordinal);
                if (comment >= 0) value = value[..comment].TrimEnd();
            }
            Environment.SetEnvironmentVariable(key, value);
        }
    }
    catch (Exception err)
    {
        Console.WriteLine($"[env] failed to load {filePath}: {err.Message}");
    }
}

static bool IsValidEnvKey(string key)
{
    if (string.IsNullOrWhiteSpace(key)) return false;
    if (!char.IsLetter(key[0]) && key[0] != '_') return false;
    return key.All(ch => char.IsLetterOrDigit(ch) || ch == '_');
}

static bool PatchEpisodeProgressDifficultyFix(ModuleDefinition module)
{
    var method = FindEpisodeProgressByEpisodeIdMethod(module)
        ?? throw new InvalidOperationException("NKMEpisodeMgr.GetEPProgressClearCount(int) was not found.");
    if (HasEpisodeProgressDifficultyFix(module)) return false;

    var scenManagerType = FindTypeDefinition(module, "NKC.NKCScenManager")
        ?? throw new InvalidOperationException("NKC.NKCScenManager was not found.");
    var currentUserData = scenManagerType.Methods.FirstOrDefault(item => item.Name == "CurrentUserData" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCScenManager.CurrentUserData was not found.");
    var episodeTempletType = FindTypeDefinition(module, "NKM.Templet.NKMEpisodeTempletV2")
        ?? throw new InvalidOperationException("NKM.Templet.NKMEpisodeTempletV2 was not found.");
    var findEpisode = episodeTempletType.Methods.FirstOrDefault(item =>
        item.Name == "Find"
        && item.Parameters.Count == 2
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32
        && item.Parameters[1].ParameterType.FullName == "NKM.Templet.EPISODE_DIFFICULTY")
        ?? throw new InvalidOperationException("NKMEpisodeTempletV2.Find(int, EPISODE_DIFFICULTY) was not found.");
    var templateOverload = FindEpisodeProgressByTempletMethod(module)
        ?? throw new InvalidOperationException("NKMEpisodeMgr.GetEPProgressClearCount(NKMUserData, NKMEpisodeTempletV2) was not found.");
    var normalDifficulty = FindEnumConstant(module, "NKM.Templet.EPISODE_DIFFICULTY", "NORMAL");

    ClearMethodBody(method, initLocals: true);
    var userDataLocal = new VariableDefinition(module.ImportReference(currentUserData.ReturnType));
    var episodeTempletLocal = new VariableDefinition(module.ImportReference(episodeTempletType));
    method.Body.Variables.Add(userDataLocal);
    method.Body.Variables.Add(episodeTempletLocal);

    var il = method.Body.GetILProcessor();
    var returnZero = il.Create(OpCodes.Ldc_I4_0);
    il.Append(il.Create(OpCodes.Call, module.ImportReference(currentUserData)));
    il.Append(il.Create(OpCodes.Stloc_0));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(CreateLoadInt(il, normalDifficulty));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(findEpisode)));
    il.Append(il.Create(OpCodes.Stloc_1));
    il.Append(il.Create(OpCodes.Ldloc_1));
    il.Append(il.Create(OpCodes.Brfalse_S, returnZero));
    il.Append(il.Create(OpCodes.Ldloc_0));
    il.Append(il.Create(OpCodes.Ldloc_1));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(templateOverload)));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(returnZero);
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool HasEpisodeProgressDifficultyFix(ModuleDefinition module)
{
    var method = FindEpisodeProgressByEpisodeIdMethod(module);
    if (method == null) return false;
    var instructions = method.Body.Instructions;
    return instructions.Count <= 16
        && instructions.Any(instruction =>
            instruction.Operand is MethodReference methodReference
            && methodReference.DeclaringType.FullName == "NKM.Templet.NKMEpisodeTempletV2"
            && methodReference.Name == "Find"
            && methodReference.Parameters.Count == 2)
        && instructions.Any(instruction =>
            instruction.Operand is MethodReference methodReference
            && methodReference.DeclaringType.FullName == "NKM.NKMEpisodeMgr"
            && methodReference.Name == "GetEPProgressClearCount"
            && methodReference.Parameters.Count == 2)
        && instructions.Any(instruction => instruction.OpCode.Code == Code.Brfalse || instruction.OpCode.Code == Code.Brfalse_S)
        && instructions.All(instruction => instruction.OpCode.Code != Code.Add);
}

static MethodDefinition? FindEpisodeProgressByEpisodeIdMethod(ModuleDefinition module)
{
    var episodeMgrType = FindTypeDefinition(module, "NKM.NKMEpisodeMgr");
    return episodeMgrType?.Methods.FirstOrDefault(item =>
        item.Name == "GetEPProgressClearCount"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32
        && item.ReturnType.MetadataType == MetadataType.Int32);
}

static MethodDefinition? FindEpisodeProgressByTempletMethod(ModuleDefinition module)
{
    var episodeMgrType = FindTypeDefinition(module, "NKM.NKMEpisodeMgr");
    return episodeMgrType?.Methods.FirstOrDefault(item =>
        item.Name == "GetEPProgressClearCount"
        && item.HasBody
        && item.Parameters.Count == 2
        && item.Parameters[0].ParameterType.FullName == "NKM.NKMUserData"
        && item.Parameters[1].ParameterType.FullName == "NKM.Templet.NKMEpisodeTempletV2"
        && item.ReturnType.MetadataType == MetadataType.Int32);
}

static bool PatchOperatorContractCategoryFix(ModuleDefinition module)
{
    var getter = FindContractCategoryGetter(module)
        ?? throw new InvalidOperationException("ContractTempletBase.Category getter was not found.");
    if (HasOperatorContractCategoryFix(module)) return false;

    var baseType = FindTypeDefinition(module, "NKM.Contract2.ContractTempletBase")
        ?? throw new InvalidOperationException("NKM.Contract2.ContractTempletBase was not found.");
    var v2Type = FindTypeDefinition(module, "NKM.Contract2.ContractTempletV2")
        ?? throw new InvalidOperationException("NKM.Contract2.ContractTempletV2 was not found.");
    var baseDataType = FindTypeDefinition(module, "NKM.Contract2.Detail.ContractBaseData")
        ?? throw new InvalidOperationException("NKM.Contract2.Detail.ContractBaseData was not found.");
    var baseDataField = baseType.Fields.FirstOrDefault(field => field.Name == "baseData")
        ?? throw new InvalidOperationException("ContractTempletBase.baseData was not found.");
    var unitTypeField = v2Type.Fields.FirstOrDefault(field => field.Name == "m_NKM_UNIT_TYPE")
        ?? throw new InvalidOperationException("ContractTempletV2.m_NKM_UNIT_TYPE was not found.");
    var categoryField = baseDataType.Fields.FirstOrDefault(field => field.Name == "m_ContractCategory")
        ?? throw new InvalidOperationException("ContractBaseData.m_ContractCategory was not found.");
    var operatorUnitType = FindEnumConstant(module, "NKM.Templet.NKM_UNIT_TYPE", "NUT_OPERATOR");

    ClearMethodBody(getter, initLocals: true);
    var v2Local = new VariableDefinition(module.ImportReference(v2Type));
    getter.Body.Variables.Add(v2Local);

    var il = getter.Body.GetILProcessor();
    var returnOriginalCategory = il.Create(OpCodes.Ldarg_0);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Isinst, module.ImportReference(v2Type)));
    il.Append(il.Create(OpCodes.Stloc_0));
    il.Append(il.Create(OpCodes.Ldloc_0));
    il.Append(il.Create(OpCodes.Brfalse_S, returnOriginalCategory));
    il.Append(il.Create(OpCodes.Ldloc_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(unitTypeField)));
    il.Append(CreateLoadInt(il, operatorUnitType));
    il.Append(il.Create(OpCodes.Bne_Un_S, returnOriginalCategory));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(baseDataField)));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(categoryField)));
    il.Append(CreateLoadInt(il, 50));
    il.Append(il.Create(OpCodes.Bne_Un_S, returnOriginalCategory));
    il.Append(CreateLoadInt(il, 300));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(returnOriginalCategory);
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(baseDataField)));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(categoryField)));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool HasOperatorContractCategoryFix(ModuleDefinition module)
{
    var getter = FindContractCategoryGetter(module);
    if (getter == null || !getter.HasBody) return false;
    return getter.Body.Instructions.Any(instruction =>
            instruction.OpCode.Code == Code.Isinst
            && instruction.Operand is TypeReference typeReference
            && typeReference.FullName == "NKM.Contract2.ContractTempletV2")
        && getter.Body.Instructions.Any(instruction => IsLoadInt(instruction, 300));
}

static MethodDefinition? FindContractCategoryGetter(ModuleDefinition module)
{
    var baseType = FindTypeDefinition(module, "NKM.Contract2.ContractTempletBase");
    return baseType?.Properties.FirstOrDefault(property => property.Name == "Category")?.GetMethod
        ?? baseType?.Methods.FirstOrDefault(method =>
            method.Name == "get_Category"
            && method.HasBody
            && method.Parameters.Count == 0
            && method.ReturnType.MetadataType == MetadataType.Int32);
}

static bool PatchCounterPassUnlock(ModuleDefinition module)
{
    var contentType = module.Types.FirstOrDefault(type => type.FullName == "NKM.Templet.ContentsType")
        ?? throw new InvalidOperationException("NKM.Templet.ContentsType was not found.");
    var counterPassField = contentType.Fields.FirstOrDefault(field => field.Name == "COUNTER_PASS")
        ?? throw new InvalidOperationException("ContentsType.COUNTER_PASS was not found.");
    var counterPassValue = Convert.ToInt32(counterPassField.Constant);

    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.NKCContentManager")
        ?? throw new InvalidOperationException("NKC.NKCContentManager was not found.");
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == "IsContentsUnlocked"
        && item.HasBody
        && item.Parameters.Count >= 1
        && item.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCContentManager.IsContentsUnlocked was not found.");

    if (HasCounterPassEarlyReturn(method, counterPassValue)) return false;

    var il = method.Body.GetILProcessor();
    var first = method.Body.Instructions.First();
    var continueInstruction = il.Create(OpCodes.Nop);
    il.InsertBefore(first, continueInstruction);
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(continueInstruction, CreateLoadInt(il, counterPassValue));
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Bne_Un_S, continueInstruction));
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Ldc_I4_1));
    il.InsertBefore(continueInstruction, il.Create(OpCodes.Ret));
    return true;
}

static bool HasCounterPassEarlyReturn(MethodDefinition method, int counterPassValue)
{
    var instructions = method.Body.Instructions;
    for (var index = 0; index + 4 < Math.Min(instructions.Count, 12); index += 1)
    {
        if (instructions[index].OpCode != OpCodes.Ldarg_0) continue;
        if (!IsLoadInt(instructions[index + 1], counterPassValue)) continue;
        if (instructions[index + 2].OpCode.Code != Code.Bne_Un_S && instructions[index + 2].OpCode.Code != Code.Bne_Un) continue;
        if (instructions[index + 3].OpCode.Code != Code.Ldc_I4_1) continue;
        if (instructions[index + 4].OpCode.Code != Code.Ret) continue;
        return true;
    }
    return false;
}

static bool HasCounterPassUnlockPatch(ModuleDefinition module)
{
    var contentType = module.Types.FirstOrDefault(type => type.FullName == "NKM.Templet.ContentsType");
    var counterPassField = contentType?.Fields.FirstOrDefault(field => field.Name == "COUNTER_PASS");
    if (counterPassField?.Constant == null) return false;

    var counterPassValue = Convert.ToInt32(counterPassField.Constant);
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.NKCContentManager");
    var method = type?.Methods.FirstOrDefault(item =>
        item.Name == "IsContentsUnlocked"
        && item.HasBody
        && item.Parameters.Count >= 1
        && item.ReturnType.MetadataType == MetadataType.Boolean);
    return method != null && HasCounterPassEarlyReturn(method, counterPassValue);
}

static bool PatchEventPassTimeGate(ModuleDefinition module)
{
    var eventPassType = module.Types.FirstOrDefault(type => type.FullName == "NKC.UI.NKCUIEventPass")
        ?? throw new InvalidOperationException("NKC.UI.NKCUIEventPass was not found.");
    var method = eventPassType.Methods.FirstOrDefault(item =>
        item.Name == "IsEventTime"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCUIEventPass.IsEventTime was not found.");

    var scenManagerType = module.Types.FirstOrDefault(type => type.FullName == "NKC.NKCScenManager")
        ?? throw new InvalidOperationException("NKC.NKCScenManager was not found.");
    var getScenManager = scenManagerType.Methods.FirstOrDefault(item => item.Name == "GetScenManager" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetScenManager was not found.");
    var getEventPassDataManager = scenManagerType.Methods.FirstOrDefault(item => item.Name == "GetEventPassDataManager" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetEventPassDataManager was not found.");

    var dataManagerType = module.Types.FirstOrDefault(type => type.FullName == "NKC.NKCEventPassDataManager")
        ?? throw new InvalidOperationException("NKC.NKCEventPassDataManager was not found.");
    var getEventPassId = dataManagerType.Methods.FirstOrDefault(item => item.Name == "get_EventPassId" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCEventPassDataManager.EventPassId getter was not found.");

    if (IsSimplifiedEventPassTimeGate(method, getEventPassId)) return false;

    method.Body.Instructions.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    method.Body.InitLocals = false;

    var il = method.Body.GetILProcessor();
    var hasManager = il.Create(OpCodes.Nop);
    il.Append(il.Create(OpCodes.Call, module.ImportReference(getScenManager)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getEventPassDataManager)));
    il.Append(il.Create(OpCodes.Dup));
    il.Append(il.Create(OpCodes.Brtrue_S, hasManager));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(hasManager);
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getEventPassId)));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Cgt));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool HasEventPassTimeGatePatch(ModuleDefinition module)
{
    var eventPassType = module.Types.FirstOrDefault(type => type.FullName == "NKC.UI.NKCUIEventPass");
    var method = eventPassType?.Methods.FirstOrDefault(item =>
        item.Name == "IsEventTime"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.ReturnType.MetadataType == MetadataType.Boolean);
    if (method == null) return false;

    return method.Body.Instructions.Count <= 16
        && method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
            && methodReference.Name == "get_EventPassId")
        && method.Body.Instructions.Any(instruction => instruction.OpCode.Code == Code.Cgt);
}

static bool PatchEventPassTempletFallback(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKM.EventPass.NKMEventPassTemplet")
        ?? throw new InvalidOperationException("NKM.EventPass.NKMEventPassTemplet was not found.");
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == "Find"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32)
        ?? throw new InvalidOperationException("NKMEventPassTemplet.Find was not found.");
    var fallbackMethod = type.Methods.FirstOrDefault(item =>
        item.Name == "GetPervTemplet"
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32)
        ?? throw new InvalidOperationException("NKMEventPassTemplet.GetPervTemplet was not found.");

    if (method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference && methodReference.Name == "GetPervTemplet"))
    {
        return false;
    }

    var findReference = method.Body.Instructions
        .Select(instruction => instruction.Operand as MethodReference)
        .FirstOrDefault(methodReference => methodReference != null && methodReference.Name == "Find")
        ?? throw new InvalidOperationException("NKMTempletContainer<NKMEventPassTemplet>.Find call was not found.");

    method.Body.Instructions.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    method.Body.InitLocals = false;

    var il = method.Body.GetILProcessor();
    var returnInstruction = il.Create(OpCodes.Ret);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(findReference)));
    il.Append(il.Create(OpCodes.Dup));
    il.Append(il.Create(OpCodes.Brtrue_S, returnInstruction));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldc_I4, int.MaxValue));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(fallbackMethod)));
    il.Append(returnInstruction);
    return true;
}

static bool HasEventPassTempletFallbackPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKM.EventPass.NKMEventPassTemplet");
    var method = type?.Methods.FirstOrDefault(item =>
        item.Name == "Find"
        && item.HasBody
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.MetadataType == MetadataType.Int32);
    return method?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == "GetPervTemplet") == true;
}

static bool PatchLobbyEventPassSelfActivation(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyMenuEventPass was not found.");
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.CheckButtonEnable was not found.");

    var instructions = method.Body.Instructions;
    var setGameobjectActive = instructions
        .Select(instruction => instruction.Operand as MethodReference)
        .FirstOrDefault(methodReference =>
            methodReference != null
            && methodReference.DeclaringType.FullName == "NKC.NKCUtil"
            && methodReference.Name == "SetGameobjectActive"
            && methodReference.Parameters.Count == 2
            && methodReference.Parameters[0].ParameterType.FullName == "UnityEngine.GameObject"
            && methodReference.Parameters[1].ParameterType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCUtil.SetGameobjectActive(GameObject,bool) was not found in CheckButtonEnable.");

    var getGameObject = FindMethodReference(module, "UnityEngine.Component", "get_gameObject", 0)
        ?? throw new InvalidOperationException("UnityEngine.Component.get_gameObject was not found.");

    if (instructions.Any(IsGetGameObjectCall)) return false;

    var storeFlag = instructions.FirstOrDefault(instruction => instruction.OpCode.Code is Code.Stloc_0 or Code.Stloc_S or Code.Stloc)
        ?? throw new InvalidOperationException("CheckButtonEnable flag store was not found.");
    var afterStore = storeFlag.Next ?? throw new InvalidOperationException("CheckButtonEnable flag store has no following instruction.");

    var il = method.Body.GetILProcessor();
    il.InsertBefore(afterStore, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(afterStore, il.Create(OpCodes.Call, module.ImportReference(getGameObject)));
    il.InsertBefore(afterStore, il.Create(OpCodes.Ldloc_0));
    il.InsertBefore(afterStore, il.Create(OpCodes.Call, module.ImportReference(setGameobjectActive)));
    return true;

    static bool IsGetGameObjectCall(Instruction instruction)
    {
        return instruction.Operand is MethodReference methodReference
            && methodReference.DeclaringType.FullName == "UnityEngine.Component"
            && methodReference.Name == "get_gameObject";
    }
}

static bool HasLobbyEventPassSelfActivationPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass");
    var method = type?.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0);
    return method?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.DeclaringType.FullName == "UnityEngine.Component"
        && methodReference.Name == "get_gameObject") == true;
}

static bool PatchLobbyEventPassLayout(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyMenuEventPass was not found.");
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.CheckButtonEnable was not found.");
    var helper = EnsureLobbyEventPassLayoutMethod(module, type);
    if (method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == helper.Name
        && methodReference.DeclaringType.FullName == type.FullName)) return false;

    var storeFlag = method.Body.Instructions.FirstOrDefault(instruction => instruction.OpCode.Code is Code.Stloc_0 or Code.Stloc_S or Code.Stloc)
        ?? throw new InvalidOperationException("CheckButtonEnable flag store was not found.");
    var afterStore = storeFlag.Next ?? throw new InvalidOperationException("CheckButtonEnable flag store has no following instruction.");
    var il = method.Body.GetILProcessor();
    il.InsertBefore(afterStore, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(afterStore, il.Create(OpCodes.Call, module.ImportReference(helper)));
    return true;
}

static bool HasLobbyEventPassLayoutPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass");
    if (type == null) return false;
    var helper = type.Methods.FirstOrDefault(method => method.Name == "RevivalSideLayoutCounterPassMenu");
    if (helper == null) return false;
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0);
    return method?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == helper.Name
        && methodReference.DeclaringType.FullName == type.FullName) == true;
}

static bool RemoveLobbyEventPassLayoutPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass");
    if (type == null) return false;
    var helper = type.Methods.FirstOrDefault(method => method.Name == "RevivalSideLayoutCounterPassMenu");
    if (helper == null) return false;
    var method = type.Methods.FirstOrDefault(item => item.Name == "CheckButtonEnable" && item.HasBody && item.Parameters.Count == 0);
    if (method == null) return false;

    var changed = false;
    var il = method.Body.GetILProcessor();
    foreach (var instruction in method.Body.Instructions.ToArray())
    {
        if (instruction.Operand is not MethodReference methodReference
            || methodReference.Name != helper.Name
            || methodReference.DeclaringType.FullName != type.FullName) continue;

        var previous = instruction.Previous;
        if (previous != null && previous.OpCode.Code == Code.Ldarg_0)
        {
            il.Remove(previous);
        }
        il.Remove(instruction);
        changed = true;
    }

    if (changed)
    {
        type.Methods.Remove(helper);
    }
    return changed;
}

static MethodDefinition EnsureLobbyEventPassLayoutMethod(ModuleDefinition module, TypeDefinition eventPassType)
{
    const string methodName = "RevivalSideLayoutCounterPassMenu";
    var existing = eventPassType.Methods.FirstOrDefault(method => method.Name == methodName);
    if (existing != null) return existing;

    var contentTypeField = FindInheritedFieldReference(module, eventPassType, "m_ContentsType");
    var counterPassValue = FindEnumConstant(module, "NKM.Templet.ContentsType", "COUNTER_PASS");
    var getComponent = FindMethodReference(module, "UnityEngine.Component", "GetComponent", 0)
        ?? throw new InvalidOperationException("UnityEngine.Component.GetComponent<T>() was not found.");
    var setAnchorMin = FindMethodReference(module, "UnityEngine.RectTransform", "set_anchorMin", 1)
        ?? throw new InvalidOperationException("RectTransform.set_anchorMin was not found.");
    var setAnchorMax = FindMethodReference(module, "UnityEngine.RectTransform", "set_anchorMax", 1)
        ?? throw new InvalidOperationException("RectTransform.set_anchorMax was not found.");
    var setPivot = FindMethodReference(module, "UnityEngine.RectTransform", "set_pivot", 1)
        ?? throw new InvalidOperationException("RectTransform.set_pivot was not found.");
    var setAnchoredPosition = FindMethodReference(module, "UnityEngine.RectTransform", "set_anchoredPosition", 1)
        ?? throw new InvalidOperationException("RectTransform.set_anchoredPosition was not found.");
    var setLocalScale = FindMethodReference(module, "UnityEngine.Transform", "set_localScale", 1)
        ?? throw new InvalidOperationException("Transform.set_localScale was not found.");
    var setAsLastSibling = FindMethodReference(module, "UnityEngine.Transform", "SetAsLastSibling", 0)
        ?? throw new InvalidOperationException("Transform.SetAsLastSibling was not found.");
    var vector2Ctor = FindConstructorReference(module, "UnityEngine.Vector2", 2)
        ?? throw new InvalidOperationException("Vector2(float,float) constructor was not found.");
    var vector3Ctor = FindConstructorReference(module, "UnityEngine.Vector3", 3)
        ?? throw new InvalidOperationException("Vector3(float,float,float) constructor was not found.");
    var rectTransformType = module.ImportReference(setAnchorMin.DeclaringType);
    var getRectTransform = new GenericInstanceMethod(module.ImportReference(getComponent is GenericInstanceMethod genericMethod
        ? genericMethod.ElementMethod
        : getComponent));
    getRectTransform.GenericArguments.Add(rectTransformType);

    var method = new MethodDefinition(
        methodName,
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    method.Body.InitLocals = true;
    var rectTransform = new VariableDefinition(rectTransformType);
    method.Body.Variables.Add(rectTransform);

    var il = method.Body.GetILProcessor();
    var layoutStart = il.Create(OpCodes.Nop);
    var ret = il.Create(OpCodes.Ret);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, contentTypeField));
    il.Append(CreateLoadInt(il, counterPassValue));
    il.Append(il.Create(OpCodes.Beq, layoutStart));
    il.Append(il.Create(OpCodes.Ret));

    il.Append(layoutStart);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Call, getRectTransform));
    il.Append(il.Create(OpCodes.Stloc, rectTransform));
    var afterNullCheck = il.Create(OpCodes.Nop);
    il.Append(il.Create(OpCodes.Ldloc, rectTransform));
    il.Append(il.Create(OpCodes.Brtrue, afterNullCheck));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(afterNullCheck);

    EmitRectTransformVector2Call(il, rectTransform, setAnchorMin, vector2Ctor, 1f, 1f);
    EmitRectTransformVector2Call(il, rectTransform, setAnchorMax, vector2Ctor, 1f, 1f);
    EmitRectTransformVector2Call(il, rectTransform, setPivot, vector2Ctor, 1f, 1f);
    EmitRectTransformVector2Call(il, rectTransform, setAnchoredPosition, vector2Ctor, -815f, -82f);
    EmitRectTransformVector3Call(il, rectTransform, setLocalScale, vector3Ctor, 0.58f, 0.58f, 1f);
    il.Append(il.Create(OpCodes.Ldloc, rectTransform));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(setAsLastSibling)));
    il.Append(ret);

    eventPassType.Methods.Add(method);
    return method;

    static void EmitRectTransformVector2Call(
        ILProcessor il,
        VariableDefinition rectTransform,
        MethodReference setter,
        MethodReference vector2Ctor,
        float x,
        float y)
    {
        il.Append(il.Create(OpCodes.Ldloc, rectTransform));
        il.Append(il.Create(OpCodes.Ldc_R4, x));
        il.Append(il.Create(OpCodes.Ldc_R4, y));
        il.Append(il.Create(OpCodes.Newobj, vector2Ctor));
        il.Append(il.Create(OpCodes.Callvirt, setter));
    }

    static void EmitRectTransformVector3Call(
        ILProcessor il,
        VariableDefinition rectTransform,
        MethodReference setter,
        MethodReference vector3Ctor,
        float x,
        float y,
        float z)
    {
        il.Append(il.Create(OpCodes.Ldloc, rectTransform));
        il.Append(il.Create(OpCodes.Ldc_R4, x));
        il.Append(il.Create(OpCodes.Ldc_R4, y));
        il.Append(il.Create(OpCodes.Ldc_R4, z));
        il.Append(il.Create(OpCodes.Newobj, vector3Ctor));
        il.Append(il.Create(OpCodes.Callvirt, setter));
    }
}

static bool PatchLobbyCounterPassFallbackRegistration(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyV2")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyV2 was not found.");
    var init = type.Methods.FirstOrDefault(item => item.Name == "Init" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUILobbyV2.Init was not found.");
    var resolver = EnsureCounterPassMenuResolver(module, type);
    if (init.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == resolver.Name
        && methodReference.DeclaringType.FullName == type.FullName)) return false;

    var uiEventPassField = type.Fields.FirstOrDefault(field => field.Name == "m_UIEventPass")
        ?? throw new InvalidOperationException("NKCUILobbyV2.m_UIEventPass was not found.");

    var il = init.Body.GetILProcessor();
    var first = init.Body.Instructions.First();
    var skip = il.Create(OpCodes.Nop);
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Ldfld, module.ImportReference(uiEventPassField)));
    il.InsertBefore(first, il.Create(OpCodes.Brtrue, skip));
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Call, module.ImportReference(resolver)));
    il.InsertBefore(first, il.Create(OpCodes.Stfld, module.ImportReference(uiEventPassField)));
    il.InsertBefore(first, skip);
    return true;
}

static bool HasLobbyCounterPassFallbackRegistrationPatch(ModuleDefinition module)
{
    var type = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyV2");
    if (type == null) return false;
    var resolver = type.Methods.FirstOrDefault(method => method.Name == "RevivalSideResolveCounterPassMenu");
    if (resolver == null) return false;
    var init = type.Methods.FirstOrDefault(item => item.Name == "Init" && item.HasBody && item.Parameters.Count == 0);
    return init?.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
        && methodReference.Name == resolver.Name
        && methodReference.DeclaringType.FullName == type.FullName) == true;
}

static MethodDefinition EnsureCounterPassMenuResolver(ModuleDefinition module, TypeDefinition lobbyType)
{
    const string methodName = "RevivalSideResolveCounterPassMenu";
    var existing = lobbyType.Methods.FirstOrDefault(method => method.Name == methodName);
    if (existing != null) return existing;

    var eventPassType = module.Types.FirstOrDefault(item => item.FullName == "NKC.UI.Lobby.NKCUILobbyMenuEventPass")
        ?? throw new InvalidOperationException("NKC.UI.Lobby.NKCUILobbyMenuEventPass was not found.");
    var objRootField = eventPassType.Fields.FirstOrDefault(field => field.Name == "m_objRoot")
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.m_objRoot was not found.");
    var objEmptyField = eventPassType.Fields.FirstOrDefault(field => field.Name == "m_objEmpty")
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.m_objEmpty was not found.");
    var buttonField = eventPassType.Fields.FirstOrDefault(field => field.Name == "m_csbtnMenu")
        ?? throw new InvalidOperationException("NKCUILobbyMenuEventPass.m_csbtnMenu was not found.");
    var getComponentsInChildren = FindMethodReference(module, "UnityEngine.Component", "GetComponentsInChildren", 1)
        ?? throw new InvalidOperationException("UnityEngine.Component.GetComponentsInChildren<T>(bool) was not found.");
    var getEventPassComponents = new GenericInstanceMethod(module.ImportReference(getComponentsInChildren is GenericInstanceMethod genericMethod
        ? genericMethod.ElementMethod
        : getComponentsInChildren));
    getEventPassComponents.GenericArguments.Add(module.ImportReference(eventPassType));

    var method = new MethodDefinition(
        methodName,
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.ImportReference(eventPassType));
    method.Body.InitLocals = true;
    var arrayType = new ArrayType(module.ImportReference(eventPassType));
    var menus = new VariableDefinition(arrayType);
    var index = new VariableDefinition(module.TypeSystem.Int32);
    var candidate = new VariableDefinition(module.ImportReference(eventPassType));
    method.Body.Variables.Add(menus);
    method.Body.Variables.Add(index);
    method.Body.Variables.Add(candidate);

    var il = method.Body.GetILProcessor();
    var menusOk = il.Create(OpCodes.Nop);
    var loopCheck = il.Create(OpCodes.Nop);
    var loopStart = il.Create(OpCodes.Nop);
    var increment = il.Create(OpCodes.Nop);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Call, getEventPassComponents));
    il.Append(il.Create(OpCodes.Stloc, menus));
    il.Append(il.Create(OpCodes.Ldloc, menus));
    il.Append(il.Create(OpCodes.Brtrue, menusOk));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(menusOk);
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Stloc, index));
    il.Append(il.Create(OpCodes.Br, loopCheck));
    il.Append(loopStart);
    il.Append(il.Create(OpCodes.Ldloc, menus));
    il.Append(il.Create(OpCodes.Ldloc, index));
    il.Append(il.Create(OpCodes.Ldelem_Ref));
    il.Append(il.Create(OpCodes.Stloc, candidate));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(objRootField)));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(objEmptyField)));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(buttonField)));
    il.Append(il.Create(OpCodes.Brfalse, increment));
    il.Append(il.Create(OpCodes.Ldloc, candidate));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(increment);
    il.Append(il.Create(OpCodes.Ldloc, index));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Add));
    il.Append(il.Create(OpCodes.Stloc, index));
    il.Append(loopCheck);
    il.Append(il.Create(OpCodes.Ldloc, index));
    il.Append(il.Create(OpCodes.Ldloc, menus));
    il.Append(il.Create(OpCodes.Ldlen));
    il.Append(il.Create(OpCodes.Conv_I4));
    il.Append(il.Create(OpCodes.Blt, loopStart));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Ret));

    lobbyType.Methods.Add(method);
    return method;
}

static bool PatchWorldMapRaidRefresh(ModuleDefinition module)
{
    var changed = false;
    var sender = EnsureWorldMapInfoSender(module, ref changed);
    var sceneHandler = EnsureWorldMapInfoSceneHandler(module, ref changed);
    EnsureWorldMapInfoAckHandler(module, sceneHandler, ref changed);

    var sceneType = FindTypeDefinition(module, "NKC.NKC_SCEN_WORLDMAP")
        ?? throw new InvalidOperationException("NKC.NKC_SCEN_WORLDMAP was not found.");
    var method = sceneType.Methods.FirstOrDefault(item => item.Name == "ScenDataReq" && item.HasBody && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKC_SCEN_WORLDMAP.ScenDataReq was not found.");

    if (IsWorldMapScenDataReqPatched(method, sender)) return changed;

    var baseScenDataReq = FindMethodReference(module, "NKC.NKC_SCEN_BASIC", "ScenDataReq", 0)
        ?? throw new InvalidOperationException("NKC_SCEN_BASIC.ScenDataReq was not found.");

    method.Body.Instructions.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    method.Body.InitLocals = false;

    var il = method.Body.GetILProcessor();
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(baseScenDataReq)));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(sender)));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool HasWorldMapRaidRefreshPatch(ModuleDefinition module)
{
    var senderType = FindTypeDefinition(module, "NKC.NKCPacketSender");
    var sender = senderType?.Methods.FirstOrDefault(item => item.Name == "Send_NKMPacket_WORLDMAP_INFO_REQ" && item.Parameters.Count == 0);
    if (sender == null) return false;

    var sceneType = FindTypeDefinition(module, "NKC.NKC_SCEN_WORLDMAP");
    if (sceneType == null) return false;
    var method = sceneType.Methods.FirstOrDefault(item => item.Name == "ScenDataReq" && item.HasBody && item.Parameters.Count == 0);
    if (method == null || !IsWorldMapScenDataReqPatched(method, sender)) return false;

    var sceneHandler = sceneType.Methods.FirstOrDefault(item => item.Name == "RevivalSideOnWorldMapInfoAck");
    var lobbyHandlers = FindTypeDefinition(module, "NKC.PacketHandler.NKCPacketHandlersLobby");
    var ackHandler = lobbyHandlers?.Methods.FirstOrDefault(item =>
        item.Name == "OnRecv"
        && item.Parameters.Count == 1
        && item.Parameters[0].ParameterType.FullName == "ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK");
    return sceneHandler != null && ackHandler != null;
}

static bool PatchGearPresetSelectionFix(ModuleDefinition module)
{
    var inventoryType = FindTypeDefinition(module, "NKC.UI.NKCUIInventory")
        ?? throw new InvalidOperationException("NKC.UI.NKCUIInventory was not found.");
    var refreshMethod = EnsureGearPresetSelectionRefreshMethod(module, inventoryType);
    var changed = false;

    foreach (var methodName in new[] { "OpenPresetChangeBoxOrChangeDirectIfEmpty", "OnClickOkButton" })
    {
        var method = inventoryType.Methods.FirstOrDefault(method =>
            method.Name == methodName
            && method.HasBody
            && method.Parameters.Count == 0)
            ?? throw new InvalidOperationException($"NKCUIInventory.{methodName}() was not found.");
        changed |= EnsureMethodStartsWithCall(method, refreshMethod);
    }

    changed |= PatchPresetChangePopupCopiesEquipList(module);
    return changed;
}

static bool HasGearPresetSelectionFix(ModuleDefinition module)
{
    var inventoryType = FindTypeDefinition(module, "NKC.UI.NKCUIInventory");
    if (inventoryType == null) return false;
    var refreshMethod = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRefreshLatestPresetEquipFromInfoSlot");
    if (refreshMethod == null) return false;

    foreach (var methodName in new[] { "OpenPresetChangeBoxOrChangeDirectIfEmpty", "OnClickOkButton" })
    {
        var method = inventoryType.Methods.FirstOrDefault(method =>
            method.Name == methodName
            && method.HasBody
            && method.Parameters.Count == 0);
        if (method == null || !MethodStartsWithCall(method, refreshMethod)) return false;
    }

    return HasPresetChangePopupCopiesEquipList(module);
}

static MethodDefinition EnsureGearPresetSelectionRefreshMethod(ModuleDefinition module, TypeDefinition inventoryType)
{
    var existing = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRefreshLatestPresetEquipFromInfoSlot");
    if (existing != null) return existing;

    var optionField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_currentOption")
        ?? throw new InvalidOperationException("NKCUIInventory.m_currentOption was not found.");
    var optionType = optionField.FieldType.Resolve()
        ?? throw new InvalidOperationException("NKCUIInventory.EquipSelectListOptions type was not resolved.");
    var buttonMenuField = optionType.Fields.FirstOrDefault(field => field.Name == "m_ButtonMenuType")
        ?? throw new InvalidOperationException("EquipSelectListOptions.m_ButtonMenuType was not found.");
    var slotInfoField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_slotEquipInfo")
        ?? throw new InvalidOperationException("NKCUIInventory.m_slotEquipInfo was not found.");
    var latestEquipField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_LatestOpenNKMEquipItemData")
        ?? throw new InvalidOperationException("NKCUIInventory.m_LatestOpenNKMEquipItemData was not found.");
    var getEquipData = FindMethodInType(module, slotInfoField.FieldType.FullName, "GetNKMEquipItemData", 0)
        ?? throw new InvalidOperationException("NKCUIInvenEquipSlot.GetNKMEquipItemData was not found.");
    var presetChangeValue = FindEnumConstant(module, "NKC.UI.NKCPopupItemEquipBox/EQUIP_BOX_BOTTOM_MENU_TYPE", "EBBMT_PRESET_CHANGE");

    var method = new MethodDefinition(
        "RevivalSideRefreshLatestPresetEquipFromInfoSlot",
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    method.Body.InitLocals = true;
    var equipLocal = new VariableDefinition(module.ImportReference(latestEquipField.FieldType));
    method.Body.Variables.Add(equipLocal);

    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);
    var slotOk = il.Create(OpCodes.Nop);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(optionField)));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(buttonMenuField)));
    il.Append(CreateLoadInt(il, presetChangeValue));
    il.Append(il.Create(OpCodes.Bne_Un_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(slotInfoField)));
    il.Append(il.Create(OpCodes.Brtrue_S, slotOk));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(slotOk);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(slotInfoField)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getEquipData)));
    il.Append(il.Create(OpCodes.Stloc, equipLocal));
    il.Append(il.Create(OpCodes.Ldloc, equipLocal));
    il.Append(il.Create(OpCodes.Brfalse_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldloc, equipLocal));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(latestEquipField)));
    il.Append(ret);

    inventoryType.Methods.Add(method);
    return method;
}

static bool EnsureMethodStartsWithCall(MethodDefinition method, MethodDefinition target)
{
    if (MethodStartsWithCall(method, target)) return false;

    var il = method.Body.GetILProcessor();
    var first = method.Body.Instructions.First();
    il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(first, il.Create(OpCodes.Call, method.Module.ImportReference(target)));
    return true;
}

static bool MethodStartsWithCall(MethodDefinition method, MethodDefinition target)
{
    var instructions = method.Body.Instructions;
    for (var index = 0; index < Math.Min(instructions.Count, 4); index += 1)
    {
        if (instructions[index].Operand is MethodReference methodReference
            && methodReference.Name == target.Name
            && methodReference.DeclaringType.FullName == target.DeclaringType.FullName)
        {
            return true;
        }
    }
    return false;
}

static bool MethodContainsCall(MethodDefinition method, MethodDefinition target)
{
    return method.Body.Instructions.Any(instruction =>
        instruction.Operand is MethodReference methodReference
        && methodReference.Name == target.Name
        && methodReference.DeclaringType.FullName == target.DeclaringType.FullName);
}

static bool IsStloc(Instruction instruction)
{
    return instruction.OpCode.Code is Code.Stloc or Code.Stloc_0 or Code.Stloc_1 or Code.Stloc_2 or Code.Stloc_3 or Code.Stloc_S;
}

static VariableDefinition? GetStlocVariable(MethodDefinition method, Instruction instruction)
{
    return instruction.OpCode.Code switch
    {
        Code.Stloc_0 => method.Body.Variables.Count > 0 ? method.Body.Variables[0] : null,
        Code.Stloc_1 => method.Body.Variables.Count > 1 ? method.Body.Variables[1] : null,
        Code.Stloc_2 => method.Body.Variables.Count > 2 ? method.Body.Variables[2] : null,
        Code.Stloc_3 => method.Body.Variables.Count > 3 ? method.Body.Variables[3] : null,
        Code.Stloc or Code.Stloc_S => instruction.Operand as VariableDefinition,
        _ => null,
    };
}

static VariableDefinition? GetLdlocVariable(MethodDefinition method, Instruction? instruction)
{
    if (instruction == null) return null;
    return instruction.OpCode.Code switch
    {
        Code.Ldloc_0 => method.Body.Variables.Count > 0 ? method.Body.Variables[0] : null,
        Code.Ldloc_1 => method.Body.Variables.Count > 1 ? method.Body.Variables[1] : null,
        Code.Ldloc_2 => method.Body.Variables.Count > 2 ? method.Body.Variables[2] : null,
        Code.Ldloc_3 => method.Body.Variables.Count > 3 ? method.Body.Variables[3] : null,
        Code.Ldloc or Code.Ldloc_S => instruction.Operand as VariableDefinition,
        _ => null,
    };
}

static bool PatchPresetChangePopupCopiesEquipList(ModuleDefinition module)
{
    var popupType = FindTypeDefinition(module, "NKC.UI.NKCPopupItemEquipBox")
        ?? throw new InvalidOperationException("NKC.UI.NKCPopupItemEquipBox was not found.");
    var method = popupType.Methods.FirstOrDefault(method =>
        method.Name == "OpenForPresetChange"
        && method.HasBody
        && method.Parameters.Count == 6)
        ?? throw new InvalidOperationException("NKCPopupItemEquipBox.OpenForPresetChange was not found.");
    var listField = popupType.Fields.FirstOrDefault(field => field.Name == "m_listPresetEquip")
        ?? throw new InvalidOperationException("NKCPopupItemEquipBox.m_listPresetEquip was not found.");
    var store = method.Body.Instructions.FirstOrDefault(instruction =>
        instruction.OpCode.Code == Code.Stfld
        && instruction.Operand is FieldReference fieldReference
        && fieldReference.Name == listField.Name
        && fieldReference.DeclaringType.FullName == listField.DeclaringType.FullName)
        ?? throw new InvalidOperationException("NKCPopupItemEquipBox.OpenForPresetChange m_listPresetEquip assignment was not found.");

    if (IsNewListCopyInstruction(store.Previous)) return false;

    var il = method.Body.GetILProcessor();
    il.InsertBefore(store, il.Create(OpCodes.Newobj, MakeGenericListCopyConstructor(module, listField.FieldType)));
    return true;
}

static bool HasPresetChangePopupCopiesEquipList(ModuleDefinition module)
{
    var popupType = FindTypeDefinition(module, "NKC.UI.NKCPopupItemEquipBox");
    var method = popupType?.Methods.FirstOrDefault(method =>
        method.Name == "OpenForPresetChange"
        && method.HasBody
        && method.Parameters.Count == 6);
    var listField = popupType?.Fields.FirstOrDefault(field => field.Name == "m_listPresetEquip");
    if (method == null || listField == null) return false;

    var store = method.Body.Instructions.FirstOrDefault(instruction =>
        instruction.OpCode.Code == Code.Stfld
        && instruction.Operand is FieldReference fieldReference
        && fieldReference.Name == listField.Name
        && fieldReference.DeclaringType.FullName == listField.DeclaringType.FullName);
    return IsNewListCopyInstruction(store?.Previous);
}

static bool PatchGearInventoryOkBindFix(ModuleDefinition module)
{
    var inventoryType = FindTypeDefinition(module, "NKC.UI.NKCUIInventory")
        ?? throw new InvalidOperationException("NKC.UI.NKCUIInventory was not found.");
    var restoreMethod = EnsureGearInventoryOkBindRestoreMethod(module, inventoryType);
    var setEquipInfo = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "SetEquipInfo"
        && method.HasBody
        && method.Parameters.Count == 1)
        ?? throw new InvalidOperationException("NKCUIInventory.SetEquipInfo was not found.");

    if (MethodContainsCall(setEquipInfo, restoreMethod)) return false;

    var setInventoryButtonsCall = setEquipInfo.Body.Instructions.FirstOrDefault(instruction =>
        instruction.OpCode.Code == Code.Call
        && instruction.Operand is MethodReference methodReference
        && methodReference.Name == "SetInventoryButtons"
        && methodReference.DeclaringType.FullName == inventoryType.FullName)
        ?? throw new InvalidOperationException("NKCUIInventory.SetEquipInfo SetInventoryButtons call was not found.");

    var il = setEquipInfo.Body.GetILProcessor();
    il.InsertBefore(setInventoryButtonsCall, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(setInventoryButtonsCall, il.Create(OpCodes.Call, module.ImportReference(restoreMethod)));
    return true;
}

static bool HasGearInventoryOkBindFix(ModuleDefinition module)
{
    var inventoryType = FindTypeDefinition(module, "NKC.UI.NKCUIInventory");
    if (inventoryType == null) return false;
    var restoreMethod = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRestoreOkButtonDefaultBinding");
    var setEquipInfo = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "SetEquipInfo"
        && method.HasBody
        && method.Parameters.Count == 1);
    return restoreMethod != null && setEquipInfo != null && MethodContainsCall(setEquipInfo, restoreMethod);
}

static MethodDefinition EnsureGearInventoryOkBindRestoreMethod(ModuleDefinition module, TypeDefinition inventoryType)
{
    var existing = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRestoreOkButtonDefaultBinding");
    if (existing != null) return existing;

    var clickDelegateField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_dOnClickEquipSlot")
        ?? throw new InvalidOperationException("NKCUIInventory.m_dOnClickEquipSlot was not found.");
    var okButtonField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_OkButton")
        ?? throw new InvalidOperationException("NKCUIInventory.m_OkButton was not found.");
    var onClickOkButton = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "OnClickOkButton"
        && method.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCUIInventory.OnClickOkButton was not found.");
    var setBindFunction = FindSetBindFunctionForButton(module, okButtonField.FieldType)
        ?? throw new InvalidOperationException("NKCUtil.SetBindFunction for the inventory OK button was not found.");
    var unityActionCtor = FindUnityActionConstructor(module, setBindFunction.Parameters[1].ParameterType)
        ?? throw new InvalidOperationException("UnityAction(object, IntPtr) constructor was not found.");

    var method = new MethodDefinition(
        "RevivalSideRestoreOkButtonDefaultBinding",
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(clickDelegateField)));
    il.Append(il.Create(OpCodes.Brtrue_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(okButtonField)));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldftn, module.ImportReference(onClickOkButton)));
    il.Append(il.Create(OpCodes.Newobj, module.ImportReference(unityActionCtor)));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(setBindFunction)));
    il.Append(ret);

    inventoryType.Methods.Add(method);
    return method;
}

static bool PatchGearInventoryStateRepair(ModuleDefinition module)
{
    var inventoryType = FindTypeDefinition(module, "NKC.UI.NKCUIInventory")
        ?? throw new InvalidOperationException("NKC.UI.NKCUIInventory was not found.");
    var canonicalizeMethod = EnsureGearInventoryCanonicalizeEquipMethod(module, inventoryType);
    var repairCurrentMethod = EnsureGearInventoryRepairCurrentMethod(module, inventoryType, canonicalizeMethod);
    var changed = EnsureSetEquipInfoCanonicalizesSelectedEquip(module, inventoryType, canonicalizeMethod);
    changed |= EnsurePresetRefreshCanonicalizesSelectedEquip(module, inventoryType, canonicalizeMethod);

    foreach (var method in GetGearInventoryDecisionMethods(inventoryType))
    {
        changed |= EnsureMethodStartsWithCall(method, repairCurrentMethod);
    }

    return changed;
}

static bool HasGearInventoryStateRepair(ModuleDefinition module)
{
    var inventoryType = FindTypeDefinition(module, "NKC.UI.NKCUIInventory");
    if (inventoryType == null) return false;
    var canonicalizeMethod = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideCanonicalizeEquipData");
    var repairCurrentMethod = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRepairCurrentEquipSelection");
    if (canonicalizeMethod == null || repairCurrentMethod == null) return false;

    var setEquipInfo = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "SetEquipInfo"
        && method.HasBody
        && method.Parameters.Count == 1);
    if (setEquipInfo == null || !SetEquipInfoCanonicalizesSelectedEquip(setEquipInfo, canonicalizeMethod)) return false;
    if (!PresetRefreshCanonicalizesSelectedEquip(inventoryType, canonicalizeMethod)) return false;

    return GetGearInventoryDecisionMethods(inventoryType).All(method => MethodStartsWithCall(method, repairCurrentMethod));
}

static IEnumerable<MethodDefinition> GetGearInventoryDecisionMethods(TypeDefinition inventoryType)
{
    var targets = new (string Name, int ParameterCount)[]
    {
        ("OnClickOkButton", 0),
        ("OpenUnitSelect", 0),
        ("OpenChangeBoxOrChangeDirectIfEmpty", 0),
        ("OpenPresetChangeBoxOrChangeDirectIfEmpty", 0),
        ("CheckEquipChange", 1),
        ("SendEquipPacket", 1),
        ("ConfirmChangeEquip", 0),
        ("ChangeEquipAccessory", 1),
        ("ChangeEquipItem", 3),
        ("OnChangeEquip", 0),
        ("OnClickUnEquip", 0),
    };

    foreach (var target in targets)
    {
        var method = inventoryType.Methods.FirstOrDefault(method =>
            method.Name == target.Name
            && method.HasBody
            && method.Parameters.Count == target.ParameterCount);
        if (method != null) yield return method;
    }
}

static MethodDefinition EnsureGearInventoryCanonicalizeEquipMethod(ModuleDefinition module, TypeDefinition inventoryType)
{
    var existing = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideCanonicalizeEquipData");
    if (existing != null) return existing;

    var equipType = FindTypeDefinition(module, "NKM.NKMEquipItemData")
        ?? throw new InvalidOperationException("NKM.NKMEquipItemData was not found.");
    var userType = FindTypeDefinition(module, "NKM.NKMUserData")
        ?? throw new InvalidOperationException("NKM.NKMUserData was not found.");
    var itemUidField = equipType.Fields.FirstOrDefault(field => field.Name == "m_ItemUid")
        ?? throw new InvalidOperationException("NKMEquipItemData.m_ItemUid was not found.");
    var latestEquipField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_LatestOpenNKMEquipItemData")
        ?? throw new InvalidOperationException("NKCUIInventory.m_LatestOpenNKMEquipItemData was not found.");
    var inventoryField = userType.Fields.FirstOrDefault(field => field.Name == "m_InventoryData")
        ?? throw new InvalidOperationException("NKMUserData.m_InventoryData was not found.");
    var currentUserData = FindMethodReference(module, "NKC.NKCScenManager", "CurrentUserData", 0)
        ?? throw new InvalidOperationException("NKCScenManager.CurrentUserData was not found.");
    var getItemEquip = FindMethodInType(module, inventoryField.FieldType.FullName, "GetItemEquip", 1)
        ?? throw new InvalidOperationException("NKMInventoryData.GetItemEquip was not found.");

    var repairMethod = EnsureGearInventoryRepairDetachedOwnerMethod(module, inventoryType);
    var method = new MethodDefinition(
        "RevivalSideCanonicalizeEquipData",
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.ImportReference(equipType));
    method.Parameters.Add(new ParameterDefinition("equipData", ParameterAttributes.None, module.ImportReference(equipType)));
    method.Body.InitLocals = true;
    var userLocal = new VariableDefinition(module.ImportReference(userType));
    var resultLocal = new VariableDefinition(module.ImportReference(equipType));
    var canonicalLocal = new VariableDefinition(module.ImportReference(equipType));
    method.Body.Variables.Add(userLocal);
    method.Body.Variables.Add(resultLocal);
    method.Body.Variables.Add(canonicalLocal);

    var il = method.Body.GetILProcessor();
    var hasInput = il.Create(OpCodes.Nop);
    var hasUser = il.Create(OpCodes.Nop);
    var afterCanonicalLookup = il.Create(OpCodes.Nop);
    var returnResult = il.Create(OpCodes.Nop);

    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Brtrue_S, hasInput));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(hasInput);
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Stloc, resultLocal));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(currentUserData)));
    il.Append(il.Create(OpCodes.Stloc, userLocal));
    il.Append(il.Create(OpCodes.Ldloc, userLocal));
    il.Append(il.Create(OpCodes.Brtrue_S, hasUser));
    il.Append(il.Create(OpCodes.Ldloc, resultLocal));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(hasUser);
    il.Append(il.Create(OpCodes.Ldloc, userLocal));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(inventoryField)));
    il.Append(il.Create(OpCodes.Ldloc, resultLocal));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(itemUidField)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getItemEquip)));
    il.Append(il.Create(OpCodes.Stloc, canonicalLocal));
    il.Append(il.Create(OpCodes.Ldloc, canonicalLocal));
    il.Append(il.Create(OpCodes.Brfalse_S, afterCanonicalLookup));
    il.Append(il.Create(OpCodes.Ldloc, canonicalLocal));
    il.Append(il.Create(OpCodes.Stloc, resultLocal));
    il.Append(afterCanonicalLookup);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldloc, resultLocal));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(repairMethod)));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldloc, resultLocal));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(latestEquipField)));
    il.Append(returnResult);
    il.Append(il.Create(OpCodes.Ldloc, resultLocal));
    il.Append(il.Create(OpCodes.Ret));

    inventoryType.Methods.Add(method);
    return method;
}

static MethodDefinition EnsureGearInventoryRepairCurrentMethod(ModuleDefinition module, TypeDefinition inventoryType, MethodDefinition canonicalizeMethod)
{
    var existing = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRepairCurrentEquipSelection");
    if (existing != null) return existing;

    var latestEquipField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_LatestOpenNKMEquipItemData")
        ?? throw new InvalidOperationException("NKCUIInventory.m_LatestOpenNKMEquipItemData was not found.");
    var method = new MethodDefinition(
        "RevivalSideRepairCurrentEquipSelection",
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(latestEquipField)));
    il.Append(il.Create(OpCodes.Brfalse_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(latestEquipField)));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(canonicalizeMethod)));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(latestEquipField)));
    il.Append(ret);

    inventoryType.Methods.Add(method);
    return method;
}

static MethodDefinition EnsureGearInventoryRepairDetachedOwnerMethod(ModuleDefinition module, TypeDefinition inventoryType)
{
    var existing = inventoryType.Methods.FirstOrDefault(method => method.Name == "RevivalSideRepairDetachedEquipOwner");
    if (existing != null) return existing;

    var equipType = FindTypeDefinition(module, "NKM.NKMEquipItemData")
        ?? throw new InvalidOperationException("NKM.NKMEquipItemData was not found.");
    var userType = FindTypeDefinition(module, "NKM.NKMUserData")
        ?? throw new InvalidOperationException("NKM.NKMUserData was not found.");
    var ownerField = equipType.Fields.FirstOrDefault(field => field.Name == "m_OwnerUnitUID")
        ?? throw new InvalidOperationException("NKMEquipItemData.m_OwnerUnitUID was not found.");
    var armyField = userType.Fields.FirstOrDefault(field => field.Name == "m_ArmyData")
        ?? throw new InvalidOperationException("NKMUserData.m_ArmyData was not found.");
    var currentUserData = FindMethodReference(module, "NKC.NKCScenManager", "CurrentUserData", 0)
        ?? throw new InvalidOperationException("NKCScenManager.CurrentUserData was not found.");
    var getUnitFromUid = FindMethodInType(module, armyField.FieldType.FullName, "GetUnitFromUID", 1)
        ?? throw new InvalidOperationException("NKMArmyData.GetUnitFromUID was not found.");

    var method = new MethodDefinition(
        "RevivalSideRepairDetachedEquipOwner",
        MethodAttributes.Private | MethodAttributes.HideBySig,
        module.TypeSystem.Boolean);
    method.Parameters.Add(new ParameterDefinition("equipData", ParameterAttributes.None, module.ImportReference(equipType)));
    method.Body.InitLocals = true;
    var userLocal = new VariableDefinition(module.ImportReference(userType));
    method.Body.Variables.Add(userLocal);

    var il = method.Body.GetILProcessor();
    var hasPositiveOwner = il.Create(OpCodes.Nop);
    var hasUser = il.Create(OpCodes.Nop);
    var clearOwner = il.Create(OpCodes.Nop);
    var returnFalse = il.Create(OpCodes.Nop);

    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Brfalse_S, returnFalse));
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(ownerField)));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Conv_I8));
    il.Append(il.Create(OpCodes.Bgt_S, hasPositiveOwner));
    il.Append(il.Create(OpCodes.Br_S, returnFalse));
    il.Append(hasPositiveOwner);
    il.Append(il.Create(OpCodes.Call, module.ImportReference(currentUserData)));
    il.Append(il.Create(OpCodes.Stloc, userLocal));
    il.Append(il.Create(OpCodes.Ldloc, userLocal));
    il.Append(il.Create(OpCodes.Brtrue_S, hasUser));
    il.Append(il.Create(OpCodes.Br_S, returnFalse));
    il.Append(hasUser);
    il.Append(il.Create(OpCodes.Ldloc, userLocal));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(armyField)));
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(ownerField)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getUnitFromUid)));
    il.Append(il.Create(OpCodes.Brfalse_S, clearOwner));
    il.Append(il.Create(OpCodes.Br_S, returnFalse));
    il.Append(clearOwner);
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Ldc_I8, -1L));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(ownerField)));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(returnFalse);
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ret));

    inventoryType.Methods.Add(method);
    return method;
}

static bool EnsureSetEquipInfoCanonicalizesSelectedEquip(ModuleDefinition module, TypeDefinition inventoryType, MethodDefinition canonicalizeMethod)
{
    var setEquipInfo = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "SetEquipInfo"
        && method.HasBody
        && method.Parameters.Count == 1)
        ?? throw new InvalidOperationException("NKCUIInventory.SetEquipInfo was not found.");
    if (SetEquipInfoCanonicalizesSelectedEquip(setEquipInfo, canonicalizeMethod)) return false;

    var slotType = setEquipInfo.Parameters[0].ParameterType;
    var getEquipData = FindMethodInType(module, slotType.FullName, "GetNKMEquipItemData", 0)
        ?? throw new InvalidOperationException("NKCUISlotEquip.GetNKMEquipItemData was not found.");
    var store = setEquipInfo.Body.Instructions
        .Select(instruction => FindFollowingStoreAfterCall(instruction, getEquipData))
        .FirstOrDefault(instruction => instruction != null)
        ?? throw new InvalidOperationException("NKCUIInventory.SetEquipInfo selected equip assignment was not found.");

    var il = setEquipInfo.Body.GetILProcessor();
    var insertionPoint = store.Next;
    if (IsStloc(store))
    {
        var local = GetStlocVariable(setEquipInfo, store)
            ?? throw new InvalidOperationException("NKCUIInventory.SetEquipInfo selected equip local was not resolved.");
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldarg_0));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldloc, local));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Call, module.ImportReference(canonicalizeMethod)));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Stloc, local));
        return true;
    }

    if (store.OpCode.Code == Code.Stfld && store.Operand is FieldReference fieldReference)
    {
        var displayLocal = GetLdlocVariable(setEquipInfo, store.Previous?.Previous?.Previous)
            ?? throw new InvalidOperationException("NKCUIInventory.SetEquipInfo selected equip display local was not resolved.");
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldloc, displayLocal));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldarg_0));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldloc, displayLocal));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldfld, module.ImportReference(fieldReference)));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Call, module.ImportReference(canonicalizeMethod)));
        il.InsertBefore(insertionPoint, il.Create(OpCodes.Stfld, module.ImportReference(fieldReference)));
        return true;
    }

    throw new InvalidOperationException("NKCUIInventory.SetEquipInfo selected equip assignment shape was not supported.");
}

static bool SetEquipInfoCanonicalizesSelectedEquip(MethodDefinition setEquipInfo, MethodDefinition canonicalizeMethod)
{
    return MethodContainsCall(setEquipInfo, canonicalizeMethod);
}

static bool EnsurePresetRefreshCanonicalizesSelectedEquip(ModuleDefinition module, TypeDefinition inventoryType, MethodDefinition canonicalizeMethod)
{
    var refreshMethod = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "RevivalSideRefreshLatestPresetEquipFromInfoSlot"
        && method.HasBody
        && method.Parameters.Count == 0);
    if (refreshMethod == null || MethodContainsCall(refreshMethod, canonicalizeMethod)) return false;

    var latestEquipField = inventoryType.Fields.FirstOrDefault(field => field.Name == "m_LatestOpenNKMEquipItemData")
        ?? throw new InvalidOperationException("NKCUIInventory.m_LatestOpenNKMEquipItemData was not found.");
    var store = refreshMethod.Body.Instructions.FirstOrDefault(instruction =>
        instruction.OpCode.Code == Code.Stfld
        && instruction.Operand is FieldReference fieldReference
        && fieldReference.Name == latestEquipField.Name
        && fieldReference.DeclaringType.FullName == latestEquipField.DeclaringType.FullName)
        ?? throw new InvalidOperationException("NKCUIInventory.RevivalSideRefreshLatestPresetEquipFromInfoSlot assignment was not found.");

    var il = refreshMethod.Body.GetILProcessor();
    var insertionPoint = store.Next;
    il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldarg_0));
    il.InsertBefore(insertionPoint, il.Create(OpCodes.Ldfld, module.ImportReference(latestEquipField)));
    il.InsertBefore(insertionPoint, il.Create(OpCodes.Call, module.ImportReference(canonicalizeMethod)));
    il.InsertBefore(insertionPoint, il.Create(OpCodes.Stfld, module.ImportReference(latestEquipField)));
    return true;
}

static bool PresetRefreshCanonicalizesSelectedEquip(TypeDefinition inventoryType, MethodDefinition canonicalizeMethod)
{
    var refreshMethod = inventoryType.Methods.FirstOrDefault(method =>
        method.Name == "RevivalSideRefreshLatestPresetEquipFromInfoSlot"
        && method.HasBody
        && method.Parameters.Count == 0);
    return refreshMethod == null || MethodContainsCall(refreshMethod, canonicalizeMethod);
}

static Instruction? FindFollowingStoreAfterCall(Instruction instruction, MethodReference target)
{
    if (instruction.Operand is not MethodReference methodReference
        || methodReference.Name != target.Name
        || methodReference.Parameters.Count != target.Parameters.Count)
    {
        return null;
    }

    var cursor = instruction.Next;
    for (var hops = 0; cursor != null && hops < 6; hops += 1, cursor = cursor.Next)
    {
        if (cursor.OpCode.Code == Code.Nop) continue;
        if (IsStloc(cursor) || cursor.OpCode.Code == Code.Stfld) return cursor;
    }
    return null;
}

static bool IsNewListCopyInstruction(Instruction? instruction)
{
    return instruction?.OpCode.Code == Code.Newobj
        && instruction.Operand is MethodReference methodReference
        && methodReference.Name == ".ctor"
        && methodReference.DeclaringType.FullName.StartsWith("System.Collections.Generic.List`1", StringComparison.Ordinal);
}

static MethodReference MakeGenericListCopyConstructor(ModuleDefinition module, TypeReference listType)
{
    if (listType is not GenericInstanceType listInstance)
    {
        throw new InvalidOperationException($"{listType.FullName} is not a generic List<T> type.");
    }

    var listDefinition = listInstance.ElementType.Resolve()
        ?? throw new InvalidOperationException($"{listType.FullName} definition was not resolved.");
    var constructor = listDefinition.Methods.FirstOrDefault(method =>
        method.IsConstructor
        && !method.IsStatic
        && method.Parameters.Count == 1
        && method.Parameters[0].ParameterType.Name == "IEnumerable`1")
        ?? throw new InvalidOperationException("List<T>(IEnumerable<T>) constructor was not found.");
    var constructorReference = new MethodReference(constructor.Name, module.TypeSystem.Void, module.ImportReference(listInstance))
    {
        HasThis = true,
        ExplicitThis = constructor.ExplicitThis,
        CallingConvention = constructor.CallingConvention,
    };

    var parameterType = constructor.Parameters[0].ParameterType;
    if (parameterType is GenericInstanceType enumerableInstance)
    {
        var enumerableReference = new GenericInstanceType(module.ImportReference(enumerableInstance.ElementType));
        foreach (var argument in listInstance.GenericArguments)
        {
            enumerableReference.GenericArguments.Add(module.ImportReference(argument));
        }
        constructorReference.Parameters.Add(new ParameterDefinition(enumerableReference));
    }
    else
    {
        constructorReference.Parameters.Add(new ParameterDefinition(module.ImportReference(parameterType)));
    }

    return constructorReference;
}

static bool IsWorldMapScenDataReqPatched(MethodDefinition method, MethodReference sender)
{
    return method.Body.Instructions.Any(instruction =>
        instruction.Operand is MethodReference methodReference
        && methodReference.Name == sender.Name
        && methodReference.DeclaringType.FullName == sender.DeclaringType.FullName);
}

static MethodDefinition EnsureWorldMapInfoSender(ModuleDefinition module, ref bool changed)
{
    var senderType = FindTypeDefinition(module, "NKC.NKCPacketSender")
        ?? throw new InvalidOperationException("NKC.NKCPacketSender was not found.");
    var existing = senderType.Methods.FirstOrDefault(method => method.Name == "Send_NKMPacket_WORLDMAP_INFO_REQ" && method.Parameters.Count == 0);
    if (existing != null) return existing;

    var reqType = FindTypeDefinition(module, "ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_REQ")
        ?? throw new InvalidOperationException("ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_REQ was not found.");
    var reqCtor = reqType.Methods.FirstOrDefault(method => method.IsConstructor && !method.IsStatic && method.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKMPacket_WORLDMAP_INFO_REQ constructor was not found.");
    var getScenManager = FindMethodReference(module, "NKC.NKCScenManager", "GetScenManager", 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetScenManager was not found.");
    var getConnectGame = FindMethodReference(module, "NKC.NKCScenManager", "GetConnectGame", 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetConnectGame was not found.");
    var send = FindMethodReference(module, "NKC.NKCConnectBase", "Send", 3)
        ?? throw new InvalidOperationException("NKCConnectBase.Send was not found.");
    var smallWaitBox = FindEnumConstant(module, "NKC.NKC_OPEN_WAIT_BOX_TYPE", "NOWBT_SMALL");

    var method = new MethodDefinition(
        "Send_NKMPacket_WORLDMAP_INFO_REQ",
        MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    method.Body.InitLocals = true;
    var reqLocal = new VariableDefinition(module.ImportReference(reqType));
    method.Body.Variables.Add(reqLocal);

    var il = method.Body.GetILProcessor();
    il.Append(il.Create(OpCodes.Newobj, module.ImportReference(reqCtor)));
    il.Append(il.Create(OpCodes.Stloc, reqLocal));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(getScenManager)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getConnectGame)));
    il.Append(il.Create(OpCodes.Ldloc, reqLocal));
    il.Append(CreateLoadInt(il, smallWaitBox));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(send)));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ret));

    senderType.Methods.Add(method);
    changed = true;
    return method;
}

static MethodDefinition EnsureWorldMapInfoSceneHandler(ModuleDefinition module, ref bool changed)
{
    var sceneType = FindTypeDefinition(module, "NKC.NKC_SCEN_WORLDMAP")
        ?? throw new InvalidOperationException("NKC.NKC_SCEN_WORLDMAP was not found.");
    var existing = sceneType.Methods.FirstOrDefault(method =>
        method.Name == "RevivalSideOnWorldMapInfoAck"
        && method.Parameters.Count == 1
        && method.Parameters[0].ParameterType.FullName == "ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK");
    if (existing != null) return existing;

    var ackType = FindTypeDefinition(module, "ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK")
        ?? throw new InvalidOperationException("ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK was not found.");
    var stateField = FindInheritedFieldReference(module, sceneType, "m_NKC_SCEN_STATE");
    var dataReqWait = FindEnumConstant(module, "NKC.NKC_SCEN_STATE", "NSS_DATA_REQ_WAIT");
    var baseWaitUpdate = FindMethodReference(module, "NKC.NKC_SCEN_BASIC", "ScenDataReqWaitUpdate", 0)
        ?? throw new InvalidOperationException("NKC_SCEN_BASIC.ScenDataReqWaitUpdate was not found.");

    var method = new MethodDefinition(
        "RevivalSideOnWorldMapInfoAck",
        MethodAttributes.Public | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    method.Parameters.Add(new ParameterDefinition("sPacket", ParameterAttributes.None, module.ImportReference(ackType)));

    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, stateField));
    il.Append(CreateLoadInt(il, dataReqWait));
    il.Append(il.Create(OpCodes.Bne_Un_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(baseWaitUpdate)));
    il.Append(ret);

    sceneType.Methods.Add(method);
    changed = true;
    return method;
}

static MethodDefinition EnsureWorldMapInfoAckHandler(ModuleDefinition module, MethodDefinition sceneHandler, ref bool changed)
{
    var handlerType = FindTypeDefinition(module, "NKC.PacketHandler.NKCPacketHandlersLobby")
        ?? throw new InvalidOperationException("NKC.PacketHandler.NKCPacketHandlersLobby was not found.");
    var existing = handlerType.Methods.FirstOrDefault(method =>
        method.Name == "OnRecv"
        && method.Parameters.Count == 1
        && method.Parameters[0].ParameterType.FullName == "ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK");
    if (existing != null) return existing;

    var ackType = FindTypeDefinition(module, "ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK")
        ?? throw new InvalidOperationException("ClientPacket.WorldMap.NKMPacket_WORLDMAP_INFO_ACK was not found.");
    var userType = FindTypeDefinition(module, "NKM.NKMUserData")
        ?? throw new InvalidOperationException("NKM.NKMUserData was not found.");
    var errorCodeField = ackType.Fields.FirstOrDefault(field => field.Name == "errorCode")
        ?? throw new InvalidOperationException("NKMPacket_WORLDMAP_INFO_ACK.errorCode was not found.");
    var worldMapDataField = ackType.Fields.FirstOrDefault(field => field.Name == "worldMapData")
        ?? throw new InvalidOperationException("NKMPacket_WORLDMAP_INFO_ACK.worldMapData was not found.");
    var worldMapType = worldMapDataField.FieldType.Resolve()
        ?? throw new InvalidOperationException("NKMPacket_WORLDMAP_INFO_ACK.worldMapData type was not resolved.");
    var userWorldMapField = userType.Fields.FirstOrDefault(field => field.Name == "m_WorldmapData")
        ?? throw new InvalidOperationException("NKMUserData.m_WorldmapData was not found.");
    var worldMapCtor = worldMapType.Methods.FirstOrDefault(method => method.IsConstructor && !method.IsStatic && method.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKMWorldMapData constructor was not found.");
    var checkError = FindMethodReference(module, "NKC.PacketHandler.NKCPacketHandlers", "Check_NKM_ERROR_CODE", 4)
        ?? throw new InvalidOperationException("NKCPacketHandlers.Check_NKM_ERROR_CODE was not found.");
    var currentUserData = FindMethodReference(module, "NKC.NKCScenManager", "CurrentUserData", 0)
        ?? throw new InvalidOperationException("NKCScenManager.CurrentUserData was not found.");
    var getScenManager = FindMethodReference(module, "NKC.NKCScenManager", "GetScenManager", 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetScenManager was not found.");
    var getNowScenId = FindMethodReference(module, "NKC.NKCScenManager", "GetNowScenID", 0)
        ?? throw new InvalidOperationException("NKCScenManager.GetNowScenID was not found.");
    var getWorldMapScene = FindMethodReference(module, "NKC.NKCScenManager", "Get_NKC_SCEN_WORLDMAP", 0)
        ?? throw new InvalidOperationException("NKCScenManager.Get_NKC_SCEN_WORLDMAP was not found.");
    var worldMapSceneId = FindEnumConstant(module, "NKM.NKM_SCEN_ID", "NSI_WORLDMAP");

    var method = new MethodDefinition(
        "OnRecv",
        MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
        module.TypeSystem.Void);
    method.Parameters.Add(new ParameterDefinition("sPacket", ParameterAttributes.None, module.ImportReference(ackType)));
    method.Body.InitLocals = true;
    var userLocal = new VariableDefinition(module.ImportReference(userType));
    method.Body.Variables.Add(userLocal);

    var il = method.Body.GetILProcessor();
    var afterErrorCheck = il.Create(OpCodes.Nop);
    var userOk = il.Create(OpCodes.Nop);
    var worldMapOk = il.Create(OpCodes.Nop);
    var ret = il.Create(OpCodes.Ret);

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(errorCodeField)));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(CreateLoadInt(il, int.MinValue));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(checkError)));
    il.Append(il.Create(OpCodes.Brtrue_S, afterErrorCheck));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(afterErrorCheck);

    il.Append(il.Create(OpCodes.Call, module.ImportReference(currentUserData)));
    il.Append(il.Create(OpCodes.Stloc, userLocal));
    il.Append(il.Create(OpCodes.Ldloc, userLocal));
    il.Append(il.Create(OpCodes.Brtrue_S, userOk));
    il.Append(il.Create(OpCodes.Ret));
    il.Append(userOk);

    il.Append(il.Create(OpCodes.Ldloc, userLocal));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldfld, module.ImportReference(worldMapDataField)));
    il.Append(il.Create(OpCodes.Dup));
    il.Append(il.Create(OpCodes.Brtrue_S, worldMapOk));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Newobj, module.ImportReference(worldMapCtor)));
    il.Append(worldMapOk);
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(userWorldMapField)));

    il.Append(il.Create(OpCodes.Call, module.ImportReference(getScenManager)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getNowScenId)));
    il.Append(CreateLoadInt(il, worldMapSceneId));
    il.Append(il.Create(OpCodes.Bne_Un_S, ret));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(getScenManager)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(getWorldMapScene)));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(sceneHandler)));
    il.Append(ret);

    handlerType.Methods.Add(method);
    changed = true;
    return method;
}

static bool PatchSteamLocalLogin(ModuleDefinition module)
{
    var changed = false;
    changed |= PatchSteamManagerStandalone(module);
    changed |= PatchSteamPublisherInit(module);
    changed |= PatchSteamAuthInit(module);
    changed |= PatchSteamAuthLoginToPublisher(module);
    changed |= PatchSteamAuthPrepareCSLogin(module);
    changed |= PatchSteamRuntimeIsolation(module);
    return changed;
}

static bool PatchFrozenOfficialUpdateBypass(ModuleDefinition module, string serverInfoUrl)
{
    var changed = false;
    changed |= PatchFrozenServerInfo(module, "NKC.Publisher.NKCPMSteamPC/ServerInfoSteam", serverInfoUrl);
    changed |= PatchFrozenServerInfo(module, "NKC.Publisher.NKCPMNone/ServerInfoDefault", serverInfoUrl);
    changed |= PatchFrozenNoticeIsolation(module, serverInfoUrl);
    changed |= PatchExternalUrlOperands(module, serverInfoUrl);
    changed |= PatchFrozenPatchDownloadBypass(module);
    changed |= PatchFrozenContentsVersionIsolation(module);

    var mismatchedHttpEndpoints = FindMismatchedHttpEndpointStrings(module, serverInfoUrl);
    if (mismatchedHttpEndpoints.Count > 0)
    {
        throw new InvalidOperationException(
            "Frozen client still contains HTTP URL references that do not match the launcher URL: "
            + string.Join(", ", mismatchedHttpEndpoints.Take(8).Select(value => $"'{value}'")));
    }

    var remainingExternalEndpoints = FindExternalEndpointStrings(module);
    if (remainingExternalEndpoints.Count > 0)
    {
        throw new InvalidOperationException(
            "Frozen client still contains external URL references after patching: "
            + string.Join(", ", remainingExternalEndpoints.Take(8).Select(value => $"'{value}'")));
    }
    return changed;
}

static bool PatchFrozenContentsVersionIsolation(ModuleDefinition module)
{
    const string localVersionMarker = "revivalside-frozen-contents-version-isolation";
    var changed = false;
    var mainType = FindTypeDefinition(module, "NKC.NKCMain");
    var localVersionMethods = mainType?.Methods.Where(method =>
        method.Name == "NKCInitLocalContentsVersion"
        && method.HasBody
        && method.ReturnType.MetadataType == MetadataType.Void).ToArray() ?? Array.Empty<MethodDefinition>();
    if (mainType != null && localVersionMethods.Length > 0)
    {
        changed |= PatchVoidMethodsNoOp(mainType, "NKCInitLocalContentsVersion", localVersionMarker);
    }

    var loginMethods = FindContentsVersionPopupMethods(module);
    if (localVersionMethods.Length == 0 && loginMethods.Length == 0)
    {
        throw new InvalidOperationException("No supported CounterSide content-version checks were found.");
    }
    changed |= PatchLoginContentsVersionReconciliation(module, loginMethods);
    return changed;
}

static bool PatchLoginContentsVersionReconciliation(ModuleDefinition module, MethodDefinition[]? methods = null)
{
    const string marker = "revivalside-frozen-login-contents-reconciliation";
    var popupMethods = methods ?? FindContentsVersionPopupMethods(module);
    if (popupMethods.Length == 0) return false;

    var contentsVersionManager = FindTypeDefinition(module, "NKM.NKMContentsVersionManager")
        ?? throw new InvalidOperationException("NKMContentsVersionManager was not found.");
    var clientContentsVersionManager = FindTypeDefinition(module, "NKC.NKCContentsVersionManager")
        ?? throw new InvalidOperationException("NKCContentsVersionManager was not found.");
    var changed = false;

    foreach (var method in popupMethods)
    {
        if (HasMarker(method, marker)) continue;
        var versionParameter = FindContentsVersionParameter(method)
            ?? throw new InvalidOperationException($"{method.FullName} content-version parameter was not found.");
        var tagParameter = FindContentsTagParameter(method)
            ?? throw new InvalidOperationException($"{method.FullName} content-tag parameter was not found.");
        var setCurrent = contentsVersionManager.Methods.FirstOrDefault(candidate =>
            candidate.Name == "SetCurrent"
            && candidate.IsStatic
            && candidate.Parameters.Count == 1
            && candidate.Parameters[0].ParameterType.FullName == versionParameter.ParameterType.FullName
            && candidate.ReturnType.MetadataType == MetadataType.Boolean)
            ?? throw new InvalidOperationException("NKMContentsVersionManager.SetCurrent(string) was not found.");
        var setTagList = clientContentsVersionManager.Methods.FirstOrDefault(candidate =>
            candidate.Name == "SetTagList"
            && candidate.IsStatic
            && candidate.Parameters.Count == 1
            && candidate.Parameters[0].ParameterType.FullName == tagParameter.ParameterType.FullName
            && candidate.ReturnType.MetadataType == MetadataType.Void)
            ?? throw new InvalidOperationException("NKCContentsVersionManager.SetTagList(contentsTagList) was not found.");

        var first = method.Body.Instructions.First();
        var il = method.Body.GetILProcessor();
        foreach (var instruction in new[]
        {
            il.Create(OpCodes.Ldstr, marker),
            il.Create(OpCodes.Pop),
            il.Create(OpCodes.Ldarg, versionParameter),
            il.Create(OpCodes.Call, module.ImportReference(setCurrent)),
            il.Create(OpCodes.Pop),
            il.Create(OpCodes.Ldarg, tagParameter),
            il.Create(OpCodes.Call, module.ImportReference(setTagList)),
        })
        {
            il.InsertBefore(first, instruction);
        }
        changed = true;
    }
    return changed;
}

static MethodDefinition[] FindContentsVersionPopupMethods(ModuleDefinition module)
{
    return AllTypes(module)
        .SelectMany(type => type.Methods)
        .Where(method =>
            method.HasBody
            && method.ReturnType.MetadataType == MetadataType.Void
            && method.Body.Instructions.Any(instruction =>
                instruction.Operand is MethodReference calledMethod
                && calledMethod.Name == "get_GET_STRING_CONTENTS_VERSION_CHANGE"))
        .ToArray();
}

static ParameterDefinition? FindContentsVersionParameter(MethodDefinition method)
{
    var named = method.Parameters.FirstOrDefault(parameter =>
        parameter.ParameterType.MetadataType == MetadataType.String
        && parameter.Name.Contains("contentsVersion", StringComparison.OrdinalIgnoreCase));
    if (named != null) return named;

    foreach (var instruction in method.Body.Instructions.Where(instruction =>
        instruction.Operand is MethodReference calledMethod
        && calledMethod.DeclaringType.FullName == "System.String"
        && calledMethod.Name is "op_Inequality" or "op_Equality"))
    {
        for (var current = instruction.Previous; current != null; current = current.Previous)
        {
            var parameter = GetLoadedParameter(method, current);
            if (parameter?.ParameterType.MetadataType == MetadataType.String) return parameter;
            if (instruction.Offset - current.Offset > 24) break;
        }
    }
    return null;
}

static ParameterDefinition? FindContentsTagParameter(MethodDefinition method)
{
    var named = method.Parameters.FirstOrDefault(parameter =>
        parameter.Name.Contains("contentsTag", StringComparison.OrdinalIgnoreCase));
    if (named != null) return named;

    foreach (var instruction in method.Body.Instructions.Where(instruction =>
        instruction.Operand is MethodReference calledMethod
        && calledMethod.Name == "CheckSameTagList"))
    {
        for (var current = instruction.Previous; current != null; current = current.Previous)
        {
            var parameter = GetLoadedParameter(method, current);
            if (parameter != null) return parameter;
            if (instruction.Offset - current.Offset > 16) break;
        }
    }
    return null;
}

static ParameterDefinition? GetLoadedParameter(MethodDefinition method, Instruction instruction)
{
    if (instruction.Operand is ParameterDefinition parameter) return parameter;
    var argumentIndex = instruction.OpCode.Code switch
    {
        Code.Ldarg_0 => 0,
        Code.Ldarg_1 => 1,
        Code.Ldarg_2 => 2,
        Code.Ldarg_3 => 3,
        _ => -1,
    };
    if (argumentIndex < 0) return null;
    if (method.HasThis) argumentIndex -= 1;
    return argumentIndex >= 0 && argumentIndex < method.Parameters.Count
        ? method.Parameters[argumentIndex]
        : null;
}

static bool PatchFrozenPatchDownloadBypass(ModuleDefinition module)
{
    const string marker = "revivalside-frozen-patch-download-bypass";
    var stateType = FindTypeDefinition(module, "NKC.Patcher.WaitForAssetBundleVersionCheckStatus/<GetEnumerator>d__8")
        ?? throw new InvalidOperationException("Frozen patch version-check state machine was not found.");
    var moveNext = stateType.Methods.FirstOrDefault(method =>
        method.Name == "MoveNext"
        && method.HasBody
        && method.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("Frozen patch version-check MoveNext method was not found.");
    if (HasMarker(moveNext, marker)) return false;

    var downloaderType = FindTypeDefinition(module, "NKC.Patcher.NKCPatchDownloader")
        ?? throw new InvalidOperationException("NKCPatchDownloader was not found.");
    var instanceField = downloaderType.Fields.FirstOrDefault(field =>
        field.Name == "Instance"
        && field.IsStatic
        && field.FieldType.FullName == downloaderType.FullName)
        ?? throw new InvalidOperationException("NKCPatchDownloader.Instance was not found.");
    var setUpdated = downloaderType.Methods.FirstOrDefault(method =>
        method.Name == "SetUpdatedForSkipPatch"
        && !method.IsStatic
        && method.Parameters.Count == 0
        && method.ReturnType.MetadataType == MetadataType.Void)
        ?? throw new InvalidOperationException("NKCPatchDownloader.SetUpdatedForSkipPatch was not found.");
    var prologuePlayField = downloaderType.Fields.FirstOrDefault(field =>
        field.Name == "ProloguePlay"
        && field.FieldType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCPatchDownloader.ProloguePlay was not found.");
    var insertionPoint = moveNext.Body.Instructions.FirstOrDefault(instruction =>
        instruction.OpCode == OpCodes.Stfld
        && instruction.Operand is FieldReference field
        && field.FullName == prologuePlayField.FullName)
        ?? throw new InvalidOperationException("Frozen patch version-check status transition was not found.");

    var il = moveNext.Body.GetILProcessor();
    var current = insertionPoint;
    foreach (var instruction in new[]
    {
        il.Create(OpCodes.Ldstr, marker),
        il.Create(OpCodes.Pop),
        il.Create(OpCodes.Ldsfld, module.ImportReference(instanceField)),
        il.Create(OpCodes.Callvirt, module.ImportReference(setUpdated)),
    })
    {
        il.InsertAfter(current, instruction);
        current = instruction;
    }
    return true;
}

static bool PatchFrozenServerInfo(ModuleDefinition module, string typeFullName, string serverInfoUrl)
{
    var serverInfoType = FindTypeDefinition(module, typeFullName)
        ?? throw new InvalidOperationException($"{typeFullName} was not found.");
    var changed = false;
    changed |= PatchStringReturnMethod(serverInfoType, "GetServerConfigPath", serverInfoUrl, "revivalside-frozen-official-update-bypass");
    changed |= PatchBoolReturnMethod(serverInfoType, "GetUseLocalSaveLastServerInfoToGetTags", false, "revivalside-frozen-official-update-bypass");
    return changed;
}

static bool PatchFrozenNoticeIsolation(ModuleDefinition module, string localUrl)
{
    var changed = false;
    var noticeType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/NoticeSteam")
        ?? throw new InvalidOperationException("NKC.Publisher.NKCPMSteamPC/NoticeSteam was not found.");
    changed |= PatchStringReturnMethod(noticeType, "NoticeUrl", localUrl, "revivalside-frozen-notice-isolation");
    changed |= PatchBoolReturnMethod(noticeType, "CheckOpenNoticeWhenFirstLoginSuccess", false, "revivalside-frozen-notice-isolation");
    changed |= PatchBoolReturnMethod(noticeType, "CheckOpenNoticeWhenFirstLobbyVisit", false, "revivalside-frozen-notice-isolation");
    changed |= PatchBoolReturnMethod(noticeType, "IsActiveCustomerCenter", false, "revivalside-frozen-notice-isolation");
    changed |= PatchNoticeCallbackNoOp(module, noticeType, "OpenNotice", callbackParameterIndex: 0, "revivalside-frozen-notice-isolation");
    changed |= PatchNoticeCallbackNoOp(module, noticeType, "OpenCommunity", callbackParameterIndex: 0, "revivalside-frozen-notice-isolation");
    changed |= PatchNoticeCallbackNoOp(module, noticeType, "OpenCustomerCenter", callbackParameterIndex: 0, "revivalside-frozen-notice-isolation");
    changed |= PatchNoticeCallbackNoOp(module, noticeType, "OpenURL", callbackParameterIndex: 1, "revivalside-frozen-notice-isolation");

    var baseNoticeType = FindTypeDefinition(module, "NKC.Publisher.NKCPublisherModule/NKCPMNotice");
    if (baseNoticeType != null)
    {
        changed |= PatchNoticeCallbackNoOp(module, baseNoticeType, "OpenCommunity", callbackParameterIndex: 0, "revivalside-frozen-notice-isolation");
        changed |= PatchNoticeCallbackNoOp(module, baseNoticeType, "OpenURL", callbackParameterIndex: 1, "revivalside-frozen-notice-isolation");
    }
    return changed;
}

static bool PatchStringReturnMethod(TypeDefinition type, string methodName, string value, string marker)
{
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == methodName
        && item.HasBody
        && item.ReturnType.FullName == "System.String")
        ?? throw new InvalidOperationException($"{type.FullName}.{methodName} was not found.");
    if (HasStringReturnPatchForValue(method, marker, value)) return false;

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    il.Append(il.Create(OpCodes.Ldstr, marker));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldstr, value));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool PatchBoolReturnMethod(TypeDefinition type, string methodName, bool value, string marker)
{
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == methodName
        && item.HasBody
        && item.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException($"{type.FullName}.{methodName} was not found.");
    if (HasMarker(method, marker)) return false;

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    il.Append(il.Create(OpCodes.Ldstr, marker));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(value ? OpCodes.Ldc_I4_1 : OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool PatchNoticeCallbackNoOp(ModuleDefinition module, TypeDefinition type, string methodName, int callbackParameterIndex, string marker)
{
    var method = type.Methods.FirstOrDefault(item =>
        item.Name == methodName
        && item.HasBody
        && item.Parameters.Count > callbackParameterIndex
        && item.ReturnType.MetadataType == MetadataType.Void)
        ?? throw new InvalidOperationException($"{type.FullName}.{methodName} was not found.");
    if (HasMarker(method, marker)) return false;

    var invoke = FindOnCompleteInvoke(module);
    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);
    il.Append(il.Create(OpCodes.Ldstr, marker));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldarg, callbackParameterIndex + 1));
    il.Append(il.Create(OpCodes.Brfalse_S, ret));
    il.Append(il.Create(OpCodes.Ldarg, callbackParameterIndex + 1));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(invoke)));
    il.Append(ret);
    return true;
}

static bool PatchExternalUrlOperands(ModuleDefinition module, string localUrl)
{
    var changed = false;
    var localUri = new Uri(localUrl, UriKind.Absolute);
    foreach (var type in module.GetTypes())
    {
        foreach (var field in type.Fields)
        {
            if (!field.HasConstant || field.Constant is not string value) continue;
            var replacement = RewriteFrozenExternalString(value, localUrl, localUri.Host);
            if (replacement == value) continue;
            field.Constant = replacement;
            changed = true;
        }

        foreach (var method in type.Methods)
        {
            foreach (var parameter in method.Parameters)
            {
                if (!parameter.HasConstant || parameter.Constant is not string value) continue;
                var replacement = RewriteFrozenExternalString(value, localUrl, localUri.Host);
                if (replacement == value) continue;
                parameter.Constant = replacement;
                changed = true;
            }

            if (!method.HasBody) continue;
            foreach (var instruction in method.Body.Instructions)
            {
                if (instruction.Operand is not string value) continue;
                var replacement = RewriteFrozenExternalString(value, localUrl, localUri.Host);
                if (replacement == value) continue;
                instruction.Operand = replacement;
                changed = true;
            }
        }
    }
    return changed;
}

static string RewriteFrozenExternalString(string value, string localUrl, string localHost)
{
    if (string.IsNullOrWhiteSpace(value)) return value;
    if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
    {
        return value.Equals(localUrl, StringComparison.Ordinal) ? value : localUrl;
    }

    return IsOfficialHostReference(value) ? localHost : value;
}

static List<string> FindExternalEndpointStrings(ModuleDefinition module)
{
    return FindEndpointStrings(module, IsExternalEndpointString);
}

static List<string> FindMismatchedHttpEndpointStrings(ModuleDefinition module, string localUrl)
{
    return FindEndpointStrings(module, value =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme is "http" or "https"
        && !value.Equals(localUrl, StringComparison.Ordinal));
}

static List<string> FindEndpointStrings(ModuleDefinition module, Func<string, bool> predicate)
{
    var values = new HashSet<string>(StringComparer.Ordinal);
    foreach (var type in module.GetTypes())
    {
        foreach (var field in type.Fields)
        {
            if (field.HasConstant && field.Constant is string value && predicate(value)) values.Add(value);
        }

        foreach (var method in type.Methods)
        {
            foreach (var parameter in method.Parameters)
            {
                if (parameter.HasConstant && parameter.Constant is string value && predicate(value)) values.Add(value);
            }

            if (!method.HasBody) continue;
            foreach (var instruction in method.Body.Instructions)
            {
                if (instruction.Operand is string value && predicate(value)) values.Add(value);
            }
        }
    }
    return values.OrderBy(value => value, StringComparer.Ordinal).ToList();
}

static bool IsExternalEndpointString(string value)
{
    if (string.IsNullOrWhiteSpace(value)) return false;
    if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
    {
        return !IsLoopbackHostName(uri.Host);
    }
    return IsOfficialHostReference(value);
}

static bool IsOfficialHostReference(string value)
{
    return value.Equals("studiobsidedev.com", StringComparison.OrdinalIgnoreCase)
        || value.Contains("ctsglobal-", StringComparison.OrdinalIgnoreCase)
        || value.Contains("ctskorea-", StringComparison.OrdinalIgnoreCase)
        || value.Contains("sbside.com", StringComparison.OrdinalIgnoreCase)
        || value.Contains("bside.com", StringComparison.OrdinalIgnoreCase)
        || value.Contains("counterside.com", StringComparison.OrdinalIgnoreCase)
        || value.Contains("nexon.com", StringComparison.OrdinalIgnoreCase)
        || value.Contains("nexon.co.jp", StringComparison.OrdinalIgnoreCase)
        || value.Contains("game-beans.com", StringComparison.OrdinalIgnoreCase);
}

static bool IsLoopbackHostName(string host)
{
    if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
    if (host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)) return true;
    if (host.Equals("::1", StringComparison.OrdinalIgnoreCase)) return true;
    return false;
}

static bool PatchSteamManagerStandalone(ModuleDefinition module)
{
    var steamManagerType = FindTypeDefinition(module, "SteamManager")
        ?? throw new InvalidOperationException("SteamManager was not found.");
    var changed = false;
    changed |= PatchSteamManagerAwake(module, steamManagerType);
    changed |= PatchSteamManagerNoOp(module, steamManagerType, "OnEnable");
    changed |= PatchSteamManagerNoOp(module, steamManagerType, "OnDestroy");
    changed |= PatchSteamManagerNoOp(module, steamManagerType, "Update");
    changed |= PatchSteamManagerNoOp(module, steamManagerType, "InitOnPlayMode");
    return changed;
}

static bool PatchSteamManagerAwake(ModuleDefinition module, TypeDefinition steamManagerType)
{
    var method = steamManagerType.Methods.FirstOrDefault(item => item.Name == "Awake" && item.HasBody)
        ?? throw new InvalidOperationException("SteamManager.Awake was not found.");
    if (HasSteamStandaloneMarker(method)) return false;

    var instanceField = steamManagerType.Fields.FirstOrDefault(item => item.Name == "s_instance")
        ?? throw new InvalidOperationException("SteamManager.s_instance was not found.");
    var everInitializedField = steamManagerType.Fields.FirstOrDefault(item => item.Name == "s_EverInitialized")
        ?? throw new InvalidOperationException("SteamManager.s_EverInitialized was not found.");
    var initializedField = steamManagerType.Fields.FirstOrDefault(item => item.Name == "m_bInitialized")
        ?? throw new InvalidOperationException("SteamManager.m_bInitialized was not found.");

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    il.Append(il.Create(OpCodes.Ldstr, "revivalside-steam-standalone"));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Stsfld, module.ImportReference(instanceField)));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(initializedField)));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Stsfld, module.ImportReference(everInitializedField)));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool PatchSteamManagerNoOp(ModuleDefinition module, TypeDefinition steamManagerType, string methodName)
{
    var method = steamManagerType.Methods.FirstOrDefault(item => item.Name == methodName && item.HasBody)
        ?? throw new InvalidOperationException($"SteamManager.{methodName} was not found.");
    if (HasSteamStandaloneMarker(method)) return false;

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    il.Append(il.Create(OpCodes.Ldstr, "revivalside-steam-standalone"));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool PatchSteamPublisherInit(ModuleDefinition module)
{
    var steamType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC")
        ?? throw new InvalidOperationException("NKC.Publisher.NKCPMSteamPC was not found.");
    var method = steamType.Methods.FirstOrDefault(item =>
        item.Name == "_Init"
        && item.HasBody
        && item.Parameters.Count == 1)
        ?? throw new InvalidOperationException("NKCPMSteamPC._Init was not found.");

    if (HasSteamPublisherInitPatch(method)) return false;

    var publisherType = FindTypeDefinition(module, "NKC.Publisher.NKCPublisherModule")
        ?? throw new InvalidOperationException("NKC.Publisher.NKCPublisherModule was not found.");
    var setInitState = publisherType.Methods.FirstOrDefault(item => item.Name == "set_InitState" && item.Parameters.Count == 1)
        ?? throw new InvalidOperationException("NKCPublisherModule.InitState setter was not found.");
    var getAuth = publisherType.Methods.FirstOrDefault(item => item.Name == "get_Auth" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCPublisherModule.Auth getter was not found.");
    var authType = publisherType.NestedTypes.FirstOrDefault(item => item.Name == "NKCPMAuthentication")
        ?? throw new InvalidOperationException("NKCPublisherModule.NKCPMAuthentication was not found.");
    var authInit = authType.Methods.FirstOrDefault(item => item.Name == "Init" && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCPMAuthentication.Init was not found.");
    var invoke = FindOnCompleteInvoke(module);

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);
    il.Append(il.Create(OpCodes.Ldc_I4_2));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(setInitState)));
    il.Append(il.Create(OpCodes.Call, module.ImportReference(getAuth)));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(authInit)));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Brfalse_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(invoke)));
    il.Append(ret);
    return true;
}

static bool PatchSteamAuthInit(ModuleDefinition module)
{
    var authType = FindSteamAuthType(module);
    var method = authType.Methods.FirstOrDefault(item =>
        item.Name == "Init"
        && item.HasBody
        && item.Parameters.Count == 0
        && item.ReturnType.MetadataType == MetadataType.Boolean)
        ?? throw new InvalidOperationException("NKCPMSteamPC.AuthSteam.Init was not found.");

    if (HasLocalSteamIdentityMarker(method)) return false;

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    AppendLocalSteamIdentity(il, module, authType);
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Ret));
    return true;
}

static bool PatchSteamAuthLoginToPublisher(ModuleDefinition module)
{
    var authType = FindSteamAuthType(module);
    var method = authType.Methods.FirstOrDefault(item =>
        item.Name == "LoginToPublisher"
        && item.HasBody
        && item.Parameters.Count == 1)
        ?? throw new InvalidOperationException("NKCPMSteamPC.AuthSteam.LoginToPublisher was not found.");

    if (HasLocalSteamIdentityMarker(method)) return false;

    var invoke = FindOnCompleteInvoke(module);
    var callbackField = authType.Fields.FirstOrDefault(item => item.Name == "m_onLoginToPublisherComplete");

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);
    AppendLocalSteamIdentity(il, module, authType);
    if (callbackField != null)
    {
        il.Append(il.Create(OpCodes.Ldarg_0));
        il.Append(il.Create(OpCodes.Ldarg_1));
        il.Append(il.Create(OpCodes.Stfld, module.ImportReference(callbackField)));
    }
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Brfalse_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(invoke)));
    il.Append(ret);
    return true;
}

static bool PatchSteamAuthPrepareCSLogin(ModuleDefinition module)
{
    var authType = FindSteamAuthType(module);
    var method = authType.Methods.FirstOrDefault(item =>
        item.Name == "PrepareCSLogin"
        && item.HasBody
        && item.Parameters.Count == 1)
        ?? throw new InvalidOperationException("NKCPMSteamPC.AuthSteam.PrepareCSLogin was not found.");

    if (method.Body.Instructions.Any(instruction => instruction.Operand is string value && value == "revivalside-local-ready")) return false;

    var invoke = FindOnCompleteInvoke(module);

    ClearMethodBody(method, initLocals: false);
    var il = method.Body.GetILProcessor();
    var ret = il.Create(OpCodes.Ret);
    il.Append(il.Create(OpCodes.Ldstr, "revivalside-local-ready"));
    il.Append(il.Create(OpCodes.Pop));
    AppendLocalSteamIdentity(il, module, authType);
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Brfalse_S, ret));
    il.Append(il.Create(OpCodes.Ldarg_1));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Callvirt, module.ImportReference(invoke)));
    il.Append(ret);
    return true;
}

static bool PatchSteamRuntimeIsolation(ModuleDefinition module)
{
    var changed = false;
    changed |= PatchSteamLocalization(module);

    var authType = FindSteamAuthType(module);
    changed |= PatchVoidMethodsNoOp(authType, "OnAuthSessionTicketResponse", "revivalside-steam-runtime-isolated");

    var inAppType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/InAppSteam")
        ?? throw new InvalidOperationException("NKCPMSteamPC.InAppSteam was not found.");
    changed |= PatchVoidMethodsNoOp(inAppType, "Init", "revivalside-steam-runtime-isolated");
    changed |= PatchVoidMethodsNoOp(inAppType, "OnGameOverlayActivated", "revivalside-steam-runtime-isolated");
    changed |= PatchVoidMethodsNoOp(inAppType, "OnMicroTxnAuthorizationResponse", "revivalside-steam-runtime-isolated");
    return changed;
}

static bool PatchSteamLocalization(ModuleDefinition module)
{
    var localizationType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/LocalizationSteam")
        ?? throw new InvalidOperationException("NKCPMSteamPC.LocalizationSteam was not found.");
    var changed = false;
    changed |= PatchStringReturnMethod(localizationType, "get_m_strCountry", "US", "revivalside-steam-runtime-isolated");
    changed |= PatchStringReturnMethod(localizationType, "get_m_strGameLanguage", "english", "revivalside-steam-runtime-isolated");

    var defaultLanguage = localizationType.Methods.FirstOrDefault(item =>
        item.Name == "GetDefaultLanguage"
        && item.HasBody
        && item.Parameters.Count == 0)
        ?? throw new InvalidOperationException("NKCPMSteamPC.LocalizationSteam.GetDefaultLanguage was not found.");
    if (!HasMarker(defaultLanguage, "revivalside-steam-runtime-isolated"))
    {
        var nationalCodeType = FindTypeDefinition(module, "NKC.NKM_NATIONAL_CODE")
            ?? throw new InvalidOperationException("NKC.NKM_NATIONAL_CODE was not found.");
        var englishField = nationalCodeType.Fields.FirstOrDefault(item =>
            item.Name == "NNC_ENG"
            && item.HasConstant)
            ?? throw new InvalidOperationException("NKM_NATIONAL_CODE.NNC_ENG was not found.");
        ClearMethodBody(defaultLanguage, initLocals: false);
        var il = defaultLanguage.Body.GetILProcessor();
        il.Append(il.Create(OpCodes.Ldstr, "revivalside-steam-runtime-isolated"));
        il.Append(il.Create(OpCodes.Pop));
        il.Append(il.Create(OpCodes.Ldc_I4, Convert.ToInt32(englishField.Constant)));
        il.Append(il.Create(OpCodes.Ret));
        changed = true;
    }
    return changed;
}

static bool PatchVoidMethodsNoOp(TypeDefinition type, string methodName, string marker)
{
    var methods = type.Methods.Where(item =>
        item.Name == methodName
        && item.HasBody
        && item.ReturnType.MetadataType == MetadataType.Void).ToArray();
    if (methods.Length == 0) throw new InvalidOperationException($"{type.FullName}.{methodName} was not found.");

    var changed = false;
    foreach (var method in methods)
    {
        if (HasMarker(method, marker)) continue;
        ClearMethodBody(method, initLocals: false);
        var il = method.Body.GetILProcessor();
        il.Append(il.Create(OpCodes.Ldstr, marker));
        il.Append(il.Create(OpCodes.Pop));
        il.Append(il.Create(OpCodes.Ret));
        changed = true;
    }
    return changed;
}

static bool HasSteamLocalLoginPatch(ModuleDefinition module)
{
    var authType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/AuthSteam");
    var loginMethod = authType?.Methods.FirstOrDefault(item => item.Name == "LoginToPublisher" && item.HasBody && item.Parameters.Count == 1);
    var initMethod = authType?.Methods.FirstOrDefault(item => item.Name == "Init" && item.HasBody && item.Parameters.Count == 0);
    var steamType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC");
    var publisherInit = steamType?.Methods.FirstOrDefault(item => item.Name == "_Init" && item.HasBody);
    return loginMethod != null
        && initMethod != null
        && publisherInit != null
        && HasLocalSteamIdentityMarker(loginMethod)
        && HasLocalSteamIdentityMarker(initMethod)
        && HasSteamPublisherInitPatch(publisherInit)
        && HasSteamStandalonePatch(module)
        && HasSteamRuntimeIsolationPatch(module);
}

static bool HasFrozenOfficialUpdateBypassPatch(ModuleDefinition module)
{
    return HasStringReturnMarker(module, "NKC.Publisher.NKCPMSteamPC/ServerInfoSteam", "GetServerConfigPath", "revivalside-frozen-official-update-bypass")
        && HasStringReturnMarker(module, "NKC.Publisher.NKCPMNone/ServerInfoDefault", "GetServerConfigPath", "revivalside-frozen-official-update-bypass")
        && HasMethodMarker(module, "NKC.Publisher.NKCPMSteamPC/NoticeSteam", "OpenURL", "revivalside-frozen-notice-isolation")
        && HasFrozenPatchDownloadBypass(module)
        && HasFrozenContentsVersionIsolation(module)
        && FindExternalEndpointStrings(module).Count == 0;
}

static bool HasFrozenPatchDownloadBypass(ModuleDefinition module)
{
    return HasMethodMarker(
        module,
        "NKC.Patcher.WaitForAssetBundleVersionCheckStatus/<GetEnumerator>d__8",
        "MoveNext",
        "revivalside-frozen-patch-download-bypass");
}

static bool HasFrozenContentsVersionIsolation(ModuleDefinition module)
{
    const string localVersionMarker = "revivalside-frozen-contents-version-isolation";
    var mainType = FindTypeDefinition(module, "NKC.NKCMain");
    var localVersionMethods = mainType?.Methods.Where(method =>
        method.Name == "NKCInitLocalContentsVersion"
        && method.HasBody
        && method.ReturnType.MetadataType == MetadataType.Void).ToArray() ?? Array.Empty<MethodDefinition>();
    var localVersionPatched = localVersionMethods.Length == 0 || localVersionMethods.All(method => HasMarker(method, localVersionMarker));
    var popupMethods = FindContentsVersionPopupMethods(module);
    var loginReconciliationPatched = popupMethods.Length == 0 || popupMethods.All(method =>
        HasMarker(method, "revivalside-frozen-login-contents-reconciliation"));
    return localVersionPatched && loginReconciliationPatched;
}

static bool HasFrozenLoginContentsReconciliation(ModuleDefinition module)
{
    var popupMethods = FindContentsVersionPopupMethods(module);
    return popupMethods.Length > 0 && popupMethods.All(method =>
        HasMarker(method, "revivalside-frozen-login-contents-reconciliation"));
}

static bool HasStringReturnMarker(ModuleDefinition module, string typeFullName, string methodName, string marker)
{
    return HasMethodMarker(module, typeFullName, methodName, marker);
}

static bool HasMethodMarker(ModuleDefinition module, string typeFullName, string methodName, string marker)
{
    var type = FindTypeDefinition(module, typeFullName);
    var method = type?.Methods.FirstOrDefault(item => item.Name == methodName && item.HasBody);
    return method != null && HasMarker(method, marker);
}

static bool HasStringReturnPatchForValue(MethodDefinition method, string marker, string value)
{
    return HasMarker(method, marker)
        && method.Body.Instructions.Any(instruction => instruction.Operand is string current && current == value);
}

static bool HasMarker(MethodDefinition method, string marker)
{
    return method.Body.Instructions.Any(instruction => instruction.Operand is string value && value == marker);
}

static bool HasSteamStandalonePatch(ModuleDefinition module)
{
    var steamManagerType = FindTypeDefinition(module, "SteamManager");
    var awake = steamManagerType?.Methods.FirstOrDefault(item => item.Name == "Awake" && item.HasBody);
    var onEnable = steamManagerType?.Methods.FirstOrDefault(item => item.Name == "OnEnable" && item.HasBody);
    var onDestroy = steamManagerType?.Methods.FirstOrDefault(item => item.Name == "OnDestroy" && item.HasBody);
    var update = steamManagerType?.Methods.FirstOrDefault(item => item.Name == "Update" && item.HasBody);
    var initOnPlayMode = steamManagerType?.Methods.FirstOrDefault(item => item.Name == "InitOnPlayMode" && item.HasBody);
    return awake != null
        && onEnable != null
        && onDestroy != null
        && update != null
        && initOnPlayMode != null
        && HasSteamStandaloneMarker(awake)
        && HasSteamStandaloneMarker(onEnable)
        && HasSteamStandaloneMarker(onDestroy)
        && HasSteamStandaloneMarker(update)
        && HasSteamStandaloneMarker(initOnPlayMode);
}

static bool HasSteamStandaloneMarker(MethodDefinition method)
{
    return method.Body.Instructions.Any(instruction => instruction.Operand is string value && value == "revivalside-steam-standalone");
}

static List<string> FindSteamInteropCallsites(ModuleDefinition module)
{
    var callsites = new SortedSet<string>(StringComparer.Ordinal);
    foreach (var type in module.GetTypes())
    {
        foreach (var method in type.Methods)
        {
            if (!method.HasBody) continue;
            foreach (var instruction in method.Body.Instructions)
            {
                if (!IsSteamInteropOperand(instruction.Operand)) continue;
                callsites.Add($"{method.FullName} -> {instruction.Operand}");
            }
        }
    }
    return callsites.ToList();
}

static bool IsSteamInteropOperand(object? operand)
{
    return operand switch
    {
        TypeReference type => IsSteamInteropType(type),
        MemberReference member => IsSteamInteropType(member.DeclaringType),
        _ => false,
    };
}

static bool IsSteamInteropType(TypeReference? type)
{
    if (type == null) return false;
    var fullName = type.FullName ?? "";
    return fullName.StartsWith("Steamworks.", StringComparison.Ordinal)
        || string.Equals(type.Scope?.Name, "com.rlabrecque.steamworks.net", StringComparison.OrdinalIgnoreCase);
}

static bool HasSteamRuntimeIsolationPatch(ModuleDefinition module)
{
    var localizationType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/LocalizationSteam");
    var authType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/AuthSteam");
    var inAppType = FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/InAppSteam");
    if (localizationType == null || authType == null || inAppType == null) return false;

    var required = new[]
    {
        localizationType.Methods.FirstOrDefault(item => item.Name == "get_m_strCountry" && item.HasBody),
        localizationType.Methods.FirstOrDefault(item => item.Name == "get_m_strGameLanguage" && item.HasBody),
        localizationType.Methods.FirstOrDefault(item => item.Name == "GetDefaultLanguage" && item.HasBody),
        authType.Methods.FirstOrDefault(item => item.Name == "OnAuthSessionTicketResponse" && item.HasBody),
        inAppType.Methods.FirstOrDefault(item => item.Name == "Init" && item.HasBody),
        inAppType.Methods.FirstOrDefault(item => item.Name == "OnGameOverlayActivated" && item.HasBody),
        inAppType.Methods.FirstOrDefault(item => item.Name == "OnMicroTxnAuthorizationResponse" && item.HasBody),
    };
    return required.All(method => method != null && HasMarker(method, "revivalside-steam-runtime-isolated"))
        && FindSteamInteropCallsites(module).Count == 0;
}

static bool HasSteamPublisherInitPatch(MethodDefinition method)
{
    return method.Body.Instructions.Any(instruction => instruction.Operand is MethodReference methodReference
            && methodReference.Name == "get_Auth"
            && methodReference.DeclaringType.FullName == "NKC.Publisher.NKCPublisherModule")
        && !method.Body.Instructions.Any(instruction => instruction.Operand is MemberReference memberReference
            && memberReference.DeclaringType.FullName.Contains("SteamManager", StringComparison.Ordinal));
}

static bool HasLocalSteamIdentityMarker(MethodDefinition method)
{
    return method.Body.Instructions.Any(instruction => instruction.Operand is string value && value == "revivalside-local-ticket");
}

static TypeDefinition FindSteamAuthType(ModuleDefinition module)
{
    return FindTypeDefinition(module, "NKC.Publisher.NKCPMSteamPC/AuthSteam")
        ?? throw new InvalidOperationException("NKC.Publisher.NKCPMSteamPC/AuthSteam was not found.");
}

static MethodDefinition FindOnCompleteInvoke(ModuleDefinition module)
{
    var publisherType = FindTypeDefinition(module, "NKC.Publisher.NKCPublisherModule")
        ?? throw new InvalidOperationException("NKC.Publisher.NKCPublisherModule was not found.");
    var onCompleteType = publisherType.NestedTypes.FirstOrDefault(item => item.Name == "OnComplete")
        ?? throw new InvalidOperationException("NKCPublisherModule.OnComplete was not found.");
    return onCompleteType.Methods.FirstOrDefault(item => item.Name == "Invoke" && item.Parameters.Count == 2)
        ?? throw new InvalidOperationException("NKCPublisherModule.OnComplete.Invoke was not found.");
}

static void AppendLocalSteamIdentity(ILProcessor il, ModuleDefinition module, TypeDefinition authType)
{
    var successField = authType.Fields.FirstOrDefault(item => item.Name == "m_bLoginSuccessFromPubAuth")
        ?? throw new InvalidOperationException("AuthSteam.m_bLoginSuccessFromPubAuth was not found.");
    var ticketLengthField = authType.Fields.FirstOrDefault(item => item.Name == "m_pcbTicket")
        ?? throw new InvalidOperationException("AuthSteam.m_pcbTicket was not found.");
    var ticketField = authType.Fields.FirstOrDefault(item => item.Name == "m_strTicket")
        ?? throw new InvalidOperationException("AuthSteam.m_strTicket was not found.");
    var userIdField = authType.Fields.FirstOrDefault(item => item.Name == "m_strUserID")
        ?? throw new InvalidOperationException("AuthSteam.m_strUserID was not found.");
    var appIdField = authType.Fields.FirstOrDefault(item => item.Name == "m_appID");

    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldc_I4_1));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(successField)));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldc_I4_0));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(ticketLengthField)));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldstr, "revivalside-local-ticket"));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(ticketField)));
    il.Append(il.Create(OpCodes.Ldarg_0));
    il.Append(il.Create(OpCodes.Ldstr, "revivalside-local"));
    il.Append(il.Create(OpCodes.Stfld, module.ImportReference(userIdField)));
    if (appIdField != null)
    {
        il.Append(il.Create(OpCodes.Ldarg_0));
        il.Append(il.Create(OpCodes.Ldstr, "0"));
        il.Append(il.Create(OpCodes.Stfld, module.ImportReference(appIdField)));
    }
}

static void ClearMethodBody(MethodDefinition method, bool initLocals)
{
    method.Body.Instructions.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    method.Body.InitLocals = initLocals;
}

static FieldReference FindInheritedFieldReference(ModuleDefinition module, TypeDefinition type, string fieldName)
{
    TypeDefinition? current = type;
    while (current != null)
    {
        var field = current.Fields.FirstOrDefault(item => item.Name == fieldName);
        if (field != null) return module.ImportReference(field);
        current = current.BaseType?.Resolve();
    }

    throw new InvalidOperationException($"{type.FullName}.{fieldName} was not found.");
}

static int FindEnumConstant(ModuleDefinition module, string typeFullName, string fieldName)
{
    var type = FindTypeDefinition(module, typeFullName)
        ?? throw new InvalidOperationException($"{typeFullName} was not found.");
    var field = type.Fields.FirstOrDefault(item => item.Name == fieldName)
        ?? throw new InvalidOperationException($"{typeFullName}.{fieldName} was not found.");
    if (field.Constant == null) throw new InvalidOperationException($"{typeFullName}.{fieldName} has no constant value.");
    return Convert.ToInt32(field.Constant);
}

static TypeDefinition? FindTypeDefinition(ModuleDefinition module, string typeFullName)
{
    foreach (var type in module.Types)
    {
        var found = FindTypeDefinitionInType(type, typeFullName);
        if (found != null) return found;
    }
    return null;
}

static TypeDefinition? FindTypeDefinitionInType(TypeDefinition type, string typeFullName)
{
    if (type.FullName == typeFullName) return type;
    foreach (var nestedType in type.NestedTypes)
    {
        var found = FindTypeDefinitionInType(nestedType, typeFullName);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindMethodInType(ModuleDefinition module, string declaringTypeFullName, string methodName, int parameterCount)
{
    var type = FindTypeDefinition(module, declaringTypeFullName);
    var method = type?.Methods.FirstOrDefault(method =>
        method.Name == methodName
        && method.Parameters.Count == parameterCount);
    return method == null ? null : module.ImportReference(method);
}

static MethodReference? FindSetBindFunctionForButton(ModuleDefinition module, TypeReference buttonType)
{
    var utilType = FindTypeDefinition(module, "NKC.NKCUtil");
    var method = utilType?.Methods.FirstOrDefault(method =>
        method.Name == "SetBindFunction"
        && method.Parameters.Count == 2
        && method.Parameters[0].ParameterType.FullName == buttonType.FullName);
    return method == null ? null : module.ImportReference(method);
}

static MethodReference? FindUnityActionConstructor(ModuleDefinition module, TypeReference unityActionType)
{
    var definition = unityActionType.Resolve();
    var constructor = definition?.Methods.FirstOrDefault(method =>
        method.IsConstructor
        && !method.IsStatic
        && method.Parameters.Count == 2
        && method.Parameters[0].ParameterType.FullName == "System.Object"
        && method.Parameters[1].ParameterType.FullName == "System.IntPtr");
    return constructor == null ? null : module.ImportReference(constructor);
}

static MethodReference? FindMethodReference(ModuleDefinition module, string declaringTypeFullName, string methodName, int parameterCount)
{
    foreach (var type in module.Types)
    {
        var found = FindMethodReferenceInType(type, declaringTypeFullName, methodName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindMethodReferenceInType(TypeDefinition type, string declaringTypeFullName, string methodName, int parameterCount)
{
    foreach (var method in type.Methods)
    {
        if (!method.HasBody) continue;
        foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.Operand is MethodReference methodReference
                && methodReference.DeclaringType.FullName == declaringTypeFullName
                && methodReference.Name == methodName
                && methodReference.Parameters.Count == parameterCount)
            {
                return methodReference;
            }
        }
    }
    foreach (var nestedType in type.NestedTypes)
    {
        var found = FindMethodReferenceInType(nestedType, declaringTypeFullName, methodName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindConstructorReference(ModuleDefinition module, string declaringTypeFullName, int parameterCount)
{
    foreach (var type in module.Types)
    {
        var found = FindConstructorReferenceInType(type, declaringTypeFullName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static MethodReference? FindConstructorReferenceInType(TypeDefinition type, string declaringTypeFullName, int parameterCount)
{
    foreach (var method in type.Methods)
    {
        if (!method.HasBody) continue;
        foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.Operand is MethodReference methodReference
                && methodReference.DeclaringType.FullName == declaringTypeFullName
                && methodReference.Name == ".ctor"
                && methodReference.Parameters.Count == parameterCount)
            {
                return methodReference;
            }
        }
    }
    foreach (var nestedType in type.NestedTypes)
    {
        var found = FindConstructorReferenceInType(nestedType, declaringTypeFullName, parameterCount);
        if (found != null) return found;
    }
    return null;
}

static bool IsSimplifiedEventPassTimeGate(MethodDefinition method, MethodReference eventPassIdGetter)
{
    var instructions = method.Body.Instructions;
    return instructions.Count <= 16
        && instructions.Any(instruction => instruction.Operand is MethodReference methodReference && methodReference.Name == eventPassIdGetter.Name)
        && instructions.Any(instruction => instruction.OpCode.Code == Code.Cgt);
}

static Instruction CreateLoadInt(ILProcessor il, int value)
{
    return value switch
    {
        -1 => il.Create(OpCodes.Ldc_I4_M1),
        0 => il.Create(OpCodes.Ldc_I4_0),
        1 => il.Create(OpCodes.Ldc_I4_1),
        2 => il.Create(OpCodes.Ldc_I4_2),
        3 => il.Create(OpCodes.Ldc_I4_3),
        4 => il.Create(OpCodes.Ldc_I4_4),
        5 => il.Create(OpCodes.Ldc_I4_5),
        6 => il.Create(OpCodes.Ldc_I4_6),
        7 => il.Create(OpCodes.Ldc_I4_7),
        8 => il.Create(OpCodes.Ldc_I4_8),
        >= sbyte.MinValue and <= sbyte.MaxValue => il.Create(OpCodes.Ldc_I4_S, (sbyte)value),
        _ => il.Create(OpCodes.Ldc_I4, value),
    };
}

static bool IsLoadInt(Instruction instruction, int value)
{
    return instruction.OpCode.Code switch
    {
        Code.Ldc_I4_M1 => value == -1,
        Code.Ldc_I4_0 => value == 0,
        Code.Ldc_I4_1 => value == 1,
        Code.Ldc_I4_2 => value == 2,
        Code.Ldc_I4_3 => value == 3,
        Code.Ldc_I4_4 => value == 4,
        Code.Ldc_I4_5 => value == 5,
        Code.Ldc_I4_6 => value == 6,
        Code.Ldc_I4_7 => value == 7,
        Code.Ldc_I4_8 => value == 8,
        Code.Ldc_I4_S => Convert.ToInt32(instruction.Operand) == value,
        Code.Ldc_I4 => Convert.ToInt32(instruction.Operand) == value,
        _ => false,
    };
}

static string ResolveManagedDir(string[] args)
{
    for (var index = 0; index < args.Length; index += 1)
    {
        if (args[index] is "--managed" or "--managed-dir")
        {
            if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} requires a path.");
            return Path.GetFullPath(args[index + 1]);
        }
    }

    foreach (var value in new[]
    {
        Environment.GetEnvironmentVariable("CS_COUNTERSIDE_MANAGED_DIR"),
        Environment.GetEnvironmentVariable("COUNTERSIDE_MANAGED_DIR"),
    })
    {
        if (!string.IsNullOrWhiteSpace(value)) return Path.GetFullPath(value);
    }

    foreach (var candidate in new[]
    {
        Path.Combine("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
    })
    {
        if (File.Exists(Path.Combine(candidate, "Assembly-CSharp.dll"))) return candidate;
    }

    throw new DirectoryNotFoundException("Could not locate CounterSide Data\\Managed. Pass --managed <path>.");
}

sealed record PatchOptions(
    bool Restore,
    bool RestoreFirst,
    bool Status,
    bool DisabledByEnv,
    bool ApplyContentUnlock,
    bool ApplyEventPassTimeGate,
    bool ApplyEventPassTempletFallback,
    bool ApplyLobbyEventPassSelfActivation,
    bool ApplyLobbyCounterPassFallbackRegistration,
    bool ApplyLobbyEventPassLayout,
    bool ApplyWorldMapRaidRefresh,
    bool ApplyGearPresetSelectionFix,
    bool ApplyGearInventoryOkBindFix,
    bool ApplyGearInventoryStateRepair,
    bool ApplyEpisodeProgressDifficultyFix,
    bool ApplyOperatorContractCategoryFix,
    bool ApplySteamLocalLogin,
    bool ApplyFrozenOfficialUpdateBypass,
    string FrozenServerInfoUrl)
{
    public static PatchOptions Parse(string[] args)
    {
        var restore = HasArg(args, "--restore");
        var status = HasArg(args, "--status");
        var envSwitch = HasArg(args, "--env-switch") || HasArg(args, "--from-env");
        var envPatchEnabled = ReadEnvFlag("CS_PATCH_COUNTER_PASS_CLIENT", "CS_COUNTER_PASS_CLIENT_PATCH");
        var envSteamLocalLoginEnabled = ReadEnvFlag("CS_PATCH_STEAM_LOCAL_LOGIN", "CS_STEAM_LOCAL_LOGIN_PATCH");
        var envFrozenOfficialUpdateBypassEnabled = ReadEnvFlag("CS_PATCH_FROZEN_OFFICIAL_UPDATE_BYPASS", "CS_FROZEN_OFFICIAL_UPDATE_BYPASS_PATCH");
        var legacyAll = HasArg(args, "--legacy-all") || HasArg(args, "--all");
        var disabledByEnv = !restore && !status && envSwitch && envPatchEnabled != true;
        var envDrivenCounterPassPatch = envSwitch && envPatchEnabled == true;
        var frozenServerInfoUrl = NormalizeFrozenServerInfoUrl(
            ReadArgValue(args, "--frozen-server-info-url")
            ?? Environment.GetEnvironmentVariable("CS_FROZEN_SERVER_INFO_URL"));
        return new PatchOptions(
            Restore: restore,
            RestoreFirst: !disabledByEnv && !restore && !status && (envSwitch || HasArg(args, "--restore-first") || HasArg(args, "--fresh")),
            Status: status,
            DisabledByEnv: disabledByEnv,
            ApplyContentUnlock: !HasArg(args, "--no-content-unlock"),
            ApplyEventPassTimeGate: !HasArg(args, "--no-time-gate"),
            ApplyEventPassTempletFallback: legacyAll || HasArg(args, "--include-template-fallback"),
            ApplyLobbyEventPassSelfActivation: envDrivenCounterPassPatch || legacyAll || HasArg(args, "--include-lobby-self-activation"),
            ApplyLobbyCounterPassFallbackRegistration: envDrivenCounterPassPatch || legacyAll || HasArg(args, "--include-lobby-fallback"),
            ApplyLobbyEventPassLayout: HasArg(args, "--include-lobby-layout") && !HasArg(args, "--no-lobby-layout"),
            ApplyWorldMapRaidRefresh: (envDrivenCounterPassPatch || legacyAll || HasArg(args, "--include-world-map-raid-refresh"))
                && !HasArg(args, "--no-world-map-raid-refresh"),
            ApplyGearPresetSelectionFix: (legacyAll || HasArg(args, "--include-gear-preset-selection-fix"))
                && !HasArg(args, "--no-gear-preset-selection-fix"),
            ApplyGearInventoryOkBindFix: (legacyAll || HasArg(args, "--include-gear-inventory-ok-bind-fix"))
                && !HasArg(args, "--no-gear-inventory-ok-bind-fix"),
            ApplyGearInventoryStateRepair: (legacyAll || HasArg(args, "--include-gear-inventory-state-repair"))
                && !HasArg(args, "--no-gear-inventory-state-repair"),
            ApplyEpisodeProgressDifficultyFix: !HasArg(args, "--no-episode-progress-difficulty-fix"),
            ApplyOperatorContractCategoryFix: !HasArg(args, "--no-operator-contract-category-fix"),
            ApplySteamLocalLogin: (envSteamLocalLoginEnabled == true || HasArg(args, "--include-steam-local-login"))
                && !HasArg(args, "--no-steam-local-login"),
            ApplyFrozenOfficialUpdateBypass: (envFrozenOfficialUpdateBypassEnabled == true || HasArg(args, "--include-frozen-official-update-bypass"))
                && !HasArg(args, "--no-frozen-official-update-bypass"),
            FrozenServerInfoUrl: frozenServerInfoUrl);
    }

    private static bool HasArg(string[] args, string name)
    {
        return args.Any(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));
    }

    private static string? ReadArgValue(string[] args, string name)
    {
        for (var index = 0; index < args.Length; index += 1)
        {
            if (!string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) continue;
            if (index + 1 >= args.Length) throw new ArgumentException($"{name} requires a value.");
            return args[index + 1];
        }
        return null;
    }

    private static string NormalizeFrozenServerInfoUrl(string? raw)
    {
        var value = string.IsNullOrWhiteSpace(raw)
            ? "http://127.0.0.1:8088/server_config/live/ServerInfo_V2.json"
            : raw.Trim();
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            throw new ArgumentException($"Frozen server-info URL must be absolute: {value}");
        }
        if (uri.Scheme is not ("http" or "https"))
        {
            throw new ArgumentException($"Frozen server-info URL must use http or https: {value}");
        }
        if (!IsLoopbackHost(uri.Host))
        {
            throw new ArgumentException($"Frozen server-info URL must point to loopback/local host: {value}");
        }
        return uri.ToString();
    }

    private static bool IsLoopbackHost(string host)
    {
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
        if (host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)) return true;
        if (host.Equals("::1", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool? ReadEnvFlag(params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (string.IsNullOrWhiteSpace(value)) continue;
            var normalized = value.Trim().ToLowerInvariant();
            if (normalized is "1" or "true" or "yes" or "on" or "patch" or "enabled") return true;
            if (normalized is "0" or "false" or "no" or "off" or "restore" or "disabled") return false;
        }
        return null;
    }
}
