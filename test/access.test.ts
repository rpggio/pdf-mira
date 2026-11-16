import { afterEach, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inviteAccess } from "../server/access.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = "https://reader.example";
async function setup(expiresAt?: string) {
  const root = await mkdtemp(join(tmpdir(), "mira-access-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "help/img"), { recursive: true });
  await writeFile(join(root, "index.html"), await readFile(new URL("../index.html", import.meta.url)));
  for (const name of ["app-icon.png", "help/img/screen.png", "social-preview.png"])
    await writeFile(join(root, name), await readFile(new URL(`../public/${name}`, import.meta.url)));
  const key = randomBytes(32).toString("hex");
  const invites = join(root, "invites.json"), signing = join(root, "signing");
  await writeFile(invites, JSON.stringify([{ name: "test", sha256: createHash("sha256").update(key).digest("hex"), expiresAt }]));
  await writeFile(signing, randomBytes(32).toString("hex"));
  const gate = inviteAccess(invites, signing, origin, root, null);
  const server = createServer((req, res) => gate(req, res, () => { res.end("protected content"); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const address = server.address() as { port: number };
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
  const redeem = (requestOrigin = origin) => request("/api/access/redeem", { method: "POST", headers: { origin: requestOrigin, "x-pdf-mira-invite": key } });
  return { request, redeem, root, invites, signing };
}

it("serves social metadata and its image without opening private help or papers", async () => {
  const { request } = await setup();
  for (const path of ["/", "/index.html", "/invite?access=not-for-metadata"]) {
    const response = await request(path, { headers: { host: "untrusted.example" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`property="og:image" content="${origin}/social-preview.png"`);
    expect(html).toContain(`name="twitter:image" content="${origin}/social-preview.png"`);
    expect(html).toContain(`rel="canonical" href="${origin}/"`);
    expect(html).not.toContain("not-for-metadata");
    expect(html).not.toContain("untrusted.example");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
  const image = await request("/social-preview.png");
  const png = Buffer.from(await image.arrayBuffer());
  expect(image.headers.get("content-type")).toBe("image/png");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  const head = await request("/social-preview.png", { method: "HEAD" });
  expect(head.status).toBe(200); expect(await head.text()).toBe("");
  expect(Number(head.headers.get("content-length"))).toBe(png.length);
  for (const path of ["/api/papers", "/help.html", "/help/img/screen.png", "/data/papers/record.json"])
    expect((await request(path)).status).toBe(401);
  expect((await request("/social-preview.png", { method: "POST" })).status).toBe(401);
});

it("requires a valid invite and same-origin writes, and rejects a tampered session", async () => {
  const { request, redeem } = await setup();
  expect((await redeem("https://other.example")).status).toBe(403);
  const response = await redeem();
  expect(response.status).toBe(204);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toContain("Secure; HttpOnly; SameSite=Lax");
  const cookie = setCookie.split(";", 1)[0];
  expect((await request("/api/papers", { headers: { cookie } })).status).toBe(200);
  expect((await request("/api/papers", { method: "POST", headers: { cookie, origin: "https://other.example" } })).status).toBe(403);
  expect((await request("/api/papers", { method: "POST", headers: { cookie, origin } })).status).toBe(200);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0");
  expect((await request("/api/papers", { headers: { cookie: tampered } })).status).toBe(401);
});

it("rejects expired invites and fails closed on invalid credentials", async () => {
  const { redeem, root, invites, signing } = await setup("2000-01-01T00:00:00Z");
  expect((await redeem()).status).toBe(403);
  await writeFile(signing, "invalid");
  expect(() => inviteAccess(invites, signing, origin, root, null)).toThrow("Invalid PDF/MIRA session signing key");
  expect(() => inviteAccess(invites, signing, "http://reader.example", root, null)).toThrow("HTTPS origin");
});
