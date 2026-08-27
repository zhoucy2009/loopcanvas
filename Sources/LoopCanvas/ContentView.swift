import SwiftUI
import WebKit

struct ContentView: View {
    @EnvironmentObject private var store: WorkflowStore
    @State private var showingResetConfirmation = false

    var body: some View {
        Group {
            if let configuration = store.selectedConfiguration {
                ConfigurationWindow(surface: configuration)
            } else if store.isShowingDeliverable {
                DeliverableWindow()
            } else if store.isShowingSharedContext {
                SharedContextWindow()
            } else if let conversationID = store.selectedConversationID {
                AgentConversationView(agentID: conversationID)
            } else {
                VStack(spacing: 0) {
                    HeaderView(showingResetConfirmation: $showingResetConfirmation)
                    Divider().overlay(AppTheme.line)

                    ScrollView {
                        VStack(spacing: 18) {
                            GoalOverview()
                            PlanningAgentsBanner()
                            PlanRail()

                            HStack(alignment: .top, spacing: 18) {
                                StepInspector()
                                    .frame(maxWidth: .infinity, alignment: .top)
                                DecisionLedger()
                                    .frame(width: 310)
                            }
                        }
                        .padding(24)
                    }
                }
            }
        }
        .confirmationDialog("开始一个新需求？", isPresented: $showingResetConfirmation) {
            Button("返回需求输入", role: .destructive) { store.resetToIntake() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("当前状态会先自动保存为检查点，再返回需求输入；之后可从侧栏恢复。")
        }
    }
}

private struct HeaderView: View {
    @EnvironmentObject private var store: WorkflowStore
    @Binding var showingResetConfirmation: Bool

    var body: some View {
        HStack(spacing: 16) {
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(AppTheme.accent.gradient)
                    Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 1) {
                    Text("LoopCanvas")
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                    Text("人类门控的可视化执行图")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
            }

            Spacer()

            StatusPill(
                text: store.isPaused ? "已暂停" : "本地多对话",
                icon: store.isPaused ? "pause.fill" : "lock.shield",
                color: store.isPaused ? AppTheme.warning : AppTheme.success
            )

            if !store.isPaused,
               store.pendingBridgeCount > 0,
               !store.hasAPIRequestInFlight {
                Button {
                    store.retryPendingAPIRequests()
                } label: {
                    Label("重新发送待处理", systemImage: "arrow.clockwise")
                }
                .buttonStyle(SecondaryButtonStyle())
            }

            Button {
                store.togglePause()
            } label: {
                Label(store.isPaused ? "继续任务" : "暂停任务并交接", systemImage: store.isPaused ? "play.fill" : "pause.fill")
            }
            .buttonStyle(SecondaryButtonStyle())

            Menu {
                Button("开始新需求", role: .destructive) {
                    showingResetConfirmation = true
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
                    .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(AppTheme.line))
            }
            .menuStyle(.borderlessButton)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
        .background(AppTheme.panel.opacity(0.92))
    }
}

private struct GoalOverview: View {
    @EnvironmentObject private var store: WorkflowStore

    var body: some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("当前目标")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.accentSoft)
                        .textCase(.uppercase)
                    Text("·")
                        .foregroundStyle(AppTheme.tertiaryText)
                    Text("目标不会因局部返工而丢失")
                        .font(.caption)
                        .foregroundStyle(AppTheme.tertiaryText)
                }
                Text(store.requirement)
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                Text("完整计划会在执行前一次生成；每个制作步骤都会更新演示产物，最终交付必须有可查看的成品。")
                    .font(.callout)
                    .foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 24)

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("总体进度")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.secondaryText)
                    Spacer()
                    Text("\(store.approvedCount) / \(store.steps.count) 已确认")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(AppTheme.primaryText)
                }
                ProgressView(value: store.progress)
                    .tint(AppTheme.accent)
                Text(store.currentStepTitle)
                    .font(.caption)
                    .foregroundStyle(store.isPaused ? AppTheme.warning : AppTheme.tertiaryText)
            }
            .frame(width: 270)
        }
        .padding(22)
        .background(CardBackground(highlighted: false))
    }
}

private struct PlanningAgentsBanner: View {
    @EnvironmentObject private var store: WorkflowStore

    var body: some View {
        if !store.agentSessions.isEmpty {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(store.hasCompletePlan ? AppTheme.success.opacity(0.14) : (store.activeAgentCount > 0 ? AppTheme.accent.opacity(0.16) : AppTheme.warning.opacity(0.14)))
                    Image(systemName: store.hasCompletePlan ? "checkmark" : (store.activeAgentCount > 0 ? "brain.head.profile" : "exclamationmark"))
                        .foregroundStyle(store.hasCompletePlan ? AppTheme.success : (store.activeAgentCount > 0 ? AppTheme.accentSoft : AppTheme.warning))
                }
                .frame(width: 38, height: 38)
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.hasCompletePlan ? "完整计划已生成" : (store.activeAgentCount > 0 ? "正在生成从需求到交付的完整计划" : "计划尚未通过完整性校验"))
                        .font(.callout.weight(.semibold))
                    Text("已生成 \(store.steps.count) 个步骤 · \(store.pendingBridgeCount) 个 \(store.transportDisplayName) 请求等待回复")
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                if !store.hasCompletePlan && store.pendingBridgeCount == 0 {
                    Button("重新生成") { store.retryPlanning() }
                        .buttonStyle(PrimaryButtonStyle())
                }
                ProgressView(value: store.planningProgress)
                    .tint(AppTheme.accent).frame(width: 150)
                ForEach(store.agentSessions) { agent in
                    Button(agent.name.replacingOccurrences(of: " Agent", with: "")) {
                        store.showAgentConversation(agent.id)
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
            }
            .padding(14)
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(AppTheme.line))
        }
    }
}

