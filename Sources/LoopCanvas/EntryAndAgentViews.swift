import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct IntakeView: View {
    @EnvironmentObject private var store: WorkflowStore
    @State private var requirement = ""
    @State private var attachments: [InputAttachment] = []
    @State private var isChoosingFile = false
    @State private var isShowingModelAPI = false

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            Circle().fill(AppTheme.accent.opacity(0.16)).frame(width: 560).blur(radius: 90).offset(x: -330, y: -260)
            Circle().fill(AppTheme.stale.opacity(0.10)).frame(width: 460).blur(radius: 100).offset(x: 430, y: 310)

            VStack(spacing: 28) {
                VStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 18).fill(AppTheme.accent.gradient)
                        Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 64, height: 64)
                    Text("你想完成什么？")
                        .font(.system(size: 38, weight: .bold, design: .rounded))
                    Text("先从一段自然语言开始。LoopCanvas 会先生成从需求到最终交付的完整计划，再让你逐步选择、执行和验收。")
                        .font(.title3)
                        .foregroundStyle(AppTheme.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 720)
                }

                VStack(spacing: 14) {
                    ComposerTextView(
                        text: $requirement,
                        placeholder: "描述目标、已有条件，以及你最在意的结果…",
                        onLongPaste: { value in
                            attachText(value, source: "自动识别长粘贴")
                            if requirement.isEmpty { requirement = "请按附件中的完整需求执行。" }
                        },
                        onImagePaste: { data, name in attach(data, name: name, source: "剪贴板图片") },
                        onSubmit: submit
                    )
                        .padding(14)
                        .frame(height: 150)
                        .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppTheme.line))

                    if !attachments.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 9) {
                                ForEach(attachments) { attachment in
                                    AttachmentChip(
                                        attachment: attachment,
                                        restore: { restore(attachment) },
                                        remove: {
                                            store.discardStagedAttachment(attachment)
                                            attachments.removeAll { $0.id == attachment.id }
                                        }
                                    )
                                }
                            }
                        }
                    }

                    HStack {
                        Label("DeepSeek Harness", systemImage: "bolt.horizontal.circle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppTheme.secondaryText)
                        Button { isShowingModelAPI = true } label: {
                            Image(systemName: "gearshape")
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .help("高级连接设置（dsh 路径、工作目录）")

                        Spacer()

                        Button { isChoosingFile = true } label: {
                            Label("附件", systemImage: "paperclip")
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        if !requirement.isEmpty {
                            Button("转为文本文件") {
                                attachText(requirement, source: "用户手动转换")
                                requirement = "请按附件中的完整需求执行。"
                            }
                            .buttonStyle(SecondaryButtonStyle())
                        }
                        Text("⌘ ↩ 开始")
                            .font(.caption.monospaced())
                            .foregroundStyle(AppTheme.tertiaryText)
                        Button("构建执行路线", action: submit)
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(requirement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
                    }
                }
                .frame(maxWidth: 820)

                HStack(spacing: 18) {
                    IntakeFeature(icon: "sidebar.left", title: "多个工作对话", detail: "在左侧快速切换工作上下文")
                    IntakeFeature(icon: "doc.text.magnifyingglass", title: "可信事实记录", detail: "只收录需求、审批与执行证据")
                    IntakeFeature(icon: "checkmark.shield", title: "验证基于证据", detail: "决策由你确认，验证由 Agent 实际运行")
                }
            }
            .padding(48)
        }
        .fileImporter(isPresented: $isChoosingFile, allowedContentTypes: [.image, .pdf, .text, .data], allowsMultipleSelection: true) { result in
            switch result {
            case let .success(urls):
                for url in urls {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    do {
                        attach(try Data(contentsOf: url), name: url.lastPathComponent, source: "文件选择器")
                    } catch {
                        store.transientMessage = "无法读取附件“\(url.lastPathComponent)”：\(error.localizedDescription)"
                    }
                }
            case let .failure(error):
                store.transientMessage = "选择附件失败：\(error.localizedDescription)"
            }
        }
        .sheet(isPresented: $isShowingModelAPI) {
            AgentConnectionConfigurationView()
                .environmentObject(store)
                .frame(minWidth: 700, minHeight: 620)
        }
        .onDrop(of: [.fileURL, .image], isTargeted: nil) { providers in
            var accepted = false
            for provider in providers {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    accepted = true
                    provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, error in
                        guard let data,
                              let raw = String(data: data, encoding: .utf8),
                              let url = URL(string: raw) else {
                            Task { @MainActor in store.transientMessage = "无法读取拖入的文件：\(error?.localizedDescription ?? "文件地址无效")" }
                            return
                        }
                        do {
                            let file = try Data(contentsOf: url)
                            Task { @MainActor in attach(file, name: url.lastPathComponent, source: "拖放") }
                        } catch {
                            Task { @MainActor in store.transientMessage = "无法读取拖入的文件：\(error.localizedDescription)" }
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    accepted = true
                    provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, error in
                        guard let data else {
                            Task { @MainActor in store.transientMessage = "无法读取拖入的图片：\(error?.localizedDescription ?? "图片数据为空")" }
                            return
                        }
                        Task { @MainActor in attach(data, name: "拖入图片-\(attachments.count + 1).png", source: "拖放图片") }
                    }
                }
            }
            return accepted
        }
    }

    private func submit() {
        let normalized = requirement.trimmingCharacters(in: .whitespacesAndNewlines)
        let goal = normalized.isEmpty && !attachments.isEmpty ? "请分析附件并完成其中描述的目标。" : requirement
        store.startPlanning(requirement: goal, attachments: attachments)
    }

    private func attachText(_ text: String, source: String) {
        guard let data = text.data(using: .utf8) else { return }
        attach(data, name: "粘贴文本-\(attachments.count + 1).txt", source: source)
    }

    private func attach(_ data: Data, name: String, source: String) {
        if let attachment = store.stageAttachment(
            data: data,
            suggestedName: name,
            source: source,
            existingAttachments: attachments
        ) {
            attachments.append(attachment)
        }
    }

    private func restore(_ attachment: InputAttachment) {
        guard let value = store.restoreText(from: attachment) else { return }
        requirement += (requirement.isEmpty ? "" : "\n") + value
        store.discardStagedAttachment(attachment)
        attachments.removeAll { $0.id == attachment.id }
    }
}

