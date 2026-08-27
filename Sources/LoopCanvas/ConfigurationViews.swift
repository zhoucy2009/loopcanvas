import AppKit
import SwiftUI

struct ConfigurationWindow: View {
    @EnvironmentObject private var store: WorkflowStore
    let surface: ConfigurationSurface

    var body: some View {
        switch surface {
        case .modelAPI: AgentConnectionConfigurationView()
        case .agents: AgentsDocumentView()
        case .skills: CapabilityBrowser(title: "Skills", roots: skillRoots, marker: "SKILL.md")
        case .plugins: PluginCatalogView()
        }
    }

    private var skillRoots: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [URL(fileURLWithPath: store.workspaceRootPath).appendingPathComponent(".agents/skills"), home.appendingPathComponent(".agents/skills"), home.appendingPathComponent(".codex/skills")]
    }
}

struct AgentConnectionConfigurationView: View {
    @EnvironmentObject private var store: WorkflowStore
    @State private var mode: ModelTransportMode = .deepSeekHarness
    @State private var harnessExecutable = ""
    @State private var harnessWorkingDirectory = ""
    @State private var harnessModel = ModelAPISettings.defaultModel
    @State private var harnessReasoningEffort = ModelAPISettings.defaultReasoningEffort
    @State private var installationStatus = DeepSeekHarnessTransport.InstallationStatus(
        nodeExecutablePath: nil,
        dshExecutablePath: nil
    )
    @State private var installationMessage = ""
    @State private var codexExecutable = ""
    @State private var codexWorkingDirectory = ""
    @State private var codexModel = ""
    @State private var codexInstallationStatus = CodexAppServerTransport.InstallationStatus(
        codexExecutablePath: nil
    )

    private let dshWebCommand = "npx @deepseek-ai/dsh web"
    private let nodeDownloadURL = URL(string: "https://nodejs.org/zh-cn/download")!

