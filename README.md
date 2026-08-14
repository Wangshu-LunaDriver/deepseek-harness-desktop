# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装进一个桌面窗口：**双击图标就能用，不用装 Node、不用开终端、不用管浏览器标签页**。

## 能干什么

- 双击打开就是一个完整的 DeepSeek Harness 界面，和命令行版本 100% 一样；
- 会话数据存在同一个地方（`~/.dsh`），命令行里建的会话在桌面端也能看到，反之亦然；
- 上游 harness 发新版时，桌面端会**自动更新**（需要联网）。

## 怎么用

**安装**：下载 `DeepSeek-Harness-Desktop-<版本>-setup.exe`，双击，选个安装目录（默认也行），装完自动启动，等几秒出界面。

**卸载**（两种任选）：
- 「设置 → 应用 → 已安装的应用」搜 `DeepSeek Harness Desktop` → 卸载；
- 或到安装目录双击 `Uninstall DeepSeek Harness Desktop.exe`。

## 常见问题

**启动有点慢？** 正常。启动要先拉起一个完整的 harness 服务（和命令行 `dsh web` 一样，约 5 秒），所以窗口会先显示"正在启动…"，几秒后进入界面。

**双击没反应 / 窗口不出现？** 多发生在远程桌面、无独立显卡、虚拟机环境。桌面版已内置兼容处理（关硬件加速 + 软件渲染）。还不行就看 `%TEMP%\dsh-desktop.log` 里的报错。

**会装一堆东西吗？** 装好后机器上只有两份 harness：你命令行用的那份 + 桌面版自带的一份（桌面版为了"免装 Node"必须自带）。其它都是缓存，可随时删。

## 自动更新

两层机制，全程无需你手动操作：

1. **应用自更新**：装好的应用启动时自动检查 GitHub，发现新版本就后台下载、弹窗提示「重启升级」。
2. **上游自动跟进**：GitHub Actions 每天检查 npm 上的 `@deepseek-ai/dsh`，上游一发新版就自动重新打包并发布，你的应用随后自动更新。

## 给开发者

```bash
npm install     # 装依赖
npm start       # 本地运行（不打包）
npm run dist    # 生成 NSIS 安装包
```

发版：打 tag 推送即可触发自动构建发布——

```bash
git tag v0.1.0-rc.6 && git push origin v0.1.0-rc.6
```

架构一句话：桌面层只有几百行「进程守护 + 窗口」代码，不碰 harness 任何逻辑——显示加载窗口 → 用 Electron 自带的 Node 拉起上游 `@deepseek-ai/dsh` → 就绪后加载进原生窗口 → 退出时回收子进程。
