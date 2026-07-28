const fs = require("fs");
const https = require("https");
const path = require("path");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");

const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT_DIR, "server-data", "official-notices-cache");
const OUTPUT_FILE = path.join(ROOT_DIR, "modules", "event-manager", "official-event-schedules.json");
const NOTICE_LIST_URL = "https://www.counterside.com/notice/lists/ct/en/tbl/notice";
const NOTICE_ITEM_BASE_URL = "https://www.counterside.com";
const DEFAULT_MAX_PAGES = 82;

const MONTHS = new Map([
  ["JAN", 0], ["JANUARY", 0],
  ["FEB", 1], ["FEBRUARY", 1],
  ["MAR", 2], ["MARCH", 2],
  ["APR", 3], ["APRIL", 3],
  ["MAY", 4],
  ["JUN", 5], ["JUNE", 5],
  ["JUL", 6], ["JULY", 6],
  ["AUG", 7], ["AUGUST", 7],
  ["SEP", 8], ["SEPT", 8], ["SEPTEMBER", 8],
  ["OCT", 9], ["OCTOBER", 9],
  ["NOV", 10], ["NOVEMBER", 10],
  ["DEC", 11], ["DECEMBER", 11],
]);

const STOP_WORDS = new Set([
  "THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "WILL", "HAVE", "HAS", "CAN", "ARE", "WAS",
  "EVENT", "SCHEDULE", "DETAILS", "UPDATE", "PATCH", "SHOP", "PRODUCTS", "NOTICE", "RECRUITMENT",
  "RECRUIT", "CONTRACT", "PICKUP", "PICK", "UP", "COUNTERSIDE", "COUNTER", "PASS", "MISSION",
  "MISSIONS", "NEW", "RETURNING", "SPECIAL", "AVAILABLE", "PERIOD", "OPEN", "CLOSE", "AFTER",
  "MAINTENANCE", "UTC", "TIME", "SALE", "PACKAGE", "PRODUCT", "ITEM", "ITEMS", "BEGIN", "BEGINNER",
  "BANNER", "CHANCE", "RETURN", "RETURNS", "START", "STARTS", "NORMAL", "CLASSIFIED", "OPERATOR",
  "CUSTOM", "RECRUITMENTS", "SETTLEMENT", "SCHEDULED", "PUNCH", "PUNCHIN", "PUNCH-IN",
  "EXCHANGE", "SUBSTREAM", "EPISODE", "CURRENCY", "BONUS", "STORE",
]);

const GENERIC_LABELS = new Set([
  "SCHEDULE", "EVENT PERIOD", "EVENT SCHEDULE", "OPEN SCHEDULE", "RECRUITMENT SCHEDULE",
  "SHOP DETAILS", "SHOP PRODUCTS", "UPDATE DETAILS", "PLEASE NOTE", "DETAILS", "SALES PERIOD",
  "MISSION SCHEDULE", "CONTRACT MISSION SCHEDULE", "PUNCH-IN EVENT", "EVENT MISSION",
]);

const TABLE_FILES = [
  "LUA_EVENT_TAB_TEMPLET.json",
  "LUA_EVENT_LOBBY_INDEX_TEMPLET.json",
  "LUA_EVENT_COLLECTION_INDEX_TEMPLET.json",
  "LUA_EVENT_COLLECTION_TEMPLET.json",
  "LUA_MISSION_TAB_TEMPLET.json",
  "LUA_CONTRACT_TAB_TABLE.json",
  "LUA_CONTRACT_CUSTOM_PICKUP.json",
  "LUA_EVENT_PASS_TEMPLET.json",
  "LUA_ATTENDANCE_TAB_TEMPLET.json",
  "LUA_SHOP_TAB_TEMPLET_01.json",
  "LUA_SHOP_TAB_TEMPLET_02.json",
  "LUA_SHOP_TEMPLET_01.json",
  "LUA_SHOP_TEMPLET_02.json",
  "LUA_POINTEXCHANGE_TEMPLET.json",
  "LUA_POINT_EXCHANGE_TEMPLET.json",
];

