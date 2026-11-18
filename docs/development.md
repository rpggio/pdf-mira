# Development guide

## Run and verify

Follow the [local setup](../README.md). Vite’s development and preview servers both mount the paper API. To smoke-test the built app, run `pnpm build && pnpm preview`. The static files in `dist/` need the paper API to load the library and import papers. Preview is for local checks.

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check TypeScript |
| `pnpm test` | Run reader, extraction, storage, and API tests with controlled upstream responses |
| `pnpm build` | Build the browser client |
| `pnpm verify:ingestion` | With `pnpm dev` running, exercise the sample library and reader, then check polling, retries, and offline recovery with browser API fixtures |
| `pnpm help:shots` | Recapture the screenshots in the full and quick help (needs `pnpm dev` running and Chrome) |
| `pnpm dev:mock` | Run the isolated mock reader on `http://127.0.0.1:5188/` (see [mock development](mock-development.md)) |
| `pnpm verify:pdf-viewer` | Build and test the internal PDF viewer in a local Chromium browser via Puppeteer |
| `pnpm verify:mock` | Check the mock reader and every sample in headless Chrome |
| `pnpm verify:live -- <arxiv-id>` | Verify real acquisition, extraction, publication, and cache reuse using the server credential |

Other scripts, run with `node`:

| Script | Purpose |
| --- | --- |
| `scripts/audit-map.mjs <map-file>...` | Audit saved maps for topology problems |
| `scripts/regenerate-papers.mjs [id...]` | Regenerate maps for ready papers in `PAPERS_DIR`; calls the model |
| `scripts/pdf-text.mjs <pdf>` | Print a PDF’s text per page, for writing and checking fixtures |
| `scripts/make-sample-pdf.mjs <text> <pdf>` | Typeset a text file as a two-column PDF with headless Chrome (how the Rain Gardens sample was made from `scripts/rain-gardens.source.txt`) |