    private var draft: ModelAPISettings {
        ModelAPISettings(
            mode: mode,
            harnessExecutable: harnessExecutable,
            harnessWorkingDirectory: harnessWorkingDirectory,
            harnessModel: harnessModel,
            harnessReasoningEffort: harnessReasoningEffort,
            codexExecutable: codexExecutable,
            codexWorkingDirectory: codexWorkingDirectory,
            codexModel: codexModel
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Agent 连接").font(.title.bold())
                    Text("DeepSeek Harness 保持为成熟默认通道；Codex App Server 可作为本地实验通道单独启用。")
                        .font(.body).foregroundStyle(AppTheme.secondaryText)
                }

                VStack(alignment: .leading, spacing: 7) {
                    Text("当前执行引擎")
                        .font(.callout.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                    Picker("当前执行引擎", selection: $mode) {
                        Text("DeepSeek Harness").tag(ModelTransportMode.deepSeekHarness)
                        Text("Codex App Server").tag(ModelTransportMode.codexAppServer)
                    }
                    .pickerStyle(.segmented)
                    Text(mode == .deepSeekHarness
                         ? "成熟默认通道；使用现有 dsh headless 系统。"
                         : "实验通道；仅使用本机 stdio，不开放远程端口。")
                        .font(.caption).foregroundStyle(AppTheme.tertiaryText)
                }

                if mode == .deepSeekHarness {
                    VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("DeepSeek Harness 连接", systemImage: "bolt.horizontal.circle")
                            .font(.headline)
                        Text("规划与每一步执行都会交给本机 `dsh --profile headless`。工作目录默认为已有产物目录或 LoopCanvas 文档目录下的 Deliverables，可在此覆盖。")
                            .font(.callout).foregroundStyle(AppTheme.secondaryText)
                    }

                    installationGuide

                    field("dsh 可执行文件（留空自动检测）", text: $harnessExecutable, prompt: "/完整路径/dsh")
                    field("预期工作目录（留空使用默认）", text: $harnessWorkingDirectory, prompt: "/明确的项目目录")

                    VStack(alignment: .leading, spacing: 7) {
                        Text("模型")
                            .font(.callout.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        Picker("模型", selection: $harnessModel) {
                            ForEach(ModelAPISettings.modelOptions, id: \.self) { option in
                                Text(ModelAPISettings.modelTitle(option)).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    VStack(alignment: .leading, spacing: 7) {
                        Text("推理强度（仅影响 LoopCanvas 的 headless 执行，不改网页会话）")
                            .font(.callout.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        Picker("推理强度", selection: $harnessReasoningEffort) {
                            ForEach(ModelAPISettings.reasoningEffortOptions, id: \.self) { option in
                                Text(ModelAPISettings.reasoningEffortTitle(option)).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                        Text("按 DeepSeek 官方档位：off / high / max；Flash 与 Pro 均支持这三档。")
                            .font(.caption).foregroundStyle(AppTheme.tertiaryText)
                    }

                    Button {
                        refreshInstallationStatus()
                        Task { await store.testDeepSeekHarness(draft) }
                    } label: {
                        if store.isTestingModelAPI {
                            ProgressView().controlSize(.small)
                            Text("检测中")
                        } else {
                            Label("检测本机 Harness", systemImage: "bolt.horizontal.circle")
                        }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(store.isTestingModelAPI)
                    }
                    .padding(18)
                    .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.line))
                } else {
                    codexConnectionCard
                }

                HStack(spacing: 10) {
                    Button("保存 Agent 连接") { store.saveModelAPISettings(draft) }
                        .buttonStyle(PrimaryButtonStyle())
                    Spacer()
                }

                if let status = store.modelAPIStatus {
                    Label(status, systemImage: store.modelAPIStatusIsError ? "exclamationmark.triangle" : "checkmark.circle")
                        .font(.callout)
                        .foregroundStyle(store.modelAPIStatusIsError ? AppTheme.warning : AppTheme.success)
                        .textSelection(.enabled)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("连接约定").font(.headline)
                    Text(mode == .deepSeekHarness
                         ? "• DeepSeek Harness 保持原有 headless 执行链路。\n• 每一步仍由你验收；解析失败时只保存脱敏诊断。"
                         : "• Codex 使用本地 stdio App Server，不开放 WebSocket 端口。\n• 固定 workspace-write、禁用网络且不自动批准越权操作。\n• Codex 失败时请求会保留，可切回 DeepSeek Harness 重试。")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(AppTheme.canvas)
        .onAppear(perform: load)
    }

    @ViewBuilder
    private var codexConnectionCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Codex App Server 连接", systemImage: "chevron.left.forwardslash.chevron.right")
                    .font(.headline)
                Text("LoopCanvas 启动短生命周期的本地 `codex app-server`，通过 stdio JSONL 执行当前请求。留空时优先从 PATH 查找，再检测 ChatGPT 内置 Codex。")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
            }

            if codexInstallationStatus.isReady,
               let path = codexInstallationStatus.codexExecutablePath {
                Label("本机 Codex 已检测到", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.success)
                Text(path)
                    .font(.caption.monospaced())
                    .foregroundStyle(AppTheme.secondaryText)
                    .textSelection(.enabled)
            } else {
                Label("尚未检测到 Codex", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.warning)
            }

            field("codex 可执行文件（留空自动检测）", text: $codexExecutable, prompt: "/完整路径/codex")
            field("预期工作目录（留空使用默认）", text: $codexWorkingDirectory, prompt: "/明确的项目目录")
            field("模型（留空沿用 Codex 当前配置）", text: $codexModel, prompt: "例如 gpt-5.6-terra")

            Text("LoopCanvas 不读取或保存 Codex token；登录与凭据由本机 Codex 自身管理。能力检测只运行 `--version` 与 `app-server --help`，不会提交模型任务。")
                .font(.caption).foregroundStyle(AppTheme.secondaryText)

            HStack(spacing: 10) {
                Button {
                    refreshCodexInstallationStatus()
                    Task { await store.testCodexAppServer(draft) }
                } label: {
                    if store.isTestingModelAPI {
                        ProgressView().controlSize(.small)
                        Text("检测中")
                    } else {
                        Label("检测本机 Codex", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(store.isTestingModelAPI)

                Button("重新检测") { refreshCodexInstallationStatus() }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(18)
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.line))
    }

    @ViewBuilder
    private var installationGuide: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !installationStatus.hasNode {
                Label("尚未检测到 Node.js", systemImage: "1.circle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.warning)
                Text("先从 Node.js 官方中文页安装 LTS 版本。安装完成后回到这里重新检测。")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
                Button("打开 Node.js 官方下载页") {
                    NSWorkspace.shared.open(nodeDownloadURL)
                }
                .buttonStyle(SecondaryButtonStyle())
            } else if !installationStatus.hasDsh {
                Label("已检测到 Node.js，下一步启动 DeepSeek Harness", systemImage: "2.circle")
                    .font(.subheadline.weight(.semibold))
                Text(dshWebCommand)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
                Text("按钮只复制命令并打开终端；请由你自己粘贴、回车并在 dsh 页面中配置账户。")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
                HStack(spacing: 10) {
                    Button("复制命令并打开终端") { copyCommandAndOpenTerminal() }
                        .buttonStyle(PrimaryButtonStyle())
                    Button("重新检测") { refreshInstallationStatus() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            } else {
                Label("本机 DeepSeek Harness 已就绪", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.success)
                if let nodePath = installationStatus.nodeExecutablePath,
                   let dshPath = installationStatus.dshExecutablePath {
                    Text("Node.js：\(nodePath)\ndsh：\(dshPath)")
                        .font(.caption.monospaced())
                        .foregroundStyle(AppTheme.secondaryText)
                        .textSelection(.enabled)
                }
                Button("重新检测") { refreshInstallationStatus() }
                    .buttonStyle(SecondaryButtonStyle())
            }

            Text("API Key 只在 dsh 中配置和保存；LoopCanvas 不要求、读取或保存 API Key。")
                .font(.caption.weight(.medium))
                .foregroundStyle(AppTheme.secondaryText)

            if !installationMessage.isEmpty {
                Text(installationMessage)
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
        }
        .padding(12)
        .background(AppTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.line))
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.callout.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
            TextField(prompt, text: text).textFieldStyle(.roundedBorder)
        }
    }

    private func load() {
        let settings = store.modelAPISettings
        mode = settings.mode
        harnessExecutable = settings.harnessExecutable
        harnessWorkingDirectory = settings.harnessWorkingDirectory
        harnessModel = settings.harnessModel
        harnessReasoningEffort = settings.harnessReasoningEffort
        codexExecutable = settings.codexExecutable
        codexWorkingDirectory = settings.codexWorkingDirectory
        codexModel = settings.codexModel
        refreshInstallationStatus()
        refreshCodexInstallationStatus()
    }

    private func refreshInstallationStatus() {
        installationStatus = DeepSeekHarnessTransport.installationStatus(settings: draft)
        installationMessage = installationStatus.isReady
            ? "检测完成，可以继续验证 Harness 版本或保存连接。"
            : ""
    }

    private func refreshCodexInstallationStatus() {
        codexInstallationStatus = CodexAppServerTransport.installationStatus(settings: draft)
    }

    private func copyCommandAndOpenTerminal() {
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(dshWebCommand, forType: .string) else {
            installationMessage = "未能写入剪贴板，请手动复制上方命令。"
            return
        }

        let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        guard FileManager.default.fileExists(atPath: terminalURL.path) else {
            installationMessage = "命令已复制，但未找到系统终端；请手动打开终端并粘贴。"
            return
        }
        NSWorkspace.shared.openApplication(
            at: terminalURL,
            configuration: NSWorkspace.OpenConfiguration(),
            completionHandler: nil
        )
        installationMessage = "命令已复制，并已请求打开终端；请粘贴后按回车。"
    }
}

private struct AgentsDocumentView: View {
    @EnvironmentObject private var store: WorkflowStore
    @State private var fileURL: URL?
    @State private var text = ""
    @State private var original = ""
    @State private var message = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("AGENTS.md").font(.title2.bold())
                    Text(fileURL?.path ?? "项目目录下尚未创建 AGENTS.md")
                        .font(.caption.monospaced()).foregroundStyle(AppTheme.secondaryText).textSelection(.enabled)
                }
                Spacer()
                if text != original { Label("有未保存修改", systemImage: "circle.fill").font(.caption).foregroundStyle(AppTheme.warning) }
                Button("重新载入", action: load).buttonStyle(SecondaryButtonStyle())
                Button("保存") { save() }.buttonStyle(PrimaryButtonStyle()).disabled(fileURL == nil || text == original)
            }
            Text("每个项目一份 AGENTS.md。其中的「## 项目宪法」章节会作为最高优先级约束随每次请求下发给 Agent；缺失时使用内置默认宪法。")
                .font(.callout).foregroundStyle(AppTheme.secondaryText)
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden).padding(12)
                .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.line))
            if !message.isEmpty { Text(message).font(.caption).foregroundStyle(AppTheme.secondaryText) }
        }
        .padding(22).background(AppTheme.canvas).onAppear(perform: load)
    }

    private func load() {
        let url = store.projectAGENTSURL
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            do {
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                let template = "# 项目规则\n\n## 项目宪法\n\n\(AgentFileStore.projectConstitution)\n"
                try template.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                message = "创建项目 AGENTS.md 失败：\(error.localizedDescription)"
                return
            }
        }
        fileURL = url
        text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        original = text
        message = "已从项目目录读取。"
    }

    private func save() {
        guard let fileURL else { return }
        do {
            try text.write(to: fileURL, atomically: true, encoding: .utf8)
            original = text
            message = "已保存到 \(fileURL.path)"
        } catch { message = "保存失败：\(error.localizedDescription)" }
    }
}