const OPEN_TAG_FIELDS = [
  "m_OpenTag", "m_OpenTagName", "m_OpenTagStrID", "OpenTag", "openTag", "OpenTags", "openTags",
  "listOpenTag", "listOpenTags", "listOpenTagAllow",
];
const INTERVAL_TAG_FIELDS = [
  "m_DateStrID", "m_DateStrId", "DateStrID", "DateStrId", "dateStrID", "dateStrId", "IntervalTag",
  "intervalTag", "m_IntervalTag", "m_IntervalStrID", "EventIntervalTag", "m_EventDateStrID",
  "m_DiscountDateStrID", "m_SeasonDateStrID", "m_RankGroupDateStrID", "m_RewardDateStrID",
  "EventRateDateStrID", "m_GameDateStrID", "ExchangeDateStrID", "RewardDateStrID",
  "m_EventRewardRateDateStrID", "m_EventDateStrID",
];
const CONTENTS_ALLOW_FIELDS = [
  "listContentsTagAllow", "contentsTagAllow", "ContentsTagAllow", "m_ContentsTagAllow",
  "m_ContentsTag", "listContentsTag",
];

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const maxPages = Math.max(1, Number(args.pages || DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES);
  const existingSchedules = loadExistingSchedules();
  const noticeLinks = await collectNoticeLinks(maxPages);
  const entries = buildGameplayEntryIndex();
  const schedules = [...existingSchedules];
  console.log(`importing ${noticeLinks.length} official notices across ${maxPages} list pages`);

  for (let index = 0; index < noticeLinks.length; index += 1) {
    const notice = noticeLinks[index];
    if (index > 0 && index % 25 === 0) {
      console.log(`processed ${index}/${noticeLinks.length} notices; schedules=${schedules.length}`);
    }
    const html = await fetchCached(notice.url);
    const parsed = parseNoticeHtml(html, notice);
    for (const range of extractScheduleRanges(parsed)) {
      const mapped = mapScheduleToGameplay(range, entries);
      schedules.push({
        id: makeScheduleId(range, schedules.length),
        name: range.name,
        startDate: range.startDate,
        endDate: range.endDate,
        scheduleType: range.scheduleType,
        noticeTitle: parsed.title,
        sourceNotice: notice.url,
        sourceNoticeId: notice.id,
        confidence: mapped.confidence,
        matchTokens: mapped.matchTokens,
        openTags: mapped.openTags,
        intervalTags: mapped.intervalTags,
        contentsTags: mapped.contentsTags,
        counterPassIds: mapped.counterPassIds,
      });
    }
  }

  const merged = mergeSchedules(schedules);
  const output = {
    version: 2,
    timezone: "UTC",
    generatedAt: new Date().toISOString(),
    source: "https://www.counterside.com/notice/lists/ct/en/tbl/notice/P1",
    notes: [
      "Generated from the official English CounterSide notice archive.",
      "Official notices commonly publish schedules in UTC-5; startDate/endDate here are converted to UTC.",
      "Rows with confidence=0 preserve the historical window but did not map cleanly to a packaged gameplay-jsons tag.",
    ],
    schedules: merged,
  };
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`wrote ${merged.length} schedules from ${noticeLinks.length} notices to ${path.relative(ROOT_DIR, OUTPUT_FILE)}`);
  console.log(`mapped=${merged.filter((row) => Number(row.confidence || 0) > 0).length} unmatched=${merged.filter((row) => Number(row.confidence || 0) <= 0).length}`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pages") result.pages = argv[++index] || "";
    else if (arg.startsWith("--pages=")) result.pages = arg.slice("--pages=".length);
  }
  return result;
}

function loadExistingSchedules() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
    if (!parsed || !Array.isArray(parsed.schedules)) return [];
    return parsed.schedules
      .filter((schedule) => schedule && typeof schedule === "object")
      .filter((schedule) => String(schedule.sourceNotice || "").startsWith("local-client-table-profile"))
      .filter((schedule) => Array.isArray(schedule.counterPassIds) && schedule.counterPassIds.length)
      .map((schedule) => ({ ...schedule, preserved: true }));
  } catch {
    return [];
  }
}

