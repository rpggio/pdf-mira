import { BROWSER_GUIDANCE, supportsPdfViewer } from "../modules/pdf-viewer/browserSupport.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Invite } from "./components/Invite.tsx";
import type { AccessStatus } from "./lib/access.ts";

const root = createRoot(document.getElementById("root")!);
const readInviteKey = () => new URLSearchParams(location.hash.slice(1)).get("access");
const inviteKey = readInviteKey();
if (inviteKey !== null) history.replaceState(null, "", location.pathname + location.search);

async function start() {
  const response = await fetch("/api/access");
  if (!response.ok) throw new Error("Access unavailable");
  const { gated, authenticated, contactEmail }: AccessStatus = await response.json();
  if (gated) {
    window.addEventListener("hashchange", () => {
      if (readInviteKey() !== null) location.reload();
    });
  }
  if (gated && inviteKey !== null) {
    root.render(<Invite contactEmail={contactEmail} status="Checking your invite…" />);
    try {
      const result = await fetch("/api/access/redeem", {
        method: "POST",
        headers: { "X-PDF-MIRA-Invite": inviteKey },
      });
      if (result.ok) {
        location.replace("/");
        return;
      }
      root.render(<Invite contactEmail={contactEmail} status="This invite link is invalid or expired. Ask for a new link." />);
    } catch {
      root.render(<Invite contactEmail={contactEmail} status="Could not check your invite. Open the original link to try again." />);
    }
    return;
  }

  if (gated && (!authenticated || location.pathname === "/invite")) {
    root.render(<Invite contactEmail={contactEmail} />);
    return;
  }

  if (!supportsPdfViewer()) {
    root.render(
      <main className="center-msg">
        <h1>This browser can’t open the PDF reader</h1>
        <p>{BROWSER_GUIDANCE}</p>
        <a href={`${import.meta.env.BASE_URL}help.html#browser-support`}>Browser support</a>
      </main>,
    );
    return;
  }

  const { App } = await import("./App.tsx");
  root.render(<StrictMode><App gated={gated} contactEmail={contactEmail} /></StrictMode>);
}

void start().catch(() => root.render(<p>Could not open PDF/MIRA. Reload the page or open your invite link again.</p>));
