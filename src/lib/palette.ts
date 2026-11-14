import type { NodeType } from "./types.ts";

export const TYPE_COLOR: Record<NodeType, string> = {
  Question: "#2f6fb0",
  Claim: "#b7791f",
  Evidence: "#2f855a",
  Study: "#9f4f86",
  Protocol: "#5f7f22",
  SourceDocument: "#8a5a3c",
  Request: "#6b4fbf",
};

export const TYPE_LABEL: Record<NodeType, string> = {
  Question: "Question",
  Claim: "Claim",
  Evidence: "Evidence",
  Study: "Study",
  Protocol: "Protocol",
  SourceDocument: "Source",
  Request: "Request",
};

export const REL_COLOR: Record<string, string> = {
  addresses: "#2f6fb0",
  supports: "#2f855a",
  opposes: "#c2412d",
  describesActivity: "#9f4f86",
  grounds: "#2c7a7b",
  follows: "#5f7f22",
  request_for: "#6b4fbf",
  request_target: "#6b4fbf",
};
