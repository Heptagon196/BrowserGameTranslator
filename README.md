# BrowserGameTranslator

BrowserGameTranslator 是一个面向离线网页游戏的桌面 AI 翻译工具。它用于处理已经下载到本地的 HTML、JavaScript、JSON 等网页游戏文件，提供文本提取、AI 分析、AI 翻译、校对、写回、预览和打包流程。

当前项目仍处于原型/MVP 开发阶段，功能以本地 Electron 应用为主。

## 主要功能

- 项目管理：打开或创建网页游戏翻译项目，项目数据保存在游戏目录下的 `.bgt`。
- 提取/回填：扫描游戏文件，提取可翻译文本项，支持 JSONL/CSV 导入导出并回填到游戏。
- 分析：提取人物、术语、禁翻项，并允许人工编辑。
- 翻译：调用 AI 执行批量翻译，支持翻译表格编辑。
- 校对：检查未翻译、术语、禁翻项、数字序号残留、换行符、占位符、HTML 标签等问题。
- AI 面板：提供类似网页 AI 的聊天式介入界面，支持流式输出、Markdown 渲染和受控命令。
- 模型设置：翻译供应商/模型和 AI 介入供应商/模型独立配置，右侧 AI 窗口切换供应商或模型不会影响批量翻译。
- 提示词配置：支持全局提示词和当前工作区提示词。
- 工具页：包含 itch.io HTML5 游戏下载和 AAOnline 游戏下载工具，下载过程显示命令行日志。
- 预览：在项目根目录启动本地网页服务器，用外部浏览器打开项目首页。
- 首页入口：项目页提供“下载游戏”按钮，可直接跳转到工具页。
- 打包：将当前翻译成果打包为 `zip`、`7z` 或 `tar.xz`，可选加入轻量 Windows 启动器。

## 项目结构

```text
src/
  main/          Electron 主进程、文件系统、AI、打包、预览等服务
  preload/       Renderer 与主进程之间的安全 API
  renderer/      React 界面
  shared/        前后端共享类型
resources/
  icon/          应用与启动器图标
  launcher/      内置 Windows 启动器
tools/
  launcher/      C/Win32 启动器源码
docs/
  browser-game-ai-translator-design.md
```

## 工作区规则

创建项目后，游戏目录本身就是工作区和预览目录：

```text
游戏目录/
  index.html
  ...
  .bgt/
    project.json
    original/
    extracted/
    resources/
    translations/
    qa/
    logs/
    prompts.json
```

`.bgt/original` 保存创建项目时的原始副本。应用翻译时，程序会先从 `.bgt/original` 重建项目根目录中除 `.bgt` 外的文件，再把当前翻译表应用回工作区，避免在已经翻译过的文件上继续替换原文。

`.bgt/project.json` 只保存 `projectRoot`。写入文件时它是相对项目根目录的 `"."`，程序打开项目后会解析为本机绝对路径使用；`.bgt` 和 `.bgt/original` 等路径都由程序从项目根目录派生，因此项目目录可以移动，也更适合多人协作。

Provider 配置、模型、Base URL 和 API Key 是应用级配置，不写入项目工作区。

## 开发环境

需要：

- Node.js
- npm
- Windows 环境
- GCC/MinGW-w64 和 `windres`，用于重新编译内置启动器

安装依赖：

```powershell
npm install
```

开发运行：

```powershell
npm run dev
```

生产构建：

```powershell
npm run build
```

类型检查：

```powershell
npm run typecheck
```

代码检查：

```powershell
npm run lint
npm run check:unused
```

## 图标与启动器

应用图标源文件为：

```text
resources/icon/icon.png
```

重新生成 Windows 图标：

```powershell
npm run build:icon
```

重新编译内置启动器：

```powershell
npm run build:launcher
```

启动器源码在：

```text
tools/launcher/main.c
```

启动器是 C/Win32 实现，只依赖 Windows 系统 DLL。它会读取包根目录下固定命名的 `BGT-Launcher.json`，启动 `127.0.0.1` 本地服务器，并用系统默认浏览器打开游戏首页。

## 打包成果

在应用左下角点击“预览游戏”可以启动本地网页服务器。启动后左下角会显示“运行中”，并提供“再次打开网页”和“停止网页服务”操作。

在应用左下角点击“打包”可以将项目根目录中除 `.bgt` 外的当前成果打包。默认输出到游戏根目录，也可以在弹窗中选择其它目录。

勾选“添加启动器”后，压缩包根目录会包含：

- 启动器 exe，默认按项目名命名
- `BGT-Launcher.json`
- `README-启动说明.txt`

用户解压后双击启动器 exe 即可启动本地服务器并打开游戏。

## 设计文档

完整设计见：

```text
docs/browser-game-ai-translator-design.md
```

## 注意事项

- 本工具面向已经合法下载到本地的网页游戏，不负责绕过 DRM、登录、付费或服务端资源限制。
- AI 请求会把待处理文本发送到用户配置的服务商，请在使用前确认文本和 Key 管理策略。
- 当前没有安装包构建配置；`npm run build` 只生成 Electron 主进程和前端构建产物。

## 参考与许可

- 翻译提示词、术语/禁翻表组织方式、部分校对规则参考 AiNiee：`https://github.com/NEKOparapa/AiNiee`。
- AiNiee 使用 GNU AGPLv3 许可证。若继续分发包含这些提示词和规则衍生实现的版本，需要一并处理 AGPLv3 的合规要求。
