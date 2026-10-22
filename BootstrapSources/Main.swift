import Foundation
import Darwin

struct Arguments {
    let raw = Array(CommandLine.arguments.dropFirst())
    var action: String { raw.first ?? "help" }
    func value(_ name: String) -> String? { guard let i = raw.firstIndex(of: name), i + 1 < raw.count else { return nil }; return raw[i+1] }
    var directory: URL { value("--data-dir").map { URL(fileURLWithPath: $0) } ?? defaultDataDirectory() }
}
func status(_ directory: URL) throws -> JSON {
    guard try verifyDirectory(directory) else { return ["state": "not-started", "backend": "Rust", "running": false] }
    if let live = try? controlRequest(directory, "status") { return live }
    var saved = (try? readJSON(directory.appendingPathComponent("state.json"))) ?? [:]
    saved.removeValue(forKey: "token"); saved["running"] = false
    if !["stopped", "failed"].contains(saved["state"] as? String ?? "") { saved["state"] = "not-running" }
    return saved
}
func stop(_ directory: URL) throws -> JSON {
    guard try verifyDirectory(directory) else { return ["state": "stopped", "message": "原生后台尚未运行"] }
    if (try? controlRequest(directory, "stop")) == nil { return ["state": "stopped", "message": "原生后台已退出"] }
    let deadline = Date().addingTimeInterval(8)
    while Date() < deadline {
        if (try? controlRequest(directory, "status")) == nil { return ["state": "stopped", "message": "断点已清理；官方客户端继续运行"] }
        usleep(100000)
    }
    throw UnlockError("停止尚未确认，请查看状态")
}
func start(_ args: Arguments) throws -> JSON {
    let info = try metadata(args.value("--app")), app = info["app"] as! String
    guard applicationProcesses(app, desktopOnly: true).isEmpty else { throw UnlockError("请先用 ⌘Q 完全退出 ChatGPT.app，再通过本启动器打开。工具未关闭客户端") }
    let checked = try preflight(app)
    _ = try verifyDirectory(args.directory, create: true)
    let lock = try acquireLock(args.directory, "launch.lock"); defer { close(lock) }
    guard (try? controlRequest(args.directory, "status")) == nil else { throw UnlockError("原生后台已在运行，请先查看状态或停止解锁") }
    var manifest = checked; let port = try freePort(); manifest["port"] = port
    let manifestURL = args.directory.appendingPathComponent("manifest.json")
    try atomicJSON(manifest, manifestURL)
    let logURL = args.directory.appendingPathComponent("agent.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
    let log = try FileHandle(forWritingTo: logURL); defer { try? log.close() }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent().appendingPathComponent("CodexUnlockAgentRust")
    child.arguments = ["agent", "--manifest", manifestURL.path, "--data-dir", args.directory.path]
    child.standardInput = FileHandle.nullDevice; child.standardOutput = log; child.standardError = log
    try? FileManager.default.removeItem(at: args.directory.appendingPathComponent("state.json"))
    try child.run()
    do {
        _ = try run("/usr/bin/open", ["-a", app, "--args", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=\(port)", "--remote-allow-origins=http://127.0.0.1:\(port)"])
        let deadline = Date().addingTimeInterval(65)
        while Date() < deadline {
            if let state = try? readJSON(args.directory.appendingPathComponent("state.json")) {
                if state["state"] as? String == "ready" { return ["state": "ready", "backend": "Rust", "message": "额度断点已挂载。点好后启动界面会退出，轻量后台继续工作。请验证回车、按钮和 CPA 回答"] }
                if state["state"] as? String == "failed" { throw UnlockError(state["error"] as? String ?? "后台启动失败") }
            }
            if !child.isRunning { throw UnlockError("原生后台提前退出，请运行诊断") }
            usleep(100000)
        }
        throw UnlockError("启动超时，请运行诊断")
    } catch { _ = try? stop(args.directory); throw error }
}

@main struct NativeMain {
    static func main() {
        let args = Arguments()
        do {
            switch args.action {
            case "start": emit(try start(args))
            case "status": emit(try status(args.directory))
            case "stop": emit(try stop(args.directory))
            case "clean":
                if try verifyDirectory(args.directory) {
                    _ = try stop(args.directory)
                    let lock = try acquireLock(args.directory, "agent.lock"); defer { close(lock) }
                    let launch = try acquireLock(args.directory, "launch.lock"); defer { close(launch) }
                    try FileManager.default.removeItem(at: args.directory)
                }
                emit(["state": "clean", "dataDirectory": args.directory.path])
            case "diagnose":
                var result: JSON = ["version": "0.3.0", "backend": "Rust", "bootstrap": "Swift", "nodeRequired": false, "dataDirectory": args.directory.path, "providerCheck": false]
                do {
                    let checked = try preflight(args.value("--app")); result["application"] = checked
                    result["desktopPids"] = applicationProcesses(checked["app"] as! String, desktopOnly: true).map(Int.init)
                } catch { result["applicationError"] = error.localizedDescription }
                result["runtime"] = try status(args.directory); emit(result)
            case "locate":
                guard let file = args.value("--source") else { throw UnlockError("需要 --source") }
                let source = try String(contentsOfFile: file, encoding: .utf8)
                guard var location = Gate.locate(source) else { throw UnlockError("额度门禁未唯一定位") }
                location["condition"] = try Gate.condition(location); emit(location)
            case "inspect":
                guard let file = args.value("--archive") else { throw UnlockError("需要 --archive") }; emit(try inspectArchive(URL(fileURLWithPath: file)))
            default:
                print("用法：CodexUnlockAgent {start|status|stop|diagnose|clean} [--app path] [--data-dir path]\n默认仅写入：" + defaultDataDirectory().path)
            }
        } catch { fail(error.localizedDescription) }
    }
}
