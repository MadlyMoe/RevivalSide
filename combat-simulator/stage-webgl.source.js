import * as PIXI from "pixi.js";
import { TextureAtlas } from "@pixi-spine/base";
import { Spine } from "@pixi-spine/runtime-3.7";
import { SkeletonBinary37 } from "../SpineViewer/src/skeletonBinary37";

const host = document.querySelector("#stageWebgl");
if (!host) throw new Error("Missing WebGL stage host");

PIXI.BaseTexture.defaultOptions.scaleMode = PIXI.SCALE_MODES.LINEAR;
PIXI.utils.rgb2hex = (rgb) => PIXI.Color.shared.setValue(rgb).toNumber();
const app = new PIXI.Application({
  resizeTo: host,
  backgroundColor: 0x090e15,
  antialias: true,
  autoDensity: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2),
});
app.stage.sortableChildren = true;
host.appendChild(app.view);

let active = null;
let activeStage = null;
let loadId = 0;
let manualCameraX = null;
const actorLayer = new PIXI.Container();
const effectLayer = new PIXI.Container();
const actorData = new Map();
const actors = new Map();
const effectData = new Map();
const effects = new Map();
actorLayer.sortableChildren = true;
actorLayer.zIndex = 100;
effectLayer.sortableChildren = true;
effectLayer.zIndex = 150;
app.stage.addChild(actorLayer);
app.stage.addChild(effectLayer);

async function load(stage) {
  const requestId = ++loadId;
  clearStage();
  activeStage = stage;
  manualCameraX = null;
  const result = stage.layers && stage.layers.length
    ? await loadLayers(stage.layers)
    : stage.spine
      ? await loadSpine(stage.spine)
      : Promise.reject(new Error("Stage has no renderable assets"));
  if (requestId !== loadId) {
    result.container.destroy({ children: true });
    throw new Error("Stage load superseded");
  }
  active = result;
  result.container.zIndex = 0;
  app.stage.addChild(result.container);
  fitActive();
  return { renderer: result.renderer };
}

async function prepareUnits(assetSets = {}) {
  clearUnits();
  const loaded = await Promise.all(Object.entries(assetSets).map(async ([bundle, files]) => {
    try {
      return [bundle.toLowerCase(), await loadSpineData(files)];
    } catch (error) {
      console.warn(`[combat-simulator] unit Spine failed ${bundle}: ${error.message}`);
      return null;
    }
  }));
  for (const entry of loaded) if (entry) actorData.set(entry[0], entry[1]);
  return { loaded: actorData.size, requested: Object.keys(assetSets).length };
}

async function prepareEffects(assetSets = {}) {
  clearEffects();
  const loaded = await Promise.all(Object.entries(assetSets).map(async ([bundle, files]) => {
    try {
      const data = files.frames
        ? { textures: await Promise.all(files.frames.map((url) => PIXI.Assets.load(url))) }
        : await loadSpineData(files);
      return [bundle.toLowerCase(), data];
    } catch (error) {
      console.warn(`[combat-simulator] effect asset failed ${bundle}: ${error.message}`);
      return null;
    }
  }));
  for (const entry of loaded) if (entry) effectData.set(entry[0], entry[1]);
  return { loaded: effectData.size, requested: Object.keys(assetSets).length };
}

function render(frame) {
  const visible = new Set();
  for (const unit of frame && frame.units || []) {
    const bundle = String(unit.spriteBundleName || "").toLowerCase();
    const data = actorData.get(bundle);
    if (!data) continue;
    const key = String(unit.gameUnitUid || unit.id || "");
    let actor = actors.get(key);
    if (!actor || actor.bundle !== bundle) {
      if (actor) destroyActor(key, actor);
      actor = createActor(bundle, data, unit);
      actors.set(key, actor);
    }
    updateActor(actor, unit, frame);
    visible.add(key);
  }
  for (const [key, actor] of actors) actor.spine.visible = visible.has(key);
  renderEffects(frame);
  updateStageCamera(frame);
  return visible;
}

