const assert = require("assert");
const fs = require("fs");
const { getStageCatalog, sanitizeScenario, simulateScenario } = require("./server");

assert.match(fs.readFileSync(require.resolve("./index.html"), "utf8"), /<title>Combat:Side<\/title>[\s\S]*<h1>Combat:Side<\/h1>/);

const scenario = {
  mode: "editable",
  duration: 10,
  delta: 0.1,
  stage: { stageId: 11211, dungeonId: 1004, mapId: 1064 },
  units: [
    { editorId: "left", name: "Left", team: 1, hp: 300, damage: 75, range: 100, speed: 50, cooldown: 0.5, x: 650 },
    { editorId: "right", name: "Right", team: 3, hp: 300, damage: 60, range: 100, speed: 50, cooldown: 0.5, x: 850 },
  ],
};

assert.throws(() => sanitizeScenario({ units: [] }), /choose between/);
const stages = getStageCatalog();
const tutorialStage = stages.find((stage) => stage.stageId === 11211);
assert.ok(stages.length > 100, "real stage catalog did not load");
assert.equal(tutorialStage.mapId, 1064);
assert.deepEqual([tutorialStage.camera.virtualWidth, tutorialStage.camera.virtualHeight, tutorialStage.camera.size], [1920, 1080, 500]);
assert.ok(tutorialStage.layers.length > 0, "tutorial stage layers were not found");
assert.ok(stages.find((stage) => stage.stageId === 11222).layers.some((layer) => layer.moveFactor > 0), "client map parallax rules were not loaded");
const result = simulateScenario(scenario);
assert.equal(result.engine, "CombatHost editable simulation");
assert.ok(result.frames.length > 2);
assert.ok(result.frames.some((frame) => frame.units.some((unit) => unit.hp < unit.maxHp)));
assert.equal(result.result.finished, true);
assert.ok(result.result.winner === 1 || result.result.winner === 3);
assert.deepEqual(result.stage, { stageId: 11211, dungeonId: 1004, mapId: 1064 });

const live = simulateScenario({
  mode: "live",
  duration: 8,
  delta: 1 / 30,
  stage: { stageId: 11222, dungeonId: 1001211, mapId: 1010 },
  units: [
    { editorId: "hilde", unitId: 1002, name: "Hilde", team: 1, level: 110, limitBreakLevel: 5, tacticLevel: 6, skillLevels: [5, 5, 5, 5, 5] },
    { editorId: "mina", unitId: 1001, name: "Yoo Mina", team: 1, level: 110, limitBreakLevel: 5, tacticLevel: 6, skillLevels: [5, 5, 5, 5, 5] },
  ],
});
assert.equal(live.engine, "CounterSide NKCGameServerLocal");
assert.equal(live.frames.length, 240);
assert.equal(live.autoUltimateEnabled, true, "managed Team A auto ultimate was not enabled");
assert.ok(live.frames.every((frame) => frame.autoUltimateEnabled), "managed runtime dropped auto ultimate during playback");
assert.ok(live.frames[0].mainUnitUidA > 0 && live.frames[0].mainUnitUidB > 0, "client HUD main-unit IDs were not captured");
assert.ok(live.frames.some((frame) => frame.units.some((unit) => unit.unitId === 1002)), "selected Hilde never entered the live stage");
const hildeFrame = live.frames.findIndex((frame) => frame.units.some((unit) => unit.unitId === 1002));
const minaFrame = live.frames.findIndex((frame) => frame.units.some((unit) => unit.unitId === 1001));
assert.ok(minaFrame > hildeFrame, "managed Team A auto deployment did not deploy the next deck unit");
assert.ok(live.frames.some((frame) => frame.units.some((unit) => unit.team === 3)), "stage enemies never entered the live stage");
assert.ok(Object.keys(live.unitAssets).some((bundle) => bundle.includes("nkm_unit_c_hilde")), "Hilde's combat Spine was not resolved");
const hildeAssets = Object.entries(live.unitAssets).find(([bundle]) => bundle.includes("nkm_unit_c_hilde"))[1];
assert.ok(Math.abs(hildeAssets.unity.skeletonDataScale - 0.01) < 0.0001, "Hilde SkeletonDataAsset scale was not read");
assert.ok(Math.abs(hildeAssets.unity.hierarchyScaleX - 28.5) < 0.001, "Hilde prefab hierarchy scale was not read");
assert.ok(live.frames.some((frame) => frame.units.some((unit) => unit.animation && unit.spriteBundleName)), "runtime animation data was not captured");
assert.ok(live.frames.some((frame) => frame.units.some((unit) => unit.spriteScale > 0 && unit.unitSizeY > 0)), "runtime unit scaling data was not captured");
assert.ok(live.frames.some((frame) => frame.units.some((unit) => unit.hasHyperSkill && unit.hyperSkillCooldownMax > 0)), "client ultimate cooldown state was not captured");
assert.ok(live.frames.some((frame) => frame.effects.length > 0), "client combat effects were not captured");

const awakened = simulateScenario({
  mode: "live",
  duration: 15,
  delta: 1 / 30,
  stage: { stageId: 11222, dungeonId: 1001211, mapId: 1010 },
  units: [
    { editorId: "awakened-na-yubin", unitId: 1071, name: "Awakened Na Yubin", team: 1, level: 110, limitBreakLevel: 5, tacticLevel: 6, skillLevels: [5, 5, 5, 5, 5] },
  ],
});
assert.ok(awakened.frames.some((frame) => frame.units.some((unit) => unit.unitId === 1071)), "Awakened Na Yubin never entered the live stage");
const awakenedNaYubinAssets = awakened.unitAssets.ab_unit_game_spine_nkm_unit_c_sixwing_na_yubin;
assert.ok(awakenedNaYubinAssets, "Awakened Na Yubin's combat Spine was not resolved");
assert.ok(Math.abs(awakenedNaYubinAssets.unity.skeletonDataScale - 0.01) < 0.0001, "Awakened Na Yubin selected an embedded FX skeleton instead of the unit skeleton");
assert.ok(Math.abs(awakenedNaYubinAssets.unity.hierarchyScaleX - 31) < 0.001, "Awakened Na Yubin prefab hierarchy scale was not read");
const awakenedSkill = awakened.frames.flatMap((frame) => frame.units).find((unit) => unit.unitId === 1071 && unit.skillType === "NST_SKILL");
assert.equal(awakenedSkill && awakenedSkill.animation, "SKILL1", "Awakened Na Yubin's real skill animation was not captured");
const awakenedEffect = awakened.frames.flatMap((frame) => frame.effects).find((effect) => effect.masterUnitUid > 0 && effect.clientEvent);
assert.ok(awakenedEffect && Number.isFinite(awakenedEffect.offsetX) && Number.isFinite(awakenedEffect.offsetY), "client skill-effect attachment metadata was not captured");
console.log(`[combat-simulator] PASS stages=${stages.length} editableFrames=${result.frames.length} liveFrames=${live.frames.length}`);
