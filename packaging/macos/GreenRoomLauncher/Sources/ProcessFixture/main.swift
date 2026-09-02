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

nonisolated(unsafe) private var termEvidenceFD: Int32 = -1
nonisolated(unsafe) private var termEvidenceBytes: UnsafeMutablePointer<CChar>?
nonisolated(unsafe) private var termEvidenceCount = 0

private func testEvidenceFD() -> Int32? {
    guard let value = ProcessInfo.processInfo.environment["GREENROOM_TEST_EVIDENCE_FD"],
          let fd = Int32(value), fcntl(fd, F_GETFD) >= 0 else { return nil }
    return fd
}

private func emitTestEvidence(_ values: [String: Any]) {
    guard let fd = testEvidenceFD(),
          let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return }
    writeAll(fd, Array(data) + [0x0a])
}

private func installCooperativeTERMHandler(role: String? = nil) {
    if let fd = testEvidenceFD(), let role {
        let line = "{\"event\":\"term-clean\",\"role\":\"\(role)\"}\n"
        termEvidenceFD = fd
        termEvidenceBytes = strdup(line)
        termEvidenceCount = line.utf8.count
    }
    signal(SIGTERM) { _ in
        if termEvidenceFD >= 0, let bytes = termEvidenceBytes {
            _ = Darwin.write(termEvidenceFD, bytes, termEvidenceCount)
        }
        _exit(0)
    }
}

private func appendEvidence(_ path: String, _ values: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { _exit(72) }
    let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR)
    if fd < 0 { _exit(73) }
    writeAll(fd, Array(data) + [0x0a])
    close(fd)
}

private func spawnChild(_ arguments: [String]) -> pid_t {
    var childPID: pid_t = 0
    let rc = withCStringArray([CommandLine.arguments[0]] + arguments) { argv in
        posix_spawn(&childPID, CommandLine.arguments[0], nil, nil, argv, environ)
    }
    if rc != 0 { _exit(70) }
    return childPID
}

private func completeReadinessHandshake(scenario: String) {
    var challenge = [UInt8]()
    var byte: UInt8 = 0
    while challenge.count <= 40 {
        let count = Darwin.read(3, &byte, 1)
        if count == 1 { challenge.append(byte); continue }
        if count == 0 { break }
        if errno != EINTR { _exit(75) }
    }
    guard challenge.count == 40,
          Array(challenge.prefix(8)) == [0x47, 0x52, 0x52, 0x44, 1, 1, 0, 32]
    else { _exit(76) }
    if scenario == "child-exit-before-ready" || scenario == "occupied-port" { _exit(77) }
    let pid = UInt32(bitPattern: getpid())
    var ready = [UInt8]([0x47, 0x52, 0x52, 0x44, 1, 2, 0, 36])
    ready.append(contentsOf: challenge[8..<40])
    ready.append(contentsOf: [
        UInt8((pid >> 24) & 0xff), UInt8((pid >> 16) & 0xff),
        UInt8((pid >> 8) & 0xff), UInt8(pid & 0xff),
    ])
    switch scenario {
    case "wrong-token": ready[8] ^= 0xff
    case "wrong-pid": ready[43] ^= 0x01
    case "bad-header": ready[0] = 0
    case "bad-version": ready[4] = 2
    case "bad-type": ready[5] = 1
    case "bad-length": ready[7] = 35
    default: break
    }
    let response: [UInt8]
    switch scenario {
    case "truncated": response = Array(ready.dropLast())
    case "oversized": response = ready + [0, 1]
    case "trailing": response = ready + [0]
    case "duplicate": response = ready + ready
    default: response = ready
    }
    for responseByte in response { writeAll(3, [responseByte]) }
    _ = shutdown(3, SHUT_WR)
    close(3)
    _ = challenge.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
    var wiped = response
    _ = wiped.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
    _ = ready.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
}

