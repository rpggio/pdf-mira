# Local mock development

The bundled sample is a fictional four-page, two-column paper with two graphs. It covers a running header and footer, hyphenated line breaks, repeated, approximate, and missing quotes, a sentence across a page break, and estimated locations. See `samples/README.md`.

Install Node.js 24, pnpm 11, and dependencies:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm verify:mock
pnpm dev:mock
```

Open `http://127.0.0.1:5188/`. This separate development server serves the bundled sample PDF locally. Its `/mock/ai` endpoint returns a fixed fictional Rain Gardens graph. Importing any numeric arXiv ID returns that fictional paper, labeled **Mock import**. Results reset on restart. The mock server does not mount the production API, read the runtime paper library, or use real provider credentials. It ignores `.env` files and binds to loopback.

Dependency installation initially needs network access. Afterwards the mock reader requires no external provider. Browser validation requires Chrome/Chromium; set `CHROME` to its executable path when different from the macOS default. `pnpm verify:mock` starts a separate server on port 5189, checks the sample and a mock import, and blocks and fails on external browser requests. Set `MOCK_PORT` to change the port.

This harness tests rendering and import UI, not real extraction quality or OpenRouter streaming compatibility. The existing extractor tests mock streaming responses separately. The dependency manifest references MIRA-extraction; its license status is documented in the development guide.
