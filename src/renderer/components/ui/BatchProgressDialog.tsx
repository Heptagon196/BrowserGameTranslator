import React from "react";
import { AppDialog, ProgressBar } from "./Primitives";

export type BatchProgressState = {
  title: string;
  currentLabel: string;
  processed: number;
  total: number;
  batchIndex: number;
  batchTotal: number;
};

export function BatchProgressDialog({ progress }: { progress: BatchProgressState }) {
  const percent = progress.total ? Math.min(100, (progress.processed / progress.total) * 100) : 0;
  const description = `${progress.currentLabel} · ${progress.processed}/${progress.total}`;

  return (
    <AppDialog open title={progress.title} description={description} className="progress-modal" disableOutsideClose>
      <div className="progress-row">
        <span>批次 {progress.batchIndex}/{progress.batchTotal}</span>
        <ProgressBar value={percent} className="progress-track active" />
        <strong>{Math.round(percent)}%</strong>
      </div>
      <div className="progress-summary">
        <span>处理中</span>
      </div>
    </AppDialog>
  );
}
