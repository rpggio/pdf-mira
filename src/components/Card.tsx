import { memo } from "react";
import type { EffNode } from "../lib/graph.ts";
import { TYPE_COLOR, TYPE_LABEL } from "../lib/palette.ts";

export interface CardProps {
  node: EffNode;
  on: "precise" | "estimated" | undefined;
  /** not on screen and not in hand: drawn faded */
  dim: boolean;
  selected: boolean;
  related: boolean;
  hovered: boolean;
  style?: React.CSSProperties;
}

/** A record card, shared by the map and the sequence. `data-rec` lets the margin connectors find it. */
export const CardBody = memo(function CardBody({ node, on, dim, selected, related, hovered, style }: CardProps) {
  return (
    <div
      data-rec={node.id}
      className={["card", selected && "selected", related && "related", hovered && "hovered", dim && "dim", !dim && on === "estimated" && "onscreen-est"].filter(Boolean).join(" ")}
      style={{ ["--type" as string]: TYPE_COLOR[node.type], ...style }}
      title={on === "precise" ? "Its passage is on screen" : on === "estimated" ? "Its estimated location is on screen (no verbatim passage)" : undefined}
    >
      <div className="card-head">
        <span className="type-chip">{TYPE_LABEL[node.type]}</span>
        <span className="spacer" />
        <span className="rec-id" title="Record key">
          {node.displayKey}
        </span>
      </div>
      <div className="card-text">{node.text || <em>(no text)</em>}</div>
    </div>
  );
});
