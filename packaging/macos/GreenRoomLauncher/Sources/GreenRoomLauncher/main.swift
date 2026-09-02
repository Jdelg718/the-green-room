import CryptoKit
import Darwin
import Foundation

struct ReleaseManifest: Equatable {
    struct FileRecord: Equatable {
        let path: String
        let sha256: String
    }

    let files: [FileRecord]
}

enum LauncherError: Error, Equatable, CustomStringConvertible {
    case invalidBundleLayout
    case manifestMissing
    case manifestInvalid(String)
    case payloadInvalid(String)
    case unsafeInvocation(String)
    case unsupportedArchitecture

    var description: String {
        switch self {
        case .invalidBundleLayout: return "invalid_bundle_layout"
        case .manifestMissing: return "release_manifest_missing"
        case .manifestInvalid(let code): return "release_manifest_invalid:\(code)"
        case .payloadInvalid(let code): return "payload_invalid:\(code)"
        case .unsafeInvocation(let code): return "unsafe_invocation:\(code)"
        case .unsupportedArchitecture: return "unsupported_architecture"
        }
    }
}

enum LauncherInvocation {
    // The launcher takes no user-controlled options. Task 10 will construct the
    // child environment from validated bundle paths rather than inherit these.
    static let forbiddenEnvironmentKeys: Set<String> = [
        "GREENROOM_PACKAGE_PAYLOAD_ROOT",
        "GREENROOM_PUBLIC_DIR",
        "GREENROOM_MIGRATIONS_DIR",
        "GREENROOM_HISTORICAL_CATALOG_DIR",
        "GREENROOM_ORIGINAL_CATALOG_DIR",
        "GREENROOM_PERSONA_PREFLIGHT_FIXTURE",
        "GREENROOM_PERSONA_VALIDATOR_EXECUTABLE",
        "GREENROOM_PERSONA_INSPECTION",
        "GREENROOM_HOST",
        "GREENROOM_PORT",
        "GREENROOM_ALLOWED_ORIGIN",
        "GREENROOM_DATA_DIR",
        "GREENROOM_RUNTIME_MODE",
        "GREENROOM_READINESS_TOKEN",
        "GREENROOM_READINESS_FD",
        "GREENROOM_READINESS_TIMEOUT_MS",
        "NODE_OPTIONS",
        "NODE_PATH",
        "DYLD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_FRAMEWORK_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
    ]

    static func validate(arguments: [String], environment: [String: String]) throws {
        guard arguments.count == 1, arguments[0].hasPrefix("/"),
              URL(fileURLWithPath: arguments[0]).standardizedFileURL.path == arguments[0]
        else {
            throw LauncherError.unsafeInvocation("arguments_not_allowed")
        }
        if let key = forbiddenEnvironmentKeys.sorted().first(where: { environment[$0] != nil }) {
            throw LauncherError.unsafeInvocation("environment_override:\(key)")
        }
        if let key = environment.keys.sorted().first(where: { $0.hasPrefix("GREENROOM_") }) {
            throw LauncherError.unsafeInvocation("environment_override:\(key)")
        }
    }
}

struct LauncherPreflight {
    static let manifestRelativePath = "Contents/Resources/release-manifest.json"
    private static let maximumManifestBytes = 1_048_576
    private static let manifestKeys: Set<String> = [
        "schemaVersion", "bundleIdentifier", "appVersion", "sourceCommit", "buildEpoch",
        "targetTriple", "runtimes", "databaseSchema", "files",
    ]
    private static let runtimeKeys: Set<String> = ["nodeVersion", "pythonVersion", "validatorVersion"]
    private static let databaseKeys: Set<String> = ["minimum", "maximum"]
    private static let fileKeys: Set<String> = ["path", "sha256"]
    private static let semanticVersionPattern = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
    private static let filePathPattern = "^Contents/(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*//)[A-Za-z0-9._ +@-]+(?:/[A-Za-z0-9._ +@-]+)*$"

    static func bundleRoot(forExecutable executableURL: URL) throws -> URL {
        guard executableURL.isFileURL else { throw LauncherError.invalidBundleLayout }
        let normalized = executableURL.standardizedFileURL
        guard normalized.path == executableURL.path,
              !normalized.lastPathComponent.isEmpty,
              normalized.deletingLastPathComponent().lastPathComponent == "MacOS",
              normalized.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Contents"
        else {
            throw LauncherError.invalidBundleLayout
        }
        let root = normalized.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard root.pathExtension == "app", !root.deletingPathExtension().lastPathComponent.isEmpty else {
            throw LauncherError.invalidBundleLayout
        }
        return root
    }

