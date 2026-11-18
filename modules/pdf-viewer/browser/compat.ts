import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build, preview, type PreviewServer } from "vite";
import { BROWSER_GUIDANCE } from "../browserSupport.ts";

const fixturePath = "/modules/pdf-viewer/browser/fixture.html";
const executablePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let outDir: string | undefined;
let server: PreviewServer | undefined;
let browser: Browser | undefined;
let base: string;

before(async () => {
  outDir = await mkdtemp(join(tmpdir(), "pdf-viewer-compat-"));
  await build({
    publicDir: false,
    build: { outDir, emptyOutDir: false, rollupOptions: { input: fileURLToPath(new URL("./fixture.html", import.meta.url)) } },
  });
  // Serve only the built fixture assets, without the app's paper API and invite gate.
  server = await preview({ configFile: false, publicDir: false, build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath, headless: true });
  console.log(await browser.version());
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      if (outDir) await rm(outDir, { recursive: true, force: true });
    }
  }
});

async function resultFor(page: Page, search = "") {
  await page.setCacheEnabled(false);
  const response = await page.goto(base + fixturePath + search);
  assert.ok(response?.ok(), `Fixture returned HTTP ${response?.status()}`);
  await page.waitForSelector("#result[data-status]");
  return page.$eval("#result", (el) => ({ status: el.getAttribute("data-status"), text: el.textContent }));
}

for (const [source, search] of [["URL", ""], ["retained bytes", "?bytes"]]) {
  test(`opens a PDF from ${source} with a worker and renders the canvas and selectable text`, async () => {
    const page = await browser!.newPage();
    try {
      const workers: string[] = [];
      const errors: unknown[] = [];
      page.on("workercreated", (worker) => workers.push(worker.url()));
      page.on("pageerror", (error) => errors.push(error));
      const result = await resultFor(page, search);
      assert.equal(result.status, "ok", result.text ?? "");
      assert.deepEqual(JSON.parse(result.text!), {
        pageCount: 4,
        canvasHasInk: true,
        textMatches: true,
        textHasGeometry: true,
        bytesPreserved: true,
      });
      assert.ok(workers.some((url) => /\/pdf\.worker\.min-[^/]+\.mjs$/.test(url)), "A dedicated PDF worker must start");
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("shows browser guidance when Web Workers are unavailable", async () => {
  const page = await browser!.newPage();
  try {
    await page.evaluateOnNewDocument(() => Reflect.deleteProperty(window, "Worker"));
    assert.deepEqual(await resultFor(page), { status: "unsupported", text: BROWSER_GUIDANCE });
  } finally {
    await page.close();
  }
});