function renderEffects(frame) {
  const visible = new Set();
  for (const effect of frame && frame.effects || []) {
    const bundle = String(effect.effectBundleName || effect.mainEffectName || "").toLowerCase();
    const data = effectData.get(bundle);
    if (!data) continue;
    const key = String(effect.effectUid || "");
    let actor = effects.get(key);
    if (!actor || actor.bundle !== bundle) {
      if (actor) destroyEffect(key, actor);
      const display = data.skeleton ? new Spine(data.skeleton) : new PIXI.AnimatedSprite(data.textures);
      display.autoUpdate = false;
      display.eventMode = "none";
      if (display.anchor) display.anchor.set(0.5);
      effectLayer.addChild(display);
      actor = { bundle, data, display, animation: "", anchorWorld: null, boneRotation: 0, right: Boolean(effect.right) };
      effects.set(key, actor);
    }
    updateEffect(actor, effect, frame);
    visible.add(key);
  }
  for (const [key, actor] of effects) actor.display.visible = visible.has(key);
}

function updateEffect(actor, effect, frame) {
  const { display, data } = actor;
  if (data.skeleton) {
    const animation = chooseAnimation(data.skeleton, effect.animation);
    if (animation && animation !== actor.animation) {
      display.state.clearTracks();
      display.skeleton.setToSetupPose();
      display.state.setAnimation(0, animation, Boolean(effect.animationLoop));
      actor.animation = animation;
    }
    const track = display.state.getCurrent(0);
    if (track) track.trackTime = Math.max(0, Number(effect.animationTime || 0));
    display.update(0);
  } else if (data.textures.length) {
    display.gotoAndStop(Math.floor(Number(effect.animationTime || 0) * 30) % data.textures.length);
  }
  const attached = effect.clientEvent && !effect.fixedPosition;
  if (!actor.anchorWorld || effect.followMaster) {
    const owner = attached && (frame.units || []).find((unit) => Number(unit.gameUnitUid || unit.id) === Number(effect.masterUnitUid));
    const ownerActor = owner && actors.get(String(owner.gameUnitUid || owner.id || ""));
    const bone = ownerActor && effect.boneName && ownerActor.spine.skeleton.findBone(effect.boneName);
    const view = battleView(frame);
    let world;
    if (bone) {
      const point = ownerActor.spine.toGlobal(new PIXI.Point(bone.worldX, bone.worldY));
      world = {
        x: view.cameraX + ((point.x - view.left) / view.fit - view.virtualWidth / 2) / view.worldScale,
        y: view.cameraY - ((point.y - view.top) / view.fit - view.virtualHeight / 2) / view.worldScale,
      };
    } else if (owner) {
      world = { x: Number(owner.x || 0), y: Number(owner.z || 0) + (effect.landConnect ? 0 : Number(owner.jumpY || 0)) };
    } else {
      world = { x: Number(effect.x || 0), y: Number(effect.z || 0) + Number(effect.jumpY || 0) };
    }
    actor.right = Boolean(effect.forceRight || (!bone && effect.followMaster && owner ? owner.right : effect.right));
    actor.anchorWorld = owner ? {
      x: world.x + Number(effect.offsetX || 0) * (actor.right || effect.useBoneRotate ? 1 : -1),
      y: world.y + Number(effect.offsetY || 0) + (effect.useOffsetZtoY ? Number(effect.offsetZ || 0) : 0),
    } : world;
    actor.boneRotation = effect.useBoneRotate && bone
      ? Number(ownerActor.data.unity.hierarchyRotation || 0) + bone.getWorldRotationX()
      : 0;
  }
  const point = attached ? stagePoint({ x: actor.anchorWorld.x, z: actor.anchorWorld.y }, frame) : stagePoint(effect, frame);
  const view = battleView(frame);
  const zScale = effect.useZScale ? 1.05 - (Number(effect.z || 0) - Number(activeStage && activeStage.bounds.minZ || 0)) * 0.001 : 1;
  const scale = Math.max(0.01, Number(effect.scaleFactor || 1)) * zScale * view.fit;
  display.scale.set(scale * (actor.right ? 1 : -1), scale);
  display.rotation = -(Number(effect.rotation || 0) + actor.boneRotation) * Math.PI / 180;
  display.position.set(point.x, point.y);
  display.zIndex = point.y + 1;
  display.visible = true;
}

