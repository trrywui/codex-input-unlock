# 来源与素材

本项目的额度门禁定位和 CDP 条件断点方案参考：

- 上游：https://github.com/1zero224/codex-input-unlock
- 审阅提交：`1863c8f3ff35974b6b5690c974e82aa82a2a8a7a`
- 上游作者：1zero224；MIT 许可，完整文本见 `LICENSE`。

macOS 实现包含 Rust 后台、Swift 启动辅助和 AppKit 界面。Rust 依赖与标准库的许可见 `THIRD-PARTY-LICENSES.txt`。`tests/reference/` 保留上游 JS 参考实现，用于行为对照，不作为应用运行时依赖。

`resources/ChatGPT.icns` 来自 ChatGPT.app，按项目发起人的要求保留。ChatGPT、OpenAI 名称及图标的权利属于相应权利人，不在本项目 MIT 许可范围内；本项目是独立社区工具，与 OpenAI 无隶属、赞助或认可关系。
