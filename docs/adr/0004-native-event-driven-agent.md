# 用 Swift 原生事件驱动后台降低资源占用

用户在查看 Node 后台的内存后，明确选择保留解锁功能并改用 Swift 原生实现。新版本将短暂的 AppKit 界面与 Foundation 后台分别编译，以 CDP 目标、刷新事件和 macOS 进程退出通知替代周期轮询；状态通过本地控制套接字按需查询，文件仅在状态改变时写入。

代价是需要移植与验证四种 JS 门禁结构，而不是直接依赖 JS 引擎。通过旧定位器对照、UTF-16 坐标、真实 V8 和模拟 Browser CDP 测试约束行为；不引入 JavaScriptCore 或 Node 运行时。保留独立冷启动入口、不检查 provider，以及定位不唯一或源码哈希变化时停止解锁的边界。运行数据集中到一个 Application Support 子目录，使 `.app` 可以单独移入 Applications。
