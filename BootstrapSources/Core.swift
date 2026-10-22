import Foundation
import CryptoKit
import Darwin

struct UnlockError: LocalizedError {
    let text: String
    init(_ text: String) { self.text = text }
    var errorDescription: String? { text }
}
typealias JSON = [String: Any]
func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func object(_ data: Data) throws -> JSON {
    guard let result = try JSONSerialization.jsonObject(with: data) as? JSON else { throw UnlockError("JSON 格式无效") }
    return result
}
func readJSON(_ url: URL) throws -> JSON { try object(Data(contentsOf: url)) }
func atomicJSON(_ value: JSON, _ url: URL) throws {
    try encode(value).write(to: url, options: .atomic)
    chmod(url.path, 0o600)
}
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func emit(_ value: Any) { if let data = try? encode(value), let text = String(data: data, encoding: .utf8) { print(text) } }
func fail(_ text: String) -> Never { fputs(text + "\n", stderr); exit(1) }
func run(_ executable: String, _ args: [String]) throws -> String {
    let task = Process(); let pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: executable); task.arguments = args
    task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
    try task.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
    guard task.terminationStatus == 0 else { throw UnlockError("命令失败：\(URL(fileURLWithPath: executable).lastPathComponent)") }
    return String(data: data, encoding: .utf8) ?? ""
}
func defaultDataDirectory() -> URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Codex Input Unlock", isDirectory: true)
}
let ownerName = "io.github.trrywui.codex-input-unlock"
func verifyDirectory(_ directory: URL, create: Bool = false) throws -> Bool {
    let fm = FileManager.default
    if !fm.fileExists(atPath: directory.path) {
        guard create else { return false }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try atomicJSON(["tool": ownerName, "format": 1], directory.appendingPathComponent("owner.json"))
    }
    let attrs = try fm.attributesOfItem(atPath: directory.path)
    guard attrs[.type] as? FileAttributeType == .typeDirectory,
          try readJSON(directory.appendingPathComponent("owner.json"))["tool"] as? String == ownerName else {
        throw UnlockError("数据目录不属于本工具或是符号链接，拒绝访问")
    }
    return true
}
func processPath(_ pid: pid_t) -> String? {
    var bytes = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { return nil }
    return String(cString: bytes)
}
func applicationProcesses(_ app: String, desktopOnly: Bool = false) -> [pid_t] {
    let count = Int(proc_listallpids(nil, 0)) + 256
    guard count > 256 else { return [] }
    var pids = [pid_t](repeating: 0, count: count)
    let actual = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
    return pids.prefix(max(0, actual)).filter { pid in
        guard let name = processPath(pid), name.hasPrefix(app + "/Contents/") else { return false }
        return !desktopOnly || name.hasPrefix(app + "/Contents/MacOS/") || name.hasPrefix(app + "/Contents/Frameworks/") && name.contains(".app/Contents/MacOS/")
    }
}
func metadata(_ supplied: String?) throws -> JSON {
    let fm = FileManager.default
    guard let supplied = supplied ?? ["/Applications/ChatGPT.app", "/Applications/Codex.app"].first(where: { fm.fileExists(atPath: $0) }) else { throw UnlockError("未找到 ChatGPT.app") }
    let app = URL(fileURLWithPath: supplied).resolvingSymlinksInPath()
    let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? JSON,
          plist["CFBundleIdentifier"] as? String == "com.openai.codex",
          let executable = plist["CFBundleExecutable"] as? String, !executable.contains("/"), !executable.isEmpty else { throw UnlockError("目标应用身份不是 com.openai.codex") }
    return ["app": app.path, "executable": app.appendingPathComponent("Contents/MacOS/" + executable).path,
            "version": plist["CFBundleShortVersionString"] as? String ?? "?", "build": plist["CFBundleVersion"] as? String ?? "?"]
}

