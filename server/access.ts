import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendAccessStatus } from "./access-status.ts";

interface Invite {
  name: string;
  sha256: string;
  expiresAt?: string;
}

const sessionSeconds = 90 * 24 * 60 * 60;
const cookieName = "__Host-pdf-mira";
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);

export function inviteAccess(file: string, signingKeyFile: string, origin: string, dist: string, contactEmail: string | null) {
  if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin) {
    throw new Error("PDF_MIRA_ORIGIN must be an HTTPS origin");
  }
  const entries: Invite[] = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(entries) || entries.length !== 1 || entries.some((entry) =>
    !entry || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 100 ||
    typeof entry.sha256 !== "string" || !validKey(entry.sha256) ||
    (entry.expiresAt !== undefined && (typeof entry.expiresAt !== "string" || !Number.isFinite(Date.parse(entry.expiresAt))))
  )) {
    throw new Error("Configure exactly one PDF/MIRA access key");
  }

  const signingKey = readFileSync(signingKeyFile, "utf8").trim();
  if (!validKey(signingKey)) throw new Error("Invalid PDF/MIRA session signing key");
  const publicImages = new Map([
    ["/preview/logo.png", readFileSync(join(dist, "app-icon.png"))],
    ["/preview/reader.png", readFileSync(join(dist, "help/img/screen.png"))],
  ]);
  const [accessKey] = entries;
  const sign = (payload: string) => createHmac("sha256", Buffer.from(signingKey, "hex")).update(payload).digest();

  function session(req: IncomingMessage) {
    const token = req.headers.cookie?.split(/;\s*/).find((part) => part.startsWith(cookieName + "="));
    const parts = token?.slice(cookieName.length + 1).match(/^([a-f0-9]{64})\.(\d{13})\.([a-f0-9]{64})$/);
    if (!parts) return;
    const [, id, expires, signature] = parts;
    if (Number(expires) <= Date.now() || !timingSafeEqual(sign(`${id}.${expires}`), Buffer.from(signature, "hex"))) return;
    return id === accessKey.sha256 ? accessKey : undefined;
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? "/").split("?", 1)[0];
    const method = req.method;
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");

    const publicImage = publicImages.get(path);
    if (publicImage && (method === "GET" || method === "HEAD")) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", publicImage.length);
      return res.end(method === "HEAD" ? undefined : publicImage);
    }

    if (path === "/api/access/redeem" && method === "POST") {
      const header = req.headers["x-pdf-mira-invite"];
      const key = typeof header === "string" && validKey(header) ? header : undefined;
      const id = key && hash(key);
      const expired = accessKey.expiresAt && Date.parse(accessKey.expiresAt) <= Date.now();
      const invite = id === accessKey.sha256 && !expired ? accessKey : undefined;
      if (req.headers.origin !== origin || !invite) return reply(res, 403, "This invite link is invalid or expired.");
      const payload = `${id}.${Date.now() + sessionSeconds * 1000}`;
      res.setHeader("Set-Cookie", `${cookieName}=${payload}.${sign(payload).toString("hex")}; Max-Age=${sessionSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      log(res, invite, "api", method, "redeem");
      res.statusCode = 204;
      return res.end();
    }

    const invite = session(req);
    if (path === "/api/access" && method === "GET") {
      if (invite) log(res, invite, "api", method, "access");
      return sendAccessStatus(res, { gated: true, authenticated: Boolean(invite), contactEmail });
    }

    const read = method === "GET" || method === "HEAD";
    if (read && (path === "/invite" || (!invite && (path === "/" || path === "/index.html")))) {
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    }
    if (read && path === "/invite") {
      req.url = "/index.html";
      return next();
    }
    if (!invite) {
      // Only the app shell, Vite build assets and public preview are served before sign-in.
      if (read && (path === "/" || path === "/index.html" || path === "/favicon.ico" ||
        /^\/assets\/[\w.-]+$/.test(path))) return next();
      return reply(res, 401, "Open your PDF/MIRA invite link to continue.");
    }

    if (path.startsWith("/api/")) {
      log(res, invite, "api", method, apiRoute(path));
    } else if (method === "GET" && (path === "/" || path === "/index.html" || req.headers["sec-fetch-dest"] === "document")) {
      log(res, invite, "visit", method, "page");
    }

    if (method !== "GET" && method !== "HEAD") {
      if (req.headers.origin !== origin) return reply(res, 403, "Send this request from the reader’s own page.");
    }
    next();
  };
}

function apiRoute(path: string) {
  if (path === "/api/access") return "access";
  if (path === "/api/papers") return "library";
  if (/^\/api\/papers\/[^/]+\/retry$/.test(path)) return "retry";
  if (/^\/api\/papers\/[^/]+\/artifacts\//.test(path)) return "artifact";
  if (/^\/api\/papers\/[^/]+$/.test(path)) return "paper";
  return "other";
}

function log(res: ServerResponse, invite: Invite, event: string, method: string | undefined, route: string) {
  res.once("finish", () => console.info(JSON.stringify({
    timestamp: new Date().toISOString(), event, invite: invite.name, method, route, status: res.statusCode,
  })));
}

function reply(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { message } }));
}
