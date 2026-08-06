using Mono.Cecil;
using Mono.Cecil.Cil;

namespace RevivalSide.CombatHost;

internal static class ManagedAssemblyPatcher
{
    public static string GetAssemblyPath(string managedDir, string gameplayTablesDir)
    {
        var sourceAssembly = Path.Combine(managedDir, "Assembly-CSharp.dll");
        if (string.IsNullOrWhiteSpace(gameplayTablesDir) || !Directory.Exists(gameplayTablesDir))
        {
            return sourceAssembly;
        }

        var patchKey = BuildPatchKey(sourceAssembly);
        var outputDir = Path.Combine(AppContext.BaseDirectory, "patched-managed", patchKey);
        Directory.CreateDirectory(outputDir);
        var outputAssembly = Path.Combine(outputDir, "Assembly-CSharp.dll");

        if (!IsUsableAssembly(outputAssembly))
        {
            var tempAssembly = outputAssembly + ".tmp";
            if (File.Exists(tempAssembly))
            {
                File.Delete(tempAssembly);
            }
            PatchAssembly(sourceAssembly, tempAssembly);
            File.SetLastWriteTimeUtc(tempAssembly, File.GetLastWriteTimeUtc(sourceAssembly));
            if (File.Exists(outputAssembly))
            {
                File.Delete(outputAssembly);
            }
            File.Move(tempAssembly, outputAssembly);
            File.SetLastWriteTimeUtc(outputAssembly, File.GetLastWriteTimeUtc(sourceAssembly));
        }
        return outputAssembly;
    }

    private static bool IsUsableAssembly(string assemblyPath)
    {
        try
        {
            if (!File.Exists(assemblyPath)) return false;
            if (new FileInfo(assemblyPath).Length <= 0) return false;
            using var module = ModuleDefinition.ReadModule(assemblyPath);
            return module.Types.Count > 0;
        }
        catch
        {
            return false;
        }
    }

    private static string BuildPatchKey(string sourceAssembly)
    {
        var sourceStamp = File.GetLastWriteTimeUtc(sourceAssembly).Ticks;
        var hostPath = Environment.ProcessPath;
        var hostStamp = !string.IsNullOrWhiteSpace(hostPath) && File.Exists(hostPath)
            ? File.GetLastWriteTimeUtc(hostPath).Ticks
            : typeof(ManagedAssemblyPatcher).Assembly.GetName().Version?.GetHashCode() ?? 0;
        return $"{sourceStamp:x}-{hostStamp:x}";
    }

    private static void PatchAssembly(string sourceAssembly, string outputAssembly)
    {
        var resolver = new DefaultAssemblyResolver();
        resolver.AddSearchDirectory(Path.GetDirectoryName(sourceAssembly)!);
        resolver.AddSearchDirectory(AppContext.BaseDirectory);

        var reader = new ReaderParameters { AssemblyResolver = resolver };
        using var module = ModuleDefinition.ReadModule(sourceAssembly, reader);
        PatchLuaLoader(module);
        PatchUnityLogging(module);
        PatchNoOp(module, "NKC.NKCMain", "NKCInitLocalContentsVersion");
        PatchNoOp(module, "NKM.NKMContentsVersionManager", "LoadDefaultVersion");
        PatchBoolReturn(module, "NKM.NKMContentsVersionManager", "SetCurrent", true);
        PatchBoolReturn(module, "NKC.NKCMain", "IsSafeMode", false);
        PatchNoOp(module, "NKM.Templet.Office.NKMOfficeGradeTemplet", "LoadFromLua");
        PatchNoOp(module, "NKM.NKMGameTeamDeckData", "InitRespawnLimitCount");
        PatchNoOp(module, "NKM.NKMItemManager", "LoadFromLUA_ITEM_MISC");
        PatchNoOp(module, "NKM.NKMItemManager", "CheckValidation");
        PatchBoolReturn(module, "NKM.NKMItemManager", "LoadFromLua_Random_Mold_Box", false);
        PatchBoolReturn(module, "NKM.NKMItemManager", "LoadFromLua_Item_Mold_Tab", false);
        PatchBoolReturn(module, "NKM.NKMItemManager", "LoadFromLua_Item_AutoWeight", false);
        PatchNoOp(module, "NKC.NKCSocketManager", "Disconnect");
        PatchNoOp(module, "NKC.NKCSocketManager", "CloseSocket");
        PatchNoOp(module, "NKC.NKCConnectGame", "Disconnect");
        PatchNoOp(module, "NKC.NKCConnectGame", "CloseSocket");
        PatchNkcInitCombatOnly(module);
        module.Write(outputAssembly);
    }