    static func validate(bundleRoot: URL) throws -> ReleaseManifest {
        guard bundleRoot.isFileURL, bundleRoot.standardizedFileURL.path == bundleRoot.path,
              bundleRoot.pathExtension == "app"
        else {
            throw LauncherError.invalidBundleLayout
        }

        let canonicalRoot = bundleRoot.resolvingSymlinksInPath().standardizedFileURL
        let manifestURL = bundleRoot.appendingPathComponent(manifestRelativePath).standardizedFileURL
        guard isStrictRegularFile(manifestURL, bundleRoot: bundleRoot, canonicalRoot: canonicalRoot) else {
            if !FileManager.default.fileExists(atPath: manifestURL.path) {
                throw LauncherError.manifestMissing
            }
            throw LauncherError.manifestInvalid("manifest_not_regular")
        }
        let attributes = try fileAttributes(manifestURL, manifest: true)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= maximumManifestBytes else {
            throw LauncherError.manifestInvalid("manifest_too_large")
        }

        let data: Data
        do {
            data = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        } catch {
            throw LauncherError.manifestInvalid("manifest_unreadable")
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw LauncherError.manifestInvalid("malformed_json")
        }
        let manifest = try parseManifest(object)
        try validatePayload(manifest.files, bundleRoot: bundleRoot, canonicalRoot: canonicalRoot)
        return manifest
    }

    private static func parseManifest(_ object: Any) throws -> ReleaseManifest {
        let root = try dictionary(object, keys: manifestKeys, code: "root_shape")
        try requireInteger(root["schemaVersion"], equalTo: 1, code: "schema_version")
        try requireString(root["bundleIdentifier"], pattern: "^net\\.greenroomai\\.GreenRoom$", code: "bundle_identifier")
        try requireString(root["appVersion"], pattern: semanticVersionPattern, code: "app_version")
        try requireString(root["sourceCommit"], pattern: "^[0-9a-f]{40}$", code: "source_commit")
        try requireNonnegativeInteger(root["buildEpoch"], code: "build_epoch")
        try requireString(root["targetTriple"], pattern: "^arm64-apple-darwin$", code: "target_triple")

        let runtimes = try dictionary(root["runtimes"], keys: runtimeKeys, code: "runtimes_shape")
        try requireString(runtimes["nodeVersion"], pattern: "^24\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", code: "node_version")
        try requireString(runtimes["pythonVersion"], pattern: "^3\\.(11|1[2-9]|[2-9][0-9])\\.(0|[1-9][0-9]*)$", code: "python_version")
        try requireString(runtimes["validatorVersion"], pattern: semanticVersionPattern, code: "validator_version")

        let database = try dictionary(root["databaseSchema"], keys: databaseKeys, code: "database_schema_shape")
        try requireInteger(database["minimum"], equalTo: 1, code: "database_minimum")
        try requireInteger(database["maximum"], equalTo: 3, code: "database_maximum")

        guard let rawFiles = root["files"] as? [Any], !rawFiles.isEmpty else {
            throw LauncherError.manifestInvalid("files_shape")
        }
        var seen = Set<String>()
        var files: [ReleaseManifest.FileRecord] = []
        for rawFile in rawFiles {
            let file = try dictionary(rawFile, keys: fileKeys, code: "file_shape")
            let path = try requiredString(file["path"], pattern: filePathPattern, code: "file_path")
            let digest = try requiredString(file["sha256"], pattern: "^[0-9a-f]{64}$", code: "file_digest")
            guard seen.insert(path).inserted else {
                throw LauncherError.manifestInvalid("duplicate_path:\(path)")
            }
            files.append(.init(path: path, sha256: digest))
        }
        return ReleaseManifest(files: files)
    }

    private static func validatePayload(
        _ files: [ReleaseManifest.FileRecord],
        bundleRoot: URL,
        canonicalRoot: URL
    ) throws {
        for file in files {
            let url = bundleRoot.appendingPathComponent(file.path).standardizedFileURL
            guard isStrictRegularFile(url, bundleRoot: bundleRoot, canonicalRoot: canonicalRoot) else {
                throw LauncherError.payloadInvalid("not_regular:\(file.path)")
            }
            let actual: String
            do {
                actual = try sha256(url)
            } catch {
                throw LauncherError.payloadInvalid("unreadable:\(file.path)")
            }
            guard actual == file.sha256 else {
                throw LauncherError.payloadInvalid("digest_mismatch:\(file.path)")
            }
        }
    }

