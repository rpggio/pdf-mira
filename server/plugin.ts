import { join } from "node:path";
import { inviteAccess } from "./access.ts";
import type { Plugin } from "vite";
import { PaperStore } from "./papers.ts";
import { sendAccessStatus } from "./access-status.ts";
import { paperApi } from "./api.ts";

export function papersPlugin(): Plugin {
  const contactEmail = process.env.PDF_MIRA_CONTACT_EMAIL?.trim() || null;
  const store = new PaperStore();
  let init: Promise<void> | undefined;
  const initialize = () => init ??= (async () => { await store.seedSamples(); await store.recover(); })();
  const monitor = () => {
    const timer = setInterval(() => { void initialize().then(() => store.recover()).catch((e) => console.error("Paper recovery failed", e.code ?? e.name)); }, 30000);
    timer.unref();
    return timer;
  };
  const capabilities: ReturnType<typeof paperApi> = async (req, res, next) => {
    if (req.url !== "/api/access" || req.method !== "GET") return next();
    sendAccessStatus(res, { gated: false, authenticated: true, contactEmail });
  };
  return { name: "papers-api",
    configureServer(server) { const timer = monitor(); server.httpServer?.once("close", () => clearInterval(timer)); server.middlewares.use(capabilities); server.middlewares.use(paperApi(store, initialize())); },
    configurePreviewServer(server) {
      if (process.env.PDF_MIRA_ORIGIN) {
        const credentials = process.env.CREDENTIALS_DIRECTORY;
        const file = process.env.PDF_MIRA_INVITES_FILE ?? (credentials && join(credentials, "invites.json"));
        const signingKeyFile = process.env.PDF_MIRA_SIGNING_KEY_FILE ?? (credentials && join(credentials, "session-key"));
        if (!file || !signingKeyFile) throw new Error("PDF/MIRA invite file and session signing key are required");
        server.middlewares.use(inviteAccess(file, signingKeyFile, process.env.PDF_MIRA_ORIGIN, join(server.config.root, server.config.build.outDir), contactEmail));
      }
      const timer = monitor(); server.httpServer.once("close", () => clearInterval(timer)); server.middlewares.use(capabilities); server.middlewares.use(paperApi(store, initialize())); },
  };
}
