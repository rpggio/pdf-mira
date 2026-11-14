import type { ServerResponse } from "node:http";
import type { AccessStatus } from "../src/lib/access.ts";

export function sendAccessStatus(res: ServerResponse, status: AccessStatus) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "private, no-store");
  res.end(JSON.stringify(status));
}
