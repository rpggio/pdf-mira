/**
 * The quick help (HelpDrawer) links into the full help (public/help.html).
 * Keep them in step: every quick-help anchor must exist in the full help.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);
const drawer = readFileSync(new URL("src/components/HelpDrawer.tsx", root), "utf8");
const full = readFileSync(new URL("public/help.html", root), "utf8");

describe("help", () => {
  it("every quick-help section links to an existing full-help anchor", () => {
    const anchors = [...drawer.matchAll(/more:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(5);
    const ids = new Set([...full.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const a of anchors) expect(ids, `help.html is missing #${a}`).toContain(a);
  });
  it("every illustration the help uses exists", () => {
    const names = [...full.matchAll(/help\/img\/([\w-]+)\.png/g), ...drawer.matchAll(/img\("([\w-]+)"\)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) expect(existsSync(new URL(`public/help/img/${n}.png`, root)), `${n}.png`).toBe(true);
  });
  it("the full help's contents list only points at sections that exist", () => {
    const ids = new Set([...full.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, a] of full.matchAll(/href="#([^"]+)"/g)) expect(ids, `#${a}`).toContain(a);
  });
});
