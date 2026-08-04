"use strict";

const assert = require("assert");

process.env.CS_GAMEPLAY_ASSET_SOURCE = "packaged";

const {
  MAINSTREAM_STAGE_CHAIN,
  SUBSTREAM_STAGE_CHAIN,
  getStoryOpenTags,
  isSuppressedStoryOpenTag,
} = require("../stages/mainStoryStage");

const openTags = new Set(getStoryOpenTags());
const episode14Tags = new Set(getStoryOpenTags({ maxMainstreamEpisode: 14 }));
const supportedStages = [...MAINSTREAM_STAGE_CHAIN, ...SUBSTREAM_STAGE_CHAIN];
const expectedTags = new Set(
  supportedStages
    .flatMap((stage) => [stage.openTag, stage.collectionOpenTag])
    .map((tag) => String(tag || "").trim())
    .filter((tag) => tag && !isSuppressedStoryOpenTag(tag))
);

assert(MAINSTREAM_STAGE_CHAIN.length > 0, "mainstream stages were not loaded");
assert(SUBSTREAM_STAGE_CHAIN.length > 0, "substream stages were not loaded");
assert(expectedTags.size > 0, "story stages did not provide any open tags");
for (const tag of expectedTags) assert(openTags.has(tag), `missing story open tag ${tag}`);
assert(
  Array.from(openTags).some((tag) => /^TAG_COMMON_EPISODE_MAIN_/i.test(tag)),
  "mainstream episode open tags were not included"
);
assert(episode14Tags.has("TAG_COMMON_EPISODE_MAIN_EP14_NORMAL"), "episode 14 normal tag was not retained");
assert(episode14Tags.has("TAG_COMMON_EPISODE_MAIN_EP14_HARD"), "episode 14 hard tag was not retained");
assert(!episode14Tags.has("TAG_COMMON_EPISODE_MAIN_EP15_NORMAL"), "episode 15 normal tag bypassed the frozen asset limit");
assert(!episode14Tags.has("TAG_COMMON_EPISODE_MAIN_EP15_HARD"), "episode 15 hard tag bypassed the frozen asset limit");

console.log(
  `[story-open-tags] PASS tags=${openTags.size} mainstreamStages=${MAINSTREAM_STAGE_CHAIN.length} substreamStages=${SUBSTREAM_STAGE_CHAIN.length}`
);
