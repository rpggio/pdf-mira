// Regenerate the illustrations used by the help (public/help.html and the
// quick-help drawer). Drives the running dev server with headless Chrome.
//
//   pnpm dev            # in another terminal
//   pnpm help:shots     # writes public/help/img/*.png
//
// Rerun whenever the reader's look changes, then check the images still match
// what the help text says about them.
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.HELP_BASE ?? "http://localhost:5178/";
const OUT = new URL("../public/help/img/", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
const page = await browser.newPage();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name, opts) => page.screenshot({ path: OUT + name + ".png", ...opts }).then(() => console.log("wrote", name));
const el = async (sel) => {
  const h = await page.$(sel);
  if (!h) throw new Error(`not found: ${sel}`);
  return h;
};
const box = async (sel, pad = 0) => {
  const b = await (await el(sel)).boundingBox();
  return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 };
};
const mouseAway = () => page.mouse.move(200, 400); // over the PDF: the graph is free to update
const selectNode = async (id) => {
  // read on until the record's passage is on screen, so it is in the graph
  for (let y = 0; y < 20000 && !(await page.$(`.react-flow__node[data-id="${id}"]`)); y += 250) {
    await page.evaluate((y) => (document.querySelector(".pdf-scroll").scrollTop = y), y);
    await pause(500);
  }
  const ids = await page.$$eval(".react-flow__node", (ns) => ns.map((n) => n.dataset.id));
  if (!ids.includes(id)) throw new Error(`record ${id} is not in the graph; showing: ${ids.join(", ")}`);
  await page.click(`.react-flow__node[data-id="${id}"]`);
  await mouseAway();
  await pause(1800);
};
const scrollPdfTo = async (y) => {
  await page.evaluate((y) => (document.querySelector(".pdf-scroll").scrollTop = y), y);
  await pause(1500);
};
const deselect = async () => {
  const b = await box(".graph-area");
  await page.mouse.click(b.x + 10, b.y + 10); // empty canvas
  await mouseAway();
  await pause(1500);
};

// fresh state: default scope and view, no help open
await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.goto(BASE, { waitUntil: "networkidle0" });
await page.waitForSelector('.paper-card.ready');
await shot("library", {});
// Show a reproducible mid-generation state without making a model call.
{
  const records = await page.evaluate(async () => (await fetch("/api/papers")).json());
  const paper = records.find((record) => record.arxivId === "2407.20666v2");
  if (!paper) throw new Error("Start the reader with the bundled sample library before capturing help images.");
  const example = { ...paper, status: "processing", stage: "converting_mira",
    progress: { fraction: 0.55, estimatedRemainingSeconds: 35 } };
  const progressPage = await browser.newPage();
  await progressPage.setRequestInterception(true);
  progressPage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    void (path.startsWith("/api/papers")
      ? request.respond({ contentType: "application/json", body: JSON.stringify(path === "/api/papers" ? [example] : example) })
      : request.continue());
  });
  await progressPage.goto(BASE, { waitUntil: "networkidle0" });
  const card = await progressPage.waitForSelector(".paper-card.processing");
  const bounds = await card.boundingBox();
  const clip = { x: Math.floor(bounds.x) - 4, y: Math.floor(bounds.y) - 4,
    width: Math.ceil(bounds.width) + 8, height: Math.ceil(bounds.height) + 8 };
  await progressPage.screenshot({ path: OUT + "processing.png", clip });
  console.log("wrote processing");
  await progressPage.close();
}
await page.click('[data-paper-id="sample:trial-detection"] .paper-title');
await page.waitForSelector(".react-flow__node", { timeout: 30000 });
// Use On screen for the examples of contextual shading and the compact map.
await page.click('[aria-label="Which records"] button:first-child');
await mouseAway();
await pause(2500);

// 1. the whole screen, a record selected
await selectNode("c1");
await shot("screen", {});

// 3. PDF highlight of the selected record
{
  const hl = await box(".hl-group.sel .hl");
  const pane = await box(".pdf-scroll");
  await shot("pdf-highlight", { clip: { x: pane.x, y: Math.max(pane.y, hl.y - 70), width: pane.width, height: 200 } });
}