private struct AttachmentChip: View {
    let attachment: InputAttachment
    let restore: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: attachment.kind == .image ? "photo" : "doc.fill")
                .foregroundStyle(AppTheme.accentSoft)
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.name).font(.caption.weight(.semibold)).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file))
                    .font(.caption2).foregroundStyle(AppTheme.secondaryText)
            }
            if attachment.kind == .text { Button("在输入框展示", action: restore).font(.caption2) }
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .contentShape(Rectangle())
                .buttonStyle(.plain)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppTheme.line))
    }
}

private struct IntakeFeature: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(AppTheme.accentSoft)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.weight(.semibold))
                Text(detail).font(.caption2).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .padding(12)
        .background(AppTheme.panel.opacity(0.8), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct PlanBuildingView: View {
    @EnvironmentObject private var store: WorkflowStore
    @State private var animate = false
    @State private var isShowingModelAPI = false

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            VStack(spacing: 34) {
                ZStack {
                    ForEach(0..<3) { index in
                        Circle()
                            .stroke(AppTheme.accent.opacity(0.30 - Double(index) * 0.07), lineWidth: 1.5)
                            .frame(width: CGFloat(120 + index * 64), height: CGFloat(120 + index * 64))
                            .scaleEffect(animate ? 1.08 : 0.92)
                            .opacity(animate ? 0.35 : 1)
                            .animation(.easeInOut(duration: 1.2 + Double(index) * 0.18).repeatForever(autoreverses: true).delay(Double(index) * 0.12), value: animate)
                    }
                    RoundedRectangle(cornerRadius: 24)
                        .fill(AppTheme.accent.gradient)
                        .frame(width: 88, height: 88)
                        .rotationEffect(.degrees(animate ? 4 : -4))
                        .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: animate)
                    Image(systemName: "wand.and.stars.inverse")
                        .font(.system(size: 34, weight: .bold))
                        .foregroundStyle(.white)
                }

                VStack(spacing: 10) {
                    Text("等待\(store.transportDisplayName)返回完整计划")
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                    Text("请求已发送到\(store.transportDisplayName)；结构化回复返回后会自动导入。")
                        .foregroundStyle(AppTheme.secondaryText)
                }

                VStack(alignment: .leading, spacing: 12) {
                    BuildLine(icon: "checkmark.circle.fill", text: "创建共享上下文文档", complete: true)
                    BuildLine(icon: "tray.and.arrow.up", text: "发送\(store.transportDisplayName)请求", complete: store.pendingBridgeCount > 0)
                    BuildLine(icon: "arrow.down.doc", text: "等待端到端步骤图", complete: false)
                }
                .padding(18)
                .frame(width: 430)
                .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 15))
                .overlay(RoundedRectangle(cornerRadius: 15).stroke(AppTheme.line))

                Text(store.requirement)
                    .font(.callout)
                    .foregroundStyle(AppTheme.secondaryText)
                    .lineLimit(3)
                    .frame(maxWidth: 600)
                    .multilineTextAlignment(.center)

                if let error = store.bridgeError {
                    VStack(spacing: 10) {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(AppTheme.warning)
                        Button("检查传输配置") { isShowingModelAPI = true }
                            .buttonStyle(SecondaryButtonStyle())
                        if store.pendingBridgeCount > 0,
                           !store.hasAPIRequestInFlight,
                           !store.isPaused {
                            Button("重新发送待处理请求") { store.retryPendingAPIRequests() }
                                .buttonStyle(PrimaryButtonStyle())
                        }
                    }
                }
                if let status = store.modelAPIStatus, !store.modelAPIStatusIsError {
                    VStack(spacing: 10) {
                        Label(status, systemImage: "network")
                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                            .textSelection(.enabled)
                        if store.pendingBridgeCount > 0,
                           !store.hasAPIRequestInFlight,
                           !store.isPaused {
                            Button("重新发送请求") { store.retryPendingAPIRequests() }
                                .buttonStyle(PrimaryButtonStyle())
                        }
                    }
                }
                if !store.planValidationIssues.isEmpty {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(store.planValidationIssues, id: \.self) { issue in
                            Label(issue, systemImage: "xmark.octagon")
                                .font(.caption).foregroundStyle(AppTheme.warning)
                        }
                        Button("按校验结果重新生成") { store.retryPlanning() }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(store.pendingBridgeCount > 0)
                    }
                    .padding(14).frame(maxWidth: 600, alignment: .leading)
                    .background(AppTheme.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .sheet(isPresented: $isShowingModelAPI) {
            AgentConnectionConfigurationView()
                .environmentObject(store)
                .frame(minWidth: 700, minHeight: 620)
        }
        .onAppear { animate = true }
    }
}

