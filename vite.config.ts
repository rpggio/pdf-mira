import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { papersPlugin } from "./server/plugin.ts";

export default defineConfig({
  plugins: [react(), papersPlugin()],
  preview: {
    allowedHosts: process.env.PDF_MIRA_ORIGIN ? [new URL(process.env.PDF_MIRA_ORIGIN).hostname] : [],
  },
  server: {
    host: "localhost",
    port: 5178,
    fs: {
      deny: [
        // Vite's deny defaults plus the local paper store and research artifacts.
        ".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**",
        "**/data/**", "**/output/**",
      ],
    },
  },
  test: { environment: "node" },
} as any);