struct ConversationSidebar: View {
    @EnvironmentObject private var store: WorkflowStore
    @AppStorage("LoopCanvas.sidebarCollapsed") private var sidebarCollapsed = false
    @State private var projectPendingDeletion: ProjectSummary?
    @State private var renamingProject: ProjectSummary?
    @State private var renameText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9).fill(AppTheme.accent.gradient)
                    Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text("LoopCanvas").font(.callout.weight(.bold))
                    Text("共享任务上下文").font(.caption2).foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                Button {
                    sidebarCollapsed = true
                } label: {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("折叠侧栏")
            }
            .padding(.horizontal, 16).padding(.vertical, 16)

            // 项目列表
            HStack(spacing: 8) {
                Text("项目")
                    .font(.caption2.weight(.bold)).foregroundStyle(AppTheme.tertiaryText)
                    .textCase(.uppercase)
                Spacer()
                Button { store.createProject() } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("新建项目")
            }
            .padding(.horizontal, 16).padding(.bottom, 6)

            ForEach(store.projects) { project in
                Button { store.switchProject(project.id) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: store.currentProjectIDValue == project.id ? "folder.fill" : "folder")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(store.currentProjectIDValue == project.id ? AppTheme.accentSoft : AppTheme.secondaryText)
                        Text(project.name)
                            .font(.caption.weight(store.currentProjectIDValue == project.id ? .semibold : .regular))
                            .foregroundStyle(AppTheme.primaryText)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .background(
                        store.currentProjectIDValue == project.id ? AppTheme.accent.opacity(0.15) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("重命名") {
                        renamingProject = project
                        renameText = project.name
                    }
                    Button("归档项目", role: .destructive) {
                        projectPendingDeletion = project
                    }
                }
            }

            HStack(spacing: 10) {
                Button("创建检查点") { store.createCheckpoint() }
                    .buttonStyle(.plain)
                if store.currentCheckpointCount > 0 {
                    Button("恢复检查点") { store.restoreLatestCheckpoint() }
                        .buttonStyle(.plain)
                }
                if store.archivedProjectCount > 0 {
                    Button("恢复归档") { store.restoreMostRecentlyArchivedProject() }
                        .buttonStyle(.plain)
                }
            }
            .font(.caption2)
            .foregroundStyle(AppTheme.secondaryText)
            .padding(.horizontal, 16)
            .padding(.top, 4)

            Divider().overlay(AppTheme.line).padding(.vertical, 8)

            Button { store.showMainLoop() } label: {
                SidebarConversationRow(
                    icon: "point.3.connected.trianglepath.dotted",
                    title: "主 Loop",
                    subtitle: "选择、执行与验收",
                    color: AppTheme.accentSoft,
                    isSelected: store.selectedConversationID == nil && !store.isShowingSharedContext && !store.isShowingDeliverable && store.selectedConfiguration == nil,
                    isActive: !store.isPaused
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .buttonStyle(.plain)

            Button { store.showDeliverable() } label: {
                SidebarConversationRow(
                    icon: "play.rectangle.fill",
                    title: "演示窗口",
                    subtitle: store.currentArtifact == nil ? "尚未生成产物" : (store.isDeliverableReady ? "成品可交付" : "查看当前版本"),
                    color: store.currentArtifact == nil ? AppTheme.tertiaryText : AppTheme.success,
                    isSelected: store.isShowingDeliverable,
                    isActive: store.currentArtifact != nil && !store.isDeliverableReady
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .buttonStyle(.plain)

            Text("规划对话")
                .font(.caption2.weight(.bold)).foregroundStyle(AppTheme.tertiaryText)
                .textCase(.uppercase).padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 7)

            ForEach(store.agentSessions) { agent in
                Button { store.showAgentConversation(agent.id) } label: {
                    SidebarConversationRow(
                        icon: agent.status.icon,
                        title: agent.name,
                        subtitle: agent.status.displayTitle,
                        color: agent.status == .complete ? AppTheme.success : AppTheme.accentSoft,
                        isSelected: store.selectedConversationID == agent.id && !store.isShowingSharedContext,
                        isActive: agent.status.isActive && !store.isPaused
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .buttonStyle(.plain)
            }

            Text("步骤对话")
                .font(.caption2.weight(.bold)).foregroundStyle(AppTheme.tertiaryText)
                .textCase(.uppercase).padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 7)

            if store.steps.isEmpty {
                Text(store.phase == .workspace ? "尚未生成步骤" : "计划生成后，每一步都会在这里独立显示")
                    .font(.caption).foregroundStyle(AppTheme.tertiaryText)
                    .padding(.horizontal, 16)
            } else {
                ForEach(store.steps) { step in
                    Button {
                        store.selectStep(step.id)
                        store.showMainLoop()
                    } label: {
                        SidebarConversationRow(
                            icon: stepStatusIcon(step.status),
                            title: step.title,
                            subtitle: stepStatusSubtitle(step),
                            color: stepStatusColor(step.status),
                            isSelected: store.selectedStepID == step.id,
                            isActive: step.status == .running && !store.isPaused
                        )
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .buttonStyle(.plain)
                }
            }

            Text("共同资料")
                .font(.caption2.weight(.bold)).foregroundStyle(AppTheme.tertiaryText)
                .textCase(.uppercase).padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 7)

            Button { store.showSharedContext() } label: {
                SidebarConversationRow(
                    icon: "doc.text.magnifyingglass",
                    title: "共享上下文",
                    subtitle: "\(store.sharedContext.count) 条同步记录",
                    color: AppTheme.warning,
                    isSelected: store.isShowingSharedContext,
                    isActive: false
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .buttonStyle(.plain)

            Text("规则与能力")
                .font(.caption2.weight(.bold)).foregroundStyle(AppTheme.tertiaryText)
                .textCase(.uppercase).padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 7)

            ForEach(ConfigurationSurface.allCases.filter { $0 != .modelAPI }) { surface in
                Button { store.showConfiguration(surface) } label: {
                    SidebarConversationRow(
                        icon: surface.icon,
                        title: surface.rawValue,
                        subtitle: surface.subtitle,
                        color: AppTheme.accentSoft,
                        isSelected: store.selectedConfiguration == surface,
                        isActive: false
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .buttonStyle(.plain)
            }

            Spacer()

            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("计划生成").font(.caption2.weight(.semibold))
                    Spacer()
                    Text("\(store.steps.count) 步")
                        .font(.caption2.monospacedDigit()).foregroundStyle(AppTheme.secondaryText)
                }
                ProgressView(value: store.planningProgress).tint(AppTheme.accent)
                Text("对话分区；规则、事实与能力分层")
                    .font(.caption2).foregroundStyle(AppTheme.tertiaryText)
            }
            .padding(14)

            Divider().overlay(AppTheme.line)

            Button { store.showConfiguration(.modelAPI) } label: {
                HStack(spacing: 9) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AppTheme.secondaryText)
                    Text("设置")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.primaryText)
                    Spacer()
                    Text(store.transportDisplayName)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.tertiaryText)
                        .lineLimit(1)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .background(
                    store.selectedConfiguration == .modelAPI ? AppTheme.accent.opacity(0.15) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8)
                )
            }
            .buttonStyle(.plain)
        }
        .background(AppTheme.panel.opacity(0.92))
        .alert(
            "归档项目？",
            isPresented: Binding(
                get: { projectPendingDeletion != nil },
                set: { if !$0 { projectPendingDeletion = nil } }
            )
        ) {
            Button("归档") {
                if let project = projectPendingDeletion {
                    store.archiveProject(project.id)
                }
                projectPendingDeletion = nil
            }
            Button("取消", role: .cancel) { projectPendingDeletion = nil }
        } message: {
            Text("将「\(projectPendingDeletion?.name ?? "")」移入本机归档。之后可从侧栏恢复最近归档的项目。")
        }
        .alert(
            "重命名项目",
            isPresented: Binding(
                get: { renamingProject != nil },
                set: { if !$0 { renamingProject = nil } }
            )
        ) {
            TextField("项目名称", text: $renameText)
            Button("保存") {
                if let project = renamingProject {
                    store.renameProject(project.id, name: renameText)
                }
                renamingProject = nil
            }
            Button("取消", role: .cancel) { renamingProject = nil }
        } message: {
            Text("修改「\(renamingProject?.name ?? "")」的显示名称。")
        }
    }

    private func stepStatusIcon(_ status: StepStatus) -> String {
        switch status {
        case .locked: "lock.fill"
        case .ready: "circle.dotted"
        case .running: "gearshape.2.fill"
        case .review: "eye.fill"
        case .approved: "checkmark.seal.fill"
        case .stale: "arrow.triangle.2.circlepath"
        }
    }

    private func stepStatusColor(_ status: StepStatus) -> Color {
        switch status {
        case .locked: AppTheme.tertiaryText
        case .ready: AppTheme.accentSoft
        case .running: AppTheme.accent
        case .review: AppTheme.warning
        case .approved: AppTheme.success
        case .stale: AppTheme.stale
        }
    }

    private func stepStatusSubtitle(_ step: WorkflowStep) -> String {
        switch step.status {
        case .locked: "等待依赖"
        case .ready: "可选择与执行"
        case .running: "执行中"
        case .review: "等待你验收"
        case .approved: "已确认"
        case .stale: "需复核"
        }
    }
}

