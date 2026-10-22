import Foundation
import Darwin

func unixAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw UnlockError("控制套接字路径太长，请使用较短的数据目录") }
    address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
    return address
}
func noPipeSignal(_ fd: Int32) {
    var one: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
}
func writeSocket(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            guard count > 0 else { throw UnlockError("控制连接写入失败") }; offset += count
        }
    }
}
func readSocket(_ fd: Int32) throws -> JSON {
    var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while result.count < 65536 {
        let count = Darwin.read(fd, &buffer, buffer.count)
        guard count > 0 else { throw UnlockError("控制连接无响应") }
        result.append(contentsOf: buffer.prefix(count))
        if let newline = result.firstIndex(of: 10) { return try object(result[..<newline]) }
    }
    throw UnlockError("控制消息过大")
}
func controlRequest(_ directory: URL, _ command: String) throws -> JSON {
    guard try verifyDirectory(directory), let token = try readJSON(directory.appendingPathComponent("state.json"))["token"] as? String else { throw UnlockError("原生后台尚未运行") }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { throw UnlockError("无法创建控制连接") }; defer { close(fd) }
    noPipeSignal(fd)
    var address = try unixAddress(directory.appendingPathComponent("control.sock").path)
    let result = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard result == 0 else { throw UnlockError("原生后台未运行或已经退出") }
    var data = try encode(["token": token, "command": command]); data.append(10)
    try writeSocket(fd, data); return try readSocket(fd)
}

func acquireLock(_ directory: URL, _ name: String) throws -> Int32 {
    let fd = open(directory.appendingPathComponent(name).path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw UnlockError("无法创建互斥锁") }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw UnlockError("已有原生后台或启动操作正在运行") }
    return fd
}
func freePort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { throw UnlockError("无法分配端口") }; defer { close(fd) }
    var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = 0
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard bound == 0 else { throw UnlockError("端口分配失败") }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let fetched = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    guard fetched == 0 else { throw UnlockError("端口读取失败") }; return Int(UInt16(bigEndian: address.sin_port))
}