// Native port of quota-gate.cjs, 1zero224/codex-input-unlock, MIT.
// NSString/NSRegularExpression offsets use UTF-16, the same coordinates as JS/CDP.
enum Gate {
    // Token boundaries and possessive repetition avoid quadratic ICU retries
    // inside long strings/comments while matching complete JS identifiers.
    static let id = "(?<![A-Za-z0-9_$])[A-Za-z_$][A-Za-z0-9_$]*+"
    static func matches(_ pattern: String, _ text: NSString) -> [NSTextCheckingResult] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text as String, range: NSRange(location: 0, length: text.length))
    }
    static func part(_ match: NSTextCheckingResult, _ group: Int, _ text: NSString) -> String { text.substring(with: match.range(at: group)) }
    static func consumers(_ pattern: String, _ atom: String, _ source: NSString) -> [NSTextCheckingResult] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        var found: [Int: NSTextCheckingResult] = [:]
        for use in matches(NSRegularExpression.escapedPattern(for: atom), source) {
            let start = max(0, use.range.location - 1024)
            let end = min(source.length, NSMaxRange(use.range) + 1024)
            for match in regex.matches(in: source as String, range: NSRange(location: start, length: end - start)) where match.range.location <= use.range.location && NSMaxRange(match.range) >= NSMaxRange(use.range) {
                found[match.range.location] = match
            }
        }
        return found.values.sorted { $0.range.location < $1.range.location }
    }
    static func window(_ text: NSString, _ offset: Int, _ length: Int) -> NSString { text.substring(with: NSRange(location: offset, length: min(length, text.length - offset))) as NSString }
    static func location(_ source: NSString, _ offset: Int, _ quota: String, _ mode: String, _ end: Int? = nil, _ conversation: String? = nil) -> JSON {
        func coordinates(_ offset: Int) -> (Int, Int) {
            let prefix = source.substring(to: offset) as NSString
            let lines = (prefix as String).components(separatedBy: "\n")
            return (lines.count - 1, (lines.last! as NSString).length)
        }
        let (line, column) = coordinates(offset)
        var result: JSON = ["lineNumber": line, "columnNumber": column, "quotaVariable": quota, "mode": mode]
        if let end = end, end > offset { let (l, c) = coordinates(end); result["endLineNumber"] = l; result["endColumnNumber"] = c }
        if let conversation = conversation { result["conversationQuotaVariable"] = conversation }
        return result
    }
    static func locate(_ input: String) -> JSON? {
        let source = input as NSString, i = id
        let atomPattern = #"(\#(i))=\#(i)\(\#(i),\(\{get:\#(i)\}\)=>\{[^}]{0,1400}?\.authMethod!==`chatgpt`[^}]{0,1400}?\.rate_limit\?\.allowed!==!1"#
        // Anchor the expensive ICU expression to literal quota markers. Never scan
        // megabytes of unrelated minified assignments with an unanchored regex.
        var atoms: [Int: String] = [:]
        for marker in matches(NSRegularExpression.escapedPattern(for: ".rate_limit?.allowed!==!1"), source) {
            let begin = max(0, marker.range.location - 16384)
            let tail = source.substring(with: NSRange(location: begin, length: NSMaxRange(marker.range) - begin)) as NSString
            for atom in matches(atomPattern, tail) { atoms[begin + atom.range.location] = part(atom, 1, tail) }
        }
        guard atoms.count == 1, let name = atoms.values.first else { return nil }
        let atom = NSRegularExpression.escapedPattern(for: name)
        let local = consumers(#"(\#(i))=\#(i)\(\#(atom)\)&&(\#(i))===`local`"#, name, source)
        var direct: [JSON] = []
        for consumer in local {
            let quota = part(consumer, 1, source), escaped = NSRegularExpression.escapedPattern(for: quota)
            let tail = window(source, consumer.range.location, 12000)
            if let assignment = matches(#"let (\#(i))=([^,;]{1,900}\|\|\#(escaped)),(\#(i));"#, tail).first {
                let after = window(tail, assignment.range.location, 10000) as String
                guard after.contains("submitDisabled:" + part(assignment, 1, tail)) else { continue }
                let start = consumer.range.location + assignment.range.location
                let whole = tail.substring(with: assignment.range) as NSString
                let suffix = whole.range(of: "," + part(assignment, 3, tail) + ";", options: .backwards)
                direct.append(location(source, start, quota, "codex-local-quota", start + suffix.location))
            }
        }
        if direct.count == 1 { return direct[0] }
        if local.count == 1 {
            let consumer = local[0], quota = part(consumer, 1, source)
            let offset = NSMaxRange(consumer.range), tail = window(source, NSMaxRange(consumer.range), 18000)
            if let assignment = matches(#"(\#(i))=(\#(i)(?:\|\|\#(i))*\|\|\#(NSRegularExpression.escapedPattern(for: quota)))(?=[,;])"#, tail).first,
               (tail as String).contains("submitDisabled:" + part(assignment, 1, tail)) {
                return location(source, offset + assignment.range.location + (part(assignment, 1, tail) as NSString).length + 1, quota, "legacy-local-host")
            }
        }
        var modern: [JSON] = []
        for consumer in consumers(#"(\#(i))=\#(i)\(\#(atom)\)&&(\#(i))"#, name, source) {
            let tail = window(source, consumer.range.location, 60000), quota = part(consumer, 1, source)
            guard (tail as String).contains("submitDisabled:") else { continue }
            if let props = matches(#"rateLimitSendBlocked:(\#(i))\|\|\#(NSRegularExpression.escapedPattern(for: quota)),rateLimitConversationSendBlocked:\1(?:[,}])"#, tail).first {
                modern.append(location(source, consumer.range.location + props.range.location, quota, "third-party-composer-dual", nil, part(props, 1, tail)))
            }
        }
        if modern.count == 1 { return modern[0] }
        var submit: [JSON] = []
        for consumer in consumers(#"(\#(i))=\#(i)\((?:[^()]{0,200}?&&\s*)?\#(atom)\)"#, name, source) {
            let quota = part(consumer, 1, source), tail = window(source, consumer.range.location, 20000)
            for block in matches(#"(\#(i))=[^;]{0,8000}?\|\|\#(NSRegularExpression.escapedPattern(for: quota))(?=[,;)|\]])"#, tail) {
                let offset = consumer.range.location + block.range.location
                guard (window(source, offset, 12000) as String).contains("submitDisabled:" + part(block, 1, tail)) else { continue }
                let equals = source.range(of: "=", range: NSRange(location: offset, length: source.length - offset)).location
                guard equals != NSNotFound else { continue }
                var start = equals + 1
                while start < source.length, (CharacterSet.whitespacesAndNewlines as NSCharacterSet).characterIsMember(source.character(at: start)) { start += 1 }
                submit.append(location(source, start, quota, "local-submit-quota", start + 1))
            }
        }
        return submit.count == 1 ? submit[0] : nil
    }
    static func condition(_ location: JSON) throws -> String {
        guard let quota = location["quotaVariable"] as? String,
              matches("^" + id + "$", quota as NSString).count == 1,
              let mode = location["mode"] as? String else { throw UnlockError("额度变量无效") }
        if mode == "third-party-composer-dual" {
            guard let conversation = location["conversationQuotaVariable"] as? String, matches("^" + id + "$", conversation as NSString).count == 1 else { throw UnlockError("会话额度变量无效") }
            return "(\(conversation)=false,\(quota)=false,false)"
        }
        guard ["codex-local-quota", "legacy-local-host", "local-submit-quota"].contains(mode) else { throw UnlockError("未知额度分支") }
        return "(\(quota)=false,false)"
    }
}

func inspectArchive(_ file: URL) throws -> JSON {
    let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
    let size = try handle.seekToEnd()
    func read(_ offset: UInt64, _ length: Int) throws -> Data {
        guard length >= 0, offset <= size, UInt64(length) <= size - offset else { throw UnlockError("ASAR 数据范围无效") }
        try handle.seek(toOffset: offset)
        guard let data = try handle.read(upToCount: length), data.count == length else { throw UnlockError("ASAR 读取不完整") }
        return data
    }
    let prefix = try read(0, 16)
    func u32(_ offset: Int) -> UInt32 { prefix.subdata(in: offset..<offset+4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian } }
    let headerSize = Int(u32(4)), jsonSize = Int(u32(12))
    guard u32(0) == 4, jsonSize <= 32 * 1024 * 1024, headerSize >= jsonSize + 8 else { throw UnlockError("不支持的 ASAR 头部") }
    let header = try object(read(16, jsonSize)); let base = UInt64(8 + headerSize)
    var results: [JSON] = []
    func walk(_ node: JSON, _ parent: String) throws {
        for (name, value) in node["files"] as? JSON ?? [:] {
            guard let entry = value as? JSON else { continue }
            let full = parent + name
            if entry["files"] != nil { try walk(entry, full + "/"); continue }
            guard full.hasPrefix("webview/assets/"), full.hasSuffix(".js"), entry["unpacked"] as? Bool != true, entry["link"] == nil else { continue }
            guard let length = entry["size"] as? Int, length <= 64 * 1024 * 1024,
                  let offsetString = entry["offset"] as? String, let offset = UInt64(offsetString), offset <= size, base <= size - offset else { throw UnlockError("ASAR 脚本范围无效") }
            try autoreleasepool {
                let data = try read(base + offset, length)
                guard data.range(of: Data("submitDisabled:".utf8)) != nil, data.range(of: Data(".rate_limit?.allowed!==!1".utf8)) != nil,
                      let source = String(data: data, encoding: .utf8), let location = Gate.locate(source) else { return }
                results.append(["url": "app://-/assets/" + URL(fileURLWithPath: full).lastPathComponent, "archiveName": full, "bundleSha256": digest(data), "location": location, "condition": try Gate.condition(location)])
            }
        }
    }
    try walk(header, "")
    guard results.count == 1 else { throw UnlockError("前端额度门禁未唯一定位（匹配 \(results.count) 个文件），需要适配当前版本") }
    return results[0]
}
func preflight(_ supplied: String?) throws -> JSON {
    var info = try metadata(supplied)
    let result = try inspectArchive(URL(fileURLWithPath: info["app"] as! String).appendingPathComponent("Contents/Resources/app.asar"))
    info.merge(result) { _, new in new }; return info
}