private struct SidebarConversationRow: View {
    let icon: String
    let title: String
    let subtitle: String
    let color: Color
    let isSelected: Bool
    let isActive: Bool

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(color)
                    .frame(width: 26, height: 26)
                if isActive {
                    Circle().fill(AppTheme.success).frame(width: 7, height: 7)
                        .overlay(Circle().stroke(AppTheme.panel, lineWidth: 2))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(AppTheme.primaryText).lineLimit(1)
                Text(subtitle).font(.caption2).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(isSelected ? AppTheme.accent.opacity(0.15) : (hovering ? AppTheme.surface : Color.clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(isSelected ? AppTheme.accent.opacity(0.40) : (hovering ? AppTheme.line : Color.clear))
        )
        .padding(.horizontal, 8).padding(.vertical, 2)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

private struct PlanRail: View {
    @EnvironmentObject private var store: WorkflowStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("执行路线")
                        .font(.headline)
                    Text("链条表示固定依赖；带拖动标记的独立步骤可以互换顺序。")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                HStack(spacing: 14) {
                    LegendItem(color: AppTheme.success, text: "已确认")
                    LegendItem(color: AppTheme.warning, text: "待验收")
                    LegendItem(color: AppTheme.stale, text: "需复核")
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(store.steps.enumerated()), id: \.element.id) { index, step in
                        if index > 0 {
                            if store.effectiveDependencies(for: step).contains(store.steps[index - 1].id) {
                                ConnectorView(isSatisfied: connectorIsSatisfied(for: step))
                            } else {
                                VStack(spacing: 3) {
                                    Image(systemName: store.effectiveDependencies(for: step).isEmpty ? "arrow.triangle.branch" : "link.badge.plus")
                                    Text(store.effectiveDependencies(for: step).isEmpty ? "并行" : "跨步依赖")
                                        .font(.caption2)
                                }
                                .foregroundStyle(AppTheme.accentSoft)
                                .frame(width: 58)
                                .help("此节点不依赖紧邻的前一步；卡片顺序只是当前拓扑排列。")
                            }
                        }

                        StepCard(
                            step: step,
                            number: index + 1,
                            isSelected: store.selectedStepID == step.id,
                            isReorderable: store.isReorderable(step.id)
                        )
                        .draggable(step.id.uuidString)
                        .dropDestination(for: String.self) { items, _ in
                            guard let rawID = items.first, let draggedID = UUID(uuidString: rawID) else { return false }
                            return store.moveStep(draggedID, before: step.id)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .padding(20)
        .background(CardBackground(highlighted: false))
    }

    private func connectorIsSatisfied(for step: WorkflowStep) -> Bool {
        store.effectiveDependencies(for: step).allSatisfy { dependency in
            store.steps.first(where: { $0.id == dependency })?.status == .approved
        }
    }
}

private struct StepCard: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep
    let number: Int
    let isSelected: Bool
    let isReorderable: Bool

    var body: some View {
        Button {
            store.selectStep(step.id)
        } label: {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Text(String(format: "%02d", number))
                        .font(.caption.monospacedDigit().weight(.bold))
                        .foregroundStyle(statusColor)
                    if store.effectiveKind(for: step) != nil {
                        Text(kindTitle)
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(kindColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(kindColor.opacity(0.12), in: Capsule())
                            .help(store.stepKindWasInferred(step) ? "旧会话缺少类型；此标签由标题和目的推断" : "规划声明的步骤类型")
                    }
                    Spacer()
                    Image(systemName: isReorderable ? "arrow.left.arrow.right" : "link")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(isReorderable ? AppTheme.accentSoft : AppTheme.tertiaryText)
                        .help(isReorderable ? "可与无依赖关系的步骤互换" : "顺序受依赖约束")
                }

                Text(step.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(step.status == .locked ? AppTheme.tertiaryText : AppTheme.primaryText)
                    .lineLimit(2)

                Spacer(minLength: 2)

                HStack(spacing: 6) {
                    Image(systemName: statusIcon)
                    Text(statusTitle)
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(statusColor)

                if let option = step.selectedOption {
                    Text(option.title)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText)
                        .lineLimit(1)
                } else {
                    Text("尚未选择方案")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.tertiaryText)
                }
            }
            .padding(14)
            .frame(width: 164, height: 152, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isSelected ? AppTheme.accent.opacity(0.13) : AppTheme.card)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(isSelected ? AppTheme.accent : AppTheme.line, lineWidth: isSelected ? 1.5 : 1)
                    )
            )
        }
        .contentShape(Rectangle())
        .buttonStyle(.plain)
    }