private struct PluginCatalogView: View {
    @StateObject private var catalog = PluginCatalog()
    @State private var selection: String?

    private var groups: [(key: String, items: [PluginEntry])] {
        var grouped: [String: [PluginEntry]] = [:]
        var order: [String] = []
        for entry in catalog.entries {
            guard let manifest = entry.manifest else { continue }
            if grouped[manifest.category] == nil { order.append(manifest.category) }
            grouped[manifest.category, default: []].append(entry)
        }
        return order.compactMap { key in
            guard let items = grouped[key] else { return nil }
            return (key, items.sorted { ($0.manifest?.name ?? "").localizedCompare($1.manifest?.name ?? "") == .orderedAscending })
        }
    }

    private var selectedEntry: PluginEntry? {
        catalog.entries.first { $0.id == selection }
    }

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 8) {
                Text("插件").font(.title2.bold()).padding(.horizontal, 14).padding(.top, 16)
                Text("内置 DeepSeek Harness 官方插件目录；启用状态只保存在本机，实际加载由 dsh 决定。")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText).padding(.horizontal, 14)
                List(selection: $selection) {
                    ForEach(groups, id: \.key) { group in
                        Section(header: Text(PluginCatalog.categoryLabels[group.key] ?? group.key)) {
                            ForEach(group.items) { entry in
                                LabeledContent {
                                    Text(entry.enabled ? "已启用" : "已停用")
                                        .font(.caption2)
                                        .foregroundStyle(entry.enabled ? AppTheme.success : AppTheme.tertiaryText)
                                } label: {
                                    Text(entry.manifest?.name ?? entry.id)
                                        .font(.callout.weight(.semibold))
                                }
                                .tag(entry.id)
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                if !catalog.legacyItems.isEmpty {
                    Divider().padding(.horizontal, 14)
                    DisclosureGroup("本机 Codex 插件（\(catalog.legacyItems.count)，只读）") {
                        ForEach(catalog.legacyItems) { item in
                            Text(item.name).font(.caption).foregroundStyle(AppTheme.secondaryText).textSelection(.enabled)
                        }
                    }
                    .font(.caption)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                }
            }
            .frame(minWidth: 260, idealWidth: 320)
            .background(AppTheme.panel)

            ScrollView {
                if let entry = selectedEntry, let manifest = entry.manifest {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .firstTextBaseline, spacing: 14) {
                            Text(manifest.name).font(.title2.bold())
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { catalog.enabled(manifest.id, defaultEnabled: manifest.defaultEnabled) },
                                set: { catalog.setEnabled(manifest.id, $0) }
                            ))
                            .toggleStyle(.switch).labelsHidden()
                            Text(catalog.enabled(manifest.id, defaultEnabled: manifest.defaultEnabled) ? "已启用" : "已停用")
                                .font(.caption)
                                .foregroundStyle(catalog.enabled(manifest.id, defaultEnabled: manifest.defaultEnabled) ? AppTheme.success : AppTheme.tertiaryText)
                        }
                        Text("\(manifest.package) · v\(manifest.version)\(entry.isUser ? " · 用户自定义" : "")")
                            .font(.caption.monospaced()).foregroundStyle(AppTheme.secondaryText)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("简介 · 这个插件在干什么").font(.headline)
                            Text(manifest.description).font(.callout)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("解决什么问题").font(.headline)
                            Text(manifest.problem).font(.callout).foregroundStyle(AppTheme.secondaryText)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("推荐使用人群").font(.headline)
                            Text(manifest.audience).font(.callout).foregroundStyle(AppTheme.secondaryText)
                        }
                        if let usage = manifest.usage {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("在哪里生效").font(.headline)
                                Text(usage).font(.callout).foregroundStyle(AppTheme.secondaryText)
                            }
                        }
                        Text("来源：\(manifest.source)\(manifest.license.map { " · \($0)" } ?? "")\(manifest.defaultEnabled ? " · 官方默认启用" : " · 官方默认关闭")")
                            .font(.caption).foregroundStyle(AppTheme.tertiaryText)
                        Text(entry.path).font(.caption2.monospaced()).foregroundStyle(AppTheme.tertiaryText).textSelection(.enabled)
                        Spacer(minLength: 40)
                    }
                    .padding(22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ContentUnavailableView("选择一个插件", systemImage: "puzzlepiece.extension")
                        .frame(maxWidth: .infinity, minHeight: 520)
                }
            }
            .background(AppTheme.canvas)
        }
        .onAppear(perform: catalog.reload)
    }
}

