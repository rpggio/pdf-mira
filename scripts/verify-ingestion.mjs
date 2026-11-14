// Browser acceptance checks. Run pnpm dev, then pnpm verify:ingestion.
// API fixtures exercise UI failures/retries without sending papers to a model.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
const base = process.env.HELP_BASE ?? "http://localhost:5178/";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  defaultViewport: { width: 1280, height: 900 } });
const page = await browser.newPage();
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // First verify actual backend storage and reader artifacts.
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-paper-id="sample:trial-detection"] .paper-title');
  const sample = await page.evaluate(async () => (await (await fetch("/api/papers")).json()).find((p) => p.id === "sample:trial-detection"));
  assert.equal(sample.status, "ready"); assert.equal(sample.graphs.length, 2);
  assert.equal(await page.$('input[type="file"]'), null, "PDF upload is absent");
  await page.click('[data-paper-id="sample:trial-detection"] .paper-title');
  await page.waitForSelector(".react-flow__node");
  const upload = await page.$('.side-pane input[type="file"]');
  assert.ok(upload, "+ map remains available");
  await upload.uploadFile(new URL("../samples/papers/c2FtcGxlOnRyaWFsLWRldGVjdGlvbg/paper.mira.jsonld", import.meta.url).pathname);
  await page.waitForFunction(() => document.querySelector(".graph-select").options.length === 3);
  console.log("PASS backend sample list, stored PDF/map reader, additional map upload");

  if (process.env.VERIFY_LIVE_PAPER_ID) {
    const id = process.env.VERIFY_LIVE_PAPER_ID;
    await page.click('[title="Back to library"]');
    await page.waitForSelector(`[data-paper-id="${id}"].ready .paper-title`);
    await page.click(`[data-paper-id="${id}"].ready .paper-title`);
    await page.waitForSelector(".react-flow__node", { timeout: 60000 });
    const selectedLabel = () => page.$eval(".graph-select", (select) => select.selectedOptions[0].textContent);
    assert.ok((await selectedLabel()).startsWith("MIRA-extraction"));
    await (await page.$('.side-pane input[type="file"]')).uploadFile(new URL("../samples/papers/c2FtcGxlOnRyaWFsLWRldGVjdGlvbg/map-1.mira.jsonld", import.meta.url).pathname);
    await page.waitForFunction(() => document.querySelector(".graph-select").options.length === 2);
    await page.click('[title="Back to library"]');
    await page.waitForSelector(`[data-paper-id="${id}"].ready .paper-title`);
    await page.click(`[data-paper-id="${id}"].ready .paper-title`);
    await page.waitForSelector(".graph-select", { timeout: 60000 });
    assert.ok((await selectedLabel()).startsWith("MIRA-extraction"));
    console.log("PASS live generated paper opens with default extractor map, additional MIRA upload, default retained on reopen");
  }

  const make = (id, status, capturedAt) => ({ ...sample, id, arxivId: id, title: `Paper ${id}`, graphs: undefined,
    authors: "Test author", abstract: "The authors’ abstract.", status, stage: "converting_mira", capturedAt, updatedAt: capturedAt,
    error: status === "error" ? { stage: "converting_mira", code: "CONVERSION_FAILED", message: "Test conversion failed.", retryable: true } : undefined });
  const records = [make("error-old", "error", "2026-01-02T00:00:00.000Z"), make("ready-old", "ready", "2026-01-01T00:00:00.000Z"),
    make("processing", "processing", "2026-01-04T00:00:00.000Z"), make("ready-new", "ready", "2026-01-03T00:00:00.000Z"), make("error-new", "error", "2026-01-05T00:00:00.000Z")];
  let failProcessing = false;
  let finishRetry = false;
  let listCount = 0;
  let polls = 0;
  let offline = false;
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/papers") || url.pathname.includes("/artifacts/")) return request.continue();
    const reply = (status, value) => request.respond({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/papers" && request.method() === "GET") {
      listCount++;
      return offline ? reply(503, { error: { message: "Offline test" } }) : reply(200, records);
    }
    if (url.pathname === "/api/papers" && request.method() === "POST") return reply(400, { error: { message: "Enter a valid arXiv ID." } });
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const record = records.find((p) => p.id === id);
    if (!record) return reply(404, { error: { message: "Unknown paper" } });
    if (request.method() === "POST") {
      record.status = "processing"; delete record.error; record.updatedAt = new Date().toISOString();
      return reply(202, record);
    }
    polls++;
    if (record.id === "processing" && failProcessing && record.status === "processing") {
      record.status = "error"; record.error = { stage: "converting_mira", code: "CONVERSION_FAILED", message: "Test conversion failed.", retryable: true };
      record.updatedAt = new Date().toISOString();
    }
    if (record.id === "error-new" && finishRetry) { record.status = "ready"; record.updatedAt = new Date().toISOString(); }
    return reply(200, record);
  });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("pdf-mira:papers:v1", JSON.stringify([{ id: "stale", status: "ready", capturedAt: "2020-01-01", title: "Stale", artifacts: {} }]));
  });
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-paper-id="processing"]');
  const ids = () => page.$$eval(".paper-card", (cards) => cards.map((p) => p.dataset.paperId));
  assert.deepEqual(await ids(), ["processing", "ready-new", "ready-old", "error-new", "error-old"]);
  assert.equal(await page.$('[data-paper-id="stale"]'), null);
  assert.equal(await page.$eval('section[aria-label="Papers with errors"] .paper-card', (p) => p.dataset.paperId), "error-new");
  console.log("PASS startup fetch, all records, capture ordering, segregated errors, authoritative list");

  await page.reload({ waitUntil: "networkidle0" });
  assert.ok(listCount >= 2);
  failProcessing = true;
  await page.waitForSelector('[data-paper-id="processing"].error', { timeout: 12000 });
  assert.ok(polls > 0);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("pdf-mira:papers:v1")).find((p) => p.id === "processing").status === "error");
  console.log("PASS reload resumes polling, terminal failure details and local record persistence");

  await page.click('[data-paper-id="error-new"] .retry');
  await page.waitForSelector('[data-paper-id="error-new"].processing');
  finishRetry = true;
  await page.waitForSelector('[data-paper-id="error-new"].ready', { timeout: 15000 });
  const terminalPollCount = polls;
  await pause(3000);
  assert.equal(polls, terminalPollCount, "terminal records are no longer polled");
  await page.type("#arxiv", "invalid"); await page.click("button.primary");
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes("Enter a valid arXiv ID."));
  console.log("PASS explicit retry, ready transition, polling stops at terminal states, invalid input feedback");

  offline = true;
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes("Offline test"));
  assert.equal((await ids()).length, records.length);
  offline = false;
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'), { timeout: 10000 });
  assert.deepEqual(failures, []);
  console.log("PASS offline cached library, automatic reconnection, no browser exceptions");
} finally { await browser.close(); }
