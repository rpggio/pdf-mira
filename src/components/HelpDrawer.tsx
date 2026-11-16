/**
 * Quick help: a short drawer over the graph. Each section links into the full
 * help (public/help.html, opened in a new window). Keep the two in step: every
 * `more` anchor below must exist in help.html (test/help.test.ts checks this).
 * Images come from public/help/img (regenerate with `pnpm help:shots`).
 */
import type { ReactNode } from "react";

const BASE = import.meta.env.BASE_URL;
export const HELP_URL = `${BASE}help.html`;
const img = (name: string) => `${BASE}help/img/${name}.png`;

export interface QuickHelpSection {
  title: string;
  /** anchor id in help.html */
  more: string;
  body: ReactNode;
}

export const QUICK_HELP: QuickHelpSection[] = [
  {
    title: "What this is",
    more: "about",
    body: (
      <p>
        The generated map offers one reading of this paper's argument through linked questions, claims, evidence and studies. Scroll the paper and the map shows the records from the
        part you are reading, and where they fit. Click a record to find its passage in the paper. In new maps, a <b>Source</b> card identifies another work. The separate local mock reader uses bundled PDFs and fixed fictional results for imports.
      </p>
    ),
  },
  {
    title: "On screen or Full",
    more: "scope",
    body: (
      <ul>
        <li>
          <b>On screen:</b> the records from the part of the paper you are reading. Faded above them: the claims and questions they lead to. The view keeps a linked record visible when a card would otherwise stand alone. Select a record to add everything it connects to.
        </li>
        <li>
          <b>Full:</b> every record in full color. Each paper opens in <b>Map</b> with <b>Full</b> selected. In <b>Map</b>, the view zooms to fit the cards for the visible part of the paper. Find this switch to the right of <b>Map</b>, <b>Outline</b> and <b>Sequence</b>.
        </li>
      </ul>
    ),
  },
  {
    title: "Map, Outline or Sequence",
    more: "views",
    body: (
      <ul>
        <li>
          <b>Map:</b> cards joined by arrows. <b>Outline:</b> an indented list under each question.
        </li>
        <li>
          <b>Sequence:</b> every record in full color and in paper order, indented by its level in the map. Loops on the left join nearby records; a chip on the right stands for a
          linked record far away in the paper (click it to go there).
        </li>
      </ul>
    ),
  },
  {
    title: "Reading a card",
    more: "cards",
    body: (
      <>
        <p>Card shading in <b>On screen</b></p>
        <div className="help-cards">
          <figure>
            <img src={img("card-onscreen")} width={145} alt="A card in full color" />
            <figcaption>On screen now</figcaption>
          </figure>
          <figure>
            <img src={img("card-faded")} width={145} alt="A faded card" />
            <figcaption>Elsewhere in the paper (point at it to darken its passage highlight)</figcaption>
          </figure>
        </div>
        <p>
          The key in the top corner, such as <b>CLM-03</b> or <b>EVD-02</b>, also appears in the paper's margin. A <b>dashed arrow</b> marked <i>(inferred)</i> is a link the
          map draws without a passage that states it.
        </p>
      </>
    ),
  },
  {
    title: "Map and paper together",
    more: "selecting",
    body: (
      <p>
        Passages stay highlighted in their record’s color. Click a card or a pill halfway across the paper’s right edge to select the record and darken its highlights. Hiding margin marks keeps the highlights visible. In <b>Full</b> <b>Map</b>, clicking the mark also centers the card at the current zoom. Point at either one to see a dashed line between them.
      </p>
    ),
  },
  {
    title: "Private access",
    more: "invite",
    body: <p>Open your invite link to enter. Use <b>Feedback</b> in the Library footer when available.</p>,
  },
  {
    title: "Keyboard",
    more: "shortcuts",
    body: (
      <p>
        <kbd>?</kbd> opens or closes this help · <kbd>Esc</kbd> closes it.
      </p>
    ),
  },
];

export function HelpDrawer({ onClose }: { onClose(): void }) {
  return (
    <aside className="help-drawer" aria-label="Quick help">
      <header>
        <h3>Quick help</h3>
        <a className="small" href={HELP_URL} target="pdf-mira-help">
          Full help ↗
        </a>
        <button className="ghost small" onClick={onClose} aria-label="Close help">
          ✕
        </button>
      </header>
      <div className="help-body">
        {QUICK_HELP.map((s) => (
          <section key={s.more}>
            <h4>{s.title}</h4>
            {s.body}
            <a className="more" href={`${HELP_URL}#${s.more}`} target="pdf-mira-help">
              More ↗
            </a>
          </section>
        ))}
      </div>
    </aside>
  );
}