async function collectNoticeLinks(maxPages) {
  const byUrl = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${NOTICE_LIST_URL}/P${page}`;
    const html = await fetchCached(url);
    const links = extractNoticeLinks(html);
    for (const link of links) {
      if (!byUrl.has(link.url)) byUrl.set(link.url, link);
    }
  }
  return Array.from(byUrl.values()).sort((left, right) => Number(right.id || 0) - Number(left.id || 0));
}

function extractNoticeLinks(html) {
  const links = [];
  const linkRegex = /href="([^"]*\/notice\/item\/ct\/en\/tbl\/notice\/idx\/(\d+)\/P\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html))) {
    const rawUrl = match[1].startsWith("http") ? match[1] : `${NOTICE_ITEM_BASE_URL}${match[1]}`;
    const title = cleanText(match[3]);
    links.push({ id: match[2], url: rawUrl, title });
  }
  return links;
}

async function fetchCached(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const fileName = encodeURIComponent(url).replace(/%/g, "_");
  const filePath = path.join(CACHE_DIR, `${fileName}.html`);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
  const html = await fetchText(url);
  fs.writeFileSync(filePath, html);
  await delay(40);
  return html;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirect = new URL(res.headers.location, url).toString();
        res.resume();
        fetchText(redirect).then(resolve, reject);
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNoticeHtml(html, notice) {
  const text = htmlToLines(html);
  const title = parseSubjectFromHtml(html) || notice.title || firstMeaningfulTitle(text) || `Notice ${notice.id}`;
  const noticeYear = parsePublishedYearFromHtml(html) || parseNoticeYear(text, title);
  const maintenanceEnd = parseMaintenanceEnd(text, noticeYear);
  return { ...notice, title, lines: text, noticeYear, maintenanceEnd };
}

function parseSubjectFromHtml(html) {
  const match = String(html || "").match(/<div[^>]*class=["'][^"']*\bsubject\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return match ? cleanText(stripHtml(match[1])) : "";
}

function parsePublishedYearFromHtml(html) {
  const text = String(html || "");
  const dateMatch = text.match(/<span>\s*(20\d{2})\.\d{1,2}\.\d{1,2}\s*<\/span>/i);
  if (dateMatch) return Number(dateMatch[1]);
  const subject = parseSubjectFromHtml(html);
  const subjectMatch = subject.match(/\b(20\d{2})\b/);
  return subjectMatch ? Number(subjectMatch[1]) : 0;
}

function htmlToLines(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
  return body.split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function firstMeaningfulTitle(lines) {
  return lines.find((line) => /^\[[^\]]+\]/.test(line)) || "";
}

function parseNoticeYear(lines, title) {
  for (const text of [title, ...lines.slice(0, 20)]) {
    const match = String(text || "").match(/\b(20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return new Date().getUTCFullYear();
}

function parseMaintenanceEnd(lines, defaultYear) {
  const joined = lines.slice(0, 80).join(" ");
  const match = joined.match(/Time:\s*([A-Za-z]{3,9}\.?\s+\d{1,2},\s*20\d{2}),\s*(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})\s*\((UTC[+-]\d{1,2})\)/i);
  if (!match) return null;
  return parseDatePart(`${match[1]}, ${match[3]}`, defaultYear, match[4], null);
}

function extractScheduleRanges(notice) {
  const ranges = [];
  const lines = notice.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeRangeLine(lines[index]);
    if (!shouldInspectLine(line)) continue;
    const contexts = contextLines(lines, index);
    for (const found of findDateRanges(line)) {
      const timezone = found.timezone || findNearestTimezone(line, contexts) || "UTC-5";
      const startDate = parseDatePart(found.start, notice.noticeYear, timezone, notice.maintenanceEnd);
      const endDate = parseDatePart(found.end, notice.noticeYear, timezone, notice.maintenanceEnd, startDate);
      if (!startDate || !endDate || endDate <= startDate) continue;
      const name = enrichScheduleNameWithContext(inferScheduleName(line, found.prefix, contexts, notice.title), line, contexts, notice.title);
      if (isMaintenanceLabel(name)) continue;
      const range = {
        name,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        scheduleType: inferScheduleType(name, line, contexts, notice.title),
        contractCategoryHint: inferContractCategoryHint(name, line, contexts),
        noticeTitle: notice.title,
        sourceNotice: notice.url,
        sourceNoticeId: notice.id,
        context: contexts.slice(-5),
      };
      ranges.push(...expandScheduleRangeFromLookahead(range, lines, index));
    }
  }
  return ranges;
}

function normalizeRangeLine(line) {
  return String(line || "")
    .replace(/[–—]/g, "-")
    .replace(/▷/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldInspectLine(line) {
  if (!/[A-Za-z]{3,9}\.?\s+\d{1,2}/.test(line)) return false;
  if (!/\s[-~]\s/.test(line) && !/\s-\s/.test(line)) return false;
  if (/maintenance compensation/i.test(line)) return false;
  return true;
}

function contextLines(lines, index) {
  return lines.slice(Math.max(0, index - 10), index).map(cleanText).filter(Boolean);
}

function findDateRanges(line) {
  const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
  const date = `${month}\\s+\\d{1,2}(?:,\\s*20\\d{2})?(?:,?\\s*(?:\\d{1,2}:\\d{2}|after (?:the )?maintenance))?`;
  const rangeRegex = new RegExp(`([^:：]{0,90}[:：]?\\s*)?(${date})\\s*(?:-|~)\\s*(${date})(?:\\s*\\((UTC[+-]\\d{1,2})\\))?`, "ig");
  const results = [];
  let match;
  while ((match = rangeRegex.exec(line))) {
    results.push({
      prefix: cleanText(match[1] || ""),
      start: cleanText(match[2] || ""),
      end: cleanText(match[3] || ""),
      timezone: cleanText(match[4] || ""),
    });
  }
  return results;
}

function findNearestTimezone(line, contexts) {
  const text = `${line} ${contexts.join(" ")}`;
  const match = text.match(/\((UTC[+-]\d{1,2})\)/i);
  return match ? match[1].toUpperCase() : "";
}

function parseDatePart(rawText, defaultYear, timezone, maintenanceEnd, startDate = null) {
  const text = String(rawText || "").replace(/\./g, "").trim();
  const match = text.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(20\d{2}))?(?:,?\s*(\d{1,2}):(\d{2}))?/i);
  if (!match) return null;
  const month = MONTHS.get(match[1].toUpperCase().replace(/\.$/, ""));
  if (month == null) return null;
  let year = Number(match[3] || defaultYear || (startDate ? startDate.getUTCFullYear() : new Date().getUTCFullYear()));
  const day = Number(match[2]);
  let hour = match[4] != null ? Number(match[4]) : 0;
  let minute = match[5] != null ? Number(match[5]) : 0;
  const afterMaintenance = /after (?:the )?maintenance/i.test(text);
  if (afterMaintenance && maintenanceEnd instanceof Date && !Number.isNaN(maintenanceEnd.getTime())) {
    return new Date(maintenanceEnd.getTime());
  }
  if (!match[3] && startDate instanceof Date) {
    const candidate = localDateToUtc(year, month, day, hour, minute, timezone);
    if (candidate < startDate) year += 1;
  }
  return localDateToUtc(year, month, day, hour, minute, timezone);
}

function localDateToUtc(year, month, day, hour, minute, timezone) {
  const offsetMatch = String(timezone || "UTC-5").match(/UTC([+-])(\d{1,2})/i);
  const offsetHours = offsetMatch ? Number(offsetMatch[2]) * (offsetMatch[1] === "+" ? 1 : -1) : 0;
  return new Date(Date.UTC(year, month, day, hour - offsetHours, minute, 0, 0));
}

function inferScheduleName(line, prefix, contexts, noticeTitle) {
  const prefixName = cleanLabel(prefix.replace(/^(Schedule|Sales Period|Event Period|Recruitment Schedule)\s*:?\s*/i, ""));
  if (isUsefulLabel(prefixName)) return prefixName;
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const label = cleanLabel(contexts[index]);
    if (isUsefulLabel(label)) return label;
  }
  return cleanLabel(noticeTitle) || cleanLabel(line).slice(0, 80);
}

function enrichScheduleNameWithContext(name, line, contexts, noticeTitle) {
  const label = cleanLabel(name);
  if (!isGenericContextScheduleLabel(label)) return label;
  const subject = inferScheduleSubject(line, contexts, noticeTitle);
  if (!subject || normalizeForCompare(label).includes(normalizeForCompare(subject))) return label;
  if (/\bSUBSTREAM\b/i.test(label)) return `Substream [${subject}] ${label.replace(/^Substream\s+/i, "")}`;
  return `${subject} ${label}`;
}

function isGenericContextScheduleLabel(label) {
  const normalized = normalizeForCompare(label);
  if (!normalized) return false;
  return (
    normalized === "NEW SUBSTREAM AVAILABLE" ||
    normalized === "SUBSTREAM EVENT MISSION AVAILABLE" ||
    normalized === "SUBSTREAM EVENT STORE AVAILABLE" ||
    normalized === "SUBSTREAM EVENT AVAILABLE" ||
    normalized === "EVENT MISSION AVAILABLE"
  );
}

function inferScheduleSubject(line, contexts, noticeTitle) {
  const sources = [line, ...contexts.slice().reverse(), noticeTitle];
  for (const source of sources) {
    const subject = subjectFromText(source);
    if (subject) return subject;
  }
  return "";
}

function subjectFromText(text) {
  const value = cleanText(text);
  if (!value) return "";

  const substreamMatch = value.match(/\bSubstream\s*[\[ã€]\s*([^\]ã€‘]+?)\s*[\]ã€‘]/i);
  if (substreamMatch) return cleanSubject(substreamMatch[1]);

  const bracketMatches = Array.from(value.matchAll(/[ã€\[]\s*([^ã€‘\]]+?)\s*[ã€‘\]]/g))
    .map((match) => cleanSubject(match[1]))
    .filter(Boolean);
  for (const candidate of bracketMatches) {
    if (!isGenericSubject(candidate)) return candidate;
  }
  return "";
}

function cleanSubject(text) {
  return cleanText(text)
    .replace(/\s+Schedule$/i, "")
    .replace(/\s+Event$/i, "")
    .trim();
}

function isGenericSubject(subject) {
  const normalized = normalizeForCompare(subject);
  if (!normalized) return true;
  return /^(SUBSTREAM|SUBSTREAM EVENT MISSION|SUBSTREAM EVENT STORE|EVENT MISSION|EVENT STORE|CONTRACT MISSION|SHOP|EVENT|MISSION)$/.test(normalized);
}

function isUsefulLabel(label) {
  const text = cleanText(label);
  if (!text || text.length < 3 || text.length > 100) return false;
  const normalized = normalizeForCompare(text);
  if (GENERIC_LABELS.has(normalized)) return false;
  if (/^(Schedule|Details|Please Note|Impact|Time|Reward|Rewards|Rules)$/i.test(text)) return false;
  if (/^[-◆◈※\d\s.)]+$/.test(text)) return false;
  return true;
}

function cleanLabel(text) {
  text = String(text || "").replace(/^[-\u25B6\u25B7\u25A0\u25C6\u25BC\u203B\d\s.)]+/, "");
  return cleanText(text)
    .replace(/^[-◆◈※\d\s.)]+/, "")
    .replace(/^(Schedule|Event Period|Sales Period|Recruitment Schedule|Open Schedule)\s*:?\s*/i, "")
    .replace(/\s*Schedule$/i, "")
    .trim();
}

function isMaintenanceLabel(name) {
  return /^(Time|Update Details|Impact|Maintenance)$/i.test(cleanText(name)) || /maintenance compensation/i.test(name);
}

function inferScheduleType(name, line, contexts, noticeTitle) {
  const localText = `${name} ${line}`.toUpperCase();
  const text = `${localText} ${noticeTitle}`.toUpperCase();
  if (text.includes("COUNTER PASS") || text.includes("EVENT PASS")) return "counter-pass";
  if (localText.includes("CONTRACT MISSION")) return "contract-mission";
  if (localText.includes("RECRUIT") || localText.includes("CONTRACT") || localText.includes("PICKUP") || localText.includes("CLASSIFIED") || localText.includes("BANNER")) return "contract";
  if (localText.includes("ATTEND") || localText.includes("PUNCH-IN") || localText.includes("LOGIN") || localText.includes("LOG IN")) return "attendance";
  if (localText.includes("SHOP") || localText.includes("PACKAGE") || localText.includes("SALE")) return "shop";
  return "event";
}

function inferContractCategoryHint(name, line, contexts) {
  const localText = `${name} ${line}`.toUpperCase();
  if (/\bOPERATOR\b/.test(localText)) return "operator";
  if (/\bCLASSIFIED\b|\bAWAKENED\b/.test(localText)) return "classified";

  for (let index = contexts.length - 1; index >= Math.max(0, contexts.length - 8); index -= 1) {
    const text = String(contexts[index] || "").toUpperCase();
    if (/RETURNING OPERATORS/.test(text)) return "operator";
    if (/RETURNING AWAKENED EMPLOYEES/.test(text)) return "classified";
    if (/RETURNING EMPLOYEES/.test(text)) return "normal";
  }
  if (/\bNORMAL\b/.test(localText)) return "normal";
  return "";
}

function buildGameplayEntryIndex() {
  const stringMap = loadEnglishStringMap();
  const unitAliasMap = loadUnitAliasMap(stringMap);
  const byKey = new Map();
  for (const fileName of TABLE_FILES) {
    const records = readGameplayTableRecords("ab_script", fileName, {
      rootDir: ROOT_DIR,
      logLabel: "official-event-schedules",
      optional: true,
      allowLuacWhenPackaged: true,
    });
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const openTags = tagsFromFields(record, OPEN_TAG_FIELDS);
      const intervalTags = tagsFromFields(record, INTERVAL_TAG_FIELDS);
      const contentsTags = tagsFromFields(record, CONTENTS_ALLOW_FIELDS);
      const eventPassId = Number(record.EventPassID || 0) || 0;
      if (!openTags.length && !intervalTags.length && !contentsTags.length && !eventPassId) continue;
      const searchText = buildEntrySearchText(fileName, record, stringMap, unitAliasMap);
      const key = `${fileName}:${index}:${openTags.join("|")}:${intervalTags.join("|")}:${contentsTags.join("|")}:${eventPassId}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        fileName,
        index,
        searchText,
        tokens: tokensForText(searchText),
        openTags,
        intervalTags,
        contentsTags,
        counterPassIds: eventPassId ? [eventPassId] : [],
      });
    }
  }
  return Array.from(byKey.values());
}