    private var statusTitle: String {
        switch step.status {
        case .locked: "等待依赖"
        case .ready: "可选择与执行"
        case .running: "执行中"
        case .review: "等待用户验收"
        case .approved: "用户已确认"
        case .stale: "上游变化，需复核"
        }
    }

    private var kindTitle: String {
        let suffix = store.stepKindWasInferred(step) ? "*" : ""
        return switch store.effectiveKind(for: step) {
        case .decision: "决策\(suffix)"
        case .build: "制作\(suffix)"
        case .integrate: "集成\(suffix)"
        case .verify: "验证\(suffix)"
        case .deliver: "交付\(suffix)"
        case nil: "未知"
        }
    }

    private var kindColor: Color {
        switch store.effectiveKind(for: step) {
        case .decision: AppTheme.accentSoft
        case .build: AppTheme.accent
        case .integrate: AppTheme.stale
        case .verify: AppTheme.warning
        case .deliver: AppTheme.success
        case nil: AppTheme.tertiaryText
        }
    }

    private var statusIcon: String {
        switch step.status {
        case .locked: "lock.fill"
        case .ready: "circle.dotted"
        case .running: "gearshape.2.fill"
        case .review: "eye.fill"
        case .approved: "checkmark.seal.fill"
        case .stale: "arrow.triangle.2.circlepath"
        }
    }

    private var statusColor: Color {
        switch step.status {
        case .locked: AppTheme.tertiaryText
        case .ready: AppTheme.accentSoft
        case .running: AppTheme.accent
        case .review: AppTheme.warning
        case .approved: AppTheme.success
        case .stale: AppTheme.stale
        }
    }
}

private struct ConnectorView: View {
    let isSatisfied: Bool

    var body: some View {
        HStack(spacing: 3) {
            Rectangle()
                .fill(isSatisfied ? AppTheme.success.opacity(0.7) : AppTheme.line)
                .frame(width: 18, height: 2)
            Image(systemName: "chevron.right")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(isSatisfied ? AppTheme.success : AppTheme.tertiaryText)
        }
        .frame(width: 26)
    }
}

private struct StepInspector: View {
    @EnvironmentObject private var store: WorkflowStore
    @State private var feedback = ""

    var body: some View {
        Group {
            if let step = store.selectedStep {
                VStack(alignment: .leading, spacing: 20) {
                    InspectorHeader(step: step)
                    ImpactAnalysisView(step: step)
                    ConversationTranscriptView(step: step)
                    StepFeedbackComposer(step: step, feedback: $feedback)

                    if step.status == .locked {
                        LockedState(step: step)
                    } else {
                        if step.status == .stale {
                            StaleBanner(step: step)
                        }

                        if step.status == .review, let result = step.result {
                            ResultReview(step: step, result: result, feedback: $feedback)
                        } else if step.status == .approved {
                            ApprovedState(step: step)
                        } else {
                            OptionsSection(step: step)

                            if let lastFeedback = step.lastFeedback {
                                FeedbackBanner(text: lastFeedback)
                            }

                            ExecutionFooter(step: step)
                        }
                    }
                }
                .padding(22)
                .background(CardBackground(highlighted: true))
                .id(step.id.uuidString + "-\(step.revision)-\(step.status.rawValue)")
            } else {
                ContentUnavailableView("选择一个步骤", systemImage: "cursorarrow.click")
                    .frame(maxWidth: .infinity, minHeight: 420)
                    .background(CardBackground(highlighted: false))
            }
        }
    }
}

private struct ImpactAnalysisView: View {
    let step: WorkflowStep

    var body: some View {
        if let level = step.riskLevel {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Label("风险 \(level.rawValue)", systemImage: "exclamationmark.shield")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(level.requiresReview ? AppTheme.warning : AppTheme.secondaryText)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background((level.requiresReview ? AppTheme.warning : AppTheme.line).opacity(0.12), in: Capsule())
                    Text(level.detail).font(.caption).foregroundStyle(AppTheme.secondaryText)
                    Spacer()
                }
                if let impact = step.impactAnalysis {
                    if !impact.surfaceProblem.isEmpty {
                        Text("问题：\(impact.surfaceProblem)").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    if !impact.problemCategory.isEmpty {
                        Text("类别：\(impact.problemCategory)").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    if !impact.relatedScenarios.isEmpty {
                        Text("同类/相邻场景：\(impact.relatedScenarios.joined(separator: "；"))").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    Text("性质：\(impact.isLocalPatch ? "局部补丁" : "统一能力缺失") · 范围：\(impact.scope) · 主流程改动：\(impact.requiresMainFlowChange ? "需要" : "不需要")")
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    if !impact.affectedModules.isEmpty {
                        Text("影响模块：\(impact.affectedModules.joined(separator: "、"))").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((level.requiresReview ? AppTheme.warning : AppTheme.surface).opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke((level.requiresReview ? AppTheme.warning : AppTheme.line).opacity(0.35)))
        }
    }
}

private struct ConversationTranscriptView: View {
    let step: WorkflowStep

    var body: some View {
        if let messages = step.conversationMessages, !messages.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 7) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .foregroundStyle(AppTheme.accentSoft)
                    Text("对话记录")
                        .font(.headline)
                    Spacer()
                    if let id = step.conversationID {
                        Text(id)
                            .font(.caption2.monospaced())
                            .foregroundStyle(AppTheme.tertiaryText)
                            .lineLimit(1)
                    }
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(messages) { message in
                            MessageBubble(message: message)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 380)
                .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.line))
            }
        }
    }
}