    private static func isStrictRegularFile(
        _ url: URL,
        bundleRoot: URL,
        canonicalRoot: URL
    ) -> Bool {
        let rootPrefix = bundleRoot.standardizedFileURL.path + "/"
        guard url.path.hasPrefix(rootPrefix) else { return false }
        let suffix = String(url.path.dropFirst(rootPrefix.count))
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL
        // Build the expected canonical path from the bundle-relative suffix, even
        // when an ancestor of the temporary/app directory itself is a symlink.
        let canonicalExpected = canonicalRoot.appendingPathComponent(suffix).standardizedFileURL
        guard resolved.path == canonicalExpected.path else { return false }
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            return values.isRegularFile == true && values.isSymbolicLink != true
        } catch {
            return false
        }
    }

    private static func sha256(_ url: URL) throws -> String {
        guard let stream = InputStream(url: url) else { throw LauncherError.payloadInvalid("stream") }
        stream.open()
        defer { stream.close() }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? LauncherError.payloadInvalid("stream") }
            if count == 0 { break }
            hasher.update(data: Data(buffer[0..<count]))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func fileAttributes(_ url: URL, manifest: Bool) throws -> [FileAttributeKey: Any] {
        do {
            return try FileManager.default.attributesOfItem(atPath: url.path)
        } catch {
            if manifest { throw LauncherError.manifestInvalid("manifest_unreadable") }
            throw error
        }
    }

    private static func dictionary(_ value: Any?, keys: Set<String>, code: String) throws -> [String: Any] {
        guard let dictionary = value as? [String: Any], Set(dictionary.keys) == keys else {
            throw LauncherError.manifestInvalid(code)
        }
        return dictionary
    }

    private static func requireInteger(_ value: Any?, equalTo expected: Int, code: String) throws {
        guard let number = value as? NSNumber, !isBoolean(number), number.intValue == expected,
              number.doubleValue == Double(expected)
        else { throw LauncherError.manifestInvalid(code) }
    }

    private static func requireNonnegativeInteger(_ value: Any?, code: String) throws {
        guard let number = value as? NSNumber, !isBoolean(number), number.doubleValue >= 0,
              number.doubleValue.rounded(.towardZero) == number.doubleValue
        else { throw LauncherError.manifestInvalid(code) }
    }

    private static func requireString(_ value: Any?, pattern: String, code: String) throws {
        _ = try requiredString(value, pattern: pattern, code: code)
    }

    private static func requiredString(_ value: Any?, pattern: String, code: String) throws -> String {
        guard let string = value as? String,
              string.range(of: pattern, options: .regularExpression) != nil
        else { throw LauncherError.manifestInvalid(code) }
        return string
    }

    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }
}

struct BoundedStream: Sendable {
    let retained: Data
    let discardedBytes: Int

    fileprivate struct Accumulator {
        let limit: Int
        var bytes = Data()
        var discarded = 0

        mutating func append(_ data: Data) {
            guard !data.isEmpty else { return }
            if data.count >= limit {
                discarded += bytes.count + data.count - limit
                bytes = data.suffix(limit)
                return
            }
            let overflow = max(0, bytes.count + data.count - limit)
            if overflow > 0 {
                bytes.removeFirst(overflow)
                discarded += overflow
            }
            bytes.append(data)
        }

        var result: BoundedStream { .init(retained: bytes, discardedBytes: discarded) }
    }
}

struct SupervisedProcessResult: Sendable {
    let pid: pid_t
    let stdout: BoundedStream
    let stderr: BoundedStream
    let termSent: Bool
    let killSent: Bool
    let reaped: Bool
    let status: Int32
}

enum SpawnError: Error, CustomStringConvertible {
    case system(String, Int32)

    var description: String {
        switch self { case .system(let operation, let code): return "\(operation):\(code)" }
    }
}

private func checked(_ code: Int32, _ operation: String) throws {
    if code != 0 { throw SpawnError.system(operation, code) }
}

private func writeTestEvidence(_ fd: Int32?, _ values: [String: Any]) {
    guard let fd, let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
          data.count < 4_096 else { return }
    var bytes = Array(data) + [UInt8(0x0a)]
    bytes.withUnsafeMutableBytes { raw in
        var offset = 0
        while offset < raw.count {
            let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if count > 0 { offset += count } else if errno != EINTR { break }
        }
    }
}