function expandScheduleRangeFromLookahead(range, lines, lineIndex) {
  if (range.scheduleType !== "contract" || !isGenericRecruitmentReturnLabel(range.name)) return [range];
  const targets = targetEmployeesFromLookahead(lines, lineIndex);
  if (!targets.length) return [range];
  return targets.map((target) => ({
    ...range,
    name: `${target} Banner`,
    sourceGroupName: range.name,
  }));
}

function isGenericRecruitmentReturnLabel(label) {
  const text = normalizeForCompare(label);
  return /\bRECRUITMENTS?\b/.test(text) && /\bRETURN/.test(text);
}

function targetEmployeesFromLookahead(lines, lineIndex) {
  const targets = [];
  for (let index = lineIndex + 1; index < Math.min(lines.length, lineIndex + 10); index += 1) {
    const line = cleanText(lines[index]);
    if (!/^[-\s]*Target employee\s*:/i.test(line)) continue;
    const afterColon = line.replace(/^[-\s]*Target employee\s*:\s*/i, "");
    const bracketMatches = Array.from(afterColon.matchAll(/[【\[]\s*([^】\]]+?)\s*[】\]]/g))
      .map((match) => cleanText(match[1]));
    if (bracketMatches.length) targets.push(...bracketMatches);
    else targets.push(...afterColon.split(/\s*,\s*/).map(cleanText).filter(Boolean));
    break;
  }
  return unique(targets
    .map((target) => target.replace(/^Target employee\s*:\s*/i, "").trim())
    .filter((target) => target.length >= 3));
}

