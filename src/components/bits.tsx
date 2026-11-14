import type { NodeType } from "../lib/types.ts";
import { TYPE_COLOR, TYPE_LABEL } from "../lib/palette.ts";

export function TypeChip({ type }: { type: NodeType }) {
  return (
    <span className="type-chip" style={{ ["--type" as string]: TYPE_COLOR[type] }}>
      {TYPE_LABEL[type]}
    </span>
  );
}
