# Codex Input Unlock for macOS

正式版 **0.3.3（build 7）**，Rust 常驻后台，Swift 原生启动界面。Bundle ID 为 `io.github.trrywui.codex-input-unlock`。当前 Release 提供 Intel Mac（x86_64）构建，最低系统声明为 macOS 12，实际测试系统为 macOS 14.8.9。

本工具针对 Bundle ID 为 `com.openai.codex` 的桌面客户端；应用可能名为 ChatGPT.app 或 Codex.app。它保留官方账号登录，通过 CDP 条件断点清除阻止发送的本地额度项。条件表达式返回 false，不暂停页面。不会增加推理上游额度，CPA 或中转服务仍执行自己的鉴权和限制。

## 下载与安装

从 [Releases](https://github.com/trrywui/codex-input-unlock/releases) 下载 `Codex-Input-Unlock-0.3.3-macos-x86_64.zip`，解压后将 `Codex Input Unlock.app` 拖入 Applications。附件 `SHA256SUMS.txt` 提供校验和。项目代码采用 MIT 许可，依赖和图标的说明见 `NOTICE.md`。

从 0.3.0–0.3.2 升级：先用旧版“停止解锁”，再完整替换 Applications 中的应用包，随后通过新版重新启动。运行数据目录及归属标记不变，无需清理数据。请勿合并新旧应用包的内部文件；完整替换后包内不再包含旧名 `CodexUnlockAgentRust`。

本版使用新的 Bundle ID；从旧 Swift 0.2.0 或原型迁移时，请先用旧启动器停止解锁、清理其运行数据并删除旧应用，再安装本版。它不会接管旧版运行目录；如果归属校验失败，应先完成旧版清理。

日常使用：

1. 用 `⌘Q` 完全退出官方客户端。
2. 打开 Codex Input Unlock，选择“启动解锁”。
3. 提示就绪后点“好”，启动界面退出，Rust 后台继续工作。
4. 官方客户端完全退出后，后台自动结束。下次需要解锁时仍从本启动器打开；直接打开官方应用不会自动启用解锁。

再次打开启动器可选择“查看状态”“停止解锁”或“运行诊断”。停止解锁会清理断点并保留官方客户端运行。

## 资源占用与运行文件

常驻进程名为 `CodexUnlockAgent`。Swift 扫描与启动辅助名为 `CodexUnlockBootstrap`，它和 AppKit 界面只短暂运行。Rust 使用系统 kqueue 等待 CDP、控制连接和目标进程退出事件，没有常态轮询或状态文件心跳，不依赖 Node.js、Swift、Foundation 或异步运行时。

原型隔离基准中，空闲 RSS 约 7.85 MiB；Swift 基线约 18.41 MiB。该数字是单次合成负载下的 RSS，不等同于活动监视器口径，也不保证真实客户端中的固定值。正式版未重新测量性能，详见 `TEST-REPORT.md`。

实际启动时，运行数据集中到：

```text
~/Library/Application Support/Codex Input Unlock/
```

包含归属标记、互斥锁、清单、状态、控制 socket 和日志。正式版归属标记为 `io.github.trrywui.codex-input-unlock`。不添加登录项、LaunchAgent 或系统服务。

命令行（使用应用实际路径）：

```sh
'./Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgent' status
'./Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgent' stop
'./Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgent' diagnose
```

`clean` 会停止本工具后台并删除经归属校验的运行目录；请仅在确实需要清理运行数据时执行。

## 构建与测试

需要 macOS、Xcode（含 Swift）和 Rust/Cargo。测试额外需要支持原生 WebSocket 的 Node.js 22 或更新版本。运行应用不需要安装这些开发工具。

在源码目录运行，示例将所有依赖、编译缓存和测试文件放入该目录的 `work/`：

```sh
./build.sh "$PWD/work/build"
./verify.sh "$PWD/work/t"
```

提交源码后可运行 `./package.sh` 生成应用压缩包、与 Git HEAD 一致的源码包及校验和。

构建脚本依据当前主机架构构建 Rust 和 Swift，并生成本机 ad-hoc 签名。每次重建暂存应用包，并在签名校验通过后完整替换工作区交付包，避免旧可执行文件残留。当前 Release 是 x86_64；Apple Silicon 可在相应主机重建，但本次未验证 arm64。构建不会调用安装或启动命令。`resources/Info.plist` 保存应用身份，`Cargo.lock` 固定依赖。

测试使用真实独立 V8 和模拟 Browser CDP，不访问账号凭证、不发出真实模型请求。macOS Unix socket 路径长度有限，请保持测试目录路径较短。可选的只读客户端静态扫描：

```sh
CODEX_UNLOCK_APP_ARCHIVE='/Applications/ChatGPT.app/Contents/Resources/app.asar' ./verify.sh "$PWD/work/t"
```

不设置该变量时跳过这一项，其余测试完全独立。性能采样：

```sh
node tests/benchmark.mjs "$PWD/work/b" "$PWD/work/benchmark.json"
```

可用 `CODEX_UNLOCK_SWIFT_BASELINE` 指定旧 Swift 后台路径以做对照。测试进程及临时文件自动收尾；构建缓存保留在指定目录供复用，可在完成后删除该构建目录。

## 兼容性与公开发布

本版沿用“不检查当前 provider”的约定。仅连接本机回环调试端口，并检查端口所属应用。启动前扫描 ASAR，运行时核对 JS 哈希；定位失败、不唯一或哈希变化会停止，需要适配新版客户端。不会修改官方应用包、账号凭证或 provider 配置。

0.3.3 修复“后台显示就绪，但本地编辑器在零额度时发送按钮仍为灰色”：沿 JS 的 export/import 别名定位实际本地编辑器中的额度变量，优先于另一套编辑器的匹配，并在挂载和停止时各刷新一次编辑器的缓存状态；不改变状态内容或输入文字。本地调用链或缓存刷新结构不完整、不唯一时停止。已在客户端 `26.1023.51421 / build 22530` 的实际窗口中确认，非空输入的发送按钮由禁用变为可用。没有点击发送或发出模型请求；真实发送及 CPA 回答仍待手动验收。原有同文件额度分支保留兼容回归。

Release 应用使用 ad-hoc 签名，未做 Developer ID 签名或 Apple 公证。macOS 可能要求在“系统设置 → 隐私与安全性”中允许打开。项目不提供自动更新。源码目录已附 `.gitignore`，应用和压缩包作为 Release 附件发布。

定位逻辑参考 [1zero224/codex-input-unlock](https://github.com/1zero224/codex-input-unlock)，审阅版本 `1863c8f3ff35974b6b5690c974e82aa82a2a8a7a`，来源见 `NOTICE.md`。保留 MIT `LICENSE` 与依赖许可。ChatGPT/OpenAI 名称及图标归相应权利人，不在项目 MIT 许可范围内。本项目与 OpenAI 无隶属、赞助或认可关系。