private func withMutableCStringArray<R>(_ strings: [String], _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> R) rethrows -> R {
    let pointers = strings.map { strdup($0) }
    defer { pointers.forEach { free($0) } }
    var terminated = pointers + [nil]
    return try terminated.withUnsafeMutableBufferPointer { buffer in try body(buffer.baseAddress!) }
}

/// Owns one trusted packaged runtime process group. A descendant which deliberately
/// calls setsid(2) can escape this group; shipped Node and the frozen validator are
/// trusted executables and must never do that.
enum SupervisedProcess {
    static func runForTest(
        executable: String,
        arguments: [String],
        environment: [String: String],
        cwd: String,
        grace: Duration,
        shutdownAfter: Duration? = nil,
        outputLimit: Int = 64 * 1024,
        lifetimeFD: Int32? = nil
    ) throws -> SupervisedProcessResult {
        try run(executable: executable, arguments: arguments, environment: environment, cwd: cwd,
                graceNanoseconds: nanoseconds(grace), shutdownAfterNanoseconds: shutdownAfter.map(nanoseconds),
                outputLimit: outputLimit, lifetimeFD: lifetimeFD, armedFD: nil)
    }

    static func run(
        executable: String,
        arguments: [String],
        environment: [String: String],
        cwd: String,
        graceNanoseconds: UInt64 = 5_000_000_000,
        shutdownAfterNanoseconds: UInt64? = nil,
        outputLimit: Int = 64 * 1024,
        lifetimeFD: Int32?,
        armedFD: Int32?,
        testEvidenceFD: Int32? = nil,
        shutdownRequested: () -> Bool = { false }
    ) throws -> SupervisedProcessResult {
        guard executable.hasPrefix("/"), cwd.hasPrefix("/"), outputLimit > 0 else {
            throw SpawnError.system("invalid_spawn_configuration", EINVAL)
        }
        var stdoutPipe = [Int32](repeating: -1, count: 2)
        var stderrPipe = [Int32](repeating: -1, count: 2)
        guard pipe(&stdoutPipe) == 0 else { throw SpawnError.system("pipe_stdout", errno) }
        guard pipe(&stderrPipe) == 0 else {
            close(stdoutPipe[0]); close(stdoutPipe[1]); throw SpawnError.system("pipe_stderr", errno)
        }
        var owned = Set(stdoutPipe + stderrPipe)
        defer { for fd in owned { close(fd) } }

        var actions: posix_spawn_file_actions_t? = nil
        try checked(posix_spawn_file_actions_init(&actions), "file_actions_init")
        defer { if actions != nil { posix_spawn_file_actions_destroy(&actions) } }
        try checked(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0), "addopen_stdin")
        try checked(posix_spawn_file_actions_adddup2(&actions, stdoutPipe[1], STDOUT_FILENO), "dup_stdout")
        try checked(posix_spawn_file_actions_adddup2(&actions, stderrPipe[1], STDERR_FILENO), "dup_stderr")
        try checked(posix_spawn_file_actions_addclose(&actions, stdoutPipe[1]), "close_stdout_source")
        try checked(posix_spawn_file_actions_addclose(&actions, stderrPipe[1]), "close_stderr_source")
        try checked(posix_spawn_file_actions_addclose(&actions, stdoutPipe[0]), "close_stdout_read")
        try checked(posix_spawn_file_actions_addclose(&actions, stderrPipe[0]), "close_stderr_read")
        if let testEvidenceFD {
            try checked(posix_spawn_file_actions_adddup2(&actions, testEvidenceFD, 3), "dup_test_evidence")
            if testEvidenceFD != 3 {
                try checked(posix_spawn_file_actions_addclose(&actions, testEvidenceFD), "close_test_evidence_source")
            }
        }
        try checked(posix_spawn_file_actions_addchdir_np(&actions, cwd), "addchdir")

