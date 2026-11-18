export interface TextItemGeom {
  /** index among the page's text items (== pdf.js TextLayer textDivs index) */
  index: number;
  str: string;
  /** PDF user-space box: x, y = bottom-left baseline origin */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageText {
  page: number; // 1-based
  width: number;
  height: number;
  items: TextItemGeom[];
}
