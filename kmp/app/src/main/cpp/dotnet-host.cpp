#include <dlfcn.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

using hostfxr_main_fn = int (*)(int argc, const char** argv);
using hostfxr_main_startupinfo_fn = int (*)(
    int argc,
    const char** argv,
    const char* host_path,
    const char* dotnet_root,
    const char* app_path
);
using mono_set_dirs_fn = void (*)(const char* assembly_dir, const char* config_dir);
using mono_set_assemblies_path_fn = void (*)(const char* path);
using mono_config_parse_fn = void (*)(const char* filename);
using mono_jit_init_version_fn = void* (*)(const char* root_domain_name, const char* runtime_version);
using mono_domain_assembly_open_fn = void* (*)(void* domain, const char* name);
using mono_jit_exec_fn = int (*)(void* domain, void* assembly, int argc, char** argv);
using mono_jit_cleanup_fn = int (*)(void* domain);

static std::string dirname_of(const char* path) {
    if (path == nullptr || path[0] == '\0') return ".";
    std::string value(path);
    const auto slash = value.find_last_of('/');
    if (slash == std::string::npos) return ".";
    if (slash == 0) return "/";
    return value.substr(0, slash);
}

static std::string join_path(const std::string& left, const char* right) {
    if (left.empty() || left == ".") return right;
    if (left.back() == '/') return left + right;
    return left + "/" + right;
}

static std::string runtime_root_for(int argc, char** argv) {
    const char* explicit_root = std::getenv("REVIVALSIDE_DOTNET_ROOT");
    if (explicit_root != nullptr && explicit_root[0] != '\0') return explicit_root;
    if (argc > 1) return dirname_of(argv[1]);
    return dirname_of(argv[0]);
}

static std::string native_root_for(char** argv) {
    const char* explicit_root = std::getenv("REVIVALSIDE_DOTNET_NATIVE_ROOT");
    if (explicit_root != nullptr && explicit_root[0] != '\0') return explicit_root;
    return dirname_of(argv[0]);
}

static void* load_hostfxr(const std::string& native_root, const std::string& runtime_root, std::string* loaded_path) {
    const std::string native_hostfxr = join_path(native_root, "libhostfxr.so");
    void* hostfxr = dlopen(native_hostfxr.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (hostfxr != nullptr) {
        if (loaded_path != nullptr) *loaded_path = native_hostfxr;
        return hostfxr;
    }

    const std::string runtime_hostfxr = join_path(runtime_root, "libhostfxr.so");
    hostfxr = dlopen(runtime_hostfxr.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (hostfxr != nullptr) {
        if (loaded_path != nullptr) *loaded_path = runtime_hostfxr;
        return hostfxr;
    }

    return nullptr;
}

static int run_mono(const std::string& native_root, const std::string& runtime_root, int argc, char** argv) {
    const std::string native_mono = join_path(native_root, "libmonosgen-2.0.so");
    void* mono = dlopen(native_mono.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (mono == nullptr) {
        const std::string runtime_mono = join_path(runtime_root, "libmonosgen-2.0.so");
        mono = dlopen(runtime_mono.c_str(), RTLD_NOW | RTLD_GLOBAL);
    }
    if (mono == nullptr) {
        std::fprintf(stderr, "revivalside-dotnet-host: neither hostfxr nor Mono could be loaded: %s\n", dlerror());
        return 127;
    }

    auto set_dirs = reinterpret_cast<mono_set_dirs_fn>(dlsym(mono, "mono_set_dirs"));
    auto set_assemblies_path = reinterpret_cast<mono_set_assemblies_path_fn>(dlsym(mono, "mono_set_assemblies_path"));
    auto config_parse = reinterpret_cast<mono_config_parse_fn>(dlsym(mono, "mono_config_parse"));
    auto jit_init = reinterpret_cast<mono_jit_init_version_fn>(dlsym(mono, "mono_jit_init_version"));
    auto assembly_open = reinterpret_cast<mono_domain_assembly_open_fn>(dlsym(mono, "mono_domain_assembly_open"));
    auto jit_exec = reinterpret_cast<mono_jit_exec_fn>(dlsym(mono, "mono_jit_exec"));
    auto jit_cleanup = reinterpret_cast<mono_jit_cleanup_fn>(dlsym(mono, "mono_jit_cleanup"));
    if (set_dirs == nullptr || set_assemblies_path == nullptr || config_parse == nullptr || jit_init == nullptr ||
        assembly_open == nullptr || jit_exec == nullptr || jit_cleanup == nullptr || argc < 2) {
        std::fprintf(stderr, "revivalside-dotnet-host: incomplete Mono embedding API or missing managed assembly argument\n");
        dlclose(mono);
        return 127;
    }

    set_dirs(runtime_root.c_str(), runtime_root.c_str());
    set_assemblies_path(runtime_root.c_str());
    config_parse(nullptr);
    void* domain = jit_init("revivalside-combat-host", "v4.0.30319");
    void* assembly = domain == nullptr ? nullptr : assembly_open(domain, argv[1]);
    if (assembly == nullptr) {
        std::fprintf(stderr, "revivalside-dotnet-host: Mono failed to load %s\n", argv[1]);
        if (domain != nullptr) jit_cleanup(domain);
        dlclose(mono);
        return 127;
    }
    const int result = jit_exec(domain, assembly, argc - 1, argv + 1);
    jit_cleanup(domain);
    dlclose(mono);
    return result;
}

int main(int argc, char** argv) {
    const std::string runtime_root = runtime_root_for(argc, argv);
    const std::string native_root = native_root_for(argv);
    std::string hostfxr_path;

    setenv("DOTNET_ROOT", native_root.c_str(), 1);
    setenv("REVIVALSIDE_DOTNET_ROOT", runtime_root.c_str(), 1);
    setenv("REVIVALSIDE_DOTNET_NATIVE_ROOT", native_root.c_str(), 1);
    chdir(runtime_root.c_str());

    void* hostfxr = load_hostfxr(native_root, runtime_root, &hostfxr_path);
    if (hostfxr == nullptr) {
        return run_mono(native_root, runtime_root, argc, argv);
    }

    auto hostfxr_main_startupinfo = reinterpret_cast<hostfxr_main_startupinfo_fn>(
        dlsym(hostfxr, "hostfxr_main_startupinfo")
    );
    if (hostfxr_main_startupinfo != nullptr) {
        const char* app_path = argc > 1 ? argv[1] : nullptr;
        return hostfxr_main_startupinfo(argc, const_cast<const char**>(argv), argv[0], native_root.c_str(), app_path);
    }

    auto hostfxr_main = reinterpret_cast<hostfxr_main_fn>(dlsym(hostfxr, "hostfxr_main"));
    if (hostfxr_main == nullptr) {
        std::fprintf(stderr, "revivalside-dotnet-host: hostfxr_main missing: %s\n", dlerror());
        dlclose(hostfxr);
        return 127;
    }

    return hostfxr_main(argc, const_cast<const char**>(argv));
}