        var attributes: posix_spawnattr_t? = nil
        try checked(posix_spawnattr_init(&attributes), "spawnattr_init")
        defer { if attributes != nil { posix_spawnattr_destroy(&attributes) } }
        try checked(posix_spawnattr_setpgroup(&attributes, 0), "setpgroup")
        var emptyMask = sigset_t(); try checked(sigemptyset(&emptyMask), "sigemptyset_mask")
        try checked(posix_spawnattr_setsigmask(&attributes, &emptyMask), "setsigmask")
        var defaults = sigset_t(); try checked(sigemptyset(&defaults), "sigemptyset_defaults")
        for signalNumber in [SIGTERM, SIGINT, SIGHUP, SIGPIPE] {
            try checked(sigaddset(&defaults, signalNumber), "sigaddset_default")
        }
        try checked(posix_spawnattr_setsigdefault(&attributes, &defaults), "setsigdefault")
        let flags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)
        try checked(posix_spawnattr_setflags(&attributes, flags), "setflags")

        var pid: pid_t = 0
        let argv = [executable] + arguments
        var childEnvironment = environment
        if testEvidenceFD != nil { childEnvironment["GREENROOM_TEST_EVIDENCE_FD"] = "3" }
        let env = childEnvironment.keys.sorted().map { "\($0)=\(childEnvironment[$0]!)" }
        let spawnCode = withMutableCStringArray(argv) { argvPointer in
            withMutableCStringArray(env) { envPointer in
                posix_spawn(&pid, executable, &actions, &attributes, argvPointer, envPointer)
            }
        }
        try checked(spawnCode, "posix_spawn")
        close(stdoutPipe[1]); owned.remove(stdoutPipe[1])
        close(stderrPipe[1]); owned.remove(stderrPipe[1])
        for fd in [stdoutPipe[0], stderrPipe[0]] {
            let current = fcntl(fd, F_GETFL)
            if current < 0 || fcntl(fd, F_SETFL, current | O_NONBLOCK) < 0 {
                let code = errno
                _ = killpg(pid, SIGKILL)
                var cleanupStatus: Int32 = 0
                while waitpid(pid, &cleanupStatus, 0) < 0 && errno == EINTR {}
                throw SpawnError.system("nonblocking_pipe", code)
            }
        }
        var armed = false
        func armOuter() throws {
            guard !armed, let armedFD else { return }
            var byte: UInt8 = 1
            guard write(armedFD, &byte, 1) == 1 else {
                let code = errno
                _ = killpg(pid, SIGKILL)
                var cleanupStatus: Int32 = 0
                while waitpid(pid, &cleanupStatus, 0) < 0 && errno == EINTR {}
                throw SpawnError.system("armed_write", code)
            }
            armed = true
        }
        if testEvidenceFD == nil { try armOuter() }

        var out = BoundedStream.Accumulator(limit: outputLimit)
        var err = BoundedStream.Accumulator(limit: outputLimit)
        var status: Int32 = 0
        var reaped = false
        var termSent = false
        var killSent = false
        var termAt: UInt64?
        let started = DispatchTime.now().uptimeNanoseconds
        var lifetimeClosed = false
        if let lifetimeFD {
            let current = fcntl(lifetimeFD, F_GETFL)
            if current >= 0 { _ = fcntl(lifetimeFD, F_SETFL, current | O_NONBLOCK) }
        }

        func groupExists() -> Bool {
            if killpg(pid, 0) == 0 { return true }
            return errno == EPERM
        }
        func requestShutdown(_ now: UInt64) {
            guard !termSent else { return }
            termSent = true; termAt = now
            if killpg(pid, SIGTERM) != 0 && errno != ESRCH { /* retry/escalate below */ }
        }
        func drain(_ fd: Int32, into accumulator: inout BoundedStream.Accumulator) -> Bool {
            var buffer = [UInt8](repeating: 0, count: 32 * 1024)
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count > 0 { accumulator.append(Data(buffer[0..<count])); continue }
                if count == 0 { return true }
                if errno == EINTR { continue }
                return errno != EAGAIN && errno != EWOULDBLOCK
            }
        }

        var stdoutEOF = false, stderrEOF = false
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            if !reaped {
                let waited = waitpid(pid, &status, WNOHANG)
                if waited == pid { reaped = true; requestShutdown(now) }
                else if waited < 0 && errno != EINTR { throw SpawnError.system("waitpid", errno) }
            }
            if let deadline = shutdownAfterNanoseconds, now - started >= deadline { requestShutdown(now) }
            if shutdownRequested() { requestShutdown(now) }
            if let lifetimeFD, !lifetimeClosed {
                var byte: UInt8 = 0
                let count = read(lifetimeFD, &byte, 1)
                if count == 0 { lifetimeClosed = true; requestShutdown(now) }
                else if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                    lifetimeClosed = true; requestShutdown(now)
                }
            }
            if !stdoutEOF { stdoutEOF = drain(stdoutPipe[0], into: &out) }
            if !stderrEOF { stderrEOF = drain(stderrPipe[0], into: &err) }
            if testEvidenceFD != nil, !armed,
               out.bytes.range(of: Data("GREENROOM_TEST_FIXTURE_READY\n".utf8)) != nil {
                try armOuter()
                writeTestEvidence(testEvidenceFD, ["event": "internal-fixture-ready", "leaderPid": Int(pid)])
            }
            if termSent, groupExists(), let sent = termAt, now - sent >= graceNanoseconds, !killSent {
                killSent = true
                if killpg(pid, SIGKILL) != 0 && errno != ESRCH { throw SpawnError.system("killpg_kill", errno) }
            }
            let gone = !groupExists()
            if gone && !reaped {
                let waited = waitpid(pid, &status, 0)
                if waited == pid { reaped = true }
                else if waited < 0 && errno != EINTR { throw SpawnError.system("waitpid_reap", errno) }
            }
            if gone && reaped && stdoutEOF && stderrEOF { break }
            usleep(2_000)
        }
        return .init(pid: pid, stdout: out.result, stderr: err.result, termSent: termSent,
                     killSent: killSent, reaped: reaped, status: status)
    }

    private static func nanoseconds(_ duration: Duration) -> UInt64 {
        let components = duration.components
        return UInt64(max(0, components.seconds)) * 1_000_000_000 + UInt64(max(0, components.attoseconds / 1_000_000_000))
    }
}