// 6. on-screen map with nothing selected, reading page 2 (source of the card crops)
await scrollPdfTo(1150);
await deselect();

// 7. card states, from that map: on screen and faded
{
  const ids = await page.$$eval(".react-flow__node", (ns) => {
    const g = document.querySelector(".graph-area").getBoundingClientRect();
    return ns
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.top > g.top + 20 && r.bottom < g.bottom - 20 && r.left > g.left + 20 && r.right < g.right - 20;
      })
      .map((n) => {
        const r = n.getBoundingClientRect();
        const d = Math.hypot(r.left + r.width / 2 - (g.left + g.width / 2), r.top + r.height / 2 - (g.top + g.height / 2));
        return { id: n.dataset.id, d, dim: !!n.querySelector(".card.dim"), est: !!n.querySelector(".card.onscreen-est") };
      })
      .sort((a, b) => a.d - b.d); // cards near the middle stay in view when zoomed
  });
  const on = ids.find((n) => !n.dim && !n.est);
  const dim = ids.find((n) => n.dim);
  // zoom the canvas to about 100% around a card so the crops are readable
  const zoomAround = async (id) => {
    for (let i = 0; i < 20; i++) {
      const b = await box(`.react-flow__node[data-id="${id}"]`);
      const scale = await page.$eval(".react-flow__viewport", (v) => Number(/scale\(([\d.]+)\)/.exec(v.style.transform)?.[1] ?? 1));
      if (scale >= 0.98) return;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.wheel({ deltaY: -100 });
      await pause(150);
    }
  };
  const card = async (name, n, pad) => {
    await page.click(".react-flow__controls-fitview"); // back to the whole picture first
    await pause(700);
    await zoomAround(n.id);
    await page.mouse.move(5, 5); // off the card, so it is not drawn as hovered (still holds nothing: outside the graph)
    await pause(300);
    await shot(name, { clip: await box(`.react-flow__node[data-id="${n.id}"]`, pad) });
  };
  if (on) await card("card-onscreen", on, 6);
  if (dim) await card("card-faded", dim, 6);
}

// 8. margin marks beside the text
{
  const pane = await box(".pdf-scroll");
  const mark = await box(".margin-marks .mark");
  const x = Math.max(pane.x, mark.x + mark.width + 12 - 360);
  await shot("margin-marks", { clip: { x, y: Math.max(pane.y, mark.y - 90), width: 360, height: 200 } });
}

// 10. outline, on-screen scope
await page.click('[role="radiogroup"][aria-label="How to show them"] button:nth-child(2)');
await mouseAway();
await pause(1500);
await shot("outline", { clip: await box(".graph-area") });

// 11. sequence: paper order, loops and reference chips (it scrolls with the paper)
await page.click('[role="radiogroup"][aria-label="How to show them"] button:nth-child(3)');
await mouseAway();
await pause(2000);
await shot("sequence", { clip: await box(".graph-area") });
{
  // close-up of a reference chip beside its card
  // a chip comfortably inside the visible panel
  const g = await box(".graph-area");
  let chip;
  for (const c of await page.$$(".seq-ref")) {
    const b = await c.boundingBox();
    if (b && b.y > g.y + 40 && b.y + b.height < g.y + g.height - 40 && b.x > g.x + 300) {
      chip = b;
      break;
    }
  }
  await shot("sequence-ref", { clip: { x: chip.x + chip.width + 8 - 360, y: chip.y - 35, width: 360, height: 90 } });
}

await browser.close();

// keep <img width/height> in help.html equal to the images' CSS size (2x captures)
{
  const { readFileSync, writeFileSync } = await import("node:fs");
  const htmlPath = new URL("../public/help.html", import.meta.url);
  let html = readFileSync(htmlPath, "utf8");
  html = html.replace(/<img src="help\/img\/([\w-]+)\.png" width="\d+" height="\d+"/g, (m, name) => {
    const png = readFileSync(OUT + name + ".png");
    const w = png.readUInt32BE(16) / 2;
    const h = png.readUInt32BE(20) / 2;
    return `<img src="help/img/${name}.png" width="${w}" height="${h}"`;
  });
  writeFileSync(htmlPath, html);
  console.log("updated image sizes in help.html");
}