private struct CapabilityItem: Identifiable {
    let id: String
    let name: String
    let path: String
    let detail: String
}

private struct CapabilityBrowser: View {
    let title: String
    let roots: [URL]
    let marker: String
    @State private var items: [CapabilityItem] = []
    @State private var selection: CapabilityItem?

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.title2.bold()).padding(.horizontal, 14).padding(.top, 16)
                Text("能力层 · 只读浏览")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText).padding(.horizontal, 14)
                List(items, selection: $selection) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name).font(.callout.weight(.semibold))
                        Text(item.path).font(.caption2.monospaced()).foregroundStyle(AppTheme.tertiaryText).lineLimit(1)
                    }.tag(item)
                }.scrollContentBackground(.hidden)
            }.frame(minWidth: 240, idealWidth: 300).background(AppTheme.panel)
            ScrollView {
                if let selection {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(selection.name).font(.title2.bold())
                        Text(selection.path).font(.caption.monospaced()).foregroundStyle(AppTheme.secondaryText).textSelection(.enabled)
                        Text(selection.detail).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ContentUnavailableView("选择一个\(title)", systemImage: title == "Skills" ? "wand.and.stars" : "puzzlepiece.extension")
                        .frame(maxWidth: .infinity, minHeight: 500)
                }
            }.background(AppTheme.canvas)
        }.onAppear(perform: scan)
    }

    private func scan() {
        let fm = FileManager.default
        var found: [CapabilityItem] = []
        for root in roots where fm.fileExists(atPath: root.path) {
            guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { continue }
            for case let url as URL in enumerator where url.lastPathComponent == marker {
                let detail = (try? String(contentsOf: url, encoding: .utf8)) ?? "（无法读取内容）"
                let name = url.deletingLastPathComponent().lastPathComponent
                found.append(CapabilityItem(id: url.path, name: name, path: url.path, detail: detail))
                if found.count >= 200 { break }
            }
        }
        items = found.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

extension CapabilityItem: Hashable {
    static func == (lhs: CapabilityItem, rhs: CapabilityItem) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