private struct PackagedRuntime {
    let node: String
    let server: String
    let cwd: String
    let environment: [String: String]

    static func resolve(bundleRoot: URL, manifest: ReleaseManifest) throws -> PackagedRuntime {
        let required = [
            "Contents/Resources/runtime/node/bin/node",
            "Contents/Resources/app/dist/src/server.js",
            "Contents/Resources/validator/greenroom-persona",
        ]
        let records = Set(manifest.files.map(\.path))
        guard required.allSatisfy(records.contains) else { throw LauncherError.payloadInvalid("runtime_files_missing") }
        func canonical(_ relative: String) throws -> String {
            let url = bundleRoot.appendingPathComponent(relative).standardizedFileURL
            let resolved = url.resolvingSymlinksInPath().standardizedFileURL
            let root = bundleRoot.resolvingSymlinksInPath().standardizedFileURL.path + "/"
            guard resolved.path.hasPrefix(root), resolved.path == url.resolvingSymlinksInPath().path else {
                throw LauncherError.payloadInvalid("runtime_path_invalid")
            }
            return resolved.path
        }
        let node = try canonical(required[0])
        let server = try canonical(required[1])
        let validator = try canonical(required[2])
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.isExecutableFile(atPath: validator) else {
            throw LauncherError.payloadInvalid("runtime_not_executable")
        }
        let resources = bundleRoot.appendingPathComponent("Contents/Resources").resolvingSymlinksInPath().path
        let app = resources + "/app"
        let appURL = URL(fileURLWithPath: app, isDirectory: true)
        let appValues = try appURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard appValues.isDirectory == true, appValues.isSymbolicLink != true,
              appURL.standardizedFileURL.path == appURL.resolvingSymlinksInPath().standardizedFileURL.path
        else { throw LauncherError.payloadInvalid("runtime_cwd_invalid") }
        let data = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/net.greenroomai.GreenRoom", isDirectory: true)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let canonicalData = data.resolvingSymlinksInPath().standardizedFileURL.path
        let environment = [
            "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8",
            "GREENROOM_RUNTIME_MODE": "packaged-macos",
            "GREENROOM_PACKAGE_PAYLOAD_ROOT": bundleRoot.appendingPathComponent("Contents").resolvingSymlinksInPath().path,
            "GREENROOM_PUBLIC_DIR": app + "/dist/public",
            "GREENROOM_MIGRATIONS_DIR": app + "/dist/migrations",
            "GREENROOM_HISTORICAL_CATALOG_DIR": app + "/dist/personas/historical",
            "GREENROOM_ORIGINAL_CATALOG_DIR": app + "/dist/personas/original",
            "GREENROOM_PERSONA_PREFLIGHT_FIXTURE": app + "/dist/runtime-assets/persona-validator/valid-minimal.greenroom",
            "GREENROOM_PERSONA_VALIDATOR_EXECUTABLE": validator,
            "GREENROOM_PERSONA_INSPECTION": "required",
            "GREENROOM_HOST": "127.0.0.1", "GREENROOM_PORT": "8787",
            "GREENROOM_DATA_DIR": canonicalData,
        ]
        return .init(node: node, server: server, cwd: app, environment: environment)
    }
}

