import AppKit

@main struct Launcher {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let choice = NSAlert()
        choice.messageText = "Codex Input Unlock"
        choice.informativeText = "请先用 ⌘Q 完全退出官方客户端，再选择启动解锁。\n启动成功后界面退出，Rust 轻量后台继续工作；官方客户端完全退出后，后台自动结束。"
        if let icon = Bundle.main.url(forResource: "ChatGPT", withExtension: "icns") { choice.icon = NSImage(contentsOf: icon) }
        ["启动解锁", "查看状态", "停止解锁", "运行诊断", "取消"].forEach { choice.addButton(withTitle: $0) }
        app.activate(ignoringOtherApps: true)
        let index = choice.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        let actions = ["start", "status", "stop", "diagnose"]
        guard actions.indices.contains(index) else { return }
        let progress = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 350, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
        progress.title = "Codex Input Unlock"
        let label = NSTextField(labelWithString: "正在处理，请稍候…")
        label.frame = NSRect(x: 25, y: 40, width: 300, height: 22)
        let spinner = NSProgressIndicator(frame: NSRect(x: 25, y: 18, width: 300, height: 12))
        spinner.isIndeterminate = true; spinner.style = .bar; spinner.startAnimation(nil)
        progress.contentView?.addSubview(label); progress.contentView?.addSubview(spinner)
        progress.center(); progress.makeKeyAndOrderFront(nil)
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process(), pipe = Pipe()
            let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/CodexUnlockAgentRust")
            task.executableURL = helper; task.arguments = [actions[index]]
            task.standardOutput = pipe; task.standardError = pipe; task.standardInput = FileHandle.nullDevice
            var message = "", failed = false
            do {
                try task.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
                message = String(data: data, encoding: .utf8) ?? "无输出"; failed = task.terminationStatus != 0
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let text = json["message"] as? String { message = text }
                    else if actions[index] == "status" {
                        let running = json["running"] as? Bool == true
                        let ready = json["state"] as? String == "ready"
                        message = running ? (ready ? "原生解锁后台正在运行，断点已就绪。" : "原生后台正在等待兼容窗口。") : "原生解锁后台未运行。每次完全退出客户端后，请通过本启动器重新打开。"
                        if let error = json["error"] as? String { message += "\n" + error }
                    }
                }
            } catch { message = error.localizedDescription; failed = true }
            DispatchQueue.main.async {
                progress.close()
                let result = NSAlert(); result.messageText = failed ? "操作未完成" : "Codex Input Unlock"
                result.informativeText = message; result.alertStyle = failed ? .warning : .informational
                result.addButton(withTitle: "好"); result.runModal(); app.terminate(nil)
            }
        }
        app.run()
    }
}
