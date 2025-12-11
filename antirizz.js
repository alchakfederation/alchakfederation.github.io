/**
 * capture_nationsmap.js
 *
 * Playwright-based LiveAtlas (Dynmap) canvas panner + stitcher.
 *
 * - Opens the map URL
 * - Finds the first <canvas> on the page (LiveAtlas WebGL canvas)
 * - Raster-scans the map by dragging, captures canvas.toDataURL() per step
 * - Detects edges by comparing MD5 of successive captures
 * - Saves captures into captures/ folder
 * - Stitches saved PNGs into a single huge PNG using node-canvas
 *
 * NOTE: tune STEP_FRACTION (how much of viewport to move per step), DELAY between pans,
 * and MAX_IDENTICAL_TO_EDGE (how many identical images in a row mean we've hit the edge).
 */

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { createCanvas, loadImage } = require("canvas");

const MAP_URL = "https://map.ccnetmc.com/nationsmap/"; // user-provided URL
const OUTPUT_DIR = path.resolve(__dirname, "output");
const CAP_DIR = path.resolve(__dirname, "captures");
fs.ensureDirSync(OUTPUT_DIR);
fs.ensureDirSync(CAP_DIR);

// --- Config: tune these ---
const VIEWPORT = { width: 1280, height: 800 }; // capture viewport (can be larger if you want)
const STEP_FRACTION = 0.75; // how much of viewport to pan per step (0 < f <= 1). 0.75 gives 25% overlap.
const DELAY_MS = 700; // ms wait after pan before capture (increase if server slow)
const MAX_IDENTICAL_TO_EDGE = 3; // how many identical captures in a row indicates edge
const HEADLESS = true; // set false if you need to log in or want to watch
const DRAG_PAUSE = 200; // ms between mouse down and move (for smoother pans)
const RETRY_ATTEMPTS = 3; // when canvas capture fails

// Helper: md5 of buffer
function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