For browser verification and screenshots, start the dev server with a fresh library. Set `PAPERS_DIR` to a new directory before starting it to seed a separate library. Set `HELP_BASE` to the server URL if it differs from `http://localhost:5178/`, and set `CHROME` to the Chrome executable if it differs from the script’s macOS default. See [Contributing](#contributing) for help updates.

Live verification writes to `PAPERS_DIR`. Use a fresh library to exercise conversion. A ready record for the same version is reused without another model call.

## Server configuration

| Environment variable | Purpose |
| --- | --- |
| `PAPERS_DIR` | Library directory, default `data/papers` relative to the working directory |
| `SAMPLES_DIR` | Seed library copied into an empty library, default `samples/papers` |
| `OPENROUTER_API_KEY` | Server-only credential for generating maps |
| `MIRA_MODEL` | Optional OpenRouter model override, default `openai/gpt-6.1-sol` |
| `PDF_MIRA_CONTACT_EMAIL` | Optional address behind **Feedback** and **Request access**; public through `/api/access` |
| `PDF_MIRA_ORIGIN` | Turns on the invite gate in `pnpm preview`; the exact HTTPS origin |
| `PDF_MIRA_INVITES_FILE`, `PDF_MIRA_SIGNING_KEY_FILE` | Invite gate files; see below |
| `CREDENTIALS_DIRECTORY` | Fallback folder for `invites.json` and `session-key` (set by systemd `LoadCredential`) |
| `CHROME`, `HELP_BASE` | Browser scripts: Chrome executable (default is the macOS path) and server URL (default `http://localhost:5178/`) |
| `MOCK_PORT` | Port for `pnpm verify:mock`, default 5189 |
| `VERIFY_LIVE_PAPER_ID` | Paper ID for the live check in `verify:ingestion` |

Pass the key through the process environment using your secret manager. Keep it out of Git, shell arguments, logs, and any `VITE_` variable, which can be exposed to browser code.

For trusted LAN use, bind explicitly with `pnpm dev --host 0.0.0.0` and use the Network address Vite prints. For a custom hostname, set Vite’s `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` to the hostname. Every reachable client can read the shared library and submit or retry imports. The API has no authentication, per-client quotas, or global generation budget. Internet-facing use would need a production server, access controls, and request, storage, and cost limits.

Keep a custom `PAPERS_DIR` outside the Vite workspace or under the repository’s `data/` directory. The development server can serve files directly from the workspace. The default configuration blocks direct requests to `data/` and `output/` while the paper API still serves published artifacts.

## Acquisition and storage

The Library loads every paper from the API, caches records in local storage, and polls processing jobs after reload. Extra maps added with **+ graph** stay in IndexedDB, scoped to the browser and site.

The backend resolves an arXiv URL or ID to a specific version through the [arXiv Atom API](https://info.arxiv.org/help/api/user-manual.html) and stores the descriptor. The browser loads the versioned PDF directly from arXiv. It retrieves HTML-derived Markdown using [arxiv2md](https://github.com/timf34/arxiv2md#rest-api), keeping references, citations, and the table of contents. Papers without usable HTML fail with `NO_USABLE_HTML`. The Library shows the authors’ arXiv abstract.

Each paper lives in a base64url-encoded directory under `PAPERS_DIR`, including legacy IDs with slashes. The backend writes `record.json`, a private `paper.md` cache, `paper.mira.jsonld`, `extraction-report.json`, and `processing.log` as work progresses. Atomic renames publish complete artifacts. A per-paper lock prevents duplicate jobs across processes on one host. Startup and a 30-second sweep recover abandoned jobs as retryable errors and restore ready records from interrupted regenerations. Shared storage across multiple hosts is unsupported. Explicit retry reuses completed acquisition artifacts.

## API

| Route | Behavior |
| --- | --- |
| `GET /api/papers` | List records by capture time, with errors last |
| `POST /api/papers` | Accept `{"arxiv":"2501.11120v1"}`. Return 202 for processing or 200 for a cached ready or error record, with a polling URL in `Location` |
| `GET /api/papers/{encoded-id}` | Return a known record at any status or 404 if it is missing |
| `POST /api/papers/{encoded-id}/retry` | Retry an eligible failure under the job lock. Non-retryable failures return 409 |
| `GET /api/papers/{encoded-id}/artifacts/{file}` | Serve published maps and bundled example PDFs |

Structured errors carry a stage where available, a code, a message, and a retryability flag. During generation, `progress.fraction` and `progress.estimatedRemainingSeconds` use input length and elapsed time. Estimates are null during acquisition or when generation outlasts the estimate.

## Map generation and audit

[`server/converter.ts`](../server/converter.ts) calls the pinned [MIRA-extraction](https://github.com/MIRA-science/MIRA-extraction) dependency through its `decompose` API. The [extraction prompt](../server/extraction-prompt.ts) asks for a grounded account of the argument and adjusts the target map size to the amount of substantive content. The stored Markdown goes to OpenRouter in one streamed request. The converter rejects inputs over 400,000 characters and uses the extractor’s idle and progress watchdogs.

The pinned extractor has no published license. Obtain upstream permission before redistributing a package or image that includes the extractor.

Before publishing, the server validates the JSON-LD and removes cards without a link to another card. If no connected cards remain, the retryable error is `NO_CONNECTED_RECORDS`. Separate arguments can remain in separate components. Conversion provenance includes the input hash, arXiv version, extractor version, model, and prompt version. The extraction report records validation details, usage, and topology, including whether claims and evidence reach a question through `supports`, `opposes`, and `addresses`. The processing log records progress and completion metadata.

Audit saved files without a server or model call.

```sh
node scripts/audit-map.mjs <map-file> [map-file ...]
```

The JSON output includes paths, SHA-256 hashes, parser warnings, isolated cards, components, and paths to questions. These checks describe the map’s structure. Assess the argument and the supporting passages in the reader.

To regenerate saved arXiv maps, use the library directory and server credential for that instance.

```sh
node scripts/regenerate-papers.mjs 2501.11120v1
```

Pass one or more versioned IDs to select papers. Omitting IDs regenerates all eligible ready arXiv papers in that library. The command reuses saved Markdown and publishes a new map after validation. A failed regeneration restores the previous ready record.

## Reader internals

- [`parse.ts`](../src/lib/parse.ts) reads MIRA JSON-LD and working graph JSON. [`graph.ts`](../src/lib/graph.ts) drops dangling links and marks unquoted relations as inferred. The reader treats saved maps as read-only. It derives display keys in stored node order, counting separately for each type, and strips matching type prefixes from displayed titles. It uses the original IDs for links, anchors, and selection.
- [`modules/pdf-viewer`](../modules/pdf-viewer/) owns the pdf.js imports, worker, stylesheet, document lifetime, page rendering, and text extraction. The reader consumes page geometry and text elements through the module. The browser entry point uses the legacy library, worker, and stylesheet. The Node entry point uses the legacy library for fixture tools and unit tests.
- [`anchor.ts`](../src/lib/anchor.ts) normalizes PDF text and maps each character back to its page, item, and offset. It handles ligatures, hyphenation, and repeated page furniture, preserves repeated exact matches, and falls back to token overlap. Records without a usable quote can get a visibly estimated location. [`PdfViewer.tsx`](../src/components/PdfViewer.tsx) measures highlights against the rendered pdf.js text layer. Record highlights persist independently of margin-mark visibility; hover and selection change the opacity of the same type-colored overlay. Selected edges also show their relation-colored passages. Approximate and estimated matches retain dashed and dotted underlines. Navigation scrolls without a transient outline. Margin pills are centered on the right page edge.
- [`focus.ts`](../src/lib/focus.ts) selects the visible argument neighborhood. [`layout.ts`](../src/lib/layout.ts) layers the full map with dagre for React Flow. Each paper opens in Full Graph. View and scope choices apply to the open reader. Full Graph fits the nodes in the settled PDF bands. A margin-mark click centers its node at the current zoom until the set of visible nodes changes. Node opacity is reduced only in On screen scope. Sequence always uses full opacity for cards and reference chips.
- [`sequence.ts`](../src/lib/sequence.ts) places records in passage order, assigns lanes for nearby links, and interpolates the scroll position between the two panes. [`userScroll.ts`](../src/lib/userScroll.ts) limits synchronization to user-initiated scrolls.

## Browser compatibility

The reader has been verified on Chromium 131 from 2024. The legacy pdf.js library and worker each supply newer JavaScript APIs, including `Uint8Array.prototype.toHex` for document fingerprints. Before importing the reader, the app checks for Web Workers, `DOMMatrix`, and `Path2D`.

Run `pnpm verify:pdf-viewer` for a browser smoke test. Set `CHROME` to the path to Chrome, Edge, or Chromium if needed. The command uses the root Vite build settings to bundle a standalone fixture with the sample PDF. It verifies URL and byte-buffer loading, the dedicated worker, canvas output, selectable text, and the guidance shown when Web Workers are unavailable. Run it when upgrading pdf.js or changing its integration.

## Optional invite gate

A deployment on a shared network can require an invite. The gate exists only in the preview server: `pnpm dev` never uses it. Build, then run `pnpm preview` with `PDF_MIRA_ORIGIN` set to the exact public HTTPS origin, and put a TLS-terminating proxy in front. Preview binds to localhost unless you pass `--host`. The gate reads two files, whose paths come from `PDF_MIRA_INVITES_FILE` and `PDF_MIRA_SIGNING_KEY_FILE`, or from `invites.json` and `session-key` in `CREDENTIALS_DIRECTORY`. Keep the paper API behind the gate: it has no accounts or quotas of its own. Keep both outside Git and readable only by the service account. A missing or invalid file prevents startup.

The invite file is a JSON array with exactly one access key. The entry has a `name` and a `sha256` field containing the hex SHA-256 digest of the key string. Optional `expiresAt` is an ISO 8601 timestamp. The key grants full app access, including adding papers and retrying generation. Generate it with 32 random bytes encoded as 64 lowercase hex characters. Share only the full `<origin>/invite#access=<key>` URL with the intended audience. The signing key is a persistent 32-byte hex value; keep it stable across deployments.

The entry page removes the fragment and redeems the key once. The browser gets a signed session cookie that lasts 90 days from redemption, including across restarts and invite expiry. Set `expiresAt` to 90 days from issuance for a three-month invite. Replacing the key digest revokes existing sessions. Rotating the signing key revokes all sessions.

The React app shell, build assets, favicon, and preview images (including `/social-preview.png`) are public. React shows the invite screen until a session is established. The middleware requires a session for full help and all paper data and APIs. The public access status endpoint returns the session state and the optional contact address.

Set `PDF_MIRA_CONTACT_EMAIL` in the server environment to show **Request access** and **Feedback**. The address is public through the access status endpoint.

The service logs JSON events for visits, successful redemptions, and authenticated API requests. Each has the time, invite name, route category, method, and response status. The app omits keys, cookies, query strings, and request bodies.

## Isolated test harness

See [local mock development](mock-development.md). `scripts/mock-reader.mjs` runs a separate Vite configuration with in-memory mock paper and AI endpoints, local bundled PDFs, and no production paper store. `scripts/verify-mock.mjs` checks sample rendering and mock import while blocking external browser requests.

## Contributing

**Read `public/help.html` before changing product behavior.** It is the reference for what the product does.

**Use proportionate verification.** Choose checks based on scope, risk, and likely failure modes. For copy, attribution, link, or instruction edits, inspect the text, destinations, and diff; do not automatically rerun tests or refresh screenshots. For behavior changes, run relevant tests and focused browser checks, adding regression coverage for meaningful bugs. For broad changes, infrastructure, dependencies, or release preparation, normally run `pnpm typecheck`, `pnpm test`, and `pnpm build`, plus relevant acceptance checks. Repeat or broaden checks only when new changes, failures, or unresolved concerns justify it. Report checks and material gaps briefly. Documentation-only edits do not require rebuilding or restarting the app.

**Keep the help accurate.** Update affected guidance when behavior, labels, or workflows change enough to make it inaccurate. Small copy or attribution edits do not require changes to both help files unless the guidance quotes that text or becomes misleading.

1. `public/help.html`: keep full-help contents links and section ids in step.
2. `src/components/HelpDrawer.tsx`: keep quick-help entries short, with `more:` links to full-help sections.
3. `public/help/img/`: refresh illustrations when meaningful visual or workflow changes make them misleading, or when requested. Minor wording differences alone do not require recapturing every image. Use `scripts/help-shots.mjs` when refreshing and inspect affected images.
4. Update `README.md` for local setup changes and this guide for changes to internals.

`test/help.test.ts` checks links and image references, not whether guidance is true. Read affected sections and remove help for removed features. Write for people reading papers: plain words, short sentences, current behavior, and accurate control labels. For substantial rewrites, use judgment about whether an independent readability review would help.

**Conventions.**

- The reader is read-only: it shows a map and never changes it. There is no editing, review or export. `effectiveGraph` (`src/lib/graph.ts`) only drops dangling links and flags unquoted ones as provisional.
- The authors' words (PDF highlights) and the AI reconstruction (card text) stay visibly distinct. Guesses, such as estimated locations and inferred relations, are always marked as such.
- Do not copy code from MIRA-extraction, which has no published license. Read only its output formats.
- Keep personal data, credentials, hostnames, and third-party papers out of the repository. `data/` and `output/` are git-ignored scratch space.

## Social previews

`index.html` supplies the description, Open Graph tags, and large-image Twitter
card tags without requiring JavaScript. Under the invite gate, the server uses
`PDF_MIRA_ORIGIN` at runtime to produce absolute image URLs, a canonical home
URL, and `og:url`. Request hosts, query strings, and invite fragments are never
used for these values. `/social-preview.png` supports public GET and HEAD while
paper data and full help stay gated. No host settings are embedded in source.
Ungated local development uses the relative preview image URL.

`pnpm help:shots` also captures the 1200 × 630 social image from the fictional
Rain Gardens reader. Use a fresh sample library, inspect the result, and rebuild.
The Library footer stays in document flow so it cannot cover Retry controls.
