import Darwin
import Foundation

private func withCStringArray<R>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
    let pointers = strings.map { strdup($0) }
    defer { pointers.forEach { free($0) } }
    return body(pointers + [nil])
}

private func writeAll(_ fd: Int32, _ bytes: [UInt8]) {
    bytes.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if count > 0 { offset += count } else if errno != EINTR { break }
        }
    }
}

let mode = CommandLine.arguments.dropFirst().first ?? "report"
let openFDs = (0..<64).filter { fcntl(Int32($0), F_GETFD) >= 0 }.map(String.init).joined(separator: ",")
let report = "pid=\(getpid()) pgid=\(getpgrp()) cwd=\(FileManager.default.currentDirectoryPath) args=\(CommandLine.arguments.dropFirst().joined(separator: "|")) env=\(ProcessInfo.processInfo.environment.keys.sorted().joined(separator: ",")) fds=\(openFDs)\n"
writeAll(STDOUT_FILENO, Array(report.utf8))
if mode == "flood" {
    let block = [UInt8](repeating: 0x41, count: 65_536) + [0xff, 0x00]
    for _ in 0..<64 { writeAll(STDOUT_FILENO, block); writeAll(STDERR_FILENO, block) }
} else if mode == "descendant" || mode == "stubborn-descendant" {
    let executable = CommandLine.arguments[0]
    var childPID: pid_t = 0
    let childMode = mode == "stubborn-descendant" ? "stubborn-child" : "child"
    let ready = FileManager.default.currentDirectoryPath + "/fixture-ready-\(UUID().uuidString)"
    let rc = withCStringArray([executable, childMode, ready]) { argv in
        posix_spawn(&childPID, executable, nil, nil, argv, environ)
    }
    if rc != 0 { _exit(70) }
    if mode == "stubborn-descendant" {
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        while !FileManager.default.fileExists(atPath: ready), DispatchTime.now().uptimeNanoseconds < deadline {
            usleep(1_000)
        }
        try? FileManager.default.removeItem(atPath: ready)
        if DispatchTime.now().uptimeNanoseconds >= deadline { _exit(71) }
        _exit(17)
    }
    while true { pause() }
} else if mode == "stubborn" || mode == "stubborn-child" {
    signal(SIGTERM, SIG_IGN)
    if mode == "stubborn-child", CommandLine.arguments.count == 3 {
        _ = FileManager.default.createFile(atPath: CommandLine.arguments[2], contents: Data(), attributes: nil)
    }
    while true { pause() }
} else if mode == "crash" {
    raise(SIGABRT)
} else if mode == "fast-exit" {
    _exit(0)
}