// Save base64 dataURL to Buffer
function dataURLToBuffer(dataUrl) {
  const match = dataUrl.match(/^data:.+;base64,(.*)$/);
  if (!match) throw new Error("Invalid data URL");
  return Buffer.from(match[1], "base64");
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  console.log("Navigating to", MAP_URL);
  await page.goto(MAP_URL, { waitUntil: "networkidle" });

  // Wait for a canvas element to appear
  await page.waitForSelector("canvas", { timeout: 30000 });
  console.log("Canvas found");

  // Helper: capture current canvas via toDataURL
  async function captureCanvasBuffer(retries = RETRY_ATTEMPTS) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const dataUrl = await page.evaluate(() => {
          const c = document.querySelector("canvas");
          if (!c) return null;
          try {
            return c.toDataURL("image/png");
          } catch (e) {
            // Some pages may block toDataURL — return null
            return null;
          }
        });
        if (!dataUrl) throw new Error("canvas.toDataURL returned null");
        return dataURLToBuffer(dataUrl);
      } catch (err) {
        console.log(`capture attempt ${attempt} failed: ${err.message}`);
        await page.waitForTimeout(300);
      }
    }
    throw new Error("Failed to capture canvas after retries");
  }

  // Helper: perform a drag on the canvas to pan
  async function dragPan(deltaX, deltaY) {
    // find canvas center
    const box = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    const startX = Math.round(box.x + box.w / 2);
    const startY = Math.round(box.y + box.h / 2);
    const endX = Math.round(startX + deltaX);
    const endY = Math.round(startY + deltaY);

    const mouse = page.mouse;
    await mouse.move(startX, startY);
    await mouse.down();
    await page.waitForTimeout(DRAG_PAUSE);
    // move in steps for smoothness
    const STEPS = 8;
    for (let i = 1; i <= STEPS; i++) {
      const xi = startX + Math.round((endX - startX) * (i / STEPS));
      const yi = startY + Math.round((endY - startY) * (i / STEPS));
      await mouse.move(xi, yi);
      await page.waitForTimeout(10);
    }
    await mouse.up();
  }

  // Initial capture
  console.log("Performing initial capture...");
  const initialBuf = await captureCanvasBuffer();
  let initialHash = md5(initialBuf);
  let startIdx = 0;

  // Find left edge: repeatedly drag RIGHT until captures stop changing
  // (drag right means mouse drag left-to-right? For panning, moving mouse right tends to pan left,
  // but we empirically choose to drag left to pan right; if wrong direction, script still works —
  // later we scan both directions)
  console.log("Finding leftmost edge (scanning left-to-right with drags)...");
  // We'll try both drag directions if necessary
  async function findEdgeHoriz(direction = "right") {
    // direction: 'right' means we will pan right across the map -> achieve by dragging left
    const stepX = Math.round(VIEWPORT.width * STEP_FRACTION) * (direction === "right" ? -1 : 1);
    let identicalCount = 0;
    let lastHash = initialHash;

    for (let i = 0; i < 2000; i++) { // safety cap
      await dragPan(stepX, 0);
      await page.waitForTimeout(DELAY_MS);
      const buf = await captureCanvasBuffer();
      const h = md5(buf);
      if (h === lastHash) {
        identicalCount++;
      } else {
        identicalCount = 0;
        lastHash = h;
      }

      // Save each step to cap dir with index
      const idx = `h_${direction}_${i}`;
      const filePath = path.join(CAP_DIR, `${idx}.png`);
      await fs.writeFile(filePath, buf);

      console.log(`h-step ${i} hash=${h} identical=${identicalCount}`);
      if (identicalCount >= MAX_IDENTICAL_TO_EDGE) {
        console.log("Edge detected (horizontal). stopping.");
        return { steps: i + 1, lastHash: lastHash };
      }
    }
    throw new Error("Horizontal edge scan reached iteration cap");
  }

  // We'll attempt to find left edge by scanning right first; if that fails, try opposite
  let horizMeta;
  try {
    horizMeta = await findEdgeHoriz("right");
  } catch (e) {
    console.log("Right scan didn't detect edge, trying left scan:", e.message);
    horizMeta = await findEdgeHoriz("left");
  }

  console.log("Now finding vertical (top) edge by scanning downwards...");
  // Find top edge: scan down (drag up) until identicals
  async function findEdgeVert(direction = "down") {
    const stepY = Math.round(VIEWPORT.height * STEP_FRACTION) * (direction === "down" ? -1 : 1);
    let identicalCount = 0;
    let lastHash = initialHash;

    for (let i = 0; i < 2000; i++) {
      await dragPan(0, stepY);
      await page.waitForTimeout(DELAY_MS);
      const buf = await captureCanvasBuffer();
      const h = md5(buf);
      if (h === lastHash) {
        identicalCount++;
      } else {
        identicalCount = 0;
        lastHash = h;
      }
      const idx = `v_${direction}_${i}`;
      await fs.writeFile(path.join(CAP_DIR, `${idx}.png`), buf);

      console.log(`v-step ${i} hash=${h} identical=${identicalCount}`);
      if (identicalCount >= MAX_IDENTICAL_TO_EDGE) {
        console.log("Edge detected (vertical). stopping.");
        return { steps: i + 1, lastHash: lastHash };
      }
    }
    throw new Error("Vertical edge scan reached iteration cap");
  }

  let vertMeta;
  try {
    vertMeta = await findEdgeVert("down");
  } catch (e) {
    console.log("Down scan didn't detect edge, trying up scan:", e.message);
    vertMeta = await findEdgeVert("up");
  }

  // Now we have an approximate tile-count horizontally and vertically from edges.
  // The "steps" counts are how many step-movements were made from the initial position to the edges.
  // We'll now return to the top-left corner by reversing the pans.
  console.log("Returning to a top-left corner (approx).");

  // Reverse vertical pans
  const revV = -Math.round(VIEWPORT.height * STEP_FRACTION) * (vertMeta ? (vertMeta.lastHash ? 1 : 1) : 1);
  for (let i = 0; i < vertMeta.steps; i++) {
    await dragPan(-0, -revV); // reverse
    await page.waitForTimeout(100);
  }
  // Reverse horizontal pans
  const revH = -Math.round(VIEWPORT.width * STEP_FRACTION) * (horizMeta ? (horizMeta.lastHash ? 1 : 1) : 1);
  for (let i = 0; i < horizMeta.steps; i++) {
    await dragPan(-revH, 0);
    await page.waitForTimeout(100);
  }

  // At this point we should be near top-left.
  // Now do structured raster scan from top-left:
  console.log("Beginning structured raster scan and saving tiles...");

  const cols = horizMeta.steps + 1; // approximate
  const rows = vertMeta.steps + 1; // approximate
  console.log(`Estimated grid: ${cols} cols x ${rows} rows`);

  // We'll scan rows top-to-bottom. For each row, scan left-to-right capturing each tile.
  // For each grid cell, we:
  //   - capture current canvas
  //   - save with coordinates
  //   - drag right by stepX to go next column
  // At end of row, return to leftmost and drag down by stepY to next row.

  const stepX = Math.round(VIEWPORT.width * STEP_FRACTION);
  const stepY = Math.round(VIEWPORT.height * STEP_FRACTION);

  // Ensure we are at top-left by doing a few extra reversals
  for (let i = 0; i < 3; i++) { await dragPan(stepX, 0); await page.waitForTimeout(50); }
  for (let i = 0; i < 3; i++) { await dragPan(0, stepY); await page.waitForTimeout(50); }
  // then reverse to get top-left for structured scan
  for (let i = 0; i < 3; i++) { await dragPan(-stepX, 0); await page.waitForTimeout(50); }
  for (let i = 0; i < 3; i++) { await dragPan(0, -stepY); await page.waitForTimeout(50); }

  // Now structured scan
  const saved = []; // rows of filepaths
  for (let r = 0; r < rows; r++) {
    const rowFiles = [];
    for (let c = 0; c < cols; c++) {
      await page.waitForTimeout(DELAY_MS);
      const buf = await captureCanvasBuffer();
      const filename = `tile_r${r}_c${c}.png`;
      const filepath = path.join(CAP_DIR, filename);
      await fs.writeFile(filepath, buf);
      rowFiles.push(filepath);
      console.log(`Saved ${filename} (r${r},c${c})`);

      // move right unless last column
      if (c < cols - 1) {
        await dragPan(-stepX, 0); // drag left -> pan right
        await page.waitForTimeout(DELAY_MS);
      }
    }

    saved.push(rowFiles);

    // After a row complete: return to leftmost by dragging opposite direction
    for (let c = 0; c < cols - 1; c++) {
      await dragPan(stepX, 0); // drag right -> pan left
      await page.waitForTimeout(50);
    }

    // Move down one row (drag up to pan down)
    if (r < rows - 1) {
      await dragPan(0, -stepY);
      await page.waitForTimeout(DELAY_MS);
    }
  }

  console.log("Raster scan finished. Closing browser...");
  await browser.close();

  console.log("Stitching captured tiles...");

  // Stitch images using node-canvas
  // Each tile is viewport size (width x height), but final stitched image uses STEP_FRACTION overlap.
  const tileW = VIEWPORT.width;
  const tileH = VIEWPORT.height;
  const effectiveStepX = Math.round(VIEWPORT.width * STEP_FRACTION);
  const effectiveStepY = Math.round(VIEWPORT.height * STEP_FRACTION);

  const stitchedWidth = (cols - 1) * effectiveStepX + tileW;
  const stitchedHeight = (rows - 1) * effectiveStepY + tileH;

  console.log(`Stitched size: ${stitchedWidth} x ${stitchedHeight}`);

  const canvas = createCanvas(stitchedWidth, stitchedHeight);
  const ctx = canvas.getContext("2d");

  for (let r = 0; r < saved.length; r++) {
    for (let c = 0; c < saved[r].length; c++) {
      const imgPath = saved[r][c];
      if (!fs.existsSync(imgPath)) continue;
      const img = await loadImage(imgPath);
      const dx = c * effectiveStepX;
      const dy = r * effectiveStepY;
      ctx.drawImage(img, dx, dy, tileW, tileH);
    }
  }

  const outPath = path.join(OUTPUT_DIR, "nationsmap_stitched.png");
  const outStream = fs.createWriteStream(outPath);
  const pngStream = canvas.createPNGStream();
  pngStream.pipe(outStream);

  await new Promise((resolve) => outStream.on("finish", resolve));
  console.log("Saved stitched image to:", outPath);
  console.log("Done.");
})().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
