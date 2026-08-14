# DeepSeek Harness Desktop（原型）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的官方 Web 界面装进一个原生桌面窗口：双击即用，不装 Node、不开终端、不碰浏览器标签页。

> 这是 **Windows 原型**，用于验证「Electron 壳 + 进程守护」这条路线。三平台打包、代码签名、应用图标等排在之后。

## 它做了什么

桌面层**不复刻**任何 Harness 逻辑，只有几百行进程守护 + 窗口代码：

1. spawn 上游 npm 包 `@deepseek-ai/dsh` 的 `lib/bin.js web`；
2. 等它在回环地址上就绪；
3. 把该 URL 加载进原生 `BrowserWindow`；
4. 退出时回收子进程。

核心 UI、插件、预设、会话全部来自上游，上游更新什么，桌面端就是什么。

## 为什么不需要用户装 Node

Electron 自带 Node 运行时。启动时用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以纯 Node 身份运行 `dsh` 的 CLI，因此最终用户机器上**无需安装 Node.js**。

## 数据互通

数据目录沿用上游默认 `~/.dsh`（Windows 下 `C:\Users\<你>\.dsh`，可用 `$DSH_HOME` 覆盖）。命令行里创建的会话在桌面端直接可见，反之亦然。

## 自动更新（两层）

**第 1 层 · 应用自更新**（`electron-updater`，已内置）：装好的应用启动后自动检查 GitHub Releases，发现新版本就在后台静默下载，下载完弹窗提示「重启升级」。`main.js` 里 `allowPrerelease = true`，因此上游 `0.1.0-rc.N` 的预发布版本也会被拾取。

**第 2 层 · 上游自动跟进**（GitHub Actions）：`.github/workflows/track-upstream.yml` 每天定时检查 npm 上的 `@deepseek-ai/dsh`——

1. 上游发新版 → 自动抬版本 + 更新依赖；
2. 重建 NSIS 安装包 → 发布 GitHub Release；
3. 已安装的应用随后通过第 1 层自动更新到新版。

发布托管在 GitHub Releases，仓库地址在 `package.json` 的 `build.publish` 里配置（owner/repo）。

## 开发运行

```bash
npm install          # 安装 electron + @deepseek-ai/dsh
npm start            # 启动桌面窗口
```

环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_USE_SYSTEM_NODE=1` | 改用系统 `node` 启动 dsh（本机已装 Node 时便于调试） |
| `DSH_HOME` | 覆盖数据目录（上游语义，默认 `~/.dsh`） |

日志：

- 桌面层：`%APPDATA%/deepseek-harness-desktop/desktop.log`
- dsh 子进程：`%APPDATA%/deepseek-harness-desktop/dsh.log`

## 已确认的上游事实

- `dsh web` 默认监听 `127.0.0.1:3080`，支持 `--port 0`（系统挑空闲端口）与显式 `--port <n>`。
- 就绪后 stdout 打印 `dsh web: http://127.0.0.1:<port>`（本原型改用 HTTP 轮询就绪，不依赖解析 stdout）。
- 数据根目录由 `@deepseek-ai/dsh-home-paths` 解析：`$DSH_HOME` → `~/.dsh`。
- 上游 `dsh-host-webserver` 源码已预留 Electron 形态注释，桌面化是被设想过但尚未实现的方向。

## 打包产物与运行方式

- **`release/win-unpacked/`**：解包形态（推荐）。直接双击 `DeepSeek Harness Desktop.exe` 即可，无需安装、无需 NSIS 自解压。
- **`release/DeepSeek-Harness-Desktop-0.1.0-portable.exe`**：单文件便携版（NSIS 自解压）。⚠️ 在**远程桌面 / 无 GPU / 部分虚拟机**环境下，NSIS 自解压可能卡住、应用无法启动；此类环境请用 `win-unpacked` 目录里的 exe。

> 生成 zip 分发前请先**关闭运行中的应用**，否则 `locales/*.pak` 等文件被占用会导致压缩失败。

## 远程桌面 / 无 GPU 环境

Electron 在远程桌面（UU远程 / RDP / ToDesk 等）、无独显或虚拟机里，常见「进程在跑但窗口不出现」。`main.js` 已内置应对：

- `app.disableHardwareAcceleration()` + `--disable-gpu` + `--disable-gpu-compositing`
- 默认加 `--no-sandbox`（可用环境变量 `DSH_DESKTOP_NO_SANDBOX=0` 关闭）

并且窗口改为**先显示加载页、再起 DSH、就绪后切换到 Harness 界面**，任何一步失败都会在窗口内显示错误原因，而不是静默无反应。

## 已知限制

- 安装包未签名（SmartScreen 会提示）。
- 单窗口：一个实例一个窗口，二次启动聚焦已有窗口。
- Windows 下回收子进程是强杀（无 POSIX 信号优雅退出；会话已按 JSONL 增量落盘，无数据丢失）。
- 与全局 CLI 共享 `~/.dsh` 时，两者都会尝试维护 `~/.dsh/profiles/node_modules` 下的模块 junction；同时跑两个实例需注意。
