import type { OriginalSourceFile } from "../../../shared/types";

export type SourceHighlight = {
  key: string;
  start: number;
  end: number;
  original?: string;
  translation?: string;
};

export type SourceViewerState = {
  file: OriginalSourceFile;
  highlights: SourceHighlight[];
  startOffset: number;
};
