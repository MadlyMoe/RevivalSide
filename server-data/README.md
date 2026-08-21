# CounterSide Server Data

Generated from parsed `ab_script*` Lua table bytecode.

- `units.json`: unit templates merged with stat templates, indexed by unit id and string id.
- `items.json`: item/equipment/piece tables grouped by table name.
- `dungeons.json`: dungeon base templates indexed by dungeon id and string id.
- `warfare.json`: warfare templates indexed by id and string id.
- `strings.json`: localized string tables by language code.
- `table_catalog.json`: every parsed table with relative source path and detected ID fields.

The full parsed table JSON normally lives in `gameplay-jsons/StreamingAssets`. The installed-client gameplay asset cache is Lua bytecode, not parsed JSON, so it is not a source for this server-data builder.
