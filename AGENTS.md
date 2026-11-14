# Agent guide: pdf-mira

## Read first

- **`public/help.html` is the full user help, and the reference for what the
  product does.** Read it before changing behavior: it describes every part
  of the reader as users see it. `README.md` covers local setup.
  `docs/development.md` describes the API, storage, and reader internals.
- Stack: Vite, React, TypeScript, pdf.js, React Flow, dagre, vitest. Use
  `pnpm`. Checks: `pnpm typecheck`, `pnpm test`, `pnpm build`. Dev server:
  `pnpm dev` (port 5178).

## Keep the help current (required)

Every change a user can see or rely on updates the help in the same change:

1. `public/help.html`: the full help. Add or edit the section; keep the
   contents list (`<nav>`) in step with the `id`s.
2. `src/components/HelpDrawer.tsx`: the quick help. Short entries only, each
   linking (`more:`) to a section id in `help.html`.
3. Illustrations in `public/help/img/`. If the change alters how the screen
   looks, start `pnpm dev` and run `pnpm help:shots`
   (`scripts/help-shots.mjs`); it recaptures every image and updates the image
   sizes in `help.html`. Open the changed images and check they still show
   what their captions say. New illustrations go in that script.
4. `README.md` for changes to local setup, and `docs/development.md` for changes to internals.

`test/help.test.ts` fails when a quick-help link, a contents entry or an image
points at something missing. It cannot tell whether the words are still true,
so reread the affected sections and correct them. Removing a feature removes
its help.

How to write it: for people reading papers, not developers. Plain words, short
sentences, what is on screen today (no plans, no internals). Use the labels
exactly as the app shows them. After a substantial rewrite, have a reviewer
with no other context read the help and the images for readability.

## Conventions

- The reader is read-only: it shows a map and never changes it. There is no
  editing, review or export; `effectiveGraph` (`src/lib/graph.ts`) only drops
  dangling links and flags unquoted ones as provisional.
- Author's words (PDF highlights) and AI reconstruction (card text) stay
  visibly distinct. Guesses (estimated locations, inferred relations) are always
  marked as such.
- Do not copy code from MIRA-extraction (license undecided); only read its
  output formats.

## Validation handoffs

- Include a working local network validation link in UI-change handoffs. Start
  the reader with `pnpm dev --host 0.0.0.0` when needed, verify the current LAN
  address responds, and share that address rather than only localhost.
