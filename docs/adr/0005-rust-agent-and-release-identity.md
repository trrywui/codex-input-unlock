# Rust 常驻后台与正式版应用身份

用户选择将已通过隔离测试的 Rust 后台升为正式版，以降低常驻内存和活动 CPU，保留短暂运行的 Swift 扫描辅助与 AppKit 界面；此决定替代 ADR-0004 中由 Swift 常驻的部分。应用名保持 Codex Input Unlock，Bundle ID 按用户 GitHub 命名规则确定为 `io.github.trrywui.codex-input-unlock`，运行目录归属标记同步采用此身份。

用户选择另行删除旧版及关联数据后全新安装，因此本次只生成工作区交付包，不替换 Applications 中的旧版、不迁移数据、不注册或启动正式版；仍属于旧版的数据目录将被拒绝访问，避免误接管。真实官方客户端的冷启动和 CPA 回答留待用户安装后验收。