private struct MessageBubble: View {
    let message: ConversationMessage

    var body: some View {
        switch message.role {
        case .system:
            Text(message.text)
                .font(.caption)
                .foregroundStyle(AppTheme.tertiaryText)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        case .user:
            HStack {
                Spacer(minLength: 40)
                Text(message.text)
                    .font(.callout)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .foregroundStyle(.white)
                    .background(AppTheme.accent, in: RoundedRectangle(cornerRadius: 12))
                    .frame(maxWidth: 520, alignment: .trailing)
            }
        case .assistant:
            HStack {
                Text(message.text)
                    .font(.callout)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .foregroundStyle(AppTheme.primaryText)
                    .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12))
                    .frame(maxWidth: 560, alignment: .leading)
                Spacer(minLength: 40)
            }
        }
    }
}

private struct StepFeedbackComposer: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep
    @Binding var feedback: String

    private var canSubmit: Bool {
        step.status == .review || step.status == .approved
    }

    var body: some View {
        if canSubmit {
            VStack(alignment: .leading, spacing: 8) {
                Text(step.status == .review ? "提意见" : "重新打开并修改")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.accentSoft)
                HStack(spacing: 8) {
                    TextField("在这里输入反馈，发送后本步会重跑", text: $feedback)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(submit)
                    Button("发送并重跑", action: submit)
                        .buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(12)
            .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.line))
        }
    }

    private func submit() {
        store.submitStepFeedback(stepID: step.id, feedback: feedback)
        feedback = ""
    }
}

private struct InspectorHeader: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text("当前步骤")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.accentSoft)
                    Text("REV \(step.revision)")
                        .font(.caption2.monospaced().weight(.bold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(AppTheme.surface, in: Capsule())
                        .foregroundStyle(AppTheme.secondaryText)
                }
                Text(step.title)
                    .font(.system(size: 23, weight: .bold, design: .rounded))
                Text(step.purpose)
                    .font(.callout)
                    .foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()

            let dependencies = store.effectiveDependencies(for: step)
            if !dependencies.isEmpty {
                VStack(alignment: .trailing, spacing: 5) {
                    Label("依赖 \(dependencies.count) 步", systemImage: "link")
                        .font(.caption.weight(.semibold))
                    Text(store.dependenciesAreApproved(for: step) ? "依赖已满足" : "依赖尚未完成")
                        .font(.caption2)
                        .foregroundStyle(store.dependenciesAreApproved(for: step) ? AppTheme.success : AppTheme.warning)
                }
            }
        }
    }
}

private struct LockedState: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.circle.fill")
                .font(.system(size: 42))
                .foregroundStyle(AppTheme.tertiaryText)
            Text("先完成依赖步骤")
                .font(.headline)
            Text("该步骤仍保留在总体计划中，但在上游获得用户确认前不能执行。")
                .font(.callout)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)

            let dependencyNames = store.effectiveDependencies(for: step).compactMap { id in store.steps.first(where: { $0.id == id })?.title }
            Text(dependencyNames.joined(separator: "  →  "))
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.warning)
        }
        .frame(maxWidth: .infinity, minHeight: 300)
    }
}

private struct OptionsSection: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("选择执行方案")
                    .font(.headline)
                Spacer()
                Text("先做决策，再做动作")
                    .font(.caption)
                    .foregroundStyle(AppTheme.tertiaryText)
            }

            ForEach(step.options) { option in
                OptionCard(
                    option: option,
                    isSelected: step.selectedOptionID == option.id
                ) {
                    store.selectOption(option.id, for: step.id)
                }
            }
        }
    }
}

private struct OptionCard: View {
    let option: PlanOption
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? AppTheme.accent : AppTheme.tertiaryText)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 8) {
                            Text(option.title)
                                .font(.system(size: 15, weight: .semibold))
                            if option.isRecommended {
                                Text("推荐")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(AppTheme.accentSoft)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 3)
                                    .background(AppTheme.accent.opacity(0.14), in: Capsule())
                            }
                        }
                        Text(option.subtitle)
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer()
                }

                Text(option.technicalReason)
                    .font(.callout)
                    .foregroundStyle(AppTheme.primaryText.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)

                HStack(alignment: .top, spacing: 16) {
                    BulletColumn(title: "优点", icon: "plus.circle.fill", color: AppTheme.success, items: option.advantages)
                    BulletColumn(title: "代价", icon: "minus.circle.fill", color: AppTheme.warning, items: option.tradeoffs)
                }

                Label(option.downstreamImpact, systemImage: "arrow.turn.down.right")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isSelected ? AppTheme.accent.opacity(0.10) : AppTheme.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(isSelected ? AppTheme.accent : AppTheme.line, lineWidth: isSelected ? 1.4 : 1)
                    )
            )
        }
        .contentShape(Rectangle())
        .buttonStyle(.plain)
    }
}

