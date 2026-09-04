import AppKit
import CryptoKit
import Darwin
import Foundation
import Security

struct ReleaseManifest: Equatable {
    struct FileRecord: Equatable {
        let path: String
        let sha256: String
        let mode: Int?
        let bytes: Int?
    }

    struct CodeObject: Equatable {
        let path: String
        let identifier: String
        let requirement: String
    }

    let schemaVersion: Int
    let files: [FileRecord]
    let signatureOwnedFiles: Set<String>
    let codeObjects: [CodeObject]
}

enum ReleaseSignatureState: Equatable { case unsigned, developerID }

enum LauncherError: Error, Equatable, CustomStringConvertible {
    case invalidBundleLayout
    case manifestMissing
    case manifestInvalid(String)
    case payloadInvalid(String)
    case unsafeInvocation(String)
    case unsupportedArchitecture
    case readinessProtocol
    case readinessTimeout
    case randomFailed
    case browserOpenFailed
    case browserOpenTimeout

    var description: String {
        switch self {
        case .invalidBundleLayout: return "invalid_bundle_layout"
        case .manifestMissing: return "release_manifest_missing"
        case .manifestInvalid(let code): return "release_manifest_invalid:\(code)"
        case .payloadInvalid(let code): return "payload_invalid:\(code)"
        case .unsafeInvocation(let code): return "unsafe_invocation:\(code)"
        case .unsupportedArchitecture: return "unsupported_architecture"
        case .readinessProtocol: return "readiness_protocol_error"
        case .readinessTimeout: return "readiness_timeout"
        case .randomFailed: return "readiness_random_failed"
        case .browserOpenFailed: return "browser_open_failed"
        case .browserOpenTimeout: return "browser_open_timeout"
        }
    }
}

enum ReadinessProtocol {
    static let tokenBytes = 32
    static let challengeBytes = 40
    static let readyBytes = 44
    static let maximumResponseBytes = 45
    private static let magic: [UInt8] = [0x47, 0x52, 0x52, 0x44]

    static func challengeFrame(token: Data) -> Data {
        precondition(token.count == tokenBytes)
        return Data(magic + [1, 1, 0, UInt8(tokenBytes)]) + token
    }

    static func readyFrameForTest(token: Data, pid: UInt32) -> Data {
        precondition(token.count == tokenBytes)
        var frame = Data(magic + [1, 2, 0, 36]) + token
        frame.append(contentsOf: [
            UInt8((pid >> 24) & 0xff), UInt8((pid >> 16) & 0xff),
            UInt8((pid >> 8) & 0xff), UInt8(pid & 0xff),
        ])
        return frame
    }

    static func validateReady(_ frame: Data, token: Data, pid: pid_t) throws {
        guard frame.count == readyBytes, token.count == tokenBytes,
              Array(frame.prefix(4)) == magic, frame[4] == 1, frame[5] == 2,
              frame[6] == 0, frame[7] == 36 else { throw LauncherError.readinessProtocol }
        var difference: UInt8 = 0
        for index in 0..<tokenBytes { difference |= frame[8 + index] ^ token[index] }
        guard difference == 0 else { throw LauncherError.readinessProtocol }
        let reported = frame[40...43].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard reported == UInt32(bitPattern: pid) else { throw LauncherError.readinessProtocol }
    }
}

enum ReadinessToken {
    typealias RandomFill = (UnsafeMutableRawBufferPointer) -> OSStatus