async function loadLayers(layers) {
  const loaded = await Promise.all(layers.map(async (layer) => ({
    name: layer.name,
    moveFactor: Number(layer.moveFactor || 0),
    texture: await PIXI.Assets.load(layer.url),
  })));
  const container = new PIXI.Container();
  const displays = loaded.map(({ name, moveFactor, texture }) => {
    const lower = name.toLowerCase();
    const display = (lower.includes("cloud") && texture.width < 512)
      ? new PIXI.TilingSprite(texture, 1, 1)
      : new PIXI.Sprite(texture);
    display.eventMode = "none";
    container.addChild(display);
    return { display, lower, moveFactor, texture };
  });
  return { container, displays, renderer: "WebGL layered Unity stage" };
}

async function loadSpine(files) {
  const data = await loadSpineData(files);
  const spine = new Spine(data.skeleton);
  spine.autoUpdate = true;
  if (data.skeleton.animations.length) spine.state.setAnimation(0, data.skeleton.animations[0].name, true);
  const container = new PIXI.Container();
  container.addChild(spine);
  return { container, spine, atlas: data.atlas, renderer: "WebGL Spine Unity stage" };
}

async function loadSpineData(files) {
  const [atlasText, skeletonBytes, textureEntries] = await Promise.all([
    fetchOk(files.atlas).then((response) => response.text()),
    fetchOk(files.skeleton).then((response) => response.arrayBuffer()),
    Promise.all(files.textures.map(async (entry) => ({
      name: entry.name,
      texture: await PIXI.Assets.load(entry.url),
    }))),
  ]);
  const textures = new Map();
  for (const entry of textureEntries) {
    textures.set(entry.name, entry.texture.baseTexture);
    textures.set(normalizeName(entry.name), entry.texture.baseTexture);
  }
  const atlas = await new Promise((resolve, reject) => {
    try {
      new TextureAtlas(atlasText, (page, callback) => {
        const texture = textures.get(page) || textures.get(normalizeName(page));
        if (!texture) throw new Error(`Missing atlas texture ${page}`);
        callback(texture);
      }, resolve);
    } catch (error) {
      reject(error);
    }
  });
  const parser = new SkeletonBinary37(atlas);
  parser.scale = Number(files.unity && files.unity.skeletonDataScale || 1);
  return { skeleton: parser.readSkeletonData(new Uint8Array(skeletonBytes)), atlas, unity: files.unity || {} };
}

function createActor(bundle, data, unit) {
  const spine = new Spine(data.skeleton);
  spine.autoUpdate = false;
  spine.eventMode = "none";
  actorLayer.addChild(spine);
  const animation = chooseAnimation(data.skeleton, unit.animation);
  if (animation) {
    spine.skeleton.setToSetupPose();
    spine.state.setAnimation(0, animation, Boolean(unit.animationLoop));
  }
  spine.update(0);
  return { bundle, spine, data, animation };
}

function updateActor(actor, unit, frame) {
  const animation = chooseAnimation(actor.data.skeleton, unit.animation);
  if (animation && animation !== actor.animation) {
    actor.spine.state.clearTracks();
    actor.spine.skeleton.setToSetupPose();
    actor.spine.state.setAnimation(0, animation, Boolean(unit.animationLoop));
    actor.animation = animation;
  }
  const track = actor.spine.state.getCurrent(0);
  if (track) {
    track.loop = Boolean(unit.animationLoop);
    track.trackTime = Math.max(0, Number(unit.animationTime || 0));
  }
  actor.spine.update(0);
  const point = stagePoint(unit, frame, actor.data.unity);
  const view = battleView(frame);
  const zScale = 1.05 - (Number(unit.z || 0) - Number(activeStage && activeStage.bounds.minZ || 0)) * 0.001;
  const rootScale = Math.max(0.01, Number(unit.spriteScale || 1)) * zScale;
  const scale = view.fit * view.worldScale * rootScale;
  actor.spine.scale.set(
    scale * Number(actor.data.unity.hierarchyScaleX || 1) * (unit.right ? 1 : -1),
    scale * Number(actor.data.unity.hierarchyScaleY || 1)
  );
  actor.spine.rotation = -Number(actor.data.unity.hierarchyRotation || 0);
  actor.spine.position.set(point.x, point.y);
  actor.spine.zIndex = point.y;
  actor.spine.alpha = /DIE|DEAD/i.test(`${unit.playState} ${unit.stateType}`) || Number(unit.hp) <= 0 ? 0.45 : 1;
  actor.spine.visible = true;
}