private struct BulletColumn: View {
    let title: String
    let icon: String
    let color: Color
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
            ForEach(items, id: \.self) { item in
                Label(item, systemImage: icon)
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
                    .labelStyle(CompactLabelStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ExecutionFooter: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep
    @State private var showingRiskConfirmation = false

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(step.status == .running
                     ? (store.isPaused ? "已暂停，点击右侧按钮继续" : "正在执行本步骤…")
                     : "执行后会暂停，等待你的验收")
                    .font(.callout.weight(.semibold))
                Text(riskHint)
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            Spacer()
            if step.status == .running {
                if store.isPaused {
                    Button("已暂停") {
                        store.resumePausedExecution()
                    }
                    .buttonStyle(PrimaryButtonStyle(color: AppTheme.warning))
                    .help("点击继续执行本步骤")
                } else {
                    ProgressView()
                        .controlSize(.small)
                    Button("执行中") {}
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(true)
                }
            } else {
                Button("执行这一步") {
                    if step.riskLevel?.requiresReview == true {
                        showingRiskConfirmation = true
                    } else {
                        store.runSelectedStep()
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(step.selectedOptionID == nil || store.isPaused || !store.dependenciesAreApproved(for: step))
            }
        }
        .padding(.top, 2)
        .confirmationDialog("高风险步骤需确认", isPresented: $showingRiskConfirmation) {
            Button("已确认方案范围，执行（\(step.riskLevel?.rawValue ?? "L?")）") {
                store.runSelectedStep()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("该步骤风险等级 \(step.riskLevel?.rawValue ?? "未知")（\(step.riskLevel?.detail ?? "")），涉及跨模块/数据/安全等影响。请确认已完成方案与影响分析审查后再执行。")
        }
    }

    private var riskHint: String {
        if let level = step.riskLevel {
            return "风险 \(level.rawValue)（\(level.detail)）· 不会自动进入下一步"
        }
        return "不会自动进入下一步 · 不会越过当前步骤"
    }
}

private struct ResultReview: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep
    let result: StepResult
    @Binding var feedback: String

    private var isVerification: Bool {
        store.effectiveKind(for: step) == .verify
    }

    private var verificationPassed: Bool {
        result.verificationPassed == true && (result.blockingIssues ?? []).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(isVerification ? "验证结果" : "等待你的判断", systemImage: isVerification ? "checkmark.shield.fill" : "eye.fill")
                    .font(.headline)
                    .foregroundStyle(AppTheme.warning)
                Spacer()
                Text(isVerification ? "结论只依据 Agent 的实际运行证据" : "Agent 不替你决定方案偏好")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }

            Text(result.summary)
                .font(.system(size: 16, weight: .semibold))

            if isVerification {
                VerificationOutcome(result: result)
            }

            if result.artifact != nil {
                Button {
                    store.showDeliverable()
                } label: {
                    Label("打开演示窗口查看当前产物", systemImage: "play.rectangle.fill")
                }
                .buttonStyle(PrimaryButtonStyle())
            }

            ResultGroup(title: "实际改变", icon: "wrench.and.screwdriver", items: result.actualChanges, color: AppTheme.accentSoft)
            ResultGroup(title: "验证证据", icon: "checkmark.shield", items: result.evidence, color: AppTheme.success)

            VStack(alignment: .leading, spacing: 6) {
                Label("已知偏差", systemImage: "exclamationmark.triangle")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.warning)
                Text(result.deviation)
                    .font(.callout)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 7) {
                Text(isVerification ? "补充检查或修复说明" : "哪里需要改？")
                    .font(.caption.weight(.semibold))
                TextField(isVerification ? "可选：补充复现方式或期望结果" : "直接指出问题；总体计划会保留", text: $feedback)
                    .textFieldStyle(.roundedBorder)
            }

            HStack(spacing: 10) {
                Button("回退本步", role: .destructive) {
                    store.rollback(stepID: step.id)
                }
                .buttonStyle(SecondaryButtonStyle())

                Spacer()

                if isVerification {
                    if verificationPassed {
                        Button("要求重新验证") {
                            store.requestRevision(stepID: step.id, feedback: feedback)
                            feedback = ""
                        }
                        .buttonStyle(SecondaryButtonStyle())

                        Button("验证成功并继续") {
                            store.approve(stepID: step.id)
                            feedback = ""
                        }
                        .buttonStyle(PrimaryButtonStyle(color: AppTheme.success))
                    } else {
                        Button("重新运行检查") {
                            store.requestRevision(stepID: step.id, feedback: feedback)
                            feedback = ""
                        }
                        .buttonStyle(SecondaryButtonStyle())

                        Button("验证不通过，返回修复") {
                            store.returnVerificationFailureToRepair(stepID: step.id, feedback: feedback)
                            feedback = ""
                        }
                        .buttonStyle(SecondaryButtonStyle())
                    }
                } else {
                    Button("要求修改") {
                        store.requestRevision(stepID: step.id, feedback: feedback)
                        feedback = ""
                    }
                    .buttonStyle(SecondaryButtonStyle())

                    Button("接受并继续") {
                        store.approve(stepID: step.id)
                        feedback = ""
                    }
                    .buttonStyle(PrimaryButtonStyle(color: AppTheme.success))
                }
            }

            Label(result.rollback, systemImage: "arrow.uturn.backward.circle")
                .font(.caption)
                .foregroundStyle(AppTheme.tertiaryText)
        }
    }
}

private struct VerificationOutcome: View {
    let result: StepResult

    private var issues: [String] { result.blockingIssues ?? [] }
    private var passed: Bool { result.verificationPassed == true && issues.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                passed ? "Agent 验证：通过" : (result.verificationPassed == false ? "Agent 验证：未通过" : "Agent 验证：结果不明确"),
                systemImage: passed ? "checkmark.circle.fill" : "xmark.octagon.fill"
            )
            .font(.headline)
            .foregroundStyle(passed ? AppTheme.success : AppTheme.warning)