private final class SignalLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var sources: [DispatchSourceSignal] = []

    init() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { [weak self] in
                self?.lock.lock(); self?.fired = true; self?.lock.unlock()
            }
            source.resume()
            sources.append(source)
        }
    }

    var requested: Bool {
        lock.lock(); defer { lock.unlock() }
        return fired
    }
}

private enum SupervisorMode {
    static let lifetimeFD: Int32 = 3
    static let armedFD: Int32 = 4
    static let testEvidenceFD: Int32 = 5
    static let inheritedTestEvidenceFD: Int32 = 200

    private static func availableTestEvidenceFD(_ fd: Int32) -> Int32? {
        var status = stat()
        let flags = fcntl(fd, F_GETFL)
        guard fstat(fd, &status) == 0, flags >= 0 else { return nil }
        let kind = status.st_mode & S_IFMT
        if kind == S_IFREG {
            let permissions = status.st_mode & (S_IRWXU | S_IRWXG | S_IRWXO)
            return permissions == (S_IRUSR | S_IWUSR) && flags & O_APPEND != 0 ? fd : nil
        }
        return kind == S_IFIFO || kind == S_IFSOCK ? fd : nil
    }

    static func runInternal(executable: URL) throws {
        guard CommandLine.arguments == [executable.path, "--internal-supervisor"],
              fcntl(lifetimeFD, F_GETFD) >= 0, fcntl(armedFD, F_GETFD) >= 0
        else { throw LauncherError.unsafeInvocation("internal_protocol") }
        #if !arch(arm64)
        throw LauncherError.unsupportedArchitecture
        #endif
        let evidenceFD = availableTestEvidenceFD(testEvidenceFD)
        do {
            let bundle = try LauncherPreflight.bundleRoot(forExecutable: executable)
            let manifest = try LauncherPreflight.validate(bundleRoot: bundle)
            let runtime = try PackagedRuntime.resolve(bundleRoot: bundle, manifest: manifest)
            let signals = SignalLatch()
            let result = try SupervisedProcess.run(
                executable: runtime.node, arguments: [runtime.server], environment: runtime.environment,
                cwd: runtime.cwd, lifetimeFD: lifetimeFD, armedFD: armedFD,
                testEvidenceFD: evidenceFD,
                shutdownRequested: { signals.requested }
            )
            writeTestEvidence(evidenceFD, [
                "event": "supervisor-result", "leaderPid": Int(result.pid),
                "termSent": result.termSent, "killSent": result.killSent, "reaped": result.reaped,
                "status": Int(result.status),
                "stdoutTail": result.stdout.retained.suffix(1_024).base64EncodedString(),
                "stderrTail": result.stderr.retained.suffix(1_024).base64EncodedString(),
                "stdoutDiscarded": result.stdout.discardedBytes, "stderrDiscarded": result.stderr.discardedBytes,
            ])
        } catch {
            writeTestEvidence(evidenceFD, ["event": "supervisor-error", "code": "internal_supervision_failed"])
            throw error
        }
    }