function battleView(frame) {
  const camera = activeStage && activeStage.camera || { virtualWidth: 1920, virtualHeight: 1080, minX: -300, maxX: 1500, minY: 0, maxY: 0, size: 500 };
  const virtualWidth = Number(camera.virtualWidth || 1920);
  const virtualHeight = Number(camera.virtualHeight || 1080);
  const fit = Math.min(app.screen.width / virtualWidth, app.screen.height / virtualHeight);
  const halfWidth = Number(camera.size || 500) * virtualWidth / virtualHeight;
  let cameraX = manualCameraX;
  if (cameraX == null) {
    cameraX = Number(camera.minX || 0);
    for (const unit of frame && frame.units || []) {
      if (Number(unit.team) === 1 && Number(unit.hp) > 0 && !/DIE|DEAD/i.test(`${unit.playState} ${unit.stateType}`)) {
        cameraX = Math.max(cameraX, Number(unit.x || 0));
      }
    }
  }
  const minX = Number(camera.minX || 0), maxX = Number(camera.maxX || 0);
  cameraX = maxX - minX <= halfWidth * 2
    ? (minX + maxX) / 2
    : Math.max(minX + halfWidth, Math.min(maxX - halfWidth, cameraX));
  return {
    fit,
    virtualWidth,
    virtualHeight,
    worldScale: virtualHeight / (2 * Number(camera.size || 500)),
    left: (app.screen.width - virtualWidth * fit) / 2,
    top: (app.screen.height - virtualHeight * fit) / 2,
    cameraX,
    cameraY: (Number(camera.minY || 0) + Number(camera.maxY || 0)) / 2,
  };
}

function camera(frame) {
  const view = battleView(frame);
  const stageCamera = activeStage && activeStage.camera || {};
  const halfWidth = Number(stageCamera.size || 500) * view.virtualWidth / view.virtualHeight;
  const sceneMin = Number(stageCamera.minX || 0), sceneMax = Number(stageCamera.maxX || 0);
  const fixed = sceneMax - sceneMin <= halfWidth * 2;
  return {
    min: fixed ? (sceneMin + sceneMax) / 2 : sceneMin + halfWidth,
    max: fixed ? (sceneMin + sceneMax) / 2 : sceneMax - halfWidth,
    value: view.cameraX,
    follow: manualCameraX == null,
  };
}

function setCameraX(value) {
  manualCameraX = value == null ? null : Number(value);
  render(window.CombatSimulatorCurrentFrame || null);
}

function stagePoint(unit, frame, unity = {}) {
  const view = battleView(frame);
  const bounds = activeStage && activeStage.bounds || { minZ: -270 };
  const zScale = 1.05 - (Number(unit.z || 0) - Number(bounds.minZ || 0)) * 0.001;
  const rootScale = Math.max(0.01, Number(unit.spriteScale || 1)) * zScale;
  const worldX = Number(unit.x || 0) + Number(unit.spriteOffsetX || 0) + Number(unity.hierarchyOffsetX || 0) * rootScale;
  const worldY = Number(unit.z || 0) + Number(unit.jumpY || 0) + Number(unit.spriteOffsetY || 0) + Number(unity.hierarchyOffsetY || 0) * rootScale;
  return {
    x: view.left + (view.virtualWidth / 2 + (worldX - view.cameraX) * view.worldScale) * view.fit,
    y: view.top + (view.virtualHeight / 2 - (worldY - view.cameraY) * view.worldScale) * view.fit,
  };
}

function chooseAnimation(data, requested) {
  const animations = data.animations || [];
  if (!animations.length) return "";
  const exact = animations.find((animation) => animation.name === requested);
  if (exact) return exact.name;
  const lower = String(requested || "").toLowerCase();
  const insensitive = animations.find((animation) => animation.name.toLowerCase() === lower);
  if (insensitive) return insensitive.name;
  return (animations.find((animation) => /stand|idle/i.test(animation.name)) || animations[0]).name;
}

function destroyActor(key, actor) {
  actorLayer.removeChild(actor.spine);
  actor.spine.destroy({ children: true, texture: false, baseTexture: false });
  actors.delete(key);
}

