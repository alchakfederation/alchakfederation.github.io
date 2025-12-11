// watch_dynmap_simple.js
// Simple Puppeteer watcher for dynmap_world.json responses.
// - Caches each response for 60s
// - While cached, repeatedly processes entries
// - When an entry expires, saves a processed file with players in world "world"

const puppeteer = require("puppeteer");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

const START_URL = "https://map.ccnetmc.com/nationsmap/"; // <- use the correct map URL
const WATCH_SUBSTRING = "dynmap_world.json";            // match any dynmap_world.json?=...
const RAW_CACHE_TTL = 60; // seconds for raw dynmap JSON
const PROCESSED_CACHE_TTL = 60 * 60 * 24 * 3; // seconds (3 days) for processed cache
const PROCESS_INTERVAL_MS = 500;    // background worker frequency
const OUTPUT_DIR = path.resolve(process.cwd(), "processed_dynmap");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function readableTs(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}_${String(d.getHours()).padStart(2,"0")}-${String(d.getMinutes()).padStart(2,"0")}-${String(d.getSeconds()).padStart(2,"0")}`;
}

function extractPlayers(json, capturedAt) {
  if (!json) return [];
  const players = json.players || [];
  const out = [];
  
  function parseName(rawName) {
    if (!rawName) return { name: "unknown", rank: null };
    let name = stripHtml(rawName).trim();
    let rank = null;

    // Extract text in [ ] as rank
    const rankMatch = name.match(/\[(.*?)\]/);
    if (rankMatch) {
      rank = rankMatch[1].trim();
      name = name.replace(/\[.*?\]/g, "").trim(); // remove [rank] from name
    }

    // Remove ~ from name
    name = name.replace(/~/g, "").trim();

    return { name, rank };
  }

  if (Array.isArray(players)) {
    for (const p of players) {
      if (p && p.world === "world") {
        const { name, rank } = parseName(p.name || p.player || "unknown");
        out.push({
          player: name,
          rank: rank,
          x: Number(p.x),
          z: Number(p.z),
          originalTimestamp: capturedAt
        });
      }
    }
  } else if (typeof players === "object") {
    for (const k of Object.keys(players)) {
      const p = players[k];
      if (p && p.world === "world") {
        const { name, rank } = parseName(p.name || k);
        out.push({
          player: name,
          rank: rank,
          x: Number(p.x),
          z: Number(p.z),
          originalTimestamp: capturedAt
        });
      }
    }
  }
  return out;
}

function stripHtml(html) {
  if (!html) return "";
  // Remove all HTML tags
  return html.replace(/<[^>]*>/g, "");
}

function saveFinal(data, label, ts) {
  const filename = `players_${label}_${readableTs(ts)}.json`;
  const full = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
  console.log("Saved:", full);
}

// cache stores objects: { url, json, capturedAt }
const rawCache = new NodeCache({ stdTTL: RAW_CACHE_TTL, checkperiod: 1, useClones: false });
const processedCache = new NodeCache({ stdTTL: PROCESSED_CACHE_TTL, checkperiod: 60, useClones: false });

rawCache.on("expired", (key, value) => {
  try {
    const { url, json, capturedAt } = value;

    // Check if we already have a processed version in processedCache
    let extracted = processedCache.get(url);
    if (!extracted) {
      extracted = extractPlayers(json, capturedAt);
      processedCache.set(url, extracted); // store for 3 days
    }

    // derive label from query param if present, else use timestamp
    const m = url.match(/[_?&]_=?(?:_2=)?(\d{9,})/);
    const label = m ? m[1] : String(capturedAt);

    saveFinal(extracted, label, capturedAt);
  } catch (e) {
    console.error("Error on raw cache expired:", e.message);
  }
});

let processingInterval = null;
function startWorker() {
  if (processingInterval) return;
  processingInterval = setInterval(() => {
    const keys = rawCache.keys();
    for (const k of keys) {
      const entry = rawCache.get(k);
      if (!entry) continue;
      try {
        // CPU work performed repeatedly while cached; here we run extractPlayers (no file writes)
        extractPlayers(entry.json, entry.capturedAt);
      } catch (e) {
        // keep running even if one entry fails
      }
    }
  }, PROCESS_INTERVAL_MS);
}

async function run() {
  console.log("Launching watcher...");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url || !url.includes(WATCH_SUBSTRING)) return;

      // read text and parse as JSON
      let text;
      try {
        text = await response.text();
      } catch {
        // can't read body
        return;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }

      const capturedAt = Date.now();
      // store under full URL (including timestamp query)
      rawCache.set(url, { url, json, capturedAt });

      // ensure worker runs while there are cached entries
      startWorker();
    } catch (err) {
      // ignore individual response errors to keep watcher alive
    }
  });

  page.on("requestfailed", req => {
    // silently ignore failed requests unless you want to log them
  });

  await page.goto(START_URL, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {
    // continue even if initial load times out
  });

  console.log("Watcher running; listening for network responses containing:", WATCH_SUBSTRING);
  console.log("Output directory:", OUTPUT_DIR);
  // keep process alive
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
