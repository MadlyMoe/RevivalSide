const fs = require("fs");
const path = require("path");
const { createModEpisodeMaker } = require("../modules/mod-episode-maker");
const { createModProjectStore } = require("../modules/mod-projects");

const ROOT = path.join(__dirname, "..");
const dialogue = [
  ["Lee Yumi", "You’re two minutes late."],
  ["Administrator", "I thought you were off duty."],
  ["Lee Yumi", "Punctuality doesn’t stop being important after work."],
  ["Administrator", "You came straight from patrol?"],
  ["Lee Yumi", "Kang took over my route."],
  ["Administrator", "Your partner volunteered?"],
  ["Lee Yumi", "She said I needed “one normal evening.”"],
  ["Administrator", "I like her already."],
  ["Lee Yumi", "Don’t encourage her."],
  ["Administrator", "Is that why you’re still wearing your watch?"],
  ["Lee Yumi", "A Counter never knows when an anomaly will appear."],
  ["Administrator", "We’re in the middle of the Normal:Side."],
  ["Lee Yumi", "That has never stopped them before."],
  ["Administrator", "You could relax for one hour."],
  ["Lee Yumi", "I am relaxed."],
  ["Administrator", "You’ve checked the exits three times."],
  ["Lee Yumi", "There are only two. I checked the window."],
  ["Administrator", "Very relaxed."],
  ["Lee Yumi", "You invited me here to criticize my habits?"],
  ["Administrator", "I invited you because I wanted to see you."],
  ["Lee Yumi", "You could have said that sooner."],
  ["Administrator", "Would it have changed anything?"],
  ["Lee Yumi", "No."],
  ["Administrator", "That answer was suspiciously fast."],
  ["Lee Yumi", "Stop smiling."],
  ["Administrator", "I can’t help it."],
  ["Lee Yumi", "Your drink is getting cold."],
  ["Administrator", "So is yours."],
  ["Lee Yumi", "I prefer it that way."],
  ["Administrator", "Yumi?"],
  ["Lee Yumi", "What?"],
  ["Administrator", "When you Dive into the Counter:Side, do you ever get scared?"],
  ["Lee Yumi", "Every time."],
  ["Administrator", "You don’t act like it."],
  ["Lee Yumi", "Fear doesn’t excuse abandoning people who need protection."],
  ["Administrator", "And who protects you?"],
  ["Lee Yumi", "Kang watches my back."],
  ["Administrator", "Anyone else?"],
  ["Lee Yumi", "That depends."],
  ["Administrator", "On what?"],
  ["Lee Yumi", "Whether you arrive on time next time."],
  ["Administrator", "There’s going to be a next time?"],
  ["Lee Yumi", "Three minutes early."],
  ["Administrator", "Yes, Officer Lee."],
  ["Lee Yumi", "I’m off duty."],
  ["Administrator", "Yes, Yumi."],
  ["Lee Yumi", "Better."],
];

function createInput() {
  return {
    projectId: "dating-event-1-off-duty",
    projectName: "Dating Event #1 — Off Duty",
    title: "Dating Event #1 — Off Duty",
    author: "RevivalSide Mod:Side",
    description: "A cutscene-only dating event appended to Mainstream Episode 1.",
    category: "EC_MAINSTREAM",
    episodeId: 2,
    actId: 4,
    stageIndex: 7,
    stageUiNumber: 3,
    unlockDungeonId: 0,
    stageId: 11246,
    dungeonId: 10106,
    cutsceneId: 900011246,
    stageStrId: "STAGE_MAINSTREAM_MODSIDE_11246",
    dungeonStrId: "NKM_DUNGEON_EP1_ACT4_DATING_EVENT_1",
    cutsceneStrId: "EP1_ACT4_DATING_EVENT_1",
    stageCharacter: "NKM_UNIT_C_POLICE_LEE_YUMI",
    background: "CAFE",
    scenes: dialogue.map(([speakerName, text]) => {
      const yumi = speakerName === "Lee Yumi";
      return {
        speakerName,
        speakerActorId: yumi ? "YUMI_POLICE_NULL_NULL" : "USER_ADMIN_NULL_NULL",
        dialogue: text,
        voiceLine: "",
        dimActors: !yumi,
        effects: [],
        actors: [{ actorId: "YUMI_POLICE_NULL_NULL", position: "C", animation: yumi ? "UNIT_IDLE" : "", visible: true, previewAsset: "" }],
      };
    }),
  };
}

if (require.main === module) {
  const store = createModProjectStore({ rootDir: ROOT });
  const maker = createModEpisodeMaker({ rootDir: ROOT, modStore: store });
  const result = maker.create(createInput());
  const output = path.join(ROOT, "dist", "mods", "Dating-Event-1-Off-Duty.revivalmod.zip");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, store.exportProject(result.project.manifest.id));
  console.log(JSON.stringify({ project: result.project.manifest.id, scenes: result.authoring.scenes.length, records: result.cutscene.recordCount, zip: output }, null, 2));
}

module.exports = { createInput, dialogue };