private func runPackagedFixture(serverPath: String) {
    guard let data = FileManager.default.contents(atPath: serverPath),
          let configuration = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let scenario = configuration["scenario"] as? String,
          let evidencePath = configuration["evidencePath"] as? String,
          let highFD = configuration["highFd"] as? Int
    else { _exit(74) }
    if scenario == "readiness-timeout" { _ = fcntl(3, F_SETFD, FD_CLOEXEC) }
    if scenario == "ignore-term" {
        signal(SIGTERM, SIG_IGN)
    } else {
        installCooperativeTERMHandler(role: "leader")
    }
    let evidenceFD = testEvidenceFD()
    let openFDs = (0..<256).filter { fcntl(Int32($0), F_GETFD) >= 0 }
    let productionFDs = openFDs.filter { Int32($0) != evidenceFD }
    appendEvidence(evidencePath, [
        "role": "leader", "pid": Int(getpid()), "pgid": Int(getpgrp()),
        "scenario": scenario, "fds": productionFDs, "highFdOpen": openFDs.contains(highFD),
        "testEvidenceFdOpen": evidenceFD != nil,
        "pathPresent": ProcessInfo.processInfo.environment["PATH"] != nil,
        "executable": CommandLine.arguments[0],
    ])
    emitTestEvidence(["event": "fixture-ready", "role": "leader", "pid": Int(getpid())])
    writeAll(STDOUT_FILENO, Array("GREENROOM_TEST_FIXTURE_READY\n".utf8))
    if scenario == "startup-crossing" {
        usleep(500_000)
    }
    let childPID = spawnChild(["cooperative-child", evidencePath, scenario, String(highFD)])
    appendEvidence(evidencePath, [
        "role": "spawned-descendant", "pid": Int(childPID), "pgid": Int(getpgrp()), "scenario": scenario,
    ])
    if scenario == "normal-exit", let quitPath = configuration["quitPath"] as? String {
        while !FileManager.default.fileExists(atPath: quitPath) { usleep(2_000) }
        _exit(0)
    }
    while true { pause() }
}

let mode = CommandLine.arguments.dropFirst().first ?? "report"
if mode == "cooperative-child", CommandLine.arguments.count == 5 {
    if CommandLine.arguments[3] == "ignore-term" {
        signal(SIGTERM, SIG_IGN)
    } else {
        installCooperativeTERMHandler(role: "descendant")
    }
    let highFD = Int(CommandLine.arguments[4]) ?? -1
    let evidenceFD = testEvidenceFD()
    let openFDs = (0..<256).filter { fcntl(Int32($0), F_GETFD) >= 0 }
    let productionFDs = openFDs.filter { Int32($0) != evidenceFD }
    appendEvidence(CommandLine.arguments[2], [
        "role": "descendant", "pid": Int(getpid()), "pgid": Int(getpgrp()),
        "scenario": CommandLine.arguments[3], "fds": productionFDs,
        "highFdOpen": openFDs.contains(highFD), "testEvidenceFdOpen": evidenceFD != nil,
        "pathPresent": ProcessInfo.processInfo.environment["PATH"] != nil,
        "executable": CommandLine.arguments[0],
    ])
    emitTestEvidence(["event": "fixture-ready", "role": "descendant", "pid": Int(getpid())])
    while true { pause() }
}
if ProcessInfo.processInfo.environment["GREENROOM_RUNTIME_MODE"] == "packaged-macos",
   mode.hasPrefix("/"), mode.hasSuffix("/server.js") {
    let configurationData = FileManager.default.contents(atPath: mode)
    let configuration = configurationData.flatMap {
        try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
    if configuration?["scenario"] as? String != "readiness-timeout",
       let scenario = configuration?["scenario"] as? String {
        completeReadinessHandshake(scenario: scenario)
    }
    runPackagedFixture(serverPath: mode)
}
let openFDs = (0..<64).filter { fcntl(Int32($0), F_GETFD) >= 0 }.map(String.init).joined(separator: ",")
let report = "pid=\(getpid()) pgid=\(getpgrp()) cwd=\(FileManager.default.currentDirectoryPath) args=\(CommandLine.arguments.dropFirst().joined(separator: "|")) env=\(ProcessInfo.processInfo.environment.keys.sorted().joined(separator: ",")) fds=\(openFDs)\n"
writeAll(STDOUT_FILENO, Array(report.utf8))
if mode == "cooperative-descendant" {
    installCooperativeTERMHandler()
    writeAll(STDOUT_FILENO, Array("ready leader \(getpid())\n".utf8))
    let childPID = spawnChild(["cooperative-live-child"])
    writeAll(STDOUT_FILENO, Array("ready descendant \(childPID)\n".utf8))
    while true { pause() }
} else if mode == "cooperative-live-child" {
    installCooperativeTERMHandler()
    while true { pause() }
} else if mode == "flood" {
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