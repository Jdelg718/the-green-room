import CryptoKit
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

@main
struct GreenRoomLauncherMain {
    static func main() {
        do {
            try LauncherInvocation.validate(
                arguments: CommandLine.arguments,
                environment: ProcessInfo.processInfo.environment
            )
            #if !arch(arm64)
            throw LauncherError.unsupportedArchitecture
            #endif
            let executable = URL(fileURLWithPath: CommandLine.arguments[0])
            let bundleRoot = try LauncherPreflight.bundleRoot(forExecutable: executable)
            let manifest = try LauncherPreflight.validate(bundleRoot: bundleRoot)
            let output = "{\"code\":\"launcher_preflight_valid\",\"files\":\(manifest.files.count),\"state\":\"ready_for_spawn\"}\n"
            FileHandle.standardOutput.write(Data(output.utf8))
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
