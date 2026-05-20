import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UpdateCheckResult } from "../../shared/types";
import { ExternalMarkdownLink } from "../markdownLinks";
import { AppDialog } from "./ui/Primitives";

export default function SoftwareUpdateDialog({
  open,
  updateCheck,
  onOpenChange,
  onOpenSettings
}: {
  open: boolean;
  updateCheck: UpdateCheckResult | null;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}) {
  const update = updateCheck?.update;
  const releaseNotes = update?.releaseNotes?.trim();
  return (
    <AppDialog
      open={open && Boolean(update)}
      title="发现新版本"
      description={update ? `当前版本 ${updateCheck?.currentVersion}，最新版本 ${update.targetVersion}。` : undefined}
      className="software-update-modal"
      onOpenChange={onOpenChange}
    >
      {releaseNotes ? (
        <div className="markdown-preview" onClick={handleUpdateMarkdownClick}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalMarkdownLink }}>
            {releaseNotes}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="settings-note">此版本没有填写更新说明。</p>
      )}
      <div className="button-row modal-actions">
        <button onClick={onOpenSettings}>前往更新设置</button>
        <button className="secondary-button" onClick={() => onOpenChange(false)}>稍后处理</button>
      </div>
    </AppDialog>
  );
}

function handleUpdateMarkdownClick(event: React.MouseEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.closest("a");
  const href = anchor?.getAttribute("href");
  if (!href || !/^https:\/\//.test(href)) return;
  event.preventDefault();
  void window.bgt.openExternal(href);
}