private struct BuildLine: View {
    let icon: String
    let text: String
    let complete: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: complete ? icon : "circle.dotted")
                .foregroundStyle(complete ? AppTheme.success : AppTheme.accentSoft)
            Text(text).font(.callout)
            Spacer()
            if !complete { ProgressView().controlSize(.small) }
        }
    }
}

struct AgentConversationView: View {
    @EnvironmentObject private var store: WorkflowStore
    let agentID: UUID

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            if let agent = store.agent(agentID) {
                VStack(spacing: 0) {
                    HStack(spacing: 12) {
                        ZStack {
                            Circle().fill(agent.status == .complete ? AppTheme.success.opacity(0.18) : AppTheme.accent.opacity(0.18))
                            Image(systemName: agent.status.icon)
                                .foregroundStyle(agent.status == .complete ? AppTheme.success : AppTheme.accentSoft)
                        }
                        .frame(width: 40, height: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.name).font(.headline)
                            Text(agent.focus).font(.caption).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                        }
                        Spacer()
                        Text(store.isPaused ? "已暂停" : agent.status.displayTitle)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(store.isPaused ? AppTheme.warning : (agent.status == .complete ? AppTheme.success : AppTheme.accentSoft))
                    }
                    .padding(18)
                    .background(AppTheme.panel)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text("对话进度").font(.caption.weight(.semibold))
                                    Spacer()
                                    Text("\(Int(agent.progress * 100))%").font(.caption.monospacedDigit())
                                }
                                ProgressView(value: agent.progress).tint(AppTheme.accent)
                                Text("这个对话拥有独立视图；共享记录只接收原始需求、用户批准和可验证执行结果。")
                                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
                            }
                            .padding(15).background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 12))

                            VStack(alignment: .leading, spacing: 10) {
                                Text("对话工作记录").font(.headline)
                                ForEach(Array(agent.notes.enumerated()), id: \.offset) { _, item in
                                    Label(item, systemImage: "text.bubble")
                                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                                }
                            }

                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text("共享上下文最新内容").font(.headline)
                                    Spacer()
                                    Text("\(store.sharedContext.count) 条").font(.caption).foregroundStyle(AppTheme.secondaryText)
                                }
                                ForEach(store.sharedContext.prefix(6)) { entry in
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(entry.author).font(.caption.weight(.semibold)).foregroundStyle(AppTheme.accentSoft)
                                        Text(entry.content).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 9))
                                }
                            }
                        }
                        .padding(18)
                    }
                }
            } else {
                ContentUnavailableView("Agent 不存在", systemImage: "questionmark.folder")
            }
        }
        .frame(minWidth: 520, minHeight: 560)
    }
}