    private static void PatchLuaLoader(ModuleDefinition module)
    {
        var luaType = module.Types.First(type => type.FullName == "NKM.NKMLua");
        var method = luaType.Methods.First(m =>
            m.Name == "LoadCommonPathBase"
            && m.Parameters.Count == 5
            && m.Parameters[0].ParameterType.FullName == "System.String");

        var loaderMethod = typeof(ManagedLuaFileLoader).GetMethod(nameof(ManagedLuaFileLoader.LoadCommonPathBase))!;
        var loaderReference = module.ImportReference(loaderMethod);

        method.Body.ExceptionHandlers.Clear();
        method.Body.Variables.Clear();
        method.Body.InitLocals = false;
        var il = method.Body.GetILProcessor();
        method.Body.Instructions.Clear();
        il.Append(il.Create(OpCodes.Ldarg_0));
        il.Append(il.Create(OpCodes.Ldarg_1));
        il.Append(il.Create(OpCodes.Ldarg_2));
        il.Append(il.Create(OpCodes.Ldarg_3));
        il.Append(il.Create(OpCodes.Ldarg_S, method.Parameters[3]));
        il.Append(il.Create(OpCodes.Ldarg_S, method.Parameters[4]));
        il.Append(il.Create(OpCodes.Call, loaderReference));
        il.Append(il.Create(OpCodes.Ret));
    }

    private static void PatchUnityLogging(ModuleDefinition module)
    {
        var logType = module.Types.FirstOrDefault(type => type.FullName == "Cs.Logging.Log");
        if (logType == null) return;
        foreach (var method in logType.Methods.Where(method => method.HasBody && method.ReturnType.MetadataType == MetadataType.Void))
        {
            method.Body.ExceptionHandlers.Clear();
            method.Body.Variables.Clear();
            method.Body.InitLocals = false;
            var il = method.Body.GetILProcessor();
            method.Body.Instructions.Clear();
            il.Append(il.Create(OpCodes.Ret));
        }
    }

    private static void PatchNoOp(ModuleDefinition module, string typeName, string methodName)
    {
        var type = module.Types.FirstOrDefault(type => type.FullName == typeName);
        var method = type?.Methods.FirstOrDefault(method => method.Name == methodName && method.HasBody);
        if (method == null || method.ReturnType.MetadataType != MetadataType.Void) return;
        method.Body.ExceptionHandlers.Clear();
        method.Body.Variables.Clear();
        method.Body.InitLocals = false;
        var il = method.Body.GetILProcessor();
        method.Body.Instructions.Clear();
        il.Append(il.Create(OpCodes.Ret));
    }

    private static void PatchBoolReturn(ModuleDefinition module, string typeName, string methodName, bool value)
    {
        var type = module.Types.FirstOrDefault(type => type.FullName == typeName);
        var method = type?.Methods.FirstOrDefault(method => method.Name == methodName && method.HasBody);
        if (method == null || method.ReturnType.MetadataType != MetadataType.Boolean) return;
        method.Body.ExceptionHandlers.Clear();
        method.Body.Variables.Clear();
        method.Body.InitLocals = false;
        var il = method.Body.GetILProcessor();
        method.Body.Instructions.Clear();
        il.Append(il.Create(value ? OpCodes.Ldc_I4_1 : OpCodes.Ldc_I4_0));
        il.Append(il.Create(OpCodes.Ret));
    }

    private static void PatchNkcInitCombatOnly(ModuleDefinition module)
    {
        var type = module.Types.FirstOrDefault(type => type.FullName == "NKC.NKCMain");
        var method = type?.Methods.FirstOrDefault(method => method.Name == "NKCInit" && method.HasBody);
        if (method == null) return;

        var instructions = method.Body.Instructions;
        var lastCombatInit = instructions.Select((instruction, index) => new { instruction, index })
            .LastOrDefault(item =>
                item.instruction.OpCode == OpCodes.Call &&
                item.instruction.Operand is MethodReference called &&
                called.DeclaringType.FullName == "NKM.Game.NKMEventConditionV2" &&
                called.Name == "LoadTempletMacro");
        if (lastCombatInit == null) return;

        var il = method.Body.GetILProcessor();
        for (var index = instructions.Count - 1; index > lastCombatInit.index; index -= 1)
        {
            instructions.RemoveAt(index);
        }
        il.Append(il.Create(OpCodes.Ret));
    }
}