function loadEnglishStringMap() {
  const map = new Map();
  const records = readGameplayTableRecords("ab_script_string_table", "LUA_STRING_ENG.json", {
    rootDir: ROOT_DIR,
    logLabel: "official-event-schedules",
    optional: true,
    allowLuacWhenPackaged: true,
  });
  for (const row of records) {
    if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string") continue;
    map.set(row[0], row[1]);
  }
  return map;
}

function loadUnitAliasMap(stringMap) {
  const map = new Map();
  const records = readGameplayTableRecords("ab_script", "LUA_COLLECTION_V2_EMPLOYEE.json", {
    rootDir: ROOT_DIR,
    logLabel: "official-event-schedules",
    optional: true,
    allowLuacWhenPackaged: true,
  });
  for (const row of records) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const unitId = Number(row.UnitID || row.m_UnitID || 0) || 0;
    if (!unitId) continue;
    const aliases = [
      row.NameValue,
      row.TeamConceptStrID,
      row.TeamUpStrID,
      row.OpenTag,
    ].flatMap((value) => resolveStringAlias(value, stringMap));
    if (!aliases.length) continue;
    map.set(unitId, unique([...(map.get(unitId) || []), ...aliases]));
  }
  return map;
}

function resolveStringAlias(value, stringMap) {
  const text = String(value || "").trim();
  if (!text) return [];
  const aliases = [text];
  for (const id of text.match(/SI_[A-Z0-9_]+/g) || []) {
    const resolved = stringMap.get(id);
    if (resolved && typeof resolved === "string") aliases.push(resolved);
  }
  return aliases;
}

