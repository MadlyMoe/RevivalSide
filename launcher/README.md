# RevivalSide Launcher

This is RevivalSide's React 19 + Tauri 2 desktop launcher. Its visual foundation comes from [timeworn/revivalside-launcher](https://github.com/timeworn/revivalside-launcher); the placeholder actions have been replaced with the complete RevivalSide runtime workflow.

The launcher includes:

- listener start/stop with real-time logs and process-tree cleanup;
- frozen-client creation, patching, routing audit, Steam isolation, and direct launch;
- CounterSide detection and manual DLL selection;
- gameplay, wiki image, and cutscene background cache controls;
- User Manager and wiki launch controls;
- live Wireshark/Npcap Cross Save capture, extraction, import, export, and clipboard copy;
- server-time, ports, event, lobby ACK, tutorial, LAN, logging, and advanced environment settings;
- system tray behavior and unexpected-service notifications.

From this directory:

```powershell
npm install
npm run build
npm run tauri -- build --no-bundle
```

The Tauri process bridge calls `../tools/revivalside-launcher-backend.js`; it does not duplicate the game server itself. The repository-level `npm run build:launcher` command is the supported release build entry point.
