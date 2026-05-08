import { useEffect, useState } from "react";
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { Download } from "lucide-react";
import type { AaOfflineDownloadEvent, AaOfflineDownloadResult, ItchDownloadEvent, ItchDownloadResult } from "../../shared/types";
import { FieldRow, PathInput } from "../components/ui/Form";
import { AppDialog, CheckboxControl, StyledSelect } from "../components/ui/Primitives";

export default function ToolsView({ run }: { run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined> }) {
  const [itchModalOpen, setItchModalOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [result, setResult] = useState<ItchDownloadResult | null>(null);
  const [itchLogs, setItchLogs] = useState<ItchDownloadEvent[]>([]);
  const [aaModalOpen, setAaModalOpen] = useState(false);
  const [aaCaseUrlOrId, setAaCaseUrlOrId] = useState("");
  const [aaOutputPath, setAaOutputPath] = useState("");
  const [aaOutputErrors, setAaOutputErrors] = useState<string[]>(["请选择输出目录。"]);
  const [aaPlayerVersion, setAaPlayerVersion] = useState("master");
  const [aaConcurrentDownloads, setAaConcurrentDownloads] = useState(5);
  const [aaContinueOnAssetError, setAaContinueOnAssetError] = useState(false);
  const [aaWithUserscripts, setAaWithUserscripts] = useState<"none" | "all" | "backlog" | "better-layout" | "keyboard-controls" | "alt-nametag">("all");
  const [aaLogs, setAaLogs] = useState<AaOfflineDownloadEvent[]>([]);
  const [aaResult, setAaResult] = useState<AaOfflineDownloadResult | null>(null);

  useEffect(() => {
    return window.bgt.onItchDownloadLog((event) => setItchLogs((logs) => [...logs, event]));
  }, []);

  useEffect(() => {
    return window.bgt.onAaOfflineDownloadLog((event) => setAaLogs((logs) => [...logs, event]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.bgt.validateAaOfflineOutputDirectory(aaOutputPath).then((errors) => {
      if (!cancelled) setAaOutputErrors(errors);
    });
    return () => {
      cancelled = true;
    };
  }, [aaOutputPath]);

  const chooseOutput = async () => {
    const selected = await window.bgt.selectDirectory();
    if (selected) setOutputDirectory(selected);
  };

  const chooseAaOutput = async () => {
    const selected = await window.bgt.selectDirectory();
    if (selected) setAaOutputPath(selected);
  };

  const startDownload = () => {
    setResult(null);
    setItchLogs([]);
    void run("下载 itch.io 网页游戏", () => window.bgt.downloadItchHtml5Game({ url, outputDirectory }), setResult);
  };

  const startAaDownload = () => {
    setAaResult(null);
    setAaLogs([]);
    void run(
      "下载 AAOnline 游戏",
      () =>
        window.bgt.downloadAaOnlineGame({
          caseUrlOrId: aaCaseUrlOrId,
          outputPath: aaOutputPath,
          playerVersion: aaPlayerVersion,
          concurrentDownloads: aaConcurrentDownloads,
          continueOnAssetError: aaContinueOnAssetError,
          withUserscripts: aaWithUserscripts
        }),
      setAaResult
    );
  };

  return (
    <div className="stack">
      <button className="panel tool-entry" onClick={() => setItchModalOpen(true)}>
        <Download size={22} />
        <div>
          <h2>itch.io 网页游戏下载</h2>
          <p>下载 itch.io HTML5 网页游戏资源，用于离线保存和后续创建翻译项目。</p>
        </div>
      </button>
      <AppDialog
        open={itchModalOpen}
        title="itch.io 网页游戏下载"
        description="填写游戏页面地址和保存目录后，程序会调用 itchio-downloader CLI 保存 HTML5 网页游戏资源和元数据。"
        onOpenChange={setItchModalOpen}
      >
        <div className="settings-form">
          <FieldRow label="游戏页面 URL" description="填写 itch.io 游戏页面地址，例如 https://作者.itch.io/游戏名。">
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.itch.io/game" />
          </FieldRow>
          <FieldRow label="保存目录" description="选择下载文件保存的位置。下载器会在此目录下保存 HTML5 资源和元数据。">
            <PathInput value={outputDirectory} onPick={chooseOutput} onChange={setOutputDirectory} />
          </FieldRow>
          <div className="button-row">
            <button disabled={!url.trim() || !outputDirectory.trim()} onClick={startDownload}>
              <Download size={16} />
              下载网页游戏
            </button>
          </div>
        </div>
        {(itchLogs.length > 0 || result) && (
          <div className="tool-result">
            <h2>下载状态</h2>
            {result && (
              <div className={result.status ? "success-box" : "error-list"}>
                <strong>{result.status ? "下载完成" : "下载失败"}</strong>
                <p>{result.message}</p>
                {result.filePath && <p>文件：{result.filePath}</p>}
                {result.metadataPath && <p>元数据：{result.metadataPath}</p>}
                {result.html5Assets?.length ? <p>资源文件：{result.html5Assets.length} 个</p> : null}
              </div>
            )}
            {itchLogs.length > 0 && (
              <pre className="tool-log">
                {itchLogs
                  .map((entry) => `[${entry.stream}] ${entry.text.trimEnd()}`)
                  .filter(Boolean)
                  .join("\n")}
              </pre>
            )}
          </div>
        )}
        <div className="button-row modal-actions">
          <button className="secondary-button" onClick={() => setItchModalOpen(false)}>
            关闭
          </button>
        </div>
      </AppDialog>
      <button className="panel tool-entry" onClick={() => setAaModalOpen(true)}>
        <Download size={22} />
        <div>
          <h2>AAOnline 游戏下载</h2>
          <p>调用内置 aaoffline CLI 下载 Ace Attorney Online 案件，生成可离线运行的本地版本。</p>
        </div>
      </button>
      <AppDialog
        open={aaModalOpen}
        title="AAOnline 游戏下载"
        description="输入 AAOnline 的 player.php 案件地址或 trial ID。程序会调用内置 aaoffline CLI 下载案件和所需资源。"
        onOpenChange={setAaModalOpen}
      >
        <div className="settings-form">
          <FieldRow label="案件 URL 或 ID" description="可以填写完整地址，例如 https://aaonline.fr/player.php?trial_id=12345，也可以只填数字 ID。">
            <input value={aaCaseUrlOrId} onChange={(event) => setAaCaseUrlOrId(event.target.value)} placeholder="https://aaonline.fr/player.php?trial_id=12345" />
          </FieldRow>
          <FieldRow label="输出目录" description="必须选择一个已经存在且为空的文件夹，避免下载结果和旧文件混在一起。">
            <PathInput value={aaOutputPath} onPick={chooseAaOutput} onChange={setAaOutputPath} />
          </FieldRow>
          {aaOutputErrors.length > 0 && (
            <div className="error-list">
              {aaOutputErrors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          )}
          <RadixCollapsible.Root className="collapsible-panel">
            <RadixCollapsible.Trigger className="collapsible-trigger">高级选项</RadixCollapsible.Trigger>
            <RadixCollapsible.Content>
              <div className="settings-form nested-settings">
                <FieldRow label="播放器版本" description="aaoffline 使用的 AAOnline 播放器分支或提交名。默认 master。">
                  <input value={aaPlayerVersion} onChange={(event) => setAaPlayerVersion(event.target.value)} />
                </FieldRow>
                <FieldRow label="并发下载数" description="同时下载资源的数量。网络不稳定时可以调低。">
                  <input
                    min={1}
                    max={32}
                    type="number"
                    value={aaConcurrentDownloads}
                    onChange={(event) => setAaConcurrentDownloads(Number(event.target.value))}
                  />
                </FieldRow>
                <FieldRow label="用户脚本" description="可让 aaoffline 对下载后的案件应用额外脚本。默认应用全部脚本。">
                  <StyledSelect
                    value={aaWithUserscripts}
                    options={[
                      { value: "all", label: "全部" },
                      { value: "none", label: "不应用" },
                      { value: "backlog", label: "回看记录" },
                      { value: "better-layout", label: "改进布局" },
                      { value: "keyboard-controls", label: "键盘控制" },
                      { value: "alt-nametag", label: "像素姓名牌字体" }
                    ]}
                    onChange={(value) => setAaWithUserscripts(value as typeof aaWithUserscripts)}
                  />
                </FieldRow>
                <label className="checkbox-row">
                  <CheckboxControl checked={aaContinueOnAssetError} onChange={setAaContinueOnAssetError} />
                  资源下载失败时继续
                </label>
              </div>
            </RadixCollapsible.Content>
          </RadixCollapsible.Root>
          <div className="button-row">
            <button disabled={!aaCaseUrlOrId.trim() || aaOutputErrors.length > 0} onClick={startAaDownload}>
              <Download size={16} />
              下载 AAOnline 游戏
            </button>
          </div>
        </div>
        {(aaLogs.length > 0 || aaResult) && (
          <div className="tool-result">
            <h2>下载状态</h2>
            {aaResult && (
              <div className={aaResult.status ? "success-box" : "error-list"}>
                <strong>{aaResult.status ? "下载完成" : "下载失败"}</strong>
                <p>{aaResult.message}</p>
                <p>输出：{aaResult.outputPath}</p>
              </div>
            )}
            {aaLogs.length > 0 && (
              <pre className="tool-log">
                {aaLogs
                  .map((entry) => `[${entry.stream}] ${entry.text.trimEnd()}`)
                  .filter(Boolean)
                  .join("\n")}
              </pre>
            )}
          </div>
        )}
        <div className="button-row modal-actions">
          <button className="secondary-button" onClick={() => setAaModalOpen(false)}>
            关闭
          </button>
        </div>
      </AppDialog>
    </div>
  );
}
