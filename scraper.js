// scraper.js (fixed & verbose)
// Captures marker_world.json from responses and parses sets -> areas/markers

const fs = require("fs");
const playwright = require("playwright");

const MAP_URL = "https://map.ccnetmc.com/nationsmap";
const OUTFILE = "towns.json";

const EXCLUDED_SUBSTRINGS = [
  "WORLD BORDER",
  "CAPTURE POINT",
  "MEDITERRANEAN",
  "SAHARA",
  "SCANDINAVIA",
  "SOUTH ATLANTIC",
  "NORTH ATLANTIC",
  "PACIFIC",
  "INDIAN OCEAN",
  "AMERICA"
];

function parseNumRaw(s) {
  if (s === undefined || s === null) return null;
  const txt = String(s).replace(/\u00A0/g, " ").trim();
  const m = txt.match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  return Number(m[0].replace(/,/g, ""));
}

function computeDays(bank, upkeep) {
  if (bank == null || upkeep == null) return null;
  const up = Number(upkeep);
  if (!isFinite(up) || up === 0) return null;
  const days = Number(bank) / up;
  // rule: if days > 1 => ceil, else round
  if (days > 1) return Math.ceil(days);
  return Math.round(days);
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

// robust bank extractor (tries many patterns)
function extractBankFromDesc(descHtml, descText) {
  if (!descHtml && !descText) return null;
  const s = (descHtml || "") + "\n" + (descText || "");
  // try bank/balance first
  let m = s.match(/(?:Bank|Balance)[:\s]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (m && m[1]) return parseNumRaw(m[1]);
  // try towny-money spans
  m = s.match(/towny-money[^>]*>\s*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (m && m[1]) return parseNumRaw(m[1]);
  // fallback: any $number
  m = s.match(/\$\s*([0-9,]+(?:\.[0-9]+)?)/);
  if (m && m[1]) return parseNumRaw(m[1]);
  return null;
}

function extractUpkeepFromDesc(descHtml, descText) {
  if (!descHtml && !descText) return null;
  const s = (descHtml || "") + "\n" + (descText || "");
  let m = s.match(/Upkeep[:\s]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (m && m[1]) return parseNumRaw(m[1]);
  // some pages use "Daily Upkeep" or "Upkeep per day"
  m = s.match(/Daily\s*Upkeep[:\s]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (m && m[1]) return parseNumRaw(m[1]);
  // fallback: if bank line present we don't want to pick it mistakenly; try towny-money but context is difficult
  // We'll look for second occurrence of money-like values after Bank, assume that might be upkeep
  const allNums = Array.from(s.matchAll(/([0-9,]+(?:\.[0-9]+)?)/g)).map(x => x[1]);
  if (allNums.length >= 2) {
    // prefer the second numeric token if formats are Bank then Upkeep inline
    return parseNumRaw(allNums[1]);
  }
  return null;
}

function extractNationFromDesc(descHtml, descText) {
  if (!descHtml && !descText) return null;
  const s = descHtml || descText || "";
  // matches "Member of X" or "Capital of X", allowing <a> wrapper
  const m = s.match(/(?:Member|Capital)\s+of\s+(?:<a[^>]*>)?\s*([^<\n]+)/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function isExcludedLabelOrDesc(label, descHtml, descText, key) {
  const l = (label || "").toUpperCase();
  const dHtml = (descHtml || "").toUpperCase();
  const dText = (descText || "").toUpperCase();
  const k = (key || "").toUpperCase();

  // exclude shops
  if (l.includes("SHOP") || k.includes("SHOP") || dHtml.includes("SHOP") || dText.includes("SHOP")) return {excluded:true, reason:"shop"};
  // exclude explicitly listed region names if label or desc contains them
  for (const ex of EXCLUDED_SUBSTRINGS) {
    if (l.includes(ex) || dHtml.includes(ex) || dText.includes(ex) || k.includes(ex)) {
      return {excluded:true, reason:"assault_region:"+ex};
    }
  }
  // world border / capture point
  if (l.includes("WORLD BORDER") || dHtml.includes("WORLD BORDER") || k.includes("WORLD BORDER")) return {excluded:true, reason:"world_border"};
  if (l.includes("CAPTURE POINT") || dHtml.includes("CAPTURE POINT") || k.includes("CAPTURE POINT")) return {excluded:true, reason:"capture_point"};
  return {excluded:false};
}

function parseAreaOrMarker(key, obj) {
  // obj expected to contain label and desc
  if (!obj || typeof obj !== "object") {
    console.log("skip: invalid obj for", key);
    return null;
  }
    // must have coordinates or else it's a nation banner / region label
  if (
    obj.x === undefined || obj.y === undefined || obj.z === undefined ||
    obj.x === null || obj.y === null || obj.z === null
  ) {
    console.log("skip: not a real town marker (no coords):", key, obj.label);
    return null;
  }


  const label = obj.label || null;
  const descHtml = obj.desc || obj.html || obj.popup || "";
  const descText = stripHtml(descHtml);

  // must have explicit label (strict)
  if (!label || String(label).trim() === "") {
    console.log("skip: no label for", key);
    return null;
  }

  // exclusion checks
  const ex = isExcludedLabelOrDesc(label, descHtml, descText, key);
  if (ex.excluded) {
    console.log(`excluded ${key} (${label}) reason=${ex.reason}`);
    return null;
  }

  // avoid labels that are actually "Member of ..." etc
  if (/^(Member|Capital)\s+of/i.test(label)) {
    console.log("skip: label looks like nation not town:", label, key);
    return null;
  }

  const town = String(label).trim();
  const nation = extractNationFromDesc(descHtml, descText) || null;
  const bank = extractBankFromDesc(descHtml, descText);
  const upkeep = extractUpkeepFromDesc(descHtml, descText);

  console.log("parsed raw:", key, {town, nation, bank, upkeep});

  return { key, town, nation, bank, upkeep };
}

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  let markerJSON = null;

  context.on("response", async (resp) => {
    const url = resp.url();
    if (!url) return;
    if (url.includes("marker_world.json")) {
      console.log("Captured response:", url);
      try {
        markerJSON = await resp.json();
        console.log("marker JSON size keys:", Object.keys(markerJSON || {}).length);
      } catch (err) {
        console.error("Error parsing JSON response:", err.message);
      }
    }
  });

  const page = await context.newPage();
  console.log("Navigating to map page...");
  await page.goto(MAP_URL, { waitUntil: "networkidle" });

  // wait short loop for the marker JSON to arrive
  for (let i = 0; i < 30 && !markerJSON; i++) {
    await page.waitForTimeout(300);
  }

  if (!markerJSON) {
    console.error("ERROR: Did not capture marker_world.json from responses.");
    await browser.close();
    process.exit(1);
  }

  // markerJSON can be either { sets: { ... } } or directly a map of keys
  const entries = [];

  if (markerJSON.sets && typeof markerJSON.sets === "object") {
    console.log("Processing marker JSON via sets -> areas/markers");
    for (const setName of Object.keys(markerJSON.sets)) {
      const set = markerJSON.sets[setName];
      if (!set || typeof set !== "object") continue;

      if (set.areas && typeof set.areas === "object") {
        for (const areaKey of Object.keys(set.areas)) {
          const fullKey = `${setName}.areas.${areaKey}`;
          const parsed = parseAreaOrMarker(fullKey, set.areas[areaKey]);
          if (parsed) entries.push(parsed);
        }
      }

      if (set.markers && typeof set.markers === "object") {
        for (const markerKey of Object.keys(set.markers)) {
          const fullKey = `${setName}.markers.${markerKey}`;
          const parsed = parseAreaOrMarker(fullKey, set.markers[markerKey]);
          if (parsed) entries.push(parsed);
        }
      }
    }
  } else {
    console.log("Processing marker JSON as top-level map");
    for (const key of Object.keys(markerJSON)) {
      const parsed = parseAreaOrMarker(key, markerJSON[key]);
      if (parsed) entries.push(parsed);
    }
  }

  console.log("RAW parsed entries count:", entries.length);

  // dedupe by exact town name (case-insensitive)
  const byTown = new Map();
  for (const e of entries) {
    const townKey = e.town.trim();
    const lc = townKey.toLowerCase();
    if (!byTown.has(lc)) {
      byTown.set(lc, { town: townKey, nation: e.nation || null, bank: e.bank || null, upkeep: e.upkeep || null });
    } else {
      const cur = byTown.get(lc);
      if ((cur.bank === null || cur.bank === undefined) && e.bank) cur.bank = e.bank;
      if ((cur.upkeep === null || cur.upkeep === undefined) && e.upkeep) cur.upkeep = e.upkeep;
      if ((!cur.nation || cur.nation === null) && e.nation) cur.nation = e.nation;
    }
  }

  const final = [];
  for (const [lc, obj] of byTown.entries()) {
    final.push({
      town: obj.town,
      nation: obj.nation === undefined ? null : obj.nation,
      bank: obj.bank === undefined ? null : obj.bank,
      upkeep: obj.upkeep === undefined ? null : obj.upkeep,
      days_rounded: computeDays(obj.bank, obj.upkeep)
    });
  }

  console.log("FINAL unique towns:", final.length);

  fs.writeFileSync(OUTFILE, JSON.stringify({ scraped_at: new Date().toISOString(), source: MAP_URL, towns: final }, null, 2));
  console.log("WROTE", OUTFILE);

  await browser.close();
})();
