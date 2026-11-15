// Starts a fresh mock server; fails if the browser requests any external URL.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const port = process.env.MOCK_PORT ?? '5189';
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/mock-reader.mjs'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_PORT: port } });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock startup timeout')), 20000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Mock server exited')); });
    child.stdout.on('data', b => { if (b.toString().includes('MOCK ONLY')) { clearTimeout(timer); resolve(); } });
  });
  const records = await (await fetch(base + '/api/papers')).json();
  assert.equal(records.length, 1);
  for (const record of records) {
    assert.equal(record.arxivId, undefined);
    const bytes = Buffer.from(await (await fetch(base + record.artifacts.pdf)).arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  }
  const response = await fetch(base + '/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arxiv: '2501.11120v1' }) });
  assert.equal(response.status, 202);
  const location = response.headers.get('location');
  let imported;
  for (let i = 0; i < 50; i++) {
    imported = await (await fetch(base + location)).json();
    if (imported.status === 'ready') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(imported.status, 'ready');
  assert.ok((await (await fetch(base + imported.artifacts.mira)).json())['@graph']);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  const external = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (!url.startsWith(base + '/') && !url.startsWith('data:') && !url.startsWith('blob:')) { external.push(url); return req.abort(); }
    return req.continue();
  });
  for (const record of [...records, imported]) {
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`[data-paper-id="${record.id}"] .paper-title`);
    await page.click(`[data-paper-id="${record.id}"] .paper-title`);
    await page.waitForSelector('.react-flow__node', { timeout: 30000 });
    await page.waitForSelector('.textLayer span');
    await page.waitForSelector('.hl-group .hl');
  }
  assert.deepEqual(external, [], 'Unexpected external browser requests');
  console.log('PASS: the local sample PDF, mock AI import, and two rendered maps with text/highlights; no external browser requests.');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
}