function buildEntrySearchText(fileName, record, stringMap, unitAliasMap) {
  const raw = JSON.stringify(record);
  const strings = [];
  raw.replace(/SI_[A-Z0-9_]+/g, (id) => {
    const text = stringMap.get(id);
    if (text) strings.push(text);
    return id;
  });
  const unitAliases = [];
  for (const field of ["EventPassMainReward", "m_UnitID", "UnitID"]) {
    const unitId = Number(record[field] || 0) || 0;
    if (unitId > 0) unitAliases.push(...(unitAliasMap.get(unitId) || []));
  }
  return `${fileName} ${raw} ${strings.join(" ")} ${unitAliases.join(" ")}`.toUpperCase();
}

function mapScheduleToGameplay(range, entries) {
  const query = String(range.name || "");
  const queryTokens = tokensForText(query);
  const prestigeNumber = prestigeServiceNumber(query);
  if (prestigeNumber >= 4 && prestigeNumber <= 8) {
    const suffix = String(prestigeNumber - 3).padStart(3, "0");
    return {
      confidence: 10,
      matchTokens: Array.from(queryTokens).slice(0, 8),
      openTags: [`TAG_COMMON_EVENT_PAYBACK_${suffix}`],
      intervalTags: [`DATE_COMMON_EVENT_PAYBACK_${suffix}`],
      contentsTags: [],
      counterPassIds: [],
    };
  }
  if (!queryTokens.size) {
    return {
      confidence: 0,
      matchTokens: [],
      openTags: [],
      intervalTags: [],
      contentsTags: [],
      counterPassIds: [],
    };
  }
  const scored = [];
  for (const entry of entries) {
    const score = scoreEntry(queryTokens, query, entry, range.scheduleType, range.contractCategoryHint);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((left, right) => right.score - left.score);
  const topScore = scored.length ? scored[0].score : 0;
  if (topScore < 4) {
    return {
      confidence: topScore,
      matchTokens: [],
      openTags: [],
      intervalTags: [],
      contentsTags: [],
      counterPassIds: [],
    };
  }
  const minimumSelectedScore = topScore >= 7 ? topScore - 1 : topScore;
  const selected = preferOfficialRegion(scored
    .filter((item) => item.score >= minimumSelectedScore)
    .slice(0, 5)
    .map((item) => item.entry), range.scheduleType);

  const openTags = unique(selected.flatMap((entry) => entry.openTags));
  const intervalTags = unique(selected.flatMap((entry) => entry.intervalTags));
  const contentsTags = unique(selected.flatMap((entry) => entry.contentsTags));
  const counterPassIds = uniqueNumbers(selected.flatMap((entry) => entry.counterPassIds));
  return {
    confidence: topScore,
    matchTokens: Array.from(queryTokens).slice(0, 8),
    openTags,
    intervalTags,
    contentsTags,
    counterPassIds,
  };
}

function prestigeServiceNumber(value) {
  const text = String(value || "").toUpperCase();
  if (!/PRESTIGE (?:SERVICE|SEASON)/.test(text)) return 0;
  for (const [token, number] of [["FOURTH", 4], ["4TH", 4], ["FIFTH", 5], ["5TH", 5], ["SIXTH", 6], ["6TH", 6], ["SEVENTH", 7], ["7TH", 7], ["EIGHTH", 8], ["8TH", 8]]) {
    if (text.includes(token)) return number;
  }
  return 0;
}

function scoreEntry(queryTokens, query, entry, scheduleType, contractCategoryHint) {
  if (!isEntryAllowedForScheduleType(entry, scheduleType, contractCategoryHint)) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (entry.tokens.has(token)) score += token.length >= 6 ? 2 : 1;
  }
  if (score <= 0) return 0;
  const normalizedQuery = normalizeForCompare(query);
  if (normalizedQuery.length >= 8 && entry.searchText.includes(normalizedQuery)) score += 4;
  if (scheduleType === "counter-pass" && entry.fileName.includes("EVENT_PASS")) score += 3;
  if (scheduleType === "contract-mission" && /EVENT_TAB|MISSION/.test(entry.fileName)) score += 3;
  if (scheduleType === "contract-mission" && /MISSION_EVENT|ENGAGE/.test(entry.searchText)) score += 2;
  if (scheduleType === "contract" && entry.fileName.includes("CONTRACT")) score += 3;
  if (scheduleType === "shop" && entry.fileName.includes("SHOP")) score += 2;
  if (scheduleType === "attendance" && entry.fileName.includes("ATTENDANCE")) score += 2;
  if (scheduleType === "event" && /EVENT|MISSION|LOBBY|COLLECTION/.test(entry.fileName)) score += 1;
  if (scheduleType === "event" && isEpisodeEventQuery(normalizedQuery) && isEpisodeEventEntry(entry)) score += 3;
  return score;
}

