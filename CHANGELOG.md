# RevivalSide changelog

## 0.4.0 - 2026-08-04

Changes since the PC v0.3.6 release.

### Mod tools

- Added the Mod:Side home, creator, loader, collision-safe editing/copying, and specialized Asset:Side, Story:Side, Unit:Side, Combat:Side, and Spine 3.7 Studio apps.
- Rebuilt Unit:Side as a complete unit maker with all employee, NPC, enemy, boss, ship, and BASE2 templates; multi-unit packs; existing-unit editing; accurate skills; appearances; lazy avatars/previews; collection/profile and association metadata; voice extraction/editing; new voice lines; and MP3 voice-bundle conversion.
- Expanded Story:Side with CounterSide-style episode organization, editable existing episodes, project copying, full stage/cutscene authoring, and dungeon-ID collision resolution.

### Runtime and launcher

- Made custom, duplicated, and boss-derived units load consistently in CombatHost with movement, skills, skill bars/icons, voices, skins, and full-squad support.
- Added independent Mod:Side and Combat:Side services, asset extraction progress, the Mod:Side home landing page, Cross Save capture/export/import, event login backgrounds, frozen-client controls, the updated Discord invite, and reliable log-folder opening.
- Added responsive launcher settings/state and single-instance focus behavior.

### Game and PC packaging

- Fixed Boss Raid duplicate handling plus tutorial/stage progression, squad loadouts, limit breaks, event shops, random-box rewards, and frozen-content compatibility.
- Added the lazy local wiki and content-addressed Windows components for x64, x86, and ARM64 while preserving profiles, settings, captures, exports, mods, and logs during upgrades.