struct SharedContextWindow: View {
    @EnvironmentObject private var store: WorkflowStore

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("事实与决策记录").font(.title2.bold())
                        Text("仅由原始需求、用户操作和执行证据自动生成 · \(store.sharedContext.count) 条记录")
                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer()
                    Label("实时同步", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.semibold)).foregroundStyle(AppTheme.success)
                }
                Divider().overlay(AppTheme.line)
                ScrollView {
                    Text(store.sharedContextMarkdown)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(22)
        }
    }
}

struct HandoffTextDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, let string = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        text = string
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

struct HandoffSheet: View {
    @EnvironmentObject private var store: WorkflowStore
    let draft: HandoffDraft
    @State private var exporting = false
    @State private var copied = false
    @State private var selectedVersion: HandoffVersion = .model

    private enum HandoffVersion: String, CaseIterable, Identifiable {
        case model = "模型高密度交接"
        case human = "人类技术报告"

        var id: String { rawValue }
    }

    private var selectedDocument: HandoffDocument {
        switch selectedVersion {
        case .model: draft.modelDocument
        case .human: draft.technicalReport
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "doc.badge.clock").font(.title2).foregroundStyle(AppTheme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("工作流已暂停").font(.headline)
                    Text("两份交接文档已生成在内存中，尚未写入电脑。")
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                Button("关闭") { store.dismissHandoff() }
            }
            .padding(18).background(AppTheme.panel)

            VStack(alignment: .leading, spacing: 12) {
                Picker("交接版本", selection: $selectedVersion) {
                    ForEach(HandoffVersion.allCases) { version in
                        Text(version.rawValue).tag(version)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: selectedVersion) { _, _ in copied = false }

                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedDocument.title).font(.callout.weight(.semibold))
                        Text(selectedDocument.audience)
                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                            .lineLimit(2)
                        Text("\(selectedDocument.filename) · 内存 Markdown · \(selectedDocument.content.utf8.count) bytes")
                            .font(.caption).foregroundStyle(AppTheme.tertiaryText)
                    }
                    Spacer()
                    Button(copied ? "已复制" : "复制文本") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(selectedDocument.content, forType: .string)
                        copied = true
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    Button("另存为…") { exporting = true }
                        .buttonStyle(PrimaryButtonStyle())
                }
                ScrollView {
                    Text(selectedDocument.content)
                        .font(selectedVersion == .model ? .system(.caption, design: .monospaced) : .system(.body, design: .default))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
                .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            .padding(18)
        }
        .frame(width: 900, height: 700)
        .background(AppTheme.canvas)
        .fileExporter(
            isPresented: $exporting,
            document: HandoffTextDocument(text: selectedDocument.content),
            contentType: .plainText,
            defaultFilename: selectedDocument.filename
        ) { _ in }
    }
}