function isEpisodeEventQuery(normalizedQuery) {
  return /\b(SUBSTREAM|EPISODE|MISSION|CURRENCY|BONUS|COLLECTION)\b/.test(normalizedQuery);
}

function isEpisodeEventEntry(entry) {
  const fileName = String(entry && entry.fileName || "").toUpperCase();
  const searchText = String(entry && entry.searchText || "").toUpperCase();
  return /EVENT_TAB|MISSION_TAB|EVENT_LOBBY|EVENT_COLLECTION/.test(fileName) &&
    /MISSION_EPISODE|MISSION_EP_|EPISODE_SUB|EVENT_COLLECTION_SUB|EPISODE_EVENT/.test(searchText);
}

function isEntryAllowedForScheduleType(entry, scheduleType, contractCategoryHint) {
  const fileName = String(entry && entry.fileName || "").toUpperCase();
  const searchText = String(entry && entry.searchText || "").toUpperCase();
  const type = String(scheduleType || "event").toLowerCase();
  if (type === "counter-pass") return fileName.includes("EVENT_PASS");
  if (type === "contract-mission") {
    return (fileName.includes("MISSION") || fileName.includes("EVENT_TAB")) && /MISSION_EVENT|ENGAGE/.test(searchText);
  }
  if (type === "contract") {
    const category = String(contractCategoryHint || "").toLowerCase();
    if (category) {
      const entryCategory = contractCategoryFromEntry(fileName, searchText);
      if (entryCategory && entryCategory !== category) return false;
    }
    return fileName.includes("CONTRACT") || fileName.includes("EVENT_TAB");
  }
  if (type === "shop") return fileName.includes("SHOP") || fileName.includes("POINT");
  if (type === "attendance") return fileName.includes("ATTENDANCE");
  if (type === "event") {
    if (/PVP|GAUNTLET|SHOP|CONTRACT/.test(fileName)) return false;
    return /EVENT|MISSION|LOBBY|COLLECTION|ATTENDANCE/.test(fileName);
  }
  return true;
}