function clearUnits() {
  for (const [key, actor] of Array.from(actors)) destroyActor(key, actor);
  for (const data of actorData.values()) data.atlas.dispose();
  actorData.clear();
}

function destroyEffect(key, actor) {
  effectLayer.removeChild(actor.display);
  actor.display.destroy({ children: true, texture: false, baseTexture: false });
  effects.delete(key);
}

function clearEffects() {
  for (const [key, actor] of Array.from(effects)) destroyEffect(key, actor);
  for (const data of effectData.values()) data.atlas?.dispose();
  effectData.clear();
}

function fitActive() {
  if (!active) return;
  const width = Math.max(1, app.screen.width);
  const height = Math.max(1, app.screen.height);
  if (active.spine) {
    const spine = active.spine;
    spine.scale.set(1);
    spine.position.set(0, 0);
    spine.update(0);
    const bounds = spine.getLocalBounds();
    const scale = Math.max(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height));
    spine.scale.set(scale);
    spine.position.set(width / 2 - (bounds.x + bounds.width / 2) * scale, height / 2 - (bounds.y + bounds.height / 2) * scale);
    active.baseX = spine.x;
    active.overflowX = Math.max(0, bounds.width * scale - width) / 2;
    return;
  }
  for (const layer of active.displays) fitLayer(layer, width, height);
}

function fitLayer(layer, width, height) {
  const { display, lower, texture } = layer;
  if (display instanceof PIXI.TilingSprite) {
    display.position.set(0, 0);
    display.width = width;
    display.height = height;
    display.tileScale.set(height / Math.max(1, texture.height));
    layer.baseX = 0;
    return;
  }
  display.anchor.set(0.5, 1);
  const background = /(^|[_-])(sky|bg|back)([_-]|\.)/.test(lower);
  const scale = background
    ? Math.max(width / Math.max(1, texture.width), height / Math.max(1, texture.height))
    : width / Math.max(1, texture.width);
  display.scale.set(scale);
  display.position.set(width / 2, background ? (height + texture.height * scale) / 2 : height);
  layer.baseX = display.x;
  layer.overflowX = Math.max(0, texture.width * scale - width) / 2;
}

function updateStageCamera(frame) {
  if (!active) return;
  const view = battleView(frame);
  const range = camera(null);
  const origin = (range.min + range.max) / 2;
  const shift = (view.cameraX - origin) * view.worldScale * view.fit;
  if (active.spine) {
    active.spine.x = active.baseX - Math.max(-active.overflowX, Math.min(active.overflowX, shift));
    return;
  }
  for (const layer of active.displays) {
    const offset = shift * Number(layer.moveFactor || 0);
    if (layer.display instanceof PIXI.TilingSprite) layer.display.tilePosition.x = -offset;
    else layer.display.x = layer.baseX - Math.max(-layer.overflowX, Math.min(layer.overflowX, offset));
  }
}

function clearStage() {
  if (active) {
    app.stage.removeChild(active.container);
    active.container.destroy({ children: true, texture: false, baseTexture: false });
    active.atlas?.dispose();
  }
  active = null;
  activeStage = null;
  manualCameraX = null;
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Stage asset failed (${response.status})`);
  return response;
}

function normalizeName(value) {
  return String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
}

new ResizeObserver(() => {
  app.resize();
  fitActive();
  render(window.CombatSimulatorCurrentFrame || null);
}).observe(host);

window.CombatStageWebGL = {
  load,
  prepareUnits,
  prepareEffects,
  render,
  camera,
  setCameraX,
  project(unit, frame) {
    const bundle = String(unit && unit.spriteBundleName || "").toLowerCase();
    return activeStage ? stagePoint(unit || {}, frame, actorData.get(bundle)?.unity) : null;
  },
  projectGauge(unit, frame) {
    if (!activeStage || !unit) return null;
    return stagePoint({
      ...unit,
      x: Number(unit.x || 0) + (unit.right ? 1 : -1) * Number(unit.gaugeOffsetX || 0),
      jumpY: Number(unit.jumpY || 0) + Number(unit.gaugeOffsetY || 0),
      spriteOffsetX: 0,
      spriteOffsetY: 0,
      spriteScale: 1,
    }, frame);
  },
  hasUnit(unit) {
    return actorData.has(String(unit && unit.spriteBundleName || "").toLowerCase());
  },
};