            Text("只有 Agent 实际运行检查并返回明确通过、且没有阻断问题时，才能进入下一步。")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)

            if !issues.isEmpty {
                ForEach(issues, id: \.self) { issue in
                    Label(issue, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(AppTheme.primaryText)
                }
            } else if result.verificationPassed == nil {
                Text("没有明确的 verificationPassed 结论，后续步骤仍保持锁定。")
                    .font(.callout)
                    .foregroundStyle(AppTheme.secondaryText)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((passed ? AppTheme.success : AppTheme.warning).opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct DeliverableWindow: View {
    @EnvironmentObject private var store: WorkflowStore

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11).fill(AppTheme.success.opacity(0.16))
                    Image(systemName: "play.rectangle.fill")
                        .font(.title3)
                        .foregroundStyle(AppTheme.success)
                }
                .frame(width: 42, height: 42)

                VStack(alignment: .leading, spacing: 2) {
                    Text("演示窗口")
                        .font(.headline)
                    Text(store.currentArtifact == nil ? "制作步骤返回产物后会在这里实时更新" : "当前步骤累积出的最新可交付版本")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }

                Spacer()

                StatusPill(
                    text: store.isDeliverableReady ? "可交付" : (store.currentArtifact == nil ? "等待产物" : "制作中"),
                    icon: store.isDeliverableReady ? "checkmark.seal.fill" : "hammer.fill",
                    color: store.isDeliverableReady ? AppTheme.success : AppTheme.warning
                )

                Button("返回主 Loop") { store.showMainLoop() }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 16)
            .background(AppTheme.panel)

            Divider().overlay(AppTheme.line)

            if let artifact = store.currentArtifact {
                VStack(spacing: 0) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(artifact.title).font(.title3.weight(.bold))
                            Text("\(artifact.kind.rawValue.uppercased()) · \(artifact.filename)")
                                .font(.caption.monospaced())
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                        Spacer()
                        Text(store.isDeliverableReady ? "全部步骤已验收，当前版本可交付" : "这是中间版本，仍会被后续步骤更新")
                            .font(.caption)
                            .foregroundStyle(store.isDeliverableReady ? AppTheme.success : AppTheme.warning)
                    }
                    .padding(16)
                    .background(AppTheme.surface)

                    ArtifactPreview(
                        artifact: artifact,
                        allowHTTPSRemoteResources: store.allowsHTTPSRemoteArtifactResources
                    )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .padding(18)
            } else {
                VStack(spacing: 18) {
                    Image(systemName: "rectangle.dashed")
                        .font(.system(size: 58, weight: .light))
                        .foregroundStyle(AppTheme.tertiaryText)
                    Text("还没有可演示产物")
                        .font(.title2.weight(.bold))
                    Text("完整计划中的 build / integrate / deliver 步骤必须返回 artifact。第一个制作步骤完成后，这里会出现 HTML、Markdown 或文本成品，而不是只显示模型的文字总结。")
                        .font(.callout)
                        .foregroundStyle(AppTheme.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 620)
                    Button("返回主 Loop 继续执行") { store.showMainLoop() }
                        .buttonStyle(PrimaryButtonStyle())
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(40)
            }
        }
        .background(AppTheme.canvas)
    }
}

private struct ArtifactPreview: View {
    let artifact: DeliverableArtifact
    let allowHTTPSRemoteResources: Bool

    @ViewBuilder
    var body: some View {
        switch artifact.kind {
        case .html:
            let issues = ArtifactValidator.blockingIssues(
                for: artifact,
                allowHTTPSRemoteResources: allowHTTPSRemoteResources
            )
            ZStack(alignment: .top) {
                HTMLArtifactPreview(
                    artifact: artifact,
                    allowHTTPSRemoteResources: allowHTTPSRemoteResources
                )
                if !issues.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("HTML 无法运行", systemImage: "exclamationmark.triangle.fill")
                            .font(.headline)
                        ForEach(issues, id: \.self) { issue in
                            Text("• \(issue)")
                                .font(.callout)
                        }
                        Text("已阻止把这份空白预览标记为可交付；请返回主 Loop 重跑当前步骤。")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    .padding(16)
                    .frame(maxWidth: 720, alignment: .leading)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.warning.opacity(0.7)))
                    .foregroundStyle(AppTheme.warning)
                    .padding(20)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.line))
        case .markdown, .text:
            ScrollView {
                Text(artifact.content)
                    .font(artifact.kind == .text ? .system(.body, design: .monospaced) : .body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(24)
            }
            .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.line))
        }
    }
}

private struct HTMLArtifactPreview: NSViewRepresentable {
    let artifact: DeliverableArtifact
    let allowHTTPSRemoteResources: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: Self.diagnosticsScriptSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        if let fileURL = artifact.previewFileURL {
            guard context.coordinator.lastFileURL != fileURL
                || context.coordinator.lastContent != artifact.content else { return }
            context.coordinator.lastFileURL = fileURL
            context.coordinator.lastContent = artifact.content
            context.coordinator.lastHTML = nil
            webView.loadFileURL(fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())
        } else {
            let secured = securedHTML(artifact.content)
            guard context.coordinator.lastHTML != secured else { return }
            context.coordinator.lastHTML = secured
            context.coordinator.lastFileURL = nil
            context.coordinator.lastContent = artifact.content
            webView.loadHTMLString(secured, baseURL: nil)
        }
    }

    private func securedHTML(_ source: String) -> String {
        let policy = HTMLPreviewSecurityPolicy.contentSecurityPolicy(
            for: source,
            allowHTTPSRemoteResources: allowHTTPSRemoteResources
        )
        let csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">"
        let inlineDiagnostics = "<script>\(Self.diagnosticsScriptSource)</script>"
        if let head = source.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
            return source.replacingCharacters(in: head, with: "\(source[head])\(csp)\(inlineDiagnostics)")
        }
        return "<!doctype html><html><head>\(csp)\(inlineDiagnostics)<meta charset=\"utf-8\"></head><body>\(source)</body></html>"
    }

    private static let diagnosticsScriptSource = """
    (() => {
      const show = (message) => {
        if (!message || document.getElementById('loopcanvas-preview-error')) return;
        const panel = document.createElement('div');
        panel.id = 'loopcanvas-preview-error';
        panel.style.cssText = 'position:fixed;left:20px;right:20px;top:20px;z-index:2147483647;padding:14px 16px;border:1px solid #d97706;border-radius:10px;background:#fff7ed;color:#9a3412;font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;white-space:pre-wrap;box-shadow:0 10px 30px rgba(0,0,0,.18)';
        panel.textContent = '预览脚本执行失败：' + message;
        (document.body || document.documentElement).appendChild(panel);
      };
      addEventListener('error', event => {
        const target = event.target;
        show(event.message || target?.src || target?.href || '脚本或资源加载失败');
      }, true);
      addEventListener('unhandledrejection', event => show(String(event.reason || 'Promise 被拒绝')));
      addEventListener('securitypolicyviolation', event => show('安全策略阻止资源：' + (event.blockedURI || event.violatedDirective)));
    })();
    """

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastHTML: String?
        var lastFileURL: URL?
        var lastContent: String?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let scheme = navigationAction.request.url?.scheme?.lowercased() else {
                decisionHandler(.allow)
                return
            }
            decisionHandler(["about", "data", "blob", "file"].contains(scheme) ? .allow : .cancel)
        }
    }
}

