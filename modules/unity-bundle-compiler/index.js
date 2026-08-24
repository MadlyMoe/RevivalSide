const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REQUIRED_UNITY_VERSION = "2022.3.62f2";
const ALLOWED_SOURCE_EXTENSIONS = new Set([".anim", ".asset", ".atlas", ".bytes", ".controller", ".fbx", ".gif", ".jpeg", ".jpg", ".json", ".mat", ".meta", ".mp3", ".obj", ".ogg", ".png", ".prefab", ".shader", ".skel", ".tga", ".txt", ".wav", ".webp"]);

function createUnityBundleCompiler(options = {}) {
  const env = options.env || process.env;
  const requiredVersion = options.requiredVersion || REQUIRED_UNITY_VERSION;

  function status() {
    const editorPath = findUnityEditor(env, requiredVersion);
    return {
      requiredVersion,
      editorPath,
      available: Boolean(editorPath),
      targets: ["windows", "android"],
      message: editorPath
        ? `Unity ${requiredVersion} is ready for Windows and Android AssetBundle builds.`
        : `Install Unity ${requiredVersion} or set CS_UNITY_EDITOR to its Unity.exe.`,
    };
  }

  async function build(project, input = {}) {
    const current = status();
    if (!current.available) throw httpError(409, current.message);
    const bundleName = validateBundleName(input.bundleName);
    const target = normalizeBuildTarget(input.target);
    const encryptHeader = input.encryptHeader === true;
    if (encryptHeader && !/\.(?:vkor|vjpn)$/.test(bundleName)) throw httpError(400, "CounterSide voice bundle encryption requires a .vkor or .vjpn bundle name.");
    const requested = Array.isArray(input.assets) ? input.assets : [];
    if (!requested.length) throw httpError(400, "Select at least one source asset.");

    const sourceRoot = path.join(project.root, "assets", "source");
    const assets = requested.map((value) => resolveSourceAsset(sourceRoot, value));
    const assetPaths = new Set(assets.map((asset) => asset.relativePath.toLowerCase()));
    const spriteAssets = new Set((Array.isArray(input.spriteAssets) ? input.spriteAssets : []).map((value) => {
      const asset = resolveSourceAsset(sourceRoot, value);
      if (!assetPaths.has(asset.relativePath.toLowerCase())) throw httpError(400, `Sprite source is not included in this build: ${asset.relativePath}`);
      if (path.extname(asset.filePath).toLowerCase() !== ".png") throw httpError(415, `Sprite source must be a PNG: ${asset.relativePath}`);
      return asset.relativePath.toLowerCase();
    }));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "modside-unity-"));
    const projectRoot = path.join(temporary, "project");
    const outputRoot = path.join(temporary, "output");
    const logPath = path.join(temporary, "unity.log");
    try {
      fs.mkdirSync(path.join(projectRoot, "Assets", "Editor"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "Assets", "ModSideSource"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "ProjectSettings"), { recursive: true });
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${requiredVersion}\nm_EditorVersionWithRevision: ${requiredVersion}\n`, "utf8");
      fs.writeFileSync(path.join(projectRoot, "Assets", "Editor", "ModSideAssetBundleCompiler.cs"), EDITOR_SCRIPT, "utf8");

      const unityAssets = assets.map((asset) => {
        const target = path.join(projectRoot, "Assets", "ModSideSource", asset.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(asset.filePath, target);
        return `Assets/ModSideSource/${asset.relativePath.replace(/\\/g, "/")}`;
      });
      const unitySpriteAssets = assets.filter((asset) => spriteAssets.has(asset.relativePath.toLowerCase())).map((asset) => `Assets/ModSideSource/${asset.relativePath.replace(/\\/g, "/")}`);
      const specPath = path.join(temporary, "bundle-spec.json");
      fs.writeFileSync(specPath, JSON.stringify({ target, bundles: [{ name: bundleName, assets: unityAssets, spriteAssets: unitySpriteAssets }] }), "utf8");
      await runUnity(current.editorPath, projectRoot, specPath, outputRoot, logPath, options.timeoutMs || 15 * 60 * 1000);

      const builtPath = path.join(outputRoot, bundleName);
      if (!fs.existsSync(builtPath)) throw httpError(500, `Unity completed without producing ${bundleName}.`);
      const destination = path.join(project.root, "assets", target === "android" ? "android-bundles" : "bundles", bundleName);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const bundle = fs.readFileSync(builtPath);
      fs.writeFileSync(destination, encryptHeader ? transformCounterSideBundleHeader(bundle, bundleName) : bundle);
      return {
        bundleName,
        target,
        path: path.relative(project.root, destination).replace(/\\/g, "/"),
        bytes: fs.statSync(destination).size,
        encryptedHeader: encryptHeader,
        spriteCount: unitySpriteAssets.length,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex"),
      };
    } catch (err) {
      if (!err.statusCode && fs.existsSync(logPath)) err.message += `\n${fs.readFileSync(logPath, "utf8").slice(-8000)}`;
      throw err;
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  return { status, build };
}

function transformCounterSideBundleHeader(input, bundleName) {
  const output = Buffer.from(input);
  const stem = path.parse(path.basename(bundleName)).name.toLowerCase();
  const digest = crypto.createHash("md5").update(stem).digest("hex");
  const masks = [digest.slice(0, 16), digest.slice(16, 32), digest.slice(0, 8) + digest.slice(16, 24), digest.slice(8, 16) + digest.slice(24, 32)].map((value) => BigInt(`0x${value}`));
  const size = Math.min(output.length, 212);
  for (let offset = 0, chunk = 0; offset < size; offset += 8, chunk += 1) {
    const mask = masks[chunk % masks.length];
    const remaining = size - offset;
    if (remaining < 8) for (let index = 0; index < remaining; index += 1) output[offset + index] ^= Number(mask & 255n);
    else for (let index = 0; index < 8; index += 1) output[offset + index] ^= Number((mask >> BigInt(index * 8)) & 255n);
  }
  return output;
}

function findUnityEditor(env, version) {
  const candidates = [
    env.CS_UNITY_EDITOR,
    env.UNITY_EDITOR_PATH,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Unity", "Hub", "Editor", version, "Editor", "Unity.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Unity Hub", "Editor", version, "Editor", "Unity.exe"),
  ].filter(Boolean).map((value) => path.resolve(value));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
}

function validateBundleName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(name)) throw httpError(400, "Bundle name must be 2-128 lowercase letters, numbers, dots, dashes, or underscores.");
  return name;
}

function normalizeBuildTarget(value) {
  const target = String(value || "windows").trim().toLowerCase();
  if (target !== "windows" && target !== "android") throw httpError(400, "AssetBundle target must be windows or android.");
  return target;
}

function resolveSourceAsset(root, value) {
  const relativePath = String(value || "").replace(/\\/g, "/").replace(/^assets\/source\//, "").replace(/^\/+/, "");
  const filePath = path.resolve(root, relativePath);
  if (!relativePath || !isInside(root, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw httpError(404, `Asset source was not found: ${relativePath}`);
  if (!ALLOWED_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw httpError(415, `Unity source type is not allowed: ${path.extname(filePath) || "extensionless file"}`);
  return { filePath, relativePath };
}

function runUnity(editorPath, projectRoot, specPath, outputRoot, logPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ["-batchmode", "-quit", "-nographics", "-accept-apiupdate", "-projectPath", projectRoot, "-executeMethod", "ModSideAssetBundleCompiler.Build", "-modSideSpec", specPath, "-modSideOutput", outputRoot, "-logFile", logPath];
    const child = spawn(editorPath, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(httpError(504, "Unity AssetBundle build timed out."));
    }, timeoutMs);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(httpError(422, `Unity AssetBundle build failed with exit code ${code}.`));
    });
  });
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const EDITOR_SCRIPT = String.raw`using System;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class ModSideAssetBundleCompiler
{
    [Serializable] private sealed class BundleSpec { public string target; public Bundle[] bundles; }
    [Serializable] private sealed class Bundle { public string name; public string[] assets; public string[] spriteAssets; }

    public static void Build()
    {
        string specPath = Arg("-modSideSpec");
        string outputPath = Arg("-modSideOutput");
        Directory.CreateDirectory(outputPath);
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        BundleSpec spec = JsonUtility.FromJson<BundleSpec>(File.ReadAllText(specPath));
        foreach (Bundle bundle in spec.bundles)
        {
            if (bundle.spriteAssets == null) continue;
            foreach (string assetPath in bundle.spriteAssets)
            {
                TextureImporter importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
                if (importer == null) throw new Exception("Sprite source is not a texture: " + assetPath);
                importer.textureType = TextureImporterType.Sprite;
                importer.spriteImportMode = SpriteImportMode.Single;
                importer.alphaIsTransparency = true;
                importer.SaveAndReimport();
            }
        }
        var builds = new AssetBundleBuild[spec.bundles.Length];
        for (int i = 0; i < spec.bundles.Length; i++)
        {
            builds[i] = new AssetBundleBuild { assetBundleName = spec.bundles[i].name, assetNames = spec.bundles[i].assets };
        }
        BuildTarget target = string.Equals(spec.target, "android", StringComparison.OrdinalIgnoreCase)
            ? BuildTarget.Android
            : BuildTarget.StandaloneWindows64;
        var manifest = BuildPipeline.BuildAssetBundles(outputPath, builds,
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.DeterministicAssetBundle,
            target);
        if (manifest == null) throw new Exception("BuildPipeline.BuildAssetBundles returned null.");
    }

    private static string Arg(string name)
    {
        string[] args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        throw new ArgumentException("Missing argument: " + name);
    }
}`;

module.exports = { ALLOWED_SOURCE_EXTENSIONS, EDITOR_SCRIPT, REQUIRED_UNITY_VERSION, createUnityBundleCompiler, findUnityEditor, normalizeBuildTarget, transformCounterSideBundleHeader };