    static func launchOuter(executable: URL, bundleRoot: URL) throws {
        var lifetime = [Int32](repeating: -1, count: 2)
        var armed = [Int32](repeating: -1, count: 2)
        guard pipe(&lifetime) == 0 else { throw SpawnError.system("lifetime_pipe", errno) }
        guard pipe(&armed) == 0 else {
            close(lifetime[0]); close(lifetime[1]); throw SpawnError.system("armed_pipe", errno)
        }
        defer { lifetime.forEach { if $0 >= 0 { close($0) } }; armed.forEach { if $0 >= 0 { close($0) } } }
        let inheritedLifetime = fcntl(lifetime[0], F_DUPFD_CLOEXEC, 10)
        let inheritedArmed = fcntl(armed[1], F_DUPFD_CLOEXEC, 10)
        guard inheritedLifetime >= 0, inheritedArmed >= 0 else { throw SpawnError.system("control_dup", errno) }
        defer { close(inheritedLifetime); close(inheritedArmed) }

        var actions: posix_spawn_file_actions_t? = nil
        try checked(posix_spawn_file_actions_init(&actions), "supervisor_actions_init")
        defer { if actions != nil { posix_spawn_file_actions_destroy(&actions) } }
        // CLOEXEC_DEFAULT closes every descriptor not named by a file action.
        // Keep only standard I/O and the two private control channels.
        for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
            try checked(posix_spawn_file_actions_adddup2(&actions, descriptor, descriptor), "supervisor_stdio_dup")
        }
        try checked(posix_spawn_file_actions_adddup2(&actions, inheritedLifetime, lifetimeFD), "supervisor_lifetime_dup")
        try checked(posix_spawn_file_actions_adddup2(&actions, inheritedArmed, armedFD), "supervisor_armed_dup")
        let evidenceFD = availableTestEvidenceFD(inheritedTestEvidenceFD)
        if let evidenceFD {
            try checked(posix_spawn_file_actions_adddup2(&actions, evidenceFD, testEvidenceFD), "supervisor_evidence_dup")
            try checked(posix_spawn_file_actions_addclose(&actions, evidenceFD), "supervisor_evidence_source_close")
        }
        try checked(posix_spawn_file_actions_addclose(&actions, inheritedLifetime), "supervisor_lifetime_source_close")
        try checked(posix_spawn_file_actions_addclose(&actions, inheritedArmed), "supervisor_armed_source_close")
        try checked(posix_spawn_file_actions_addchdir_np(&actions, bundleRoot.appendingPathComponent("Contents/Resources").path), "supervisor_chdir")
        var attributes: posix_spawnattr_t? = nil
        try checked(posix_spawnattr_init(&attributes), "supervisor_attr_init")
        defer { if attributes != nil { posix_spawnattr_destroy(&attributes) } }
        var empty = sigset_t(); try checked(sigemptyset(&empty), "supervisor_sigemptyset")
        try checked(posix_spawnattr_setsigmask(&attributes, &empty), "supervisor_sigmask")
        var defaults = sigset_t(); try checked(sigemptyset(&defaults), "supervisor_defaults_empty")
        for number in [SIGTERM, SIGINT, SIGHUP] {
            try checked(sigaddset(&defaults, number), "supervisor_default_signal")
        }
        try checked(posix_spawnattr_setsigdefault(&attributes, &defaults), "supervisor_sigdefault")
        try checked(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)), "supervisor_flags")
        var pid: pid_t = 0
        let code = withMutableCStringArray([executable.path, "--internal-supervisor"]) { argv in
            withMutableCStringArray(["LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8"]) { env in
                posix_spawn(&pid, executable.path, &actions, &attributes, argv, env)
            }
        }
        try checked(code, "spawn_supervisor")
        writeTestEvidence(evidenceFD, ["event": "internal-supervisor", "pid": Int(pid)])
        close(lifetime[0]); lifetime[0] = -1
        close(armed[1]); armed[1] = -1
        var pollDescriptor = pollfd(fd: armed[0], events: Int16(POLLIN | POLLHUP), revents: 0)
        let pollCode = poll(&pollDescriptor, 1, 10_000)
        var byte: UInt8 = 0
        guard pollCode > 0, read(armed[0], &byte, 1) == 1, byte == 1 else {
            close(lifetime[1]); lifetime[1] = -1
            _ = kill(pid, SIGTERM)
            var status: Int32 = 0; while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            throw SpawnError.system("supervisor_arm_timeout", ETIMEDOUT)
        }
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 {
            if errno != EINTR { throw SpawnError.system("wait_supervisor", errno) }
        }
    }
}

@main
struct GreenRoomLauncherMain {
    static func main() {
        do {
            let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--internal-supervisor" {
                try SupervisorMode.runInternal(executable: executable)
                return
            }
            try LauncherInvocation.validate(
                arguments: CommandLine.arguments,
                environment: ProcessInfo.processInfo.environment
            )
            #if !arch(arm64)
            throw LauncherError.unsupportedArchitecture
            #endif
            let bundleRoot = try LauncherPreflight.bundleRoot(forExecutable: executable)
            _ = try LauncherPreflight.validate(bundleRoot: bundleRoot)
            try SupervisorMode.launchOuter(executable: executable, bundleRoot: bundleRoot)
        } catch {
            let message = error as? LauncherError
            let output = "{\"code\":\"launcher_preflight_failed\",\"reason\":\"\(jsonEscape(message?.description ?? "internal_error"))\"}\n"
            FileHandle.standardError.write(Data(output.utf8))
            Foundation.exit(1)
        }
    }

    private static func jsonEscape(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}