function contractCategoryFromEntry(fileName, searchText) {
  if (/"M_CONTRACTCATEGORY"\s*:\s*300/.test(searchText) || /OPERATOR_CONTRACT|CONTRACTTAB_OPR|TAG_FIRST_OPR|OPR_/.test(searchText)) return "operator";
  if (/"M_CONTRACTCATEGORY"\s*:\s*200/.test(searchText) || /CLASSIFIED|CONTRACTTAB_AWAKEN|TAG_FIRST_UNIT_.*_CA_|_CA_/.test(searchText)) return "classified";
  if (/"M_CONTRACTCATEGORY"\s*:\s*100/.test(searchText) || /CONTRACTTAB_NORMAL|PICKUP_CONTRACT/.test(searchText)) return "normal";
  if (fileName.includes("CONTRACT_CUSTOM_PICKUP")) return "";
  return "";
}

function preferOfficialRegion(entries, scheduleType) {
  const type = String(scheduleType || "").toLowerCase();
  if (!["contract", "counter-pass"].includes(type)) return entries;
  let preferred = entries;
  const globalEntries = preferred.filter((entry) => tagsForEntry(entry).some((tag) => /(?:^|_)GLOBAL(?:_|$)/.test(tag)));
  if (globalEntries.length) preferred = globalEntries;
  if (type === "contract") {
    const nonOldEntries = preferred.filter((entry) => !isOldVersionEntry(entry));
    if (nonOldEntries.length) preferred = nonOldEntries;
  }
  return preferred;
}

function isOldVersionEntry(entry) {
  return tagsForEntry(entry).some((tag) => tag.includes("OLD_VERSION") || tag === "TAG_KOR_CONTRACT_OLD_VERSION");
}

function tagsForEntry(entry) {
  return unique([
    ...safeArray(entry && entry.openTags),
    ...safeArray(entry && entry.intervalTags),
    ...safeArray(entry && entry.contentsTags),
  ]).map((tag) => tag.toUpperCase());
}

function tokensForText(text) {
  const normalized = normalizeForCompare(text);
  const tokens = normalized.split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
  return new Set(tokens);
}

function normalizeForCompare(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagsFromFields(record, fields) {
  const tags = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    collectTags(record[field], tags);
  }
  return unique(tags.filter((tag) => tag && !tag.startsWith("SI_")));
}

function collectTags(value, output) {
  if (value == null || value === false) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTags(item, output);
    return;
  }
  if (typeof value === "object") return;
  const text = String(value).trim();
  if (!text) return;
  if (/^(TAG_|DATE_|SHOP_|GLOBAL_|KOR_|JPN_|SEA_|COMMON_|TAB_)/i.test(text)) output.push(text);
}

function mergeSchedules(schedules) {
  const byKey = new Map();
  for (const schedule of schedules) {
    const key = [
      normalizeForCompare(schedule.name),
      schedule.startDate,
      schedule.endDate,
      schedule.sourceNoticeId,
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalizeScheduleForOutput(schedule));
      continue;
    }
    existing.openTags = unique([...safeArray(existing.openTags), ...safeArray(schedule.openTags)]);
    existing.intervalTags = unique([...safeArray(existing.intervalTags), ...safeArray(schedule.intervalTags)]);
    existing.contentsTags = unique([...safeArray(existing.contentsTags), ...safeArray(schedule.contentsTags)]);
    existing.counterPassIds = uniqueNumbers([...safeArray(existing.counterPassIds), ...safeArray(schedule.counterPassIds)]);
    existing.confidence = Math.max(Number(existing.confidence || 0), Number(schedule.confidence || 0));
  }
  return Array.from(byKey.values()).sort((left, right) =>
    left.startDate.localeCompare(right.startDate) ||
    left.name.localeCompare(right.name)
  );
}

function normalizeScheduleForOutput(schedule) {
  const output = { ...schedule };
  output.openTags = unique(safeArray(output.openTags));
  output.intervalTags = unique(safeArray(output.intervalTags));
  output.contentsTags = unique(safeArray(output.contentsTags));
  output.counterPassIds = uniqueNumbers(safeArray(output.counterPassIds));
  output.matchTokens = unique(safeArray(output.matchTokens));
  if (!output.openTags.length) delete output.openTags;
  if (!output.intervalTags.length) delete output.intervalTags;
  if (!output.contentsTags.length) delete output.contentsTags;
  if (!output.counterPassIds.length) delete output.counterPassIds;
  if (!output.matchTokens.length) delete output.matchTokens;
  return output;
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function makeScheduleId(range, index) {
  const date = range.startDate.slice(0, 10);
  const slug = normalizeForCompare(range.name).toLowerCase().replace(/\s+/g, "-").slice(0, 72) || `schedule-${index + 1}`;
  return `${date}-${slug}`;
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function uniqueNumbers(values) {
  return Array.from(new Set((values || []).map((value) => Number(value || 0)).filter((value) => Number.isInteger(value) && value > 0))).sort((a, b) => a - b);
}

function cleanText(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
}
