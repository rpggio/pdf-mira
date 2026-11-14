// Isolated development harness: never mounts the production paper API.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const records = new Map();
const files = new Map();
for (const dir of await readdir(resolve(root, 'samples/papers'))) {
  const folder = resolve(root, 'samples/papers', dir);
  const record = JSON.parse(await readFile(resolve(folder, 'record.json'), 'utf8'));
  delete record.arxivId; // Force the viewer to use the local PDF provider.
  records.set(record.id, record);
  for (const name of ['paper.pdf', 'paper.mira.jsonld', 'map-1.mira.jsonld']) {
    try { files.set(`/api/papers/${encodeURIComponent(record.id)}/artifacts/${name}`, await readFile(resolve(folder, name))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
const fixture = records.get('sample:rain-gardens');
const map = files.get(fixture.artifacts.mira);
const pdf = files.get(fixture.artifacts.pdf);
const json = (res, status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const plugin = { name: 'isolated-mock-providers', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/') && !path?.startsWith('/mock/')) return next();
    try {
      if (path === '/api/access') return json(res, 200, { gated: false, authenticated: true, contactEmail: process.env.PDF_MIRA_CONTACT_EMAIL?.trim() || null });
      if (path === '/mock/ai' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json'); return res.end(map);
      }
      if (files.has(path)) {
        res.setHeader('Content-Type', path.endsWith('.pdf') ? 'application/pdf' : 'application/json');
        return res.end(files.get(path));
      }
      if (path === '/api/papers' && req.method === 'GET') return json(res, 200, [...records.values()]);
      if (path === '/api/papers' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: { message: 'Request too large' } }); }
        const input = JSON.parse(body).arxiv;
        if (typeof input !== 'string' || !/^(?:\d{4}\.\d{4,5})(?:v\d+)?$/.test(input)) return json(res, 400, { error: { message: 'Use a numeric arXiv ID for this mock.' } });
        const id = `mock:${input}`;
        if (records.has(id)) return json(res, 200, records.get(id));
        const base = `/api/papers/${encodeURIComponent(id)}/artifacts/`;
        const record = { ...fixture, id, title: `Mock import: ${input} — Rain Gardens`, capturedAt: new Date().toISOString(), status: 'processing', stage: 'converting_mira', graphs: undefined, artifacts: { pdf: base + 'paper.pdf', mira: base + 'paper.mira.jsonld' } };
        records.set(id, record);
        res.setHeader('Location', `/api/papers/${encodeURIComponent(id)}`);
        json(res, 202, record);
        // Exercise an HTTP AI endpoint, with a fixed same-process loopback destination.
        const address = server.httpServer.address();
        const result = await fetch(`http://127.0.0.1:${address.port}/mock/ai`, { method: 'POST', signal: AbortSignal.timeout(5000) });
        if (!result.ok) throw new Error('Mock AI failed');
        files.set(record.artifacts.mira, Buffer.from(await result.text())); files.set(record.artifacts.pdf, pdf);
        record.status = 'ready'; record.updatedAt = new Date().toISOString();
        return;
      }
      if (path.startsWith('/api/papers/') && req.method === 'GET') {
        const record = records.get(decodeURIComponent(path.slice('/api/papers/'.length)));
        return json(res, record ? 200 : 404, record ?? { error: { message: 'Unknown mock paper' } });
      }
      return json(res, 404, { error: { message: 'Unsupported mock route' } });
    } catch { if (!res.writableEnded) json(res, 500, { error: { message: 'Mock request failed' } }); }
  });
} };
const server = await createServer({ root, configFile: false, envFile: false, plugins: [react(), plugin], server: { host: '127.0.0.1', port: Number(process.env.MOCK_PORT ?? 5188), strictPort: true, fs: { deny: ['.env', '.env.*', '**/.git/**', '**/data/**', '**/output/**', '**/*.{key,pem}'] } } });
await server.listen();
console.log('MOCK ONLY: local PDFs and deterministic AI; imports reset on restart.');
server.printUrls();
