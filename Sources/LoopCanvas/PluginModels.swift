import Foundation

// MARK: - 插件清单（与 plugins/README.md 的 plugin.json 规范 v1 对应）

struct PluginManifest: Codable, Equatable, Hashable {
    let schemaVersion: Int
    let id: String
    let name: String
    let kind: String
    let category: String
    let package: String
    let version: String
    let source: String
    let license: String?
    let author: String?
    let description: String
    let problem: String
    let audience: String
    let defaultEnabled: Bool
    let usage: String?
    let tags: [String]?
}

struct PluginEntry: Identifiable, Equatable, Hashable {
    let id: String
    let path: String
    let manifest: PluginManifest?
    let error: String?
    var enabled: Bool
    let isUser: Bool

    static func == (lhs: PluginEntry, rhs: PluginEntry) -> Bool {
        lhs.id == rhs.id && lhs.enabled == rhs.enabled && lhs.manifest == rhs.manifest
    }
}

struct LegacyCapabilityItem: Identifiable, Equatable {
    let id: String
    let name: String
    let path: String
    let detail: String
}

// MARK: - 插件目录

@MainActor
final class PluginCatalog: ObservableObject {
    @Published private(set) var entries: [PluginEntry] = []
    @Published private(set) var legacyItems: [LegacyCapabilityItem] = []

    private static let statesKey = "LoopCanvas.pluginStates.v1"
    private static let legacyMarker = "plugin.json"
    private static let legacyRoots: [URL] = [
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/plugins")
    ]

    static let categoryLabels: [String: String] = [
        "agent-preset": "官方 Agent 模式",
        "shell": "Shell 与命令",
        "filesystem": "文件与编辑",
        "retrieval": "检索与信息",
        "execution": "执行与控制",
        "delegation": "委派与协作",
        "planning": "计划与目标",
        "context": "上下文与压缩",
        "identity": "身份与指令",
        "presentation": "工具呈现",
        "framework": "框架与运行时"
    ]

    private var states: [String: Bool] {
        didSet { saveStates() }
    }

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.statesKey),
           let decoded = try? JSONDecoder().decode([String: Bool].self, from: data) {
            states = decoded
        } else {
            states = [:]
        }
        reload()
    }

    func reload() {
        var byID: [String: PluginEntry] = [:]
        for root in Self.bundledRoots {
            for entry in scanDirectory(root, isUser: false) where entry.manifest != nil {
                byID[entry.id] = entry
            }
        }
        for root in Self.userRoots {
            for entry in scanDirectory(root, isUser: true) where entry.manifest != nil {
                byID[entry.id] = entry
            }
        }
        entries = byID.values.sorted { $0.manifest?.name.localizedCompare($1.manifest?.name ?? "") == .orderedAscending }
        legacyItems = scanLegacy()
    }

    func setEnabled(_ id: String, _ enabled: Bool) {
        states[id] = enabled
        reload()
    }

    func enabled(_ id: String, defaultEnabled: Bool) -> Bool {
        states[id] ?? defaultEnabled
    }

    private var statesToSave: [String: Bool] { states }

    private func saveStates() {
        if let data = try? JSONEncoder().encode(statesToSave) {
            UserDefaults.standard.set(data, forKey: Self.statesKey)
        }
    }

    // 内置插件目录：优先应用包 Resources（打包版），其次仓库根目录（开发版 swift run）。
    private static var bundledRoots: [URL] {
        var roots: [URL] = []
        if let resources = Bundle.main.resourceURL {
            roots.append(resources.appendingPathComponent("plugins"))
        }
        let sourceURL = URL(fileURLWithPath: #filePath)
        let repoRoot = sourceURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        roots.append(repoRoot.appendingPathComponent("plugins"))
        return roots
    }

    private static var userRoots: [URL] {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return [support.appendingPathComponent("LoopCanvas/plugins")]
    }

    private func scanDirectory(_ root: URL, isUser: Bool) -> [PluginEntry] {
        let fm = FileManager.default
        guard let folders = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            return []
        }
        return folders.compactMap { folder in
            guard folder.hasDirectoryPath else { return nil }
            let manifestURL = folder.appendingPathComponent("plugin.json")
            guard fm.fileExists(atPath: manifestURL.path) else { return nil }
            do {
                let manifest = try Self.decodeManifest(at: manifestURL)
                let enabled = enabled(manifest.id, defaultEnabled: manifest.defaultEnabled)
                return PluginEntry(id: manifest.id, path: manifestURL.path, manifest: manifest, error: nil, enabled: enabled, isUser: isUser)
            } catch {
                return PluginEntry(id: folder.lastPathComponent, path: manifestURL.path, manifest: nil, error: error.localizedDescription, enabled: false, isUser: isUser)
            }
        }
    }

    private static func decodeManifest(at url: URL) throws -> PluginManifest {
        let data = try Data(contentsOf: url)
        let manifest = try JSONDecoder().decode(PluginManifest.self, from: data)
        guard manifest.schemaVersion == 1 else { throw PluginCatalogError.unsupportedVersion(manifest.schemaVersion) }
        let required: [(String, String)] = [
            ("id", manifest.id), ("name", manifest.name), ("kind", manifest.kind),
            ("category", manifest.category), ("package", manifest.package), ("version", manifest.version),
            ("source", manifest.source), ("description", manifest.description),
            ("problem", manifest.problem), ("audience", manifest.audience)
        ]
        for (key, value) in required where value.isEmpty {
            throw PluginCatalogError.missingField(key)
        }
        return manifest
    }

    private func scanLegacy() -> [LegacyCapabilityItem] {
        let fm = FileManager.default
        var found: [LegacyCapabilityItem] = []
        for root in Self.legacyRoots where fm.fileExists(atPath: root.path) {
            guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { continue }
            for case let url as URL in enumerator where url.lastPathComponent == Self.legacyMarker {
                let detail = (try? String(contentsOf: url, encoding: .utf8)) ?? "（无法读取内容）"
                let name = url.deletingLastPathComponent().lastPathComponent
                found.append(LegacyCapabilityItem(id: url.path, name: name, path: url.path, detail: detail))
                if found.count >= 200 { break }
            }
        }
        return found.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

enum PluginCatalogError: LocalizedError {
    case unsupportedVersion(Int)
    case missingField(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let version): "不支持的清单版本：\(version)。"
        case .missingField(let key): "清单缺少必填字段：\(key)。"
        }
    }
}