private struct ResultGroup: View {
    let title: String
    let icon: String
    let items: [String]
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(color)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: 8) {
                    Circle().fill(color).frame(width: 5, height: 5).padding(.top, 6)
                    Text(item)
                        .font(.callout)
                        .foregroundStyle(AppTheme.secondaryText)
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ApprovedState: View {
    @EnvironmentObject private var store: WorkflowStore
    let step: WorkflowStep

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 46))
                .foregroundStyle(AppTheme.success)
            Text("这一步已由用户确认")
                .font(.title3.weight(.bold))
            Text("系统会保留第 \(step.revision) 版决策。你仍然可以单独重开这一步；受影响的下游会被标记，而总体计划不会消失。")
                .font(.callout)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)

            if let selected = step.selectedOption {
                Label(selected.title, systemImage: "checkmark.circle")
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(AppTheme.success.opacity(0.10), in: Capsule())
                    .foregroundStyle(AppTheme.success)
            }

            HStack(spacing: 10) {
                Button("回退本步", role: .destructive) {
                    store.rollback(stepID: step.id)
                }
                .buttonStyle(SecondaryButtonStyle())
                Button("重新打开并修改") {
                    store.reopenApprovedStep(stepID: step.id)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, minHeight: 330)
    }
}

private struct StaleBanner: View {
    let step: WorkflowStep

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                .font(.title3)
                .foregroundStyle(AppTheme.stale)
            VStack(alignment: .leading, spacing: 3) {
                Text("上游发生变化，这一步需要复核")
                    .font(.callout.weight(.semibold))
                Text("原方案与历史结果仍然保留。确认依赖后，可以按原方案重跑，也可以换一个方案。")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.stale.opacity(0.10), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(AppTheme.stale.opacity(0.35)))
    }
}

private struct FeedbackBanner: View {
    let text: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("上一轮用户反馈")
                    .font(.caption.weight(.bold))
                Text(text)
                    .font(.callout)
            }
        } icon: {
            Image(systemName: "quote.bubble.fill")
                .foregroundStyle(AppTheme.warning)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct DecisionLedger: View {
    @EnvironmentObject private var store: WorkflowStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("决策记录")
                        .font(.headline)
                    Text("方向不只存在于聊天上下文")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(AppTheme.tertiaryText)
            }

            Divider().overlay(AppTheme.line)

            if store.decisionLog.isEmpty {
                Text("还没有记录")
                    .font(.callout)
                    .foregroundStyle(AppTheme.secondaryText)
                    .frame(maxWidth: .infinity, minHeight: 200)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(store.decisionLog.prefix(8).enumerated()), id: \.element.id) { index, entry in
                        LogRow(entry: entry, isLast: index == min(store.decisionLog.count, 8) - 1)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(minHeight: 460, alignment: .top)
        .background(CardBackground(highlighted: false))
    }
}

private struct LogRow: View {
    let entry: DecisionLogEntry
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            VStack(spacing: 0) {
                Circle()
                    .fill(kindColor)
                    .frame(width: 9, height: 9)
                    .padding(.top, 4)
                if !isLast {
                    Rectangle()
                        .fill(AppTheme.line)
                        .frame(width: 1, height: 52)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.primaryText)
                    .lineLimit(2)
                Text(entry.detail)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.secondaryText)
                    .lineLimit(3)
                Text(entry.date, style: .time)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(AppTheme.tertiaryText)
            }
            .padding(.bottom, isLast ? 0 : 10)
        }
    }

    private var kindColor: Color {
        switch entry.kind {
        case .decision: AppTheme.success
        case .execution: AppTheme.accent
        case .revision: AppTheme.warning
        case .system: AppTheme.tertiaryText
        }
    }
}

private struct LegendItem: View {
    let color: Color
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.caption2).foregroundStyle(AppTheme.secondaryText)
        }
    }
}

private struct StatusPill: View {
    let text: String
    let icon: String
    let color: Color

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.10), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.28)))
    }
}

struct CardBackground: View {
    let highlighted: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 17, style: .continuous)
            .fill(AppTheme.panel)
            .overlay(
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .stroke(highlighted ? AppTheme.accent.opacity(0.28) : AppTheme.line, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.13), radius: 18, y: 8)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var color: Color = AppTheme.accent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
            .background(color.opacity(configuration.isPressed ? 0.72 : 1), in: RoundedRectangle(cornerRadius: 9))
            .modifier(ButtonHoverEffect())
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(AppTheme.primaryText)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
            .background(AppTheme.surface.opacity(configuration.isPressed ? 0.55 : 1), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(AppTheme.line))
            .modifier(ButtonHoverEffect())
    }
}

/// 让按钮整个区域（含 padding 与背景）都可点击，并给悬停一个轻微高亮反馈。
private struct ButtonHoverEffect: ViewModifier {
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .onHover { hovering = $0 }
            .brightness(hovering ? 0.09 : 0)
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            configuration.icon
                .font(.system(size: 9))
            configuration.title
        }
    }
}

enum AppTheme {
    static let canvas = Color(red: 0.045, green: 0.052, blue: 0.071)
    static let panel = Color(red: 0.075, green: 0.085, blue: 0.112)
    static let card = Color(red: 0.095, green: 0.106, blue: 0.137)
    static let surface = Color(red: 0.115, green: 0.126, blue: 0.160)
    static let line = Color.white.opacity(0.09)
    static let primaryText = Color.white.opacity(0.94)
    static let secondaryText = Color.white.opacity(0.62)
    static let tertiaryText = Color.white.opacity(0.36)
    static let accent = Color(red: 0.36, green: 0.43, blue: 1.0)
    static let accentSoft = Color(red: 0.58, green: 0.64, blue: 1.0)
    static let success = Color(red: 0.25, green: 0.82, blue: 0.60)
    static let warning = Color(red: 1.0, green: 0.68, blue: 0.28)
    static let stale = Color(red: 0.78, green: 0.48, blue: 1.0)
}