    static func generate(randomFill: RandomFill = { raw in
        SecRandomCopyBytes(kSecRandomDefault, raw.count, raw.baseAddress!)
    }) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: ReadinessProtocol.tokenBytes)
        let status = bytes.withUnsafeMutableBytes(randomFill)
        guard status == errSecSuccess else {
            _ = bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
            throw LauncherError.randomFailed
        }
        defer { _ = bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        return Data(bytes)
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
    private static let signedManifestKeys: Set<String> = [
        "schemaVersion", "bundleIdentifier", "appVersion", "sourceCommit", "buildEpoch",
        "targetTriple", "runtimes", "databaseSchema", "unsignedPayloadDigest", "payloadFiles",
        "signatureOwnedFiles", "signingPolicy",
    ]
    private static let runtimeKeys: Set<String> = ["nodeVersion", "pythonVersion", "validatorVersion"]
    private static let databaseKeys: Set<String> = ["minimum", "maximum"]
    private static let fileKeys: Set<String> = ["path", "sha256"]
    private static let signedFileKeys: Set<String> = ["path", "mode", "bytes", "sha256"]
    // codesign creates the resource seal; stapler later adds the ticket. The
    // signed manifest closes both exact names and permits no wildcard paths.
    private static let signatureOwnedPaths: Set<String> = [
        "Contents/CodeResources", "Contents/MacOS/GreenRoomLauncher",
        "Contents/_CodeSignature/CodeResources",
    ]
    private static let appIdentifier = "net.greenroomai.GreenRoom"
    private static let teamID = "JZ233HBW3Z"
    private static let codeObjectKeys: Set<String> = ["path", "identifier", "requirement"]
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

    static func validate(
        bundleRoot: URL,
        signatureState: ((URL) throws -> ReleaseSignatureState)? = nil
    ) throws -> ReleaseManifest {
        guard bundleRoot.isFileURL, bundleRoot.standardizedFileURL.path == bundleRoot.path,
              bundleRoot.pathExtension == "app"
        else {
            throw LauncherError.invalidBundleLayout
        }

        // This runs before even locating or opening the manifest. A Developer ID
        // launcher may never fall back to the separately supported unsigned-v1 path.
        let trust = try (signatureState ?? containingSignatureState)(bundleRoot)
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
        guard (trust == .developerID) == (manifest.schemaVersion == 2) else {
            throw LauncherError.manifestInvalid("signature_schema_mismatch")
        }
        try validatePayload(manifest, bundleRoot: bundleRoot, canonicalRoot: canonicalRoot)
        return manifest
    }

    private static func containingSignatureState(_ bundleRoot: URL) throws -> ReleaseSignatureState {
        let requirementText = designatedRequirement(appIdentifier)
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement else { throw LauncherError.manifestInvalid("signature_requirement") }
        var current: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &current) == errSecSuccess, let current else {
            throw LauncherError.manifestInvalid("launcher_signature_unavailable")
        }
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate)
        let exactStatus = SecCodeCheckValidity(current, flags, requirement)
        var developerIDRequirement: SecRequirement?
        let developerIDRequirementText = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
        guard SecRequirementCreateWithString(developerIDRequirementText as CFString, SecCSFlags(), &developerIDRequirement) == errSecSuccess,
              let developerIDRequirement else { throw LauncherError.manifestInvalid("signature_requirement") }
        let developerIDStatus = exactStatus == errSecSuccess
            ? errSecSuccess
            : SecCodeCheckValidity(current, flags, developerIDRequirement)
        var signingInformation: CFDictionary?
        var currentStaticCode: SecStaticCode?
        let staticCodeStatus = SecCodeCopyStaticCode(current, SecCSFlags(), &currentStaticCode)
        let signingInformationStatus = staticCodeStatus == errSecSuccess && currentStaticCode != nil
            ? SecCodeCopySigningInformation(
                currentStaticCode!, SecCSFlags(rawValue: kSecCSSigningInformation), &signingInformation
            )
            : staticCodeStatus
        let signatureFlags = (signingInformation as? [String: Any])?[kSecCodeInfoFlags as String] as? NSNumber
        // CS_ADHOC is the stable Code Signing Services flag value; Swift's
        // Security overlay does not expose the C macro on every SDK.
        let adHocSignatureFlag: UInt32 = 0x00000002
        let adHocOrUnsigned = signingInformationStatus == errSecCSUnsigned ||
            signingInformationStatus == errSecSuccess &&
            (signatureFlags?.uint32Value ?? 0) & adHocSignatureFlag != 0
        let state = try classifySignature(
            exactRequirementStatus: exactStatus,
            developerIDRequirementStatus: developerIDStatus,
            adHocOrUnsigned: adHocOrUnsigned
        )
        guard state == .developerID else { return state }
        var application: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundleRoot as CFURL, SecCSFlags(), &application) == errSecSuccess,
              let application,
              SecStaticCodeCheckValidity(application, flags, requirement) == errSecSuccess else {
            throw LauncherError.manifestInvalid("app_signature_invalid")
        }
        return .developerID
    }

    static func classifySignature(
        exactRequirementStatus: OSStatus,
        developerIDRequirementStatus: OSStatus,
        adHocOrUnsigned: Bool
    ) throws -> ReleaseSignatureState {
        if exactRequirementStatus == errSecSuccess { return .developerID }
        if developerIDRequirementStatus == errSecSuccess || !adHocOrUnsigned {
            throw LauncherError.manifestInvalid("launcher_signer_identity_mismatch")
        }
        return .unsigned
    }

    private static func parseManifest(_ object: Any) throws -> ReleaseManifest {
        guard let raw = object as? [String: Any], let version = raw["schemaVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), [1, 2].contains(version.intValue)
        else { throw LauncherError.manifestInvalid("schema_version") }
        let schemaVersion = version.intValue
        let root = try dictionary(object, keys: schemaVersion == 1 ? manifestKeys : signedManifestKeys, code: "root_shape")
        try requireInteger(root["schemaVersion"], equalTo: schemaVersion, code: "schema_version")
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
        try requireInteger(database["maximum"], equalTo: 8, code: "database_maximum")

        if schemaVersion == 2 {
            try requireString(root["unsignedPayloadDigest"], pattern: "^[0-9a-f]{64}$", code: "unsigned_payload_digest")
            try validateSigningPolicy(root["signingPolicy"])
        }
        let rawFileValue = schemaVersion == 1 ? root["files"] : root["payloadFiles"]
        guard let rawFiles = rawFileValue as? [Any], !rawFiles.isEmpty else {
            throw LauncherError.manifestInvalid("files_shape")
        }
        var seen = Set<String>()
        var files: [ReleaseManifest.FileRecord] = []
        var previousPath = ""
        for rawFile in rawFiles {
            let file = try dictionary(rawFile, keys: schemaVersion == 1 ? fileKeys : signedFileKeys, code: "file_shape")
            let path = try requiredString(file["path"], pattern: filePathPattern, code: "file_path")
            let digest = try requiredString(file["sha256"], pattern: "^[0-9a-f]{64}$", code: "file_digest")
            guard seen.insert(path).inserted, schemaVersion == 1 || path > previousPath else {
                throw LauncherError.manifestInvalid("duplicate_path:\(path)")
            }
            previousPath = path
            var mode: Int? = nil
            var bytes: Int? = nil
            if schemaVersion == 2 {
                guard let rawMode = file["mode"] as? NSNumber, CFGetTypeID(rawMode) != CFBooleanGetTypeID(), [292, 365].contains(rawMode.intValue),
                      let rawBytes = file["bytes"] as? NSNumber, CFGetTypeID(rawBytes) != CFBooleanGetTypeID(), rawBytes.intValue >= 0
                else { throw LauncherError.manifestInvalid("file_metadata") }
                mode = rawMode.intValue; bytes = rawBytes.intValue
            }
            files.append(.init(path: path, sha256: digest, mode: mode, bytes: bytes))
        }
        var signatureFiles = Set<String>()
        if schemaVersion == 2 {
            guard let rawSignatureFiles = root["signatureOwnedFiles"] as? [String], Set(rawSignatureFiles) == signatureOwnedPaths,
                  rawSignatureFiles.count == signatureOwnedPaths.count else {
                throw LauncherError.manifestInvalid("signature_owned_files")
            }
            signatureFiles = signatureOwnedPaths
        }
        let codeObjects = schemaVersion == 2 ? try parseCodeObjects(root["signingPolicy"], payloadFiles: files, signatureFiles: signatureFiles) : []
        return ReleaseManifest(schemaVersion: schemaVersion, files: files, signatureOwnedFiles: signatureFiles, codeObjects: codeObjects)
    }

    private static func validateSigningPolicy(_ object: Any?) throws {
        let keys: Set<String> = ["teamId", "identity", "hardenedRuntime", "secureTimestamp", "identifiers", "requirements", "codeObjects"]
        let policy = try dictionary(object, keys: keys, code: "signing_policy_shape")
        try requireString(policy["teamId"], pattern: "^JZ233HBW3Z$", code: "signing_team")
        try requireString(policy["identity"], pattern: "^Developer ID Application: James DelGuercio \\(JZ233HBW3Z\\)$", code: "signing_identity")
        guard policy["hardenedRuntime"] as? Bool == true, policy["secureTimestamp"] as? Bool == true,
              let codeObjects = policy["codeObjects"] as? [Any], !codeObjects.isEmpty
        else { throw LauncherError.manifestInvalid("signing_policy") }
        let identifiers = try dictionary(policy["identifiers"], keys: ["app", "credentialHelper"], code: "signing_identifiers")
        let requirements = try dictionary(policy["requirements"], keys: ["app", "credentialHelper"], code: "signing_requirements")
        let suffix = " and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"JZ233HBW3Z\""
        let app = "net.greenroomai.GreenRoom"
        let helper = "net.greenroomai.GreenRoom.credential-helper"
        guard identifiers["app"] as? String == app, identifiers["credentialHelper"] as? String == helper,
              requirements["app"] as? String == "identifier \"\(app)\"\(suffix)",
              requirements["credentialHelper"] as? String == "identifier \"\(helper)\"\(suffix)" else {
            throw LauncherError.manifestInvalid("helper_requirement")
        }
    }

    private static func parseCodeObjects(_ object: Any?, payloadFiles: [ReleaseManifest.FileRecord], signatureFiles: Set<String>) throws -> [ReleaseManifest.CodeObject] {
        guard let policy = object as? [String: Any], let rawObjects = policy["codeObjects"] as? [Any] else {
            throw LauncherError.manifestInvalid("code_objects_shape")
        }
        let payload = Dictionary(uniqueKeysWithValues: payloadFiles.map { ($0.path, $0) })
        var result: [ReleaseManifest.CodeObject] = []
        var previous = ""
        for raw in rawObjects {
            let value = try dictionary(raw, keys: codeObjectKeys, code: "code_object_shape")
            let path = try requiredString(value["path"], pattern: filePathPattern, code: "code_object_path")
            let expectedIdentifier = identifier(for: path)
            let identifier = try requiredString(value["identifier"], pattern: "^net\\.greenroomai\\.GreenRoom(?:\\.[a-z0-9-]+)*$", code: "code_object_identifier")
            let requirement = try requiredString(value["requirement"], pattern: ".+", code: "code_object_requirement")
            guard path > previous, identifier == expectedIdentifier,
                  requirement == designatedRequirement(identifier),
                  payload[path]?.mode == 365 || path == "Contents/MacOS/GreenRoomLauncher" && signatureFiles.contains(path) else {
                throw LauncherError.manifestInvalid("code_object_policy")
            }
            previous = path
            result.append(.init(path: path, identifier: identifier, requirement: requirement))
        }
        return result
    }

    private static func designatedRequirement(_ identifier: String) -> String {
        "identifier \"\(identifier)\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\""
    }

    private static func identifier(for path: String) -> String {
        let known = [
            "Contents/MacOS/GreenRoomLauncher": appIdentifier,
            "Contents/Resources/helpers/GreenRoomCredentialHelper": "\(appIdentifier).credential-helper",
            "Contents/Resources/runtime/node/bin/node": "\(appIdentifier).node",
            "Contents/Resources/validator/greenroom-persona": "\(appIdentifier).validator",
        ]
        if let value = known[path] { return value }
        let digest = SHA256.hash(data: Data(path.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return "\(appIdentifier).component.\(digest)"
    }

    private static func isClassifiedMachO(_ path: String) -> Bool {
        [
            "Contents/MacOS/GreenRoomLauncher",
            "Contents/Resources/helpers/GreenRoomCredentialHelper",
            "Contents/Resources/runtime/node/bin/node",
            "Contents/Resources/validator/greenroom-persona",
        ].contains(path) || path.hasPrefix("Contents/Resources/validator/") ||
            (path.hasPrefix("Contents/Resources/app/node_modules/") && path.hasSuffix(".node"))
    }

    private static func isMachO(_ url: URL) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: 4) ?? Data()
        guard bytes.count == 4 else { return false }
        let magic = Array(bytes)
        return [
            [0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe],
            [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
            [0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca],
        ].contains(magic)
    }

    private static func validatePayload(
        _ manifest: ReleaseManifest,
        bundleRoot: URL,
        canonicalRoot: URL
    ) throws {
        let files = manifest.files
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
            if let expectedMode = file.mode, let expectedBytes = file.bytes {
                let attributes = try fileAttributes(url, manifest: false)
                let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue
                let bytes = (attributes[.size] as? NSNumber)?.intValue
                guard mode == expectedMode, bytes == expectedBytes else {
                    throw LauncherError.payloadInvalid("metadata_mismatch:\(file.path)")
                }
            }
        }
        if manifest.schemaVersion == 2 {
            let declared = Set(files.map(\.path))
            let required = declared.union([manifestRelativePath, "Contents/MacOS/GreenRoomLauncher", "Contents/_CodeSignature/CodeResources"])
            let allowed = required.union(["Contents/CodeResources"])
            var actualFiles = Set<String>()
            var actualCode = Set<String>()
            var enumerationError = false
            guard let resolvedPointer = realpath(bundleRoot.path, nil) else {
                throw LauncherError.payloadInvalid("inventory_unreadable")
            }
            let inventoryRoot = URL(fileURLWithPath: String(cString: resolvedPointer), isDirectory: true)
            free(resolvedPointer)
            guard (try fileAttributes(bundleRoot, manifest: false)[.posixPermissions] as? NSNumber)?.intValue == 365 else {
                throw LauncherError.payloadInvalid("directory_mode")
            }
            guard let enumerator = FileManager.default.enumerator(
                at: inventoryRoot, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey],
                options: [], errorHandler: { _, _ in enumerationError = true; return false }
            ) else { throw LauncherError.payloadInvalid("inventory_unreadable") }
            while let url = enumerator.nextObject() as? URL {
                let rootPrefix = inventoryRoot.path + "/"
                guard url.path.hasPrefix(rootPrefix) else { throw LauncherError.payloadInvalid("inventory_escape") }
                let relative = String(url.path.dropFirst(rootPrefix.count))
                let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
                if values.isSymbolicLink == true || values.isRegularFile != true && values.isDirectory != true {
                    throw LauncherError.payloadInvalid("inventory_type:\(relative)")
                }
                let attributes = try fileAttributes(url, manifest: false)
                if values.isDirectory == true && (attributes[.posixPermissions] as? NSNumber)?.intValue != 365 {
                    throw LauncherError.payloadInvalid("directory_mode:\(relative)")
                }
                if [".DS_Store", "Thumbs.db", "__MACOSX"].contains(where: { relative.split(separator: "/").contains(Substring($0)) }) {
                    throw LauncherError.payloadInvalid("inventory_junk:\(relative)")
                }
                if values.isRegularFile == true {
                    guard (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else {
                        throw LauncherError.payloadInvalid("inventory_hardlink:\(relative)")
                    }
                    guard allowed.contains(relative), actualFiles.insert(relative).inserted else {
                        throw LauncherError.payloadInvalid("undeclared:\(relative)")
                    }
                    let protectedMode = relative == "Contents/MacOS/GreenRoomLauncher" ? 365 : 292
                    if (relative == manifestRelativePath || manifest.signatureOwnedFiles.contains(relative)),
                       (attributes[.posixPermissions] as? NSNumber)?.intValue != protectedMode {
                        throw LauncherError.payloadInvalid("metadata_mismatch:\(relative)")
                    }
                    if try isMachO(url) {
                        guard isClassifiedMachO(relative) else { throw LauncherError.payloadInvalid("unclassified_macho:\(relative)") }
                        actualCode.insert(relative)
                    } else if (attributes[.posixPermissions] as? NSNumber)?.intValue == 365 {
                        throw LauncherError.payloadInvalid("executable_non_macho:\(relative)")
                    }
                }
            }
            if enumerationError { throw LauncherError.payloadInvalid("inventory_unreadable") }
            guard required.isSubset(of: actualFiles), actualFiles.isSubset(of: allowed) else {
                throw LauncherError.payloadInvalid("inventory_incomplete")
            }
            guard actualCode == Set(manifest.codeObjects.map(\.path)) else {
                throw LauncherError.payloadInvalid("code_object_inventory")
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
                outputLimit: outputLimit, lifetimeFD: lifetimeFD, armedFD: nil, readinessFD: nil)
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
        readinessFD: Int32?,
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
        if let readinessFD {
            try checked(posix_spawn_file_actions_adddup2(&actions, readinessFD, 3), "dup_readiness")
            if readinessFD != 3 {
                try checked(posix_spawn_file_actions_addclose(&actions, readinessFD), "close_readiness_source")
            }
        }
        if let testEvidenceFD {
            try checked(posix_spawn_file_actions_adddup2(&actions, testEvidenceFD, 4), "dup_test_evidence")
            if testEvidenceFD != 4 {
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
        if testEvidenceFD != nil { childEnvironment["GREENROOM_TEST_EVIDENCE_FD"] = "4" }
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
            let bytes = [
                UInt8((UInt32(bitPattern: pid) >> 24) & 0xff),
                UInt8((UInt32(bitPattern: pid) >> 16) & 0xff),
                UInt8((UInt32(bitPattern: pid) >> 8) & 0xff),
                UInt8(UInt32(bitPattern: pid) & 0xff),
            ]
            let written = bytes.withUnsafeBytes { write(armedFD, $0.baseAddress!, $0.count) }
            guard written == bytes.count else {
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
    static let readinessFD: Int32 = 5
    static let testEvidenceFD: Int32 = 6
    static let inheritedTestEvidenceFD: Int32 = 200
    #if DEBUG
    static let inheritedBrowserTestControlFD: Int32 = 201
    static let browserTestControlFD: Int32 = 4
    #endif
    static let browserAuthorizationFD: Int32 = 3
    static let browserOpenTimeoutNanoseconds: UInt64 = 2_000_000_000
    private static let browserAuthorization: [UInt8] = [0x47, 0x52, 0x4f, 0x50]
    private static let browserURL = URL(string: "http://127.0.0.1:8787/")!

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
              fcntl(lifetimeFD, F_GETFD) >= 0, fcntl(armedFD, F_GETFD) >= 0,
              fcntl(readinessFD, F_GETFD) >= 0
        else { throw LauncherError.unsafeInvocation("internal_protocol") }
        #if !arch(arm64)
        throw LauncherError.unsupportedArchitecture
        #endif
        #if DEBUG
        let evidenceFD = availableTestEvidenceFD(testEvidenceFD)
        #else
        let evidenceFD: Int32? = nil
        #endif
        do {
            let bundle = try LauncherPreflight.bundleRoot(forExecutable: executable)
            let manifest = try LauncherPreflight.validate(bundleRoot: bundle)
            let runtime = try PackagedRuntime.resolve(bundleRoot: bundle, manifest: manifest)
            let signals = SignalLatch()
            let result = try SupervisedProcess.run(
                executable: runtime.node, arguments: [runtime.server], environment: runtime.environment,
                cwd: runtime.cwd, lifetimeFD: lifetimeFD, armedFD: armedFD,
                readinessFD: readinessFD,
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

    static func runBrowserOpener(executable: URL) throws {
        guard CommandLine.arguments == [executable.path, "--internal-browser-opener"],
              fcntl(browserAuthorizationFD, F_GETFD) >= 0
        else { throw LauncherError.unsafeInvocation("browser_protocol") }
        var authorization = [UInt8](repeating: 0, count: browserAuthorization.count + 1)
        var count = 0
        while count < authorization.count {
            let result = authorization.withUnsafeMutableBytes { raw in
                Darwin.read(browserAuthorizationFD, raw.baseAddress!.advanced(by: count), raw.count - count)
            }
            if result > 0 { count += result; continue }
            if result == 0 { break }
            if errno != EINTR { throw LauncherError.browserOpenFailed }
        }
        guard count == browserAuthorization.count,
              Array(authorization.prefix(count)) == browserAuthorization
        else { throw LauncherError.unsafeInvocation("browser_protocol") }
        #if DEBUG
        if fcntl(browserTestControlFD, F_GETFD) >= 0 {
            var mode: UInt8 = 0xff
            guard Darwin.read(browserTestControlFD, &mode, 1) == 1 else {
                throw LauncherError.browserOpenFailed
            }
            switch mode {
            case 0: return
            case 1: throw LauncherError.browserOpenFailed
            case 2: while true { pause() }
            default: throw LauncherError.browserOpenFailed
            }
        }
        #endif
        guard NSWorkspace.shared.open(browserURL) else { throw LauncherError.browserOpenFailed }
    }

    private static func openBrowserBounded(executable: URL, evidenceFD: Int32?) throws {
        var authorization = [Int32](repeating: -1, count: 2)
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &authorization) == 0 else {
            throw SpawnError.system("browser_socketpair", errno)
        }
        defer { authorization.forEach { if $0 >= 0 { close($0) } } }
        var noSigPipe: Int32 = 1
        guard setsockopt(authorization[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe,
                         socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw SpawnError.system("browser_nosigpipe", errno)
        }
        for fd in authorization {
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else {
                throw SpawnError.system("browser_cloexec", errno)
            }
        }
        var inheritedAuthorization = fcntl(authorization[1], F_DUPFD_CLOEXEC, 10)
        guard inheritedAuthorization >= 0 else { throw SpawnError.system("browser_dup", errno) }
        defer { if inheritedAuthorization >= 0 { close(inheritedAuthorization) } }

        var actions: posix_spawn_file_actions_t? = nil
        try checked(posix_spawn_file_actions_init(&actions), "browser_actions_init")
        defer { if actions != nil { posix_spawn_file_actions_destroy(&actions) } }
        for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
            try checked(posix_spawn_file_actions_adddup2(&actions, descriptor, descriptor), "browser_stdio_dup")
        }
        try checked(posix_spawn_file_actions_adddup2(&actions, inheritedAuthorization, browserAuthorizationFD), "browser_authorization_dup")
        try checked(posix_spawn_file_actions_addclose(&actions, inheritedAuthorization), "browser_authorization_source_close")
        #if DEBUG
        if availableTestEvidenceFD(inheritedBrowserTestControlFD) != nil {
            try checked(posix_spawn_file_actions_adddup2(&actions, inheritedBrowserTestControlFD, browserTestControlFD), "browser_test_control_dup")
        }
        #endif
        var attributes: posix_spawnattr_t? = nil
        try checked(posix_spawnattr_init(&attributes), "browser_attr_init")
        defer { if attributes != nil { posix_spawnattr_destroy(&attributes) } }
        var empty = sigset_t(); try checked(sigemptyset(&empty), "browser_sigemptyset")
        var defaults = sigset_t(); try checked(sigemptyset(&defaults), "browser_defaults_empty")
        for number in [SIGTERM, SIGINT, SIGHUP, SIGPIPE] {
            try checked(sigaddset(&defaults, number), "browser_default_signal")
        }
        try checked(posix_spawnattr_setsigmask(&attributes, &empty), "browser_sigmask")
        try checked(posix_spawnattr_setsigdefault(&attributes, &defaults), "browser_sigdefault")
        try checked(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)), "browser_flags")
        var openerPID: pid_t = 0
        let code = withMutableCStringArray([executable.path, "--internal-browser-opener"]) { argv in
            withMutableCStringArray(["LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8"]) { env in
                posix_spawn(&openerPID, executable.path, &actions, &attributes, argv, env)
            }
        }
        try checked(code, "spawn_browser_opener")
        var openerReaped = false
        defer {
            if !openerReaped {
                _ = kill(openerPID, SIGKILL)
                try? reap(openerPID)
            }
        }
        close(authorization[1]); authorization[1] = -1
        close(inheritedAuthorization); inheritedAuthorization = -1
        try writeAll(authorization[0], data: Data(browserAuthorization))
        guard shutdown(authorization[0], SHUT_WR) == 0 else {
            _ = kill(openerPID, SIGKILL); try? reap(openerPID); openerReaped = true
            throw LauncherError.browserOpenFailed
        }
        let deadline = DispatchTime.now().uptimeNanoseconds + browserOpenTimeoutNanoseconds
        var status: Int32 = 0
        while true {
            let waited = waitpid(openerPID, &status, WNOHANG)
            if waited == openerPID {
                openerReaped = true
                guard status == 0 else {
                    throw LauncherError.browserOpenFailed
                }
                writeTestEvidence(evidenceFD, ["event": "browser-open", "count": 1])
                return
            }
            if waited < 0 && errno != EINTR { throw SpawnError.system("wait_browser_opener", errno) }
            if DispatchTime.now().uptimeNanoseconds >= deadline {
                _ = kill(openerPID, SIGKILL)
                try? reap(openerPID)
                openerReaped = true
                throw LauncherError.browserOpenTimeout
            }
            usleep(2_000)
        }
    }

    private static func writeAll(_ fd: Int32, data: Data) throws {
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count > 0 { offset += count; continue }
                if count < 0 && errno == EINTR { continue }
                throw LauncherError.readinessProtocol
            }
        }
    }

    private static func readBoundedResponse(_ fd: Int32, deadline: UInt64) throws -> Data {
        var response = Data()
        var buffer = [UInt8](repeating: 0, count: ReadinessProtocol.maximumResponseBytes + 1)
        defer { _ = buffer.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw LauncherError.readinessTimeout }
            let remaining = min(UInt64(Int32.max), (deadline - now + 999_999) / 1_000_000)
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN | POLLHUP), revents: 0)
            let result = poll(&descriptor, 1, Int32(remaining))
            if result == 0 { throw LauncherError.readinessTimeout }
            if result < 0 { if errno == EINTR { continue }; throw LauncherError.readinessProtocol }
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count > 0 {
                response.append(contentsOf: buffer[0..<count])
                if response.count > ReadinessProtocol.maximumResponseBytes { throw LauncherError.readinessProtocol }
                continue
            }
            if count == 0 { return response }
            if errno != EINTR { throw LauncherError.readinessProtocol }
        }
    }

    private static func reap(_ pid: pid_t) throws {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 {
            if errno != EINTR { throw SpawnError.system("wait_supervisor", errno) }
        }
    }

    static func launchOuter(executable: URL, bundleRoot: URL) throws {
        var token = try ReadinessToken.generate()
        defer { token.resetBytes(in: 0..<token.count) }
        var lifetime = [Int32](repeating: -1, count: 2)
        var armed = [Int32](repeating: -1, count: 2)
        var readiness = [Int32](repeating: -1, count: 2)
        guard pipe(&lifetime) == 0 else { throw SpawnError.system("lifetime_pipe", errno) }
        guard pipe(&armed) == 0 else {
            close(lifetime[0]); close(lifetime[1]); throw SpawnError.system("armed_pipe", errno)
        }
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &readiness) == 0 else {
            lifetime.forEach { close($0) }; armed.forEach { close($0) }
            throw SpawnError.system("readiness_socketpair", errno)
        }
        defer {
            lifetime.forEach { if $0 >= 0 { close($0) } }
            armed.forEach { if $0 >= 0 { close($0) } }
            readiness.forEach { if $0 >= 0 { close($0) } }
        }
        var noSigPipe: Int32 = 1
        guard setsockopt(readiness[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe,
                         socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw SpawnError.system("readiness_nosigpipe", errno)
        }
        for fd in lifetime + armed + readiness {
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else {
                throw SpawnError.system("control_cloexec", errno)
            }
        }
        var inheritedLifetime = fcntl(lifetime[0], F_DUPFD_CLOEXEC, 10)
        var inheritedArmed = fcntl(armed[1], F_DUPFD_CLOEXEC, 10)
        var inheritedReadiness = fcntl(readiness[1], F_DUPFD_CLOEXEC, 10)
        defer {
            if inheritedLifetime >= 0 { close(inheritedLifetime) }
            if inheritedArmed >= 0 { close(inheritedArmed) }
            if inheritedReadiness >= 0 { close(inheritedReadiness) }
        }
        guard inheritedLifetime >= 0, inheritedArmed >= 0, inheritedReadiness >= 0 else {
            throw SpawnError.system("control_dup", errno)
        }

        var actions: posix_spawn_file_actions_t? = nil
        try checked(posix_spawn_file_actions_init(&actions), "supervisor_actions_init")
        defer { if actions != nil { posix_spawn_file_actions_destroy(&actions) } }
        for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
            try checked(posix_spawn_file_actions_adddup2(&actions, descriptor, descriptor), "supervisor_stdio_dup")
        }
        try checked(posix_spawn_file_actions_adddup2(&actions, inheritedLifetime, lifetimeFD), "supervisor_lifetime_dup")
        try checked(posix_spawn_file_actions_adddup2(&actions, inheritedArmed, armedFD), "supervisor_armed_dup")
        try checked(posix_spawn_file_actions_adddup2(&actions, inheritedReadiness, readinessFD), "supervisor_readiness_dup")
        #if DEBUG
        let evidenceFD = availableTestEvidenceFD(inheritedTestEvidenceFD)
        #else
        let evidenceFD: Int32? = nil
        #endif
        if let evidenceFD {
            try checked(posix_spawn_file_actions_adddup2(&actions, evidenceFD, testEvidenceFD), "supervisor_evidence_dup")
            try checked(posix_spawn_file_actions_addclose(&actions, evidenceFD), "supervisor_evidence_source_close")
        }
        for fd in [inheritedLifetime, inheritedArmed, inheritedReadiness] {
            try checked(posix_spawn_file_actions_addclose(&actions, fd), "supervisor_control_source_close")
        }
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
        var supervisorPID: pid_t = 0
        let code = withMutableCStringArray([executable.path, "--internal-supervisor"]) { argv in
            withMutableCStringArray(["LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8"]) { env in
                posix_spawn(&supervisorPID, executable.path, &actions, &attributes, argv, env)
            }
        }
        try checked(code, "spawn_supervisor")
        writeTestEvidence(evidenceFD, ["event": "internal-supervisor", "pid": Int(supervisorPID)])
        close(lifetime[0]); lifetime[0] = -1
        close(armed[1]); armed[1] = -1
        close(readiness[1]); readiness[1] = -1
        close(inheritedLifetime); inheritedLifetime = -1
        close(inheritedArmed); inheritedArmed = -1
        close(inheritedReadiness); inheritedReadiness = -1

        do {
            var challenge = ReadinessProtocol.challengeFrame(token: token)
            defer { challenge.resetBytes(in: 0..<challenge.count) }
            try writeAll(readiness[0], data: challenge)
            guard shutdown(readiness[0], SHUT_WR) == 0 else { throw LauncherError.readinessProtocol }
            let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
            var pidBytes = [UInt8](repeating: 0, count: 4)
            var pidOffset = 0
            while pidOffset < pidBytes.count {
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadline else { throw LauncherError.readinessTimeout }
                var descriptor = pollfd(fd: armed[0], events: Int16(POLLIN | POLLHUP), revents: 0)
                let remaining = Int32(min(UInt64(Int32.max), (deadline - now + 999_999) / 1_000_000))
                let polled = poll(&descriptor, 1, remaining)
                guard polled > 0 else { throw polled == 0 ? LauncherError.readinessTimeout : LauncherError.readinessProtocol }
                let count = pidBytes.withUnsafeMutableBytes { raw in
                    Darwin.read(armed[0], raw.baseAddress!.advanced(by: pidOffset), raw.count - pidOffset)
                }
                guard count > 0 else { throw LauncherError.readinessProtocol }
                pidOffset += count
            }
            let nodePID = pidBytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            var response = try readBoundedResponse(readiness[0], deadline: deadline)
            defer { response.resetBytes(in: 0..<response.count) }
            try ReadinessProtocol.validateReady(response, token: token, pid: pid_t(bitPattern: nodePID))
            guard kill(pid_t(bitPattern: nodePID), 0) == 0 || errno == EPERM else {
                throw LauncherError.readinessProtocol
            }
            try openBrowserBounded(executable: executable, evidenceFD: evidenceFD)
            guard kill(pid_t(bitPattern: nodePID), 0) == 0 || errno == EPERM else {
                throw LauncherError.readinessProtocol
            }
        } catch {
            close(lifetime[1]); lifetime[1] = -1
            try? reap(supervisorPID)
            throw error
        }
        try reap(supervisorPID)
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
            if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--internal-browser-opener" {
                try SupervisorMode.runBrowserOpener(executable: executable)
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
