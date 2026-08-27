import Foundation
import SwiftUI

@MainActor
final class WorkflowStore: ObservableObject {
    @Published private(set) var phase: AppPhase
    @Published private(set) var requirement: String
    @Published private(set) var steps: [WorkflowStep]
    @Published var selectedStepID: UUID?
    @Published private(set) var isPaused: Bool
    @Published private(set) var decisionLog: [DecisionLogEntry]
    @Published private(set) var sharedContext: [SharedContextEntry]
    @Published private(set) var agentSessions: [AgentSession]
    @Published private(set) var selectedConversationID: UUID?
    @Published private(set) var isShowingSharedContext: Bool
    @Published private(set) var isShowingDeliverable: Bool
    @Published private(set) var pendingBridgeRequests: [CodexBridgeRequest]
    @Published private(set) var requirementAttachments: [InputAttachment]
    @Published private(set) var requirementDirectives: [RequirementDirective]
    @Published private(set) var planValidationIssues: [String]
    @Published private(set) var selectedConfiguration: ConfigurationSurface?
    @Published private(set) var bridgeError: String?
    @Published private(set) var modelAPISettings: ModelAPISettings
    @Published private(set) var modelAPIStatus: String?
    @Published private(set) var modelAPIStatusIsError: Bool
    @Published private(set) var isTestingModelAPI: Bool
    @Published var handoffDraft: HandoffDraft?
    @Published var transientMessage: String?

    private static let persistenceKey = "LoopCanvas.workflow.v3"
    private static let projectsKey = "LoopCanvas.projects.v1"
    private let shouldPersist: Bool
    private let fileStore: AgentFileStore
    private let harnessTransport: DeepSeekHarnessTransport
    private let codexTransport: CodexAppServerTransport
    private let automaticallyDispatchRequests: Bool
    private var apiRequestsInFlight: Set<UUID> = []
    private var apiRequestTasks: [UUID: Task<Void, Never>] = [:]
    private var apiRequestTokens: [UUID: UUID] = [:]
    private var allProjects: [Project] = []
    private var archivedProjects: [Project] = []
    private var currentProjectID: UUID?
    @Published private(set) var projects: [ProjectSummary] = []

    init(
        loadPersisted: Bool = true,
        bridgeRoot: URL? = nil,
        modelAPISettings: ModelAPISettings? = nil,
        harnessTransport: DeepSeekHarnessTransport = DeepSeekHarnessTransport(),
        codexTransport: CodexAppServerTransport = CodexAppServerTransport()
    ) {
        self.shouldPersist = loadPersisted
        self.fileStore = AgentFileStore(rootURL: bridgeRoot ?? AgentFileStore.defaultRootURL())
        self.automaticallyDispatchRequests = bridgeRoot == nil
        self.modelAPISettings = modelAPISettings
            ?? (loadPersisted && bridgeRoot == nil ? ModelAPISettingsPersistence.load() : .default)
        self.harnessTransport = harnessTransport
        self.codexTransport = codexTransport
        self.modelAPIStatus = nil
        self.modelAPIStatusIsError = false
        self.isTestingModelAPI = false

        var loadedProjects: [Project] = []
        var loadedArchivedProjects: [Project] = []
        var legacyRecoveryData: Data?
        var projectsRecoveryData: Data?
        if loadPersisted {
            if let data = UserDefaults.standard.data(forKey: Self.projectsKey) {
                do {
                    let document = try JSONDecoder().decode(ProjectsDocument.self, from: data)
                    loadedProjects = document.projects
                    loadedArchivedProjects = document.archivedProjects
                    currentProjectID = document.currentProjectID ?? document.projects.first?.id
                } catch {
                    projectsRecoveryData = data
                }
            } else if let legacyData = UserDefaults.standard.data(forKey: Self.persistenceKey) {
                if let snapshot = try? JSONDecoder().decode(WorkflowSnapshot.self, from: legacyData) {
                    let project = Project(
                        id: UUID(),
                        name: Self.deriveProjectName(from: snapshot.requirement),
                        createdAt: Date(),
                        snapshot: snapshot
                    )
                    loadedProjects = [project]
                    currentProjectID = project.id
                } else {
                    legacyRecoveryData = legacyData
                }
            }
            if loadedProjects.isEmpty,
               projectsRecoveryData != nil,
               let legacyData = UserDefaults.standard.data(forKey: Self.persistenceKey) {
                if let snapshot = try? JSONDecoder().decode(WorkflowSnapshot.self, from: legacyData) {
                    let project = Project(
                        id: UUID(),
                        name: Self.deriveProjectName(from: snapshot.requirement),
                        createdAt: Date(),
                        snapshot: snapshot
                    )
                    loadedProjects = [project]
                    currentProjectID = project.id
                } else {
                    legacyRecoveryData = legacyData
                }
            }
        }

        // 一次性迁移：把旧版单快照 workflow.v3 里尚未成为项目的工作流恢复成一个项目。
        if loadPersisted,
           let legacyData = UserDefaults.standard.data(forKey: Self.persistenceKey),
           let snapshot = try? JSONDecoder().decode(WorkflowSnapshot.self, from: legacyData),
           !snapshot.steps.isEmpty {
            let existingStepIDs = Set(loadedProjects.flatMap { $0.snapshot.steps.map(\.id) })
            let legacyStepIDs = Set(snapshot.steps.map(\.id))
            if legacyStepIDs.isEmpty || !legacyStepIDs.isSubset(of: existingStepIDs) {
                let recovered = Project(
                    id: UUID(),
                    name: Self.deriveProjectName(from: snapshot.requirement),
                    createdAt: Date(),
                    snapshot: snapshot
                )
                loadedProjects.append(recovered)
            }
            UserDefaults.standard.removeObject(forKey: Self.persistenceKey)
        }

        if !loadPersisted {
            let sample = DemoWorkflow.makeSteps()
            self.phase = .workspace
            self.requirement = DemoWorkflow.objective
            self.steps = sample
            self.selectedStepID = sample.first?.id
            self.isPaused = false
            self.decisionLog = []
            self.sharedContext = []
            self.agentSessions = []
            self.pendingBridgeRequests = []
            self.requirementAttachments = []
            self.requirementDirectives = []
            self.allProjects = []
            self.currentProjectID = nil
        } else {
            if loadedProjects.isEmpty {
                let fresh = Project(id: UUID(), name: "新项目", createdAt: Date(), snapshot: Self.emptySnapshot())
                loadedProjects = [fresh]
                currentProjectID = fresh.id
            }
            self.allProjects = loadedProjects
            self.archivedProjects = loadedArchivedProjects
            let resolvedID = currentProjectID
            var snapshot = Self.emptySnapshot()
            for project in allProjects where project.id == resolvedID {
                snapshot = project.snapshot
                break
            }
            self.phase = snapshot.phase
            self.requirement = snapshot.requirement
            self.steps = snapshot.steps
            self.selectedStepID = snapshot.selectedStepID ?? snapshot.steps.first?.id
            self.isPaused = snapshot.isPaused
            self.decisionLog = snapshot.decisionLog
            self.sharedContext = snapshot.sharedContext
            self.agentSessions = snapshot.agentSessions
            self.pendingBridgeRequests = snapshot.pendingBridgeRequests
            self.requirementAttachments = snapshot.requirementAttachments ?? []
            self.requirementDirectives = snapshot.requirementDirectives ?? []
        }

        self.selectedConversationID = nil
        self.isShowingSharedContext = false
        self.isShowingDeliverable = false
        self.handoffDraft = nil
        self.transientMessage = nil
        self.bridgeError = nil
        self.planValidationIssues = []
        self.selectedConfiguration = nil
        self.projects = allProjects.map { ProjectSummary(id: $0.id, name: $0.name) }
        if let legacyRecoveryData {
            do {
                let recoveryURL = try fileStore.writeWorkflowRecoveryData(legacyRecoveryData)
                self.transientMessage = "旧版工作流快照无法读取，已保留原始恢复数据：\(recoveryURL.path)"
            } catch {
                self.transientMessage = "旧版工作流快照无法读取，且恢复数据保存失败：\(error.localizedDescription)"
            }
        }
        if let projectsRecoveryData {
            do {
                let recoveryURL = try fileStore.writeWorkflowRecoveryData(projectsRecoveryData, label: "projects")
                self.transientMessage = "项目数据无法读取，已保留原始恢复数据：\(recoveryURL.path)"
            } catch {
                self.transientMessage = "项目数据无法读取，且恢复数据保存失败：\(error.localizedDescription)"
            }
        }
        let restoredObjectiveVerification = restoreObjectiveVerificationState()
        recomputeAvailability()
        restoreVisibleVerificationReviews()
        if restoredObjectiveVerification || shouldPersist { persist() }
    }

    var currentProjectName: String {
        allProjects.first(where: { $0.id == currentProjectID })?.name ?? "新项目"
    }

    var currentProjectIDValue: UUID? { currentProjectID }
    var archivedProjectCount: Int { archivedProjects.count }
    var currentCheckpointCount: Int {
        allProjects.first(where: { $0.id == currentProjectID })?.checkpoints.count ?? 0
    }

    // MARK: - 项目 CRUD

    func createProject(name: String? = nil) {
        saveCurrentProjectSnapshot()
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let projectName = trimmed.isEmpty ? "新项目 \(allProjects.count + 1)" : trimmed
        let fresh = Project(id: UUID(), name: projectName, createdAt: Date(), snapshot: Self.emptySnapshot())
        allProjects.append(fresh)
        currentProjectID = fresh.id
        apply(snapshot: fresh.snapshot)
        resetTransientNavigation()
        recomputeAvailability()
        restoreVisibleVerificationReviews()
        persist()
    }

    func switchProject(_ id: UUID) {
        guard id != currentProjectID, let project = allProjects.first(where: { $0.id == id }) else { return }
        let cancelled = cancelActiveAPIRequests()
        saveCurrentProjectSnapshot()
        currentProjectID = id
        apply(snapshot: project.snapshot)
        resetTransientNavigation()
        recomputeAvailability()
        restoreVisibleVerificationReviews()
        if cancelled > 0 {
            modelAPIStatus = "切换项目前已取消 \(cancelled) 个 Agent 任务；原项目的待处理请求已保留。"
            modelAPIStatusIsError = false
        }
        persist()
    }

    func renameProject(_ id: UUID, name: String) {
        guard let index = allProjects.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        allProjects[index].name = trimmed
        persist()
    }

    func archiveProject(_ id: UUID) {
        guard let index = allProjects.firstIndex(where: { $0.id == id }) else { return }
        if currentProjectID == id {
            _ = cancelActiveAPIRequests()
            saveCurrentProjectSnapshot()
        }
        let archived = allProjects.remove(at: index)
        archivedProjects.append(archived)
        if currentProjectID == id {
            if let next = allProjects.first {
                currentProjectID = next.id
                apply(snapshot: next.snapshot)
            } else {
                let fresh = Project(id: UUID(), name: "新项目", createdAt: Date(), snapshot: Self.emptySnapshot())
                allProjects = [fresh]
                currentProjectID = fresh.id
                apply(snapshot: fresh.snapshot)
            }
            resetTransientNavigation()
            recomputeAvailability()
            restoreVisibleVerificationReviews()
        }
        persist()
    }

    func restoreMostRecentlyArchivedProject() {
        guard let restored = archivedProjects.popLast() else { return }
        _ = cancelActiveAPIRequests()
        saveCurrentProjectSnapshot()
        allProjects.append(restored)
        currentProjectID = restored.id
        apply(snapshot: restored.snapshot)
        resetTransientNavigation()
        recomputeAvailability()
        restoreVisibleVerificationReviews()
        transientMessage = "已恢复项目“\(restored.name)”。"
        persist()
    }

    func createCheckpoint(reason: String = "手动检查点") {
        saveCurrentProjectSnapshot()
        guard let index = allProjects.firstIndex(where: { $0.id == currentProjectID }) else { return }
        allProjects[index].checkpoints.append(WorkflowCheckpoint(
            id: UUID(),
            createdAt: Date(),
            reason: reason,
            snapshot: currentSnapshot()
        ))
        if allProjects[index].checkpoints.count > 10 {
            allProjects[index].checkpoints.removeFirst(allProjects[index].checkpoints.count - 10)
        }
        transientMessage = "已创建可恢复检查点。"
        persist()
    }

    func restoreLatestCheckpoint() {
        guard let index = allProjects.firstIndex(where: { $0.id == currentProjectID }),
              let checkpoint = allProjects[index].checkpoints.popLast() else { return }
        _ = cancelActiveAPIRequests()
        apply(snapshot: checkpoint.snapshot)
        resetTransientNavigation()
        recomputeAvailability()
        restoreVisibleVerificationReviews()
        transientMessage = "已恢复检查点：\(checkpoint.reason)。"
        persist()
    }

    private func apply(snapshot: WorkflowSnapshot) {
        phase = snapshot.phase
        requirement = snapshot.requirement
        steps = snapshot.steps
        selectedStepID = snapshot.selectedStepID ?? snapshot.steps.first?.id
        isPaused = snapshot.isPaused
        decisionLog = snapshot.decisionLog
        sharedContext = snapshot.sharedContext
        agentSessions = snapshot.agentSessions
        pendingBridgeRequests = snapshot.pendingBridgeRequests
        requirementAttachments = snapshot.requirementAttachments ?? []
        requirementDirectives = snapshot.requirementDirectives ?? []
    }

    private func resetTransientNavigation() {
        selectedConversationID = nil
        isShowingSharedContext = false
        isShowingDeliverable = false
        selectedConfiguration = nil
        handoffDraft = nil
        bridgeError = nil
        planValidationIssues = []
        transientMessage = nil
    }

    private func currentSnapshot() -> WorkflowSnapshot {
        WorkflowSnapshot(
            phase: phase,
            requirement: requirement,
            steps: steps,
            selectedStepID: selectedStepID,
            isPaused: isPaused,
            decisionLog: decisionLog,
            sharedContext: sharedContext,
            agentSessions: agentSessions,
            pendingBridgeRequests: pendingBridgeRequests,
            requirementAttachments: requirementAttachments,
            requirementDirectives: requirementDirectives
        )
    }

    private func saveCurrentProjectSnapshot() {
        guard let index = allProjects.firstIndex(where: { $0.id == currentProjectID }) else { return }
        allProjects[index].snapshot = currentSnapshot()
    }

    private func checkpointCurrentProjectIfMeaningful(reason: String) {
        guard phase != .intake || !requirement.isEmpty || !steps.isEmpty || !pendingBridgeRequests.isEmpty,
              let index = allProjects.firstIndex(where: { $0.id == currentProjectID }) else { return }
        let snapshot = currentSnapshot()
        allProjects[index].snapshot = snapshot
        allProjects[index].checkpoints.append(WorkflowCheckpoint(
            id: UUID(),
            createdAt: Date(),
            reason: reason,
            snapshot: snapshot
        ))
        if allProjects[index].checkpoints.count > 10 {
            allProjects[index].checkpoints.removeFirst(allProjects[index].checkpoints.count - 10)
        }
    }

    var selectedStep: WorkflowStep? {
        guard let selectedStepID else { return nil }
        return steps.first { $0.id == selectedStepID }
    }

    var approvedCount: Int {
        steps.filter { $0.status == .approved }.count
    }

    var progress: Double {
        guard !steps.isEmpty else { return 0 }
        return Double(approvedCount) / Double(steps.count)
    }

    var planningProgress: Double {
        guard !agentSessions.isEmpty else { return phase == .workspace ? 1 : 0 }
        return agentSessions.map(\.progress).reduce(0, +) / Double(agentSessions.count)
    }

    var activeAgentCount: Int {
        agentSessions.filter { $0.status == .planning || $0.status == .waiting }.count
    }

    var workspaceRootPath: String {
        let configured = modelAPISettings.harnessWorkingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if !configured.isEmpty {
            return NSString(string: configured).expandingTildeInPath
        }
        let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        if FileManager.default.fileExists(atPath: current.appendingPathComponent("Package.swift").path) {
            return current.path
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/LoopCanvas", isDirectory: true).path
    }

    /// 工作目录按「项目/步骤」分层：每个项目一个目录，项目内每步一个子目录，避免并行步骤互相覆盖，
    /// 也让 DSH 会话按项目分组（会话目录以工作目录为 key），防止不同项目对话混在一起。
    private func harnessWorkingDirectory(for request: CodexBridgeRequest) -> URL {
        let base = URL(fileURLWithPath: workspaceRootPath).appendingPathComponent("Deliverables", isDirectory: true)
        let projectID = (currentProjectID ?? request.agentID)?.uuidString.lowercased() ?? "default"
        let projectDir = base.appendingPathComponent(projectID, isDirectory: true)
        guard let stepID = request.targetStepID else {
            return projectDir.appendingPathComponent("_planning", isDirectory: true)
        }
        return projectDir.appendingPathComponent(stepID.uuidString.lowercased(), isDirectory: true)
    }

    /// 产物根目录校验边界：agent 的 projectRoot 必须落在 Deliverables 目录内（宽松到项目共享/旧目录，但阻止写到数据区之外）。
    var deliverableBoundary: URL {
        URL(fileURLWithPath: workspaceRootPath).appendingPathComponent("Deliverables", isDirectory: true)
    }

    /// 当前项目的 AGENTS.md（每个项目独立，存放在各自项目目录下）。
    var projectAGENTSURL: URL {
        let projectID = (currentProjectID?.uuidString.lowercased()) ?? "default"
        return URL(fileURLWithPath: workspaceRootPath)
            .appendingPathComponent("Deliverables", isDirectory: true)
            .appendingPathComponent(projectID, isDirectory: true)
            .appendingPathComponent("AGENTS.md")
    }

    /// 从当前项目的 AGENTS.md 提取「## 项目宪法」章节；缺失则退回内置默认宪法。
    var currentProjectConstitution: String {
        guard let text = try? String(contentsOf: projectAGENTSURL, encoding: .utf8) else {
            return AgentFileStore.projectConstitution
        }
        let extracted = Self.extractSection(named: "项目宪法", from: text)
        return extracted.isEmpty ? AgentFileStore.projectConstitution : extracted
    }

    private static func extractSection(named name: String, from text: String) -> String {
        var result: [String] = []
        var inSection = false
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("## ") {
                if inSection { break }
                if trimmed.contains(name) { inSection = true }
                continue
            }
            if inSection { result.append(line) }
        }
        return result.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var transportDisplayName: String {
        switch modelAPISettings.mode {
        case .deepSeekHarness: "DeepSeek Harness"
        case .codexAppServer: "Codex App Server"
        }
    }

    var pendingBridgeCount: Int { pendingBridgeRequests.count }
    var hasAPIRequestInFlight: Bool { !apiRequestsInFlight.isEmpty }

    var currentArtifact: DeliverableArtifact? {
        for step in steps.reversed() where step.status == .review || step.status == .approved {
            if let artifact = step.result?.artifact { return artifact }
        }
        return nil
    }

    var allowsHTTPSRemoteArtifactResources: Bool {
        steps.contains { ArtifactValidator.optionAllowsHTTPSRemoteResources($0.selectedOption) }
    }

    var hasCompletePlan: Bool {
        planIssues(for: steps).isEmpty
    }

    var isDeliverableReady: Bool {
        !steps.isEmpty
            && approvedCount == steps.count
            && pendingBridgeRequests.isEmpty
            && hasCompletePlan
            && currentArtifact != nil
    }

    var currentStepTitle: String {
        if isPaused { return "任务已暂停 · Agent 任务已停止，待处理请求仍保留" }
        if isDeliverableReady { return "可交付成品已由用户确认" }
        if !steps.isEmpty, pendingBridgeRequests.isEmpty, approvedCount == steps.count { return "步骤已确认，但仍缺少可交付成品" }
        return steps.first { $0.status == .review }?.title
            ?? steps.first { $0.status == .ready || $0.status == .stale }?.title
            ?? (activeAgentCount > 0 ? "其他对话仍在规划" : "等待依赖完成")
    }

    var sharedContextMarkdown: String {
        var lines = [
            "# LoopCanvas 共享上下文",
            "",
            "## 用户需求",
            requirement.isEmpty ? "（尚未输入）" : requirement,
            "",
            "## 上下文时间线"
        ]
        for entry in sharedContext.reversed() {
            lines.append("- [\(Self.contextDateFormatter.string(from: entry.date))] **\(entry.author)** / \(entry.kind.rawValue): \(entry.content)")
        }
        return lines.joined(separator: "\n")
    }

    func startPlanning(requirement rawRequirement: String, attachments: [InputAttachment] = []) {
        let normalized = rawRequirement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            transientMessage = "请先写下你真正想完成的事情。"
            return
        }

        if phase != .intake || !requirement.isEmpty || !steps.isEmpty {
            _ = cancelActiveAPIRequests()
            checkpointCurrentProjectIfMeaningful(reason: "重新规划前自动保存")
        }

        requirement = normalized
        if let index = allProjects.firstIndex(where: { $0.id == currentProjectID }),
           allProjects[index].name.hasPrefix("新项目") {
            allProjects[index].name = Self.deriveProjectName(from: normalized)
        }
        requirementAttachments = attachments
        requirementDirectives = RequirementAnalyzer.directives(in: normalized)
        planValidationIssues = []
        phase = .building
        steps = []
        selectedStepID = nil
        isPaused = false
        handoffDraft = nil
        decisionLog = [
            DecisionLogEntry(
                id: UUID(), date: Date(), stepID: nil,
                title: "收到用户需求",
                detail: "一次生成从需求到交付的完整计划，再逐步执行与验收。",
                kind: .system
            )
        ]
        sharedContext = [
            SharedContextEntry(
                id: UUID(), date: Date(), author: "用户", stepID: nil,
                kind: .user, content: normalized
            )
        ]
        agentSessions = Self.makeAgentSessions()
        pendingBridgeRequests = []
        bridgeError = nil
        selectedConversationID = nil
        isShowingSharedContext = false
        isShowingDeliverable = false
        enqueuePlanningRequest(
            kind: .planFirstStep,
            agentIndex: 0,
            focus: "一次生成从需求到最终交付的完整计划。输出 6–10 个按真实依赖排列的步骤，必须覆盖需求/技术决策、实际制作、集成、验证和最终交付；不能只列决策步骤。允许无依赖分支并行，禁止为排成直线虚构依赖。每一步给出 2–3 个真正不同的执行方案；若用户明确提出方案，必须保留原意并放在对应 options 第一项。"
        )
        persist()
    }

    func resetToIntake() {
        _ = cancelActiveAPIRequests()
        checkpointCurrentProjectIfMeaningful(reason: "返回需求输入前自动保存")
        phase = .intake
        requirement = ""
        steps = []
        selectedStepID = nil
        isPaused = false
        decisionLog = []
        sharedContext = []
        agentSessions = []
        pendingBridgeRequests = []
        requirementAttachments = []
        requirementDirectives = []
        planValidationIssues = []
        selectedConfiguration = nil
        bridgeError = nil
        selectedConversationID = nil
        isShowingSharedContext = false
        isShowingDeliverable = false
        handoffDraft = nil
        transientMessage = nil
        persist()
    }

    func selectStep(_ id: UUID) {
        selectedStepID = id
        persist()
    }

    func selectOption(_ optionID: UUID, for stepID: UUID) {
        guard let index = index(of: stepID), steps[index].status != .locked else { return }
        steps[index].selectedOptionID = optionID
        let optionTitle = steps[index].selectedOption?.title ?? "未知方案"
        appendLog(stepID: stepID, title: "选择方案：\(optionTitle)", detail: "执行并验收后才会成为已确认决策。", kind: .decision)
        appendContext(author: "主窗口 / 用户", stepID: stepID, kind: .decision, content: "为「\(steps[index].title)」选择方案「\(optionTitle)」。")
        persist()
    }

    @discardableResult
    func beginExecution(stepID: UUID? = nil) -> UUID? {
        let targetID = stepID ?? selectedStepID
        guard !isPaused,
              let targetID,
              let index = index(of: targetID),
              steps[index].selectedOptionID != nil,
              steps[index].status == .ready || steps[index].status == .stale,
              dependenciesAreApproved(for: steps[index]) else {
            transientMessage = isPaused ? "工作流已暂停，继续后才能执行。" : "请先选择方案并完成所有依赖。"
            return nil
        }

        steps[index].status = .running
        steps[index].result = nil
        appendLog(stepID: targetID, title: "开始单步执行", detail: "只执行「\(steps[index].title)」，不会自动进入下一步。", kind: .execution)
        appendContext(author: "执行对话", stepID: targetID, kind: .system, content: "开始执行「\(steps[index].title)」，等待生成可验收结果。")
        persist()
        return targetID
    }

    func runSelectedStep() {
        guard let stepID = beginExecution() else { return }
        guard let index = index(of: stepID) else { return }
        let step = steps[index]
        let request = makeBridgeRequest(
            kind: .executeStep,
            agentID: selectedConversationID,
            targetStepID: stepID,
            focus: "只执行当前步骤「\(step.title)」（阶段：\(effectiveKind(for: step)?.rawValue ?? "unknown")；requires_artifact=\(stepRequiresArtifact(step))）所选方案「\(step.selectedOption?.title ?? "未选择")」。不要继续后续步骤。返回可供用户验收的结果卡。",
            selectedOption: step.selectedOption,
            feedback: step.lastFeedback
        )
        enqueue(request, agentIndex: nil)
        persist()
    }

    func receiveAgentResponse(_ response: CodexBridgeResponse) {
        guard !isPaused,
              let request = pendingBridgeRequests.first(where: { $0.id == response.requestID }) else {
            bridgeError = "收到无法匹配当前待处理请求的 Agent 回复。"
            return
        }
        applyBridgeResponse(response, to: request)
        pendingBridgeRequests.removeAll { $0.id == request.id }
        persist()
    }

    func approve(stepID: UUID) {
        guard let index = index(of: stepID), steps[index].status == .review else { return }
        if let artifact = steps[index].result?.artifact {
            let issues = ArtifactValidator.blockingIssues(
                for: artifact,
                allowHTTPSRemoteResources: allowsHTTPSRemoteArtifactResources
            )
            guard issues.isEmpty else {
                bridgeError = "当前产物不能验收：\(issues.joined(separator: "；"))"
                transientMessage = bridgeError
                return
            }
        }
        if effectiveKind(for: steps[index]) == .verify {
            let result = steps[index].result
            let issues = result?.blockingIssues ?? []
            guard result?.verificationPassed == true, issues.isEmpty else {
                bridgeError = "当前验证不能验收：\(issues.isEmpty ? "没有明确通过真实验证" : issues.joined(separator: "；"))"
                transientMessage = bridgeError
                return
            }
        }
        steps[index].status = .approved
        appendLog(stepID: stepID, title: "用户接受结果", detail: "第 \(steps[index].revision) 版已锁定。", kind: .decision)
        appendContext(author: "主窗口 / 用户", stepID: stepID, kind: .decision, content: "接受「\(steps[index].title)」第 \(steps[index].revision) 版结果。")
        recomputeAvailability()
        moveSelectionToNextActionable(after: index)
        persist()
    }

    func requestRevision(stepID: UUID, feedback: String) {
        guard let index = index(of: stepID), steps[index].status == .review else { return }
        let normalized = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        steps[index].revision += 1
        steps[index].status = .ready
        steps[index].result = nil
        steps[index].lastFeedback = normalized.isEmpty ? "用户要求调整当前结果。" : normalized
        markDescendantsStale(of: stepID)
        appendLog(stepID: stepID, title: "用户要求修改", detail: steps[index].lastFeedback ?? "未提供具体说明", kind: .revision)
        appendContext(author: "主窗口 / 用户", stepID: stepID, kind: .correction, content: "修正「\(steps[index].title)」：\(steps[index].lastFeedback ?? "需要调整")")
        recomputeAvailability()
        persist()
    }

    func returnVerificationFailureToRepair(stepID: UUID, feedback: String) {
        guard let verificationIndex = index(of: stepID),
              effectiveKind(for: steps[verificationIndex]) == .verify,
              steps[verificationIndex].status == .review,
              let result = steps[verificationIndex].result,
              result.verificationPassed != true || !(result.blockingIssues ?? []).isEmpty else { return }

        let userNote = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        let reportedIssues = (result.blockingIssues ?? []).joined(separator: "；")
        let repairDetail = [reportedIssues, userNote]
            .filter { !$0.isEmpty }
            .joined(separator: "；补充：")
        guard let repairIndex = nearestApprovedArtifactAncestorIndex(of: stepID) else {
            transientMessage = "没有找到可返回修复的上游产物步骤；请重新验证并补充具体问题。"
            return
        }

        let repairStepID = steps[repairIndex].id
        steps[repairIndex].revision += 1
        steps[repairIndex].status = .ready
        steps[repairIndex].result = nil
        steps[repairIndex].lastFeedback = repairDetail.isEmpty
            ? "验证未通过，请修复后重新执行。"
            : "验证未通过：\(repairDetail)"
        markDescendantsStale(of: repairStepID)
        selectedStepID = repairStepID
        bridgeError = nil
        appendLog(
            stepID: repairStepID,
            title: "验证失败，返回上游修复",
            detail: steps[repairIndex].lastFeedback ?? "验证未通过",
            kind: .revision
        )
        appendContext(
            author: "主窗口 / 用户",
            stepID: repairStepID,
            kind: .correction,
            content: "验证「\(steps[verificationIndex].title)」未通过，返回「\(steps[repairIndex].title)」修复：\(repairDetail.isEmpty ? "未提供补充说明" : repairDetail)"
        )
        recomputeAvailability()
        persist()
    }

    func reopenApprovedStep(stepID: UUID, feedback: String = "") {
        guard let index = index(of: stepID), steps[index].status == .approved else { return }
        let normalized = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        steps[index].revision += 1
        steps[index].status = .ready
        steps[index].result = nil
        steps[index].lastFeedback = normalized.isEmpty ? "用户重新打开已通过步骤。" : normalized
        markDescendantsStale(of: stepID)
        appendLog(stepID: stepID, title: "重新打开已确认步骤", detail: "受影响的下游已标记为需复核。", kind: .revision)
        appendContext(author: "主窗口 / 用户", stepID: stepID, kind: .correction, content: "重新打开「\(steps[index].title)」：\(steps[index].lastFeedback ?? "需要修改")")
        recomputeAvailability()
        persist()
    }

    func submitStepFeedback(stepID: UUID, feedback: String) {
        guard let index = index(of: stepID) else { return }
        switch steps[index].status {
        case .review:
            requestRevision(stepID: stepID, feedback: feedback)
        case .approved:
            reopenApprovedStep(stepID: stepID, feedback: feedback)
        default:
            break
        }
    }

    func rollback(stepID: UUID) {
        guard let index = index(of: stepID), steps[index].status != .locked else { return }
        let hadApprovedResult = steps[index].status == .approved
        steps[index].revision += 1
        steps[index].status = dependenciesAreApproved(for: steps[index]) ? .ready : .locked
        steps[index].selectedOptionID = nil
        steps[index].result = nil
        steps[index].lastFeedback = "本步骤已回退到未选择方案状态。"
        if hadApprovedResult || !downstreamIDs(of: stepID).isEmpty { markDescendantsStale(of: stepID) }
        appendLog(stepID: stepID, title: "回退当前步骤", detail: "目标、计划和决策历史仍然保留。", kind: .revision)
        appendContext(author: "主窗口 / 用户", stepID: stepID, kind: .correction, content: "回退「\(steps[index].title)」到未选择方案状态。")
        recomputeAvailability()
        persist()
    }

    func togglePause() {
        if !isPaused {
            isPaused = true
            let cancelledCount = cancelActiveAPIRequests()
            let detail = cancelledCount > 0
                ? "已取消 \(cancelledCount) 个正在进行的 Agent 任务；待处理请求保留。双版本交接文档已生成但没有写入磁盘。"
                : "当前没有正在进行的 Agent 任务；待处理请求保留。双版本交接文档已生成但没有写入磁盘。"
            modelAPIStatus = cancelledCount > 0
                ? "任务已暂停；已取消 \(cancelledCount) 个 Agent 任务。恢复后请重新发送待处理请求。"
                : "任务已暂停；不会发送或导入新响应。"
            modelAPIStatusIsError = false
            appendLog(stepID: nil, title: "任务已真正暂停", detail: detail, kind: .system)
            appendContext(author: "系统", stepID: nil, kind: .system, content: "任务暂停；活动 Agent 任务已取消，待处理请求保留，并创建 Agent 版与人类版内存交接快照。")
            generateHandoffDraft()
        } else {
            isPaused = false
            let pendingCount = pendingBridgeRequests.count
            modelAPIStatus = pendingCount > 0
                ? "任务已恢复；\(pendingCount) 个待处理请求尚未重发，请确认后点击重新发送。"
                : "任务已恢复；后台规划对话与当前步骤可以继续。"
            modelAPIStatusIsError = false
            appendLog(stepID: nil, title: "任务已恢复", detail: pendingCount > 0 ? "保留 \(pendingCount) 个待处理请求；未自动重发。" : "当前没有待处理模型请求。", kind: .system)
            appendContext(author: "系统", stepID: nil, kind: .system, content: "任务恢复；为避免重复计费，暂停期间取消的请求没有自动重发。")
        }
        persist()
    }

    func dismissHandoff() {
        handoffDraft = nil
    }

    /// 从执行按钮继续：解除暂停并重发待处理请求（DeepSeek Harness 模式会自动重新提交）。
    func resumePausedExecution() {
        guard isPaused else { return }
        isPaused = false
        appendLog(stepID: nil, title: "从执行按钮继续", detail: "解除暂停并重发待处理请求。", kind: .system)
        appendContext(author: "系统", stepID: nil, kind: .system, content: "从执行按钮恢复任务并重发待处理请求。")
        retryPendingAPIRequests()
        persist()
    }

    func agent(_ id: UUID) -> AgentSession? {
        agentSessions.first { $0.id == id }
    }

    func showMainLoop() {
        selectedConversationID = nil
        isShowingSharedContext = false
        isShowingDeliverable = false
        selectedConfiguration = nil
    }

    func showAgentConversation(_ id: UUID) {
        guard agentSessions.contains(where: { $0.id == id }) else { return }
        selectedConversationID = id
        isShowingSharedContext = false
        isShowingDeliverable = false
        selectedConfiguration = nil
    }

    func showSharedContext() {
        selectedConversationID = nil
        isShowingSharedContext = true
        isShowingDeliverable = false
        selectedConfiguration = nil
    }

    func showDeliverable() {
        selectedConversationID = nil
        isShowingSharedContext = false
        isShowingDeliverable = true
        selectedConfiguration = nil
    }

    func showConfiguration(_ surface: ConfigurationSurface) {
        selectedConversationID = nil
        isShowingSharedContext = false
        isShowingDeliverable = false
        selectedConfiguration = surface
    }

    func saveModelAPISettings(_ settings: ModelAPISettings) {
        do {
            switch settings.mode {
            case .deepSeekHarness:
                try DeepSeekHarnessTransport.validate(settings: settings)
            case .codexAppServer:
                try CodexAppServerTransport.validate(settings: settings)
            }
            if shouldPersist { try ModelAPISettingsPersistence.save(settings) }
            modelAPISettings = settings
            modelAPIStatus = switch settings.mode {
            case .deepSeekHarness:
                "DeepSeek Harness 已启用；后续规划与每一步执行都会交给本机 `dsh --profile headless` 完成。"
            case .codexAppServer:
                "Codex App Server 已启用；后续请求使用本地 stdio、workspace-write 沙盒且不自动批准越权操作。"
            }
            modelAPIStatusIsError = false
            for request in pendingBridgeRequests { dispatchAgentRequest(request) }
        } catch {
            modelAPIStatus = error.localizedDescription
            modelAPIStatusIsError = true
        }
    }

    func testDeepSeekHarness(_ settings: ModelAPISettings) async {
        isTestingModelAPI = true
        defer { isTestingModelAPI = false }
        do {
            let result = try await harnessTransport.probe(settings: settings)
            modelAPIStatus = "检测到 dsh \(result.version)（\(result.executablePath)）：\(result.compatibilityDetail)"
            modelAPIStatusIsError = !result.supportsLoopCanvasExecution
        } catch {
            modelAPIStatus = error.localizedDescription
            modelAPIStatusIsError = true
        }
    }

    func testCodexAppServer(_ settings: ModelAPISettings) async {
        isTestingModelAPI = true
        defer { isTestingModelAPI = false }
        do {
            let result = try await codexTransport.probe(settings: settings)
            modelAPIStatus = "检测到 Codex \(result.version)（\(result.executablePath)）：\(result.compatibilityDetail)"
            modelAPIStatusIsError = !result.supportsAppServer
        } catch {
            modelAPIStatus = error.localizedDescription
            modelAPIStatusIsError = true
        }
    }

    func surfacePendingAPIRequestsIfNeeded() {
        guard !pendingBridgeRequests.isEmpty,
              apiRequestsInFlight.isEmpty else { return }
        modelAPIStatus = isPaused
            ? "任务已暂停；\(pendingBridgeRequests.count) 个待处理请求已保留，不会自动发送。"
            : "已恢复 \(pendingBridgeRequests.count) 个待处理请求；点击重新发送后才会启动当前传输。"
        modelAPIStatusIsError = false
    }

    func retryPendingAPIRequests() {
        guard !isPaused else {
            transientMessage = "任务仍处于暂停状态；请先点击继续，再重新发送待处理请求。"
            return
        }
        for index in pendingBridgeRequests.indices {
            let request = pendingBridgeRequests[index]
            let refreshed = CodexBridgeRequest(
                id: request.id,
                createdAt: request.createdAt,
                kind: request.kind,
                agentID: request.agentID,
                targetStepID: request.targetStepID,
                userGoal: request.userGoal,
                focus: request.focus,
                modelPolicy: request.modelPolicy,
                projectConstitution: request.projectConstitution ?? AgentFileStore.projectConstitution,
                sharedContext: request.sharedContext,
                existingSteps: request.existingSteps,
                selectedOption: request.selectedOption,
                userFeedback: request.userFeedback,
                currentArtifact: request.currentArtifact,
                responseInstructions: responseInstructions(
                    for: request.kind,
                    selectedOption: request.selectedOption
                ),
                attachments: request.attachments,
                requirementDirectives: request.requirementDirectives
            )
            pendingBridgeRequests[index] = refreshed
            dispatchAgentRequest(refreshed)
        }
        persist()
    }

    func stageAttachment(
        data: Data,
        suggestedName: String,
        source: String,
        existingAttachments: [InputAttachment] = []
    ) -> InputAttachment? {
        do {
            return try fileStore.stageAttachment(
                data: data,
                suggestedName: suggestedName,
                source: source,
                existingByteCount: existingAttachments.reduce(0) { $0 + $1.byteCount },
                existingHashes: Set(existingAttachments.map(\.sha256))
            )
        }
        catch {
            transientMessage = "附件暂存失败：\(error.localizedDescription)"
            return nil
        }
    }

    func discardStagedAttachment(_ attachment: InputAttachment) {
        do {
            try fileStore.discardAttachment(attachment)
        } catch {
            transientMessage = "附件移除失败：\(error.localizedDescription)"
        }
    }

    func restoreText(from attachment: InputAttachment) -> String? {
        guard attachment.kind != .image, attachment.kind != .pdf else { return nil }
        return try? String(contentsOfFile: attachment.localPath, encoding: .utf8)
    }

    func moveStep(_ draggedID: UUID, before targetID: UUID) -> Bool {
        guard draggedID != targetID, let sourceIndex = index(of: draggedID), let targetIndex = index(of: targetID) else { return false }
        var candidate = steps
        let item = candidate.remove(at: sourceIndex)
        let adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
        candidate.insert(item, at: adjustedTarget)
        guard isValidTopologicalOrder(candidate) else {
            transientMessage = "这次移动会破坏步骤依赖，顺序已保持不变。"
            return false
        }
        steps = candidate
        transientMessage = "顺序已调整；依赖关系没有改变。"
        appendLog(stepID: draggedID, title: "调整可互换步骤顺序", detail: "新排列仍满足全部依赖。", kind: .system)
        appendContext(author: "主窗口 / 用户", stepID: draggedID, kind: .decision, content: "调整步骤显示顺序；拓扑依赖保持有效。")
        persist()
        return true
    }

    func isReorderable(_ stepID: UUID) -> Bool {
        guard steps.contains(where: { $0.id == stepID }) else { return false }
        return steps.contains { other in
            other.id != stepID && !isDownstream(other.id, of: stepID) && !isDownstream(stepID, of: other.id)
        }
    }

    func dependenciesAreApproved(for step: WorkflowStep) -> Bool {
        effectiveDependencies(for: step).allSatisfy { dependencyID in
            steps.first(where: { $0.id == dependencyID })?.status == .approved
        }
    }

    func effectiveDependencies(for step: WorkflowStep) -> [UUID] {
        guard isLegacyMultiConversationPlan else { return step.dependencies }
        guard let index = steps.firstIndex(where: { $0.id == step.id }), index > 0 else { return [] }
        return [steps[index - 1].id]
    }

    func effectiveKind(for step: WorkflowStep) -> WorkflowStepKind? {
        if let kind = step.kind { return kind }
        guard isLegacyMultiConversationPlan else { return nil }
        let text = "\(step.title) \(step.purpose)".lowercased()
        if text.contains("交付") || text.contains("发布") { return .deliver }
        if text.contains("验证") || text.contains("测试") || text.contains("验收") || text.contains("fps") { return .verify }
        if text.contains("集成") || text.contains("整合") || text.contains("接入") { return .integrate }
        if text.contains("制作") || text.contains("构建") || text.contains("创建") || text.contains("实现") || text.contains("建模") || text.contains("原型") { return .build }
        return .decision
    }

    func stepRequiresArtifact(_ step: WorkflowStep) -> Bool {
        effectiveKind(for: step)?.requiresArtifact ?? false
    }

    func stepKindWasInferred(_ step: WorkflowStep) -> Bool {
        step.kind == nil && effectiveKind(for: step) != nil
    }

    private var isLegacyMultiConversationPlan: Bool {
        !steps.isEmpty && steps.allSatisfy { $0.kind == nil }
    }

    private func enqueuePlanningRequest(kind: CodexBridgeRequestKind, agentIndex: Int, focus: String) {
        guard agentSessions.indices.contains(agentIndex) else { return }
        let request = makeBridgeRequest(kind: kind, agentID: agentSessions[agentIndex].id, targetStepID: nil, focus: focus, selectedOption: nil, feedback: nil)
        enqueue(request, agentIndex: agentIndex)
    }

    private func makeBridgeRequest(kind: CodexBridgeRequestKind, agentID: UUID?, targetStepID: UUID?, focus: String, selectedOption: PlanOption?, feedback: String?) -> CodexBridgeRequest {
        return CodexBridgeRequest(
            id: UUID(), createdAt: Date(), kind: kind, agentID: agentID, targetStepID: targetStepID,
            userGoal: requirement, focus: focus, modelPolicy: AgentFileStore.harnessModelPolicy,
            projectConstitution: currentProjectConstitution,
            sharedContext: sharedContextMarkdown,
            existingSteps: steps.map {
                CodexBridgeStepSummary(
                    id: $0.id,
                    title: $0.title,
                    purpose: $0.purpose,
                    status: $0.status,
                    kind: effectiveKind(for: $0),
                    dependencies: effectiveDependencies(for: $0)
                )
            },
            selectedOption: selectedOption, userFeedback: feedback, currentArtifact: currentArtifact,
            responseInstructions: responseInstructions(for: kind, selectedOption: selectedOption),
            attachments: requirementAttachments,
            requirementDirectives: requirementDirectives
        )
    }

    private func enqueue(_ request: CodexBridgeRequest, agentIndex: Int?) {
        pendingBridgeRequests.append(request)
        if let agentIndex, agentSessions.indices.contains(agentIndex) {
            agentSessions[agentIndex].status = .waiting
            agentSessions[agentIndex].notes.append("请求 \(request.id.uuidString.prefix(8)) 已发送到\(transportDisplayName)，等待回复。")
        }
        appendLog(stepID: request.targetStepID, title: "已发送\(transportDisplayName)请求", detail: "\(request.kind.rawValue) · \(request.id.uuidString)", kind: .system)
        if automaticallyDispatchRequests { dispatchAgentRequest(request) }
    }

    private func dispatchAgentRequest(_ request: CodexBridgeRequest) {
        guard !isPaused,
              !apiRequestsInFlight.contains(request.id) else { return }
        let operationToken = UUID()
        apiRequestsInFlight.insert(request.id)
        apiRequestTokens[request.id] = operationToken
        let settings = modelAPISettings
        let startedAt = Date()
        bridgeError = nil
        let transportName = transportDisplayName
        modelAPIStatus = "请求 \(request.id.uuidString.prefix(8)) 已提交到\(transportName)，正在等待响应。"
        modelAPIStatusIsError = false
        let operation = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.finishAPIRequest(request.id, token: operationToken) }
            do {
                let response: CodexBridgeResponse
                let sessionID: String?
                let conversation: [ConversationMessage]?
                switch settings.mode {
                case .deepSeekHarness:
                    let outcome = try await self.harnessTransport.send(
                        request,
                        settings: settings,
                        defaultWorkingDirectory: self.harnessWorkingDirectory(for: request),
                        deliverableBoundary: self.deliverableBoundary
                    )
                    response = outcome.response
                    sessionID = outcome.sessionID
                    conversation = outcome.conversation
                case .codexAppServer:
                    let outcome = try await self.codexTransport.send(
                        request,
                        settings: settings,
                        defaultWorkingDirectory: self.harnessWorkingDirectory(for: request),
                        deliverableBoundary: self.deliverableBoundary
                    )
                    response = outcome.response
                    sessionID = outcome.sessionID
                    conversation = outcome.conversation
                }
                try Task.checkCancellation()
                guard !self.isPaused,
                      self.apiRequestTokens[request.id] == operationToken else { return }
                if let stepID = request.targetStepID, let index = self.index(of: stepID) {
                    self.steps[index].conversationID = sessionID
                    self.steps[index].conversationMessages = conversation
                }
                let elapsed = Date().timeIntervalSince(startedAt)
                self.modelAPIStatus = "\(transportName)已回复请求 \(request.id.uuidString.prefix(8))，耗时 \(String(format: "%.1f", elapsed)) 秒。"
                self.modelAPIStatusIsError = false
                self.receiveAgentResponse(response)
            } catch {
                guard !Task.isCancelled,
                      !self.isPaused,
                      self.apiRequestTokens[request.id] == operationToken else { return }
                var message = "\(transportName)请求失败：\(error.localizedDescription)"
                if let decodingFailure = error as? ModelResponseDecodingFailure {
                    do {
                        let diagnosticURL = try self.fileStore.writeModelResponseDiagnostic(
                            requestID: request.id,
                            transport: transportName,
                            failure: decodingFailure
                        )
                        message += "；脱敏响应已保存到 \(diagnosticURL.path)"
                        self.appendLog(
                            stepID: request.targetStepID,
                            title: "Agent 响应解析失败",
                            detail: "脱敏诊断：\(diagnosticURL.path)",
                            kind: .system
                        )
                    } catch {
                        message += "；保存脱敏诊断失败：\(error.localizedDescription)"
                    }
                }
                self.bridgeError = message
                self.modelAPIStatus = message
                self.modelAPIStatusIsError = true
                if let stepID = request.targetStepID, let index = self.index(of: stepID), self.steps[index].status == .running {
                    self.steps[index].status = .ready
                }
                self.transientMessage = message + " 请求已保留；可修正 Agent 连接配置后重新发送。"
                self.persist()
            }
        }
        apiRequestTasks[request.id] = operation
    }

    @discardableResult
    private func cancelActiveAPIRequests() -> Int {
        let operations = apiRequestTasks
        apiRequestTasks.removeAll()
        apiRequestTokens.removeAll()
        apiRequestsInFlight.removeAll()
        for operation in operations.values { operation.cancel() }
        return operations.count
    }

    private func finishAPIRequest(_ requestID: UUID, token: UUID) {
        guard apiRequestTokens[requestID] == token else { return }
        apiRequestTasks.removeValue(forKey: requestID)
        apiRequestTokens.removeValue(forKey: requestID)
        apiRequestsInFlight.remove(requestID)
    }

    private func applyBridgeResponse(_ response: CodexBridgeResponse, to request: CodexBridgeRequest) {
        guard response.status == .success else {
            bridgeError = response.error ?? "Agent 返回失败但未提供原因。"
            if let stepID = request.targetStepID, let index = index(of: stepID) { steps[index].status = .ready }
            return
        }

        switch request.kind {
        case .planFirstStep, .planContinuation:
            let candidates = (response.steps ?? []).filter { candidate in !steps.contains(where: { $0.id == candidate.id }) }
            let newSteps = conservativelyLinkedPlanningSteps(candidates)
            let proposed = steps + newSteps.map {
                WorkflowStep(id: $0.id, title: $0.title, purpose: $0.purpose, dependencies: $0.dependencies, kind: $0.kind, status: .locked, options: $0.options, selectedOptionID: nil, result: nil, revision: 1, lastFeedback: nil, appliedDirectiveIDs: $0.appliedDirectiveIDs, riskLevel: $0.riskLevel, impactAnalysis: $0.impactAnalysis)
            }
            let issues = planIssues(for: proposed)
            guard issues.isEmpty else {
                planValidationIssues = issues
                bridgeError = "计划未通过结构校验，尚未进入执行区。"
                updateAgentValidationFailure(request: request, issues: issues)
                return
            }
            for candidate in newSteps {
                steps.append(WorkflowStep(id: candidate.id, title: candidate.title, purpose: candidate.purpose, dependencies: candidate.dependencies, kind: candidate.kind, status: .locked, options: candidate.options, selectedOptionID: nil, result: nil, revision: 1, lastFeedback: nil, appliedDirectiveIDs: candidate.appliedDirectiveIDs, riskLevel: candidate.riskLevel, impactAnalysis: candidate.impactAnalysis))
                appendContext(author: agentName(for: request.agentID), stepID: candidate.id, kind: .plan, content: "新增步骤「\(candidate.title)」：\(candidate.purpose)")
            }
            recomputeAvailability()
            updateAgentAfterResponse(request: request, producedStepIDs: newSteps.map(\.id), message: response.assistantMessage)

            if request.kind == .planFirstStep, let first = newSteps.first {
                phase = .workspace
                selectedStepID = first.id
                showMainLoop()
            }
        case .executeStep:
            guard let stepID = request.targetStepID, let index = index(of: stepID), let result = response.result else {
                bridgeError = "执行回复缺少 targetStepID 或 result。"
                return
            }
            if stepRequiresArtifact(steps[index]), result.artifact == nil {
                bridgeError = "当前产物型步骤必须返回可演示的 artifact，不能只返回文字结果。"
                steps[index].status = .ready
                return
            }
            if let artifact = result.artifact {
                let issues = ArtifactValidator.blockingIssues(
                    for: artifact,
                    allowHTTPSRemoteResources: allowsHTTPSRemoteArtifactResources
                )
                guard issues.isEmpty else {
                    steps[index].result = result
                    steps[index].status = .ready
                    bridgeError = "产物未通过本地可运行性检查：\(issues.joined(separator: "；"))"
                    appendLog(stepID: stepID, title: "产物校验失败", detail: issues.joined(separator: "；"), kind: .execution)
                    return
                }
            }
            if effectiveKind(for: steps[index]) == .verify {
                var issues = result.blockingIssues ?? []
                if let artifact = currentArtifact {
                    issues.append(contentsOf: ArtifactValidator.blockingIssues(
                        for: artifact,
                        allowHTTPSRemoteResources: allowsHTTPSRemoteArtifactResources
                    ))
                } else {
                    issues.append("当前没有可供验证的 artifact。")
                }
                steps[index].result = result
                steps[index].status = .review
                if result.verificationPassed != true || !issues.isEmpty {
                    let detail = issues.isEmpty ? "验证步骤没有明确返回 verificationPassed=true。" : issues.joined(separator: "；")
                    bridgeError = "验证未通过，后续步骤已阻止：\(detail)"
                    appendLog(stepID: stepID, title: "验证结果已返回：未通过", detail: detail, kind: .execution)
                    appendContext(author: "DeepSeek Harness", stepID: stepID, kind: .result, content: response.assistantMessage)
                    return
                }
            }
            steps[index].result = result
            steps[index].status = .review
            appendLog(stepID: stepID, title: "Harness 单步结果已返回", detail: "等待用户验收；不会自动进入下一步。", kind: .execution)
            appendContext(author: "DeepSeek Harness", stepID: stepID, kind: .result, content: response.assistantMessage)
        }
    }

    private func updateAgentAfterResponse(request: CodexBridgeRequest, producedStepIDs: [UUID], message: String) {
        guard let agentID = request.agentID, let index = agentSessions.firstIndex(where: { $0.id == agentID }) else { return }
        agentSessions[index].assignedStepIDs.append(contentsOf: producedStepIDs)
        agentSessions[index].notes.append(message)
        agentSessions[index].progress = 1
        agentSessions[index].status = .complete
    }

    private func conservativelyLinkedPlanningSteps(_ candidates: [CodexBridgeStep]) -> [CodexBridgeStep] {
        candidates
    }

    private func updateAgentValidationFailure(request: CodexBridgeRequest, issues: [String]) {
        guard let id = request.agentID, let index = agentSessions.firstIndex(where: { $0.id == id }) else { return }
        agentSessions[index].status = .waiting
        agentSessions[index].progress = 0.9
        agentSessions[index].notes.append("计划校验失败：\(issues.joined(separator: "；"))")
    }

    func retryPlanning() {
        guard phase == .building || !hasCompletePlan, pendingBridgeRequests.isEmpty else { return }
        planValidationIssues = []
        bridgeError = nil
        if agentSessions.isEmpty { agentSessions = Self.makeAgentSessions() }
        agentSessions[0].status = .waiting
        enqueuePlanningRequest(kind: .planFirstStep, agentIndex: 0, focus: "重新生成完整计划。修复上次所有结构问题，并严格遵守 responseInstructions、requirementDirectives 与附件清单。")
        persist()
    }

    private func agentName(for id: UUID?) -> String {
        guard let id else { return "DeepSeek Harness" }
        return agentSessions.first(where: { $0.id == id })?.name ?? "DeepSeek Harness"
    }

    private func responseInstructions(
        for kind: CodexBridgeRequestKind,
        selectedOption: PlanOption?
    ) -> String {
        switch kind {
        case .planFirstStep:
            return "返回 CodexBridgeResponse JSON。status=success；steps 为覆盖完整任务的 6–10 个步骤；result=null。每步结构为 {id(UUID),title,purpose,dependencies,kind,appliedDirectiveIDs,riskLevel,impactAnalysis,options}；kind 必须是 decision/build/integrate/verify/deliver 之一，必须覆盖五类，最后一步必须是 deliver。riskLevel 必须是 L0|L1|L2|L3：L0=文案/样式/小范围修正，L1=单模块功能，L2=跨模块/公共能力/数据变更，L3=安全/生产数据/基础设施/不可逆。impactAnalysis 为结构化对象，字段 {surfaceProblem(String),problemCategory(String),relatedScenarios([String]),isLocalPatch(Bool),scope(String:implement|reserve|degrade|unsupported),affectedModules([String]),requiresMainFlowChange(Bool)}，必须如实填写“是局部补丁还是统一能力缺失、哪些实现/预留/降级/不支持、影响哪些模块、后续同类需求是否改主流程”。dependencies 只能引用本回复更早步骤的 UUID，只声明真实输入依赖；独立步骤写空数组并可并行，禁止虚构直接前序依赖。每步 options 为 2–3 个且恰好一个 isRecommended=true，每项完整包含 {id(UUID),title,subtitle,technicalReason,advantages([String]),tradeoffs([String]),downstreamImpact,isRecommended(Bool),origin(userExplicit|userInferred|model),matchedDirectiveIDs([UUID]),rankReason(String)}。用户明确提出的方案必须保持原意、放在对应步骤第一项并标记 userExplicit；硬约束不是可选方案，必须由 appliedDirectiveIDs 标明落实位置。不要只规划选择，制作、集成、验证与交付都必须成为可执行步骤。不要输出 JSON 之外的文本。"
        case .planContinuation:
            return "返回 CodexBridgeResponse JSON。status=success；steps 为 1–2 个步骤；result=null。每步结构为 {id(UUID),title,purpose,dependencies,riskLevel,impactAnalysis,options}；dependencies 只能引用 existingSteps 或本回复较早步骤的 UUID。riskLevel 为 L0|L1|L2|L3；impactAnalysis 字段 {surfaceProblem,problemCategory,relatedScenarios([String]),isLocalPatch(Bool),scope,affectedModules([String]),requiresMainFlowChange(Bool)}。每步 2–3 个 options，每项完整包含 {id(UUID),title,subtitle,technicalReason,advantages([String]),tradeoffs([String]),downstreamImpact,isRecommended(Bool)}。不要输出 JSON 之外的文本。"
        case .executeStep:
            let allowsRemote = allowsHTTPSRemoteArtifactResources
                || ArtifactValidator.optionAllowsHTTPSRemoteResources(selectedOption)
            let dependencyRule = allowsRemote
                ? "用户所选方案明确允许 CDN：仅可引用固定的 HTTPS CDN 脚本或 ES Module，并在 dependencies 中记录完整 URL；禁止 HTTP、远程图片和业务网络 API。不要内嵌或复制 Three.js 第三方库源码。"
                : "artifact 必须自包含且可离线预览，不得引用 CDN、远程脚本、远程图片或网络 API；若缺少本地第三方库，应简洁返回 status=failure 说明依赖缺失，禁止伪造、内嵌超长库源码或声称省略的代码可运行。"
            return "返回 CodexBridgeResponse JSON。status=success；steps=null；result 完整结构为 {summary(String),actualChanges([String]),evidence([String]),deviation(String),rollback(String),artifact(DeliverableArtifact|null),verificationPassed(Bool|null),blockingIssues([String]|null)}。只执行当前步骤，不继续后续步骤。若当前步骤 kind 为 build、integrate 或 deliver，artifact 必须是当前完整可演示版本，结构为 {title,kind(html|markdown|text),content,filename,projectRoot?,files?,entrypoint?,dependencies?,runCommands?,testCommands?,testResults?}；在 currentArtifact 基础上更新，不要只返回差异。\(dependencyRule) projectRoot 必须是真实交付项目目录，绝不能填写 LoopCanvas 编排器源码或 Bridge 路径；未创建实际目录时填 null。只有实际执行过的命令和测试才能写入，未知字段填 null，不得虚构。若当前步骤 kind=verify，必须返回 verificationPassed；只要存在缺失依赖、未运行测试、控制台错误、空白画布或其他阻断项，就必须为 false 并逐条填写 blockingIssues，不得把发现问题的验证写成 success=true。decision 或 verify 可令 artifact=null，但不得虚构验证证据。保持回复紧凑，第三方库必须引用而不是复制；不要重复代码、注释或说明，绝不能写“此处省略但保证可运行”。若无法在输出上限内返回完整有效 JSON，改为 status=failure 并用 error 简洁说明，不得返回被截断的 success。不要输出 JSON 之外的文本。"
        }
    }

    private func generateHandoffDraft() {
        let createdAt = Date()
        let timestamp = Self.filenameDateFormatter.string(from: createdAt)
        handoffDraft = HandoffDraft(
            id: UUID(),
            createdAt: createdAt,
            modelDocument: HandoffDocument(
                filename: "LoopCanvas-MODEL-HANDOFF-\(timestamp).md",
                title: "模型高密度交接",
                audience: "供其他窗口或模型无损恢复当前任务状态；优先信息密度与稳定字段。",
                content: makeModelHandoff(createdAt: createdAt)
            ),
            technicalReport: HandoffDocument(
                filename: "LoopCanvas-TECHNICAL-REPORT-\(timestamp).md",
                title: "人类技术报告",
                audience: "供用户或团队成员阅读；解释做了什么、如何实现、为何这样做以及下一步建议。",
                content: makeTechnicalReport(createdAt: createdAt)
            )
        )
    }

    private func makeModelHandoff(createdAt: Date) -> String {
        let selected = selectedStep
        let next = nextActionDescription
        var lines = [
            "# LC-HANDOFF/2",
            "HANDOFF_SPEC|consumer=model|priority=state_fidelity,token_density,resumability|do_not_infer_missing=true",
            "META|generated_at=\(Self.isoDateFormatter.string(from: createdAt))|phase=\(phase.rawValue)|paused=\(isPaused)|complete_plan=\(hasCompletePlan)|deliverable_ready=\(isDeliverableReady)",
            "GOAL|\(dense(requirement))",
            "DIRECTIVES|\(requirementDirectives.isEmpty ? "none" : requirementDirectives.map { "\($0.id.uuidString):\($0.strength.rawValue):\(dense($0.text))" }.joined(separator: "||"))",
            "ATTACHMENTS|\(requirementAttachments.isEmpty ? "none" : requirementAttachments.map { "\($0.id.uuidString):\($0.kind.rawValue):\($0.sha256):\(dense($0.localPath))" }.joined(separator: "||"))",
            "COUNTS|steps=\(steps.count)|approved=\(approvedCount)|pending_requests=\(pendingBridgeRequests.count)|agents=\(agentSessions.count)|context=\(sharedContext.count)|log=\(decisionLog.count)",
            "CURSOR|selected_step_id=\(selected?.id.uuidString ?? "null")|selected_step_status=\(selected?.status.rawValue ?? "null")|selected_step_title=\(dense(selected?.title ?? "null"))",
            "NEXT|\(dense(next))",
            "RESUME_RULES|1=preserve_goal_and_DAG|2=do_not_redo_approved_unless_stale_or_reopened|3=honor_user_feedback|4=process_existing_pending_request_before_creating_new|5=one_step_then_user_review|6=artifact_steps_return_full_offline_snapshot",
            "ENVIRONMENT|orchestrator=LoopCanvas|data_root=\(dense(fileStore.rootURL.path))|data_root_is_target_project=false|target_project_root=\(dense(currentArtifact?.projectRoot ?? "UNKNOWN_NOT_CREATED_OR_NOT_REPORTED"))",
            "",
            "## ARTIFACT"
        ]

        if let artifact = currentArtifact {
            lines += [
                "ARTIFACT_META|present=true|title=\(dense(artifact.title))|kind=\(artifact.kind.rawValue)|filename=\(dense(artifact.filename))|utf8_bytes=\(artifact.content.utf8.count)",
                "EXECUTION_MANIFEST|project_root=\(dense(artifact.projectRoot ?? "UNKNOWN_NOT_CREATED_OR_NOT_REPORTED"))|entrypoint=\(dense(artifact.entrypoint ?? "UNKNOWN"))|files=\(dense(artifact.files?.joined(separator: ",") ?? "UNKNOWN"))",
                "DEPENDENCIES|\(dense(artifact.dependencies?.joined(separator: "; ") ?? "UNKNOWN"))",
                "RUN_COMMANDS|\(dense(artifact.runCommands?.joined(separator: "; ") ?? "UNKNOWN"))",
                "TEST_COMMANDS|\(dense(artifact.testCommands?.joined(separator: "; ") ?? "UNKNOWN"))",
                "TEST_RESULTS|\(dense(artifact.testResults?.joined(separator: "; ") ?? "NOT_RUN_OR_NOT_REPORTED"))",
                "<<<ARTIFACT_CONTENT_BEGIN>>>",
                artifact.content,
                "<<<ARTIFACT_CONTENT_END>>>"
            ]
        } else {
            lines += [
                "ARTIFACT_META|present=false|meaning=no_webpage_model_or_interaction_has_been_produced",
                "EXECUTION_MANIFEST|project_root=UNKNOWN_NOT_CREATED_OR_NOT_REPORTED|entrypoint=UNKNOWN|files=UNKNOWN",
                "DEPENDENCIES|UNKNOWN",
                "RUN_COMMANDS|UNKNOWN",
                "TEST_COMMANDS|UNKNOWN",
                "TEST_RESULTS|NOT_RUN_OR_NOT_REPORTED"
            ]
        }

        lines += ["", "## DAG_AND_STEP_STATE"]
        for (index, step) in steps.enumerated() {
            let declaredDependencies = step.dependencies.map(\.uuidString).joined(separator: ",")
            let effectiveDependencies = effectiveDependencies(for: step).map(\.uuidString).joined(separator: ",")
            let kind = effectiveKind(for: step)
            lines.append("STEP|i=\(index + 1)|id=\(step.id.uuidString)|kind=\(kind?.rawValue ?? "unknown")|kind_source=\(stepKindWasInferred(step) ? "inferred_legacy" : "declared")|requires_artifact=\(stepRequiresArtifact(step))|status=\(step.status.rawValue)|rev=\(step.revision)|declared_deps=\(declaredDependencies.isEmpty ? "none" : declaredDependencies)|effective_deps=\(effectiveDependencies.isEmpty ? "none" : effectiveDependencies)|title=\(dense(step.title))")
            lines.append("PURPOSE|\(dense(step.purpose))")
            for option in step.options {
                lines.append("OPTION|id=\(option.id.uuidString)|selected=\(step.selectedOptionID == option.id)|recommended=\(option.isRecommended)|title=\(dense(option.title))|subtitle=\(dense(option.subtitle))")
                lines.append("OPTION_PROVENANCE|origin=\(option.origin?.rawValue ?? "legacy_unknown")|matched_directives=\(option.matchedDirectiveIDs?.map(\.uuidString).joined(separator: ",") ?? "none")|rank_reason=\(dense(option.rankReason ?? "unknown"))")
                lines.append("OPTION_REASON|\(dense(option.technicalReason))")
                lines.append("OPTION_ADV|\(dense(option.advantages.joined(separator: "; ")))")
                lines.append("OPTION_TRADEOFF|\(dense(option.tradeoffs.joined(separator: "; ")))")
                lines.append("OPTION_IMPACT|\(dense(option.downstreamImpact))")
            }
            lines.append("USER_FEEDBACK|\(dense(step.lastFeedback ?? "null"))")
            if let result = step.result {
                lines.append("RESULT_SUMMARY|\(dense(result.summary))")
                result.actualChanges.forEach { lines.append("RESULT_CHANGE|\(dense($0))") }
                result.evidence.forEach { lines.append("RESULT_EVIDENCE|\(dense($0))") }
                lines.append("RESULT_DEVIATION|\(dense(result.deviation))")
                lines.append("RESULT_ROLLBACK|\(dense(result.rollback))")
                lines.append("RESULT_ARTIFACT|\(result.artifact == nil ? "none" : "see_ARTIFACT_section_if_latest")")
            } else {
                lines.append("RESULT|null")
            }
            lines.append("END_STEP")
        }

        lines += ["", "## PENDING_BRIDGE_REQUESTS"]
        if pendingBridgeRequests.isEmpty { lines.append("REQUESTS|none") }
        for request in pendingBridgeRequests {
            lines.append("REQUEST|id=\(request.id.uuidString)|kind=\(request.kind.rawValue)|target=\(request.targetStepID?.uuidString ?? "null")|agent=\(request.agentID?.uuidString ?? "null")|created_at=\(Self.isoDateFormatter.string(from: request.createdAt))")
            lines.append("REQUEST_FOCUS|\(dense(request.focus))")
            lines.append("REQUEST_OPTION|\(dense(request.selectedOption?.title ?? "null"))")
            lines.append("REQUEST_FEEDBACK|\(dense(request.userFeedback ?? "null"))")
        }

        lines += ["", "## AGENTS"]
        if agentSessions.isEmpty { lines.append("AGENTS|none") }
        for agent in agentSessions {
            lines.append("AGENT|id=\(agent.id.uuidString)|status=\(agent.status.rawValue)|progress=\(Int(agent.progress * 100))|assigned=\(agent.assignedStepIDs.map(\.uuidString).joined(separator: ","))|name=\(dense(agent.name))|focus=\(dense(agent.focus))")
            agent.notes.forEach { lines.append("AGENT_NOTE|agent=\(agent.id.uuidString)|\(dense($0))") }
        }

        lines += ["", "## NON_DERIVABLE_HISTORY_DELTA", "HISTORY_POLICY|canonical_current_state_is_above|redundant_timeline_events_omitted=true"]
        let corrections = sharedContext.reversed().filter { $0.kind == .correction }
        if corrections.isEmpty { lines.append("CORRECTIONS|none") }
        for entry in corrections {
            lines.append("CTX|at=\(Self.isoDateFormatter.string(from: entry.date))|kind=\(entry.kind.rawValue)|step=\(entry.stepID?.uuidString ?? "null")|author=\(dense(entry.author))|content=\(dense(entry.content))")
        }
        let revisions = decisionLog.reversed().filter { $0.kind == .revision }
        if revisions.isEmpty { lines.append("REVISIONS|none") }
        for entry in revisions {
            lines.append("LOG|at=\(Self.isoDateFormatter.string(from: entry.date))|kind=\(entry.kind.rawValue)|step=\(entry.stepID?.uuidString ?? "null")|title=\(dense(entry.title))|detail=\(dense(entry.detail))")
        }
        lines += ["", "END_HANDOFF|resume_from=NEXT|ask_user_only_if_required_information_is_unknown"]
        return lines.joined(separator: "\n")
    }

    private func makeTechnicalReport(createdAt: Date) -> String {
        let approved = steps.filter { $0.status == .approved }
        let review = steps.filter { $0.status == .review }
        let unresolved = steps.filter { $0.status != .approved }
        var lines = [
            "# LoopCanvas 技术交接报告",
            "",
            "生成时间：\(Self.handoffDateFormatter.string(from: createdAt))",
            "",
            "## 1. 执行摘要",
            "",
            isDeliverableReady
                ? "当前完整计划的所有步骤均已由用户确认，并且存在最终可演示产物；状态为可交付。"
                : "当前工作流已暂停。已确认 \(approvedCount)/\(steps.count) 个步骤；\(currentArtifact == nil ? "尚无可演示产物" : "已有中间产物，但尚未满足最终交付条件")。",
            "",
            "**恢复后的第一动作：** \(nextActionDescription)",
            "",
            "## 2. 原始目标与具体要求",
            "",
            requirement,
            requirementAttachments.isEmpty ? "" : "\n附件：\(requirementAttachments.map { "`\($0.name)`（\($0.kind.rawValue)，SHA-256 `\($0.sha256)`）" }.joined(separator: "、"))",
            "",
            "## 3. 当前完成度",
            "",
            "| 指标 | 当前值 |",
            "|---|---:|",
            "| 计划步骤 | \(steps.count) |",
            "| 已确认 | \(approvedCount) |",
            "| 等待用户验收 | \(review.count) |",
            "| 待处理 Agent 请求 | \(pendingBridgeRequests.count) |",
            "| 完整端到端计划 | \(hasCompletePlan ? "是" : "否") |",
            "| 当前产物 | \(currentArtifact?.filename ?? "无") |",
            "| 可交付 | \(isDeliverableReady ? "是" : "否") |",
            "",
            "## 4. 已完成或已产出内容",
            ""
        ]

        if approved.isEmpty && review.isEmpty {
            lines.append("尚无完成并返回结果的步骤。")
        }
        for step in steps where step.status == .approved || step.status == .review {
            lines += [
                "### \(step.title)（\(humanStatus(step.status))，第 \(step.revision) 版）",
                "",
                "- 采用方案：\(step.selectedOption?.title ?? "未记录")",
                "- 该步目的：\(step.purpose)"
            ]
            if let result = step.result {
                lines.append("- 结果摘要：\(result.summary)")
                for change in result.actualChanges { lines.append("  - 实际改变：\(change)") }
            }
            lines.append("")
        }

        lines += [
            "## 5. 实现方式与选择理由",
            "",
            "| 阶段 | 步骤 | 选择 | 技术理由 | 主要代价 |",
            "|---|---|---|---|---|"
        ]
        for step in steps {
            let option = step.selectedOption
            lines.append("| \(humanKind(for: step)) | \(table(step.title)) | \(table(option?.title ?? "未选择")) | \(table(option?.technicalReason ?? "尚未形成决策")) | \(table(option?.tradeoffs.joined(separator: "；") ?? "—")) |")
        }

        lines += [
            "",
            "## 6. 需求满足情况",
            "",
            "以下矩阵只依据计划、用户确认和现有证据，不把尚未执行的事项写成已满足。",
            "",
            "| 状态 | 计划贡献 | 如何满足原始目标 | 证据 |",
            "|---|---|---|---|"
        ]
        for step in steps {
            let evidence = step.result?.evidence.joined(separator: "；") ?? "尚无执行证据"
            lines.append("| \(humanStatus(step.status)) | \(table(step.title)) | \(table(step.purpose)) | \(table(evidence)) |")
        }

        lines += ["", "## 7. 目标项目与可运行性", ""]
        if let artifact = currentArtifact {
            lines += [
                "- **目标项目根目录：** \(artifact.projectRoot.map { "`\($0)`" } ?? "未提供；不能使用 LoopCanvas 编排器源码路径代替")",
                "- **项目文件：** \(artifact.files?.map { "`\($0)`" }.joined(separator: "、") ?? "未提供")",
                "- **入口文件：** \(artifact.entrypoint.map { "`\($0)`" } ?? "未提供")",
                "- **依赖及版本：** \(artifact.dependencies?.joined(separator: "；") ?? "未提供")",
                "- **运行命令：** \(artifact.runCommands?.map { "`\($0)`" }.joined(separator: "；") ?? "未提供")",
                "- **测试命令：** \(artifact.testCommands?.map { "`\($0)`" }.joined(separator: "；") ?? "未提供")",
                "- **测试结果：** \(artifact.testResults?.joined(separator: "；") ?? "未运行或未报告")",
                "- **当前产物：** `\(artifact.filename)`（\(artifact.kind.rawValue)，\(artifact.content.utf8.count) bytes）",
                "- **产物标题：** \(artifact.title)",
                "- 产物正文保存在同批次模型交接文档中；本报告不重复嵌入，以保持人类可读性。"
            ]
        } else {
            lines += [
                "- **目标项目根目录：未创建或未报告。** `LocalAITeam/LoopCanvas` 是编排器本身，不是用户要求的交付项目。",
                "- 项目文件、入口、依赖、运行命令和测试命令：均未提供。",
                "- 当前没有 artifact；网页、模型和交互尚未生成，不能把计划或文字结果视为可交付成品。"
            ]
        }

        lines += ["", "## 8. 验证证据与已知限制", ""]
        for step in steps {
            guard let result = step.result else { continue }
            if !result.evidence.isEmpty {
                lines.append("- \(step.title)的验证证据：\(result.evidence.joined(separator: "；"))")
            }
            if !result.deviation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, result.deviation != "无" {
                lines.append("- \(step.title)的已知偏差：\(result.deviation)")
            }
        }

        lines += ["", "## 9. 未决事项与风险", ""]
        if unresolved.isEmpty && pendingBridgeRequests.isEmpty {
            lines.append("没有未决步骤或待处理请求。")
        } else {
            for step in unresolved {
                lines.append("- [\(humanStatus(step.status))] \(step.title)：\(step.lastFeedback ?? step.purpose)")
            }
            for request in pendingBridgeRequests {
                lines.append("- 待处理请求 `\(request.id.uuidString)`：\(request.focus)")
            }
        }

        lines += ["", "## 10. 后续建议", "", "1. \(nextActionDescription)"]
        if currentArtifact != nil && !isDeliverableReady {
            lines.append("2. 后续产物型步骤必须在当前完整 artifact 上继续修改，不能只返回差异或文字说明。")
        }
        if steps.contains(where: { $0.status == .stale }) {
            lines.append("3. 优先复核所有受上游变化影响的 stale 步骤，再进行最终交付。")
        }
        lines += [
            "",
            "## 附录 A：完整计划索引",
            "",
            stepKindWasInferredForAnyStep ? "注：带 `*` 的阶段来自旧会话标题/目的推断；不是原规划声明。旧会话的有效依赖采用保守前序链，原始依赖仍保留在模型交接的 `declared_deps` 中。" : ""
        ]
        for (index, step) in steps.enumerated() {
            let dependencies = effectiveDependencies(for: step)
            lines.append("\(index + 1). **\(step.title)** · \(humanKind(for: step)) · requires_artifact=\(stepRequiresArtifact(step)) · \(humanStatus(step.status)) · 有效依赖：\(dependencies.isEmpty ? "无" : dependencies.map(\.uuidString).joined(separator: "、"))")
        }
        return lines.joined(separator: "\n")
    }

    private var nextActionDescription: String {
        if let request = pendingBridgeRequests.first {
            return "先处理已存在的 Agent 请求 \(request.id.uuidString)，不要创建重复请求。"
        }
        if let step = steps.first(where: { $0.status == .review }) {
            return "请用户验收「\(step.title)」第 \(step.revision) 版；根据反馈接受或仅修改该步。"
        }
        if !hasCompletePlan {
            return "PLAN_REPAIR_ONLY：先补全并修正剩余 DAG，形成“需求/美术决策 → 模型或页面原型制作 → 交互集成 → 可复现验证 → 最终交付”的连续依赖链；本轮只新增或修正计划，不生成 artifact，不跳到交付。"
        }
        if let step = steps.first(where: { $0.status == .stale }) {
            return "复核受上游变化影响的「\(step.title)」，保留原方案与历史结果。"
        }
        if let step = steps.first(where: { $0.status == .ready }) {
            return "在「\(step.title)」中选择方案并只执行当前一步。"
        }
        if isDeliverableReady { return "交付当前产物；除非用户提出新要求，不再继续修改。" }
        if approvedCount == steps.count { return "补充缺失的产物型交付步骤或最终 artifact；当前不能宣称可交付。" }
        return "检查未批准依赖和 Agent 连接错误，再恢复第一个可执行步骤。"
    }

    private func dense(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "|", with: "\\|")
            .replacingOccurrences(of: "\r\n", with: "\\n")
            .replacingOccurrences(of: "\n", with: "\\n")
    }

    private func table(_ value: String) -> String {
        value.replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: "<br>")
    }

    private func humanStatus(_ status: StepStatus) -> String {
        switch status {
        case .locked: "等待依赖"
        case .ready: "待选择/执行"
        case .running: "执行中"
        case .review: "等待用户验收"
        case .approved: "用户已确认"
        case .stale: "受上游变化影响，需复核"
        }
    }

    private var stepKindWasInferredForAnyStep: Bool {
        steps.contains(where: stepKindWasInferred)
    }

    private func humanKind(for step: WorkflowStep) -> String {
        let label = switch effectiveKind(for: step) {
        case .decision: "决策"
        case .build: "制作"
        case .integrate: "集成"
        case .verify: "验证"
        case .deliver: "交付"
        case nil: "未知阶段"
        }
        return stepKindWasInferred(step) ? "\(label)*" : label
    }

    private func recomputeAvailability() {
        for index in steps.indices {
            switch steps[index].status {
            case .approved, .review, .running, .stale: continue
            case .locked, .ready:
                steps[index].status = dependenciesAreApproved(for: steps[index]) ? .ready : .locked
            }
        }
    }

    private func restoreVisibleVerificationReviews() {
        for index in steps.indices where
            effectiveKind(for: steps[index]) == .verify
                && steps[index].status == .ready
                && steps[index].result != nil {
            steps[index].status = .review
        }
    }

    @discardableResult
    private func restoreObjectiveVerificationState() -> Bool {
        let subjectivePrefixes = [
            "用户在 LoopCanvas 中人工确认验证通过",
            "用户人工确认验证通过"
        ]
        var migratedStepIDs: [UUID] = []

        for index in steps.indices {
            guard effectiveKind(for: steps[index]) == .verify,
                  var result = steps[index].result,
                  result.evidence.contains(where: { evidence in
                      subjectivePrefixes.contains(where: evidence.hasPrefix)
                  }) else { continue }

            let recoveredIssues = result.evidence
                .filter { $0.hasPrefix("模型检查曾报告：") }
                .flatMap { evidence in
                    evidence
                        .dropFirst("模型检查曾报告：".count)
                        .split(separator: "；")
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                }

            result.evidence.removeAll { evidence in
                subjectivePrefixes.contains(where: evidence.hasPrefix)
            }
            result.verificationPassed = false
            result.blockingIssues = recoveredIssues.isEmpty
                ? ["此前仅由用户主观覆盖验证，缺少 Agent 实际运行并通过的客观证据。"]
                : Array(Set(recoveredIssues)).sorted()
            steps[index].result = result
            steps[index].status = .review
            migratedStepIDs.append(steps[index].id)
        }

        guard !migratedStepIDs.isEmpty else { return false }
        decisionLog.removeAll { $0.title == "用户判定验证通过" }
        sharedContext.removeAll {
            $0.kind == .decision
                && $0.content.contains("人工确认")
                && $0.content.contains("验证通过")
        }
        for stepID in migratedStepIDs { markDescendantsStale(of: stepID) }
        return true
    }

    private func nearestApprovedArtifactAncestorIndex(of stepID: UUID) -> Int? {
        var visited = Set<UUID>()
        var frontier = steps.first(where: { $0.id == stepID }).map(effectiveDependencies(for:)) ?? []
        while !frontier.isEmpty {
            let current = frontier.removeFirst()
            guard visited.insert(current).inserted,
                  let candidateIndex = index(of: current) else { continue }
            if steps[candidateIndex].status == .approved, stepRequiresArtifact(steps[candidateIndex]) {
                return candidateIndex
            }
            frontier.append(contentsOf: effectiveDependencies(for: steps[candidateIndex]))
        }
        return nil
    }

    private func markDescendantsStale(of stepID: UUID) {
        let affected = downstreamIDs(of: stepID)
        for index in steps.indices where affected.contains(steps[index].id) {
            if steps[index].selectedOptionID != nil || steps[index].result != nil || steps[index].status == .approved || steps[index].status == .review {
                steps[index].status = .stale
            } else {
                steps[index].status = .locked
            }
        }
    }

    private func downstreamIDs(of stepID: UUID) -> Set<UUID> {
        var result = Set<UUID>()
        var frontier = [stepID]
        while let current = frontier.popLast() {
            let children = steps.filter { effectiveDependencies(for: $0).contains(current) }.map(\.id)
            for child in children where !result.contains(child) {
                result.insert(child)
                frontier.append(child)
            }
        }
        return result
    }

    private func isDownstream(_ candidateID: UUID, of ancestorID: UUID) -> Bool {
        downstreamIDs(of: ancestorID).contains(candidateID)
    }

    private func isValidTopologicalOrder(_ candidate: [WorkflowStep]) -> Bool {
        let positions = Dictionary(uniqueKeysWithValues: candidate.enumerated().map { ($0.element.id, $0.offset) })
        return candidate.allSatisfy { step in
            guard let stepPosition = positions[step.id] else { return false }
            return effectiveDependencies(for: step).allSatisfy { dependencyID in
                guard let dependencyPosition = positions[dependencyID] else { return false }
                return dependencyPosition < stepPosition
            }
        }
    }

    private func planIssues(for candidate: [WorkflowStep]) -> [String] {
        var issues: [String] = []
        guard (6...10).contains(candidate.count) else { return ["步骤数必须为 6–10，当前为 \(candidate.count)"] }
        if Set(candidate.map(\.id)).count != candidate.count { issues.append("步骤 UUID 存在重复") }
        let kinds = Set(candidate.compactMap { $0.kind ?? effectiveKind(for: $0) })
        if !kinds.isSuperset(of: Set(WorkflowStepKind.allCases)) { issues.append("计划未覆盖 decision/build/integrate/verify/deliver 五类") }
        if candidate.last.flatMap({ $0.kind ?? effectiveKind(for: $0) }) != .deliver { issues.append("最后一步必须是 deliver") }
        if !isValidTopologicalOrder(candidate) { issues.append("DAG 包含缺失、倒序或循环依赖") }
        for (index, step) in candidate.enumerated() {
            if !(2...3).contains(step.options.count) { issues.append("第 \(index + 1) 步必须有 2–3 个方案") }
            if step.options.filter(\.isRecommended).count != 1 { issues.append("第 \(index + 1) 步必须且只能推荐一个方案") }
            if let firstModel = step.options.firstIndex(where: { ($0.origin ?? .model) == .model }),
               step.options.dropFirst(firstModel + 1).contains(where: { $0.origin == .userExplicit }) {
                issues.append("第 \(index + 1) 步的用户明确方案没有排在模型方案之前")
            }
        }
        if !requirementDirectives.isEmpty {
            let applied = Set(candidate.flatMap { $0.appliedDirectiveIDs ?? [] })
            let matched = Set(candidate.flatMap { $0.options.flatMap { $0.matchedDirectiveIDs ?? [] } })
            for directive in requirementDirectives where !applied.contains(directive.id) && !matched.contains(directive.id) {
                issues.append("用户约束未映射：\(directive.text)")
            }
        }
        return issues
    }

    private func moveSelectionToNextActionable(after index: Int) {
        let ordered = Array(steps.dropFirst(min(index + 1, steps.count))) + Array(steps.prefix(min(index + 1, steps.count)))
        if let next = ordered.first(where: { $0.status == .ready || $0.status == .stale || $0.status == .review }) { selectedStepID = next.id }
    }

    private func appendContext(author: String, stepID: UUID?, kind: SharedContextEntry.Kind, content: String) {
        sharedContext.insert(SharedContextEntry(id: UUID(), date: Date(), author: author, stepID: stepID, kind: kind, content: content), at: 0)
        if sharedContext.count > 240 { sharedContext.removeLast(sharedContext.count - 240) }
    }

    private func appendLog(stepID: UUID?, title: String, detail: String, kind: DecisionLogEntry.Kind) {
        decisionLog.insert(DecisionLogEntry(id: UUID(), date: Date(), stepID: stepID, title: title, detail: detail, kind: kind), at: 0)
        if decisionLog.count > 100 { decisionLog.removeLast(decisionLog.count - 100) }
    }

    private func index(of stepID: UUID) -> Int? {
        steps.firstIndex { $0.id == stepID }
    }

    private func persist() {
        guard shouldPersist else { return }
        do {
            try persistProjectsDocument()
        } catch {
            let message = "工作流保存失败：\(error.localizedDescription)。上一份成功快照仍保留。"
            bridgeError = message
            transientMessage = message
        }
    }

    /// 把当前工作流快照写回项目列表，并落盘为多项目文档。
    private func persistProjectsDocument() throws {
        saveCurrentProjectSnapshot()
        let document = ProjectsDocument(
            projects: allProjects,
            archivedProjects: archivedProjects,
            currentProjectID: currentProjectID
        )
        UserDefaults.standard.set(try JSONEncoder().encode(document), forKey: Self.projectsKey)
        projects = allProjects.map { ProjectSummary(id: $0.id, name: $0.name) }
    }

    private static func emptySnapshot() -> WorkflowSnapshot {
        WorkflowSnapshot(
            phase: .intake,
            requirement: "",
            steps: [],
            selectedStepID: nil,
            isPaused: false,
            decisionLog: [],
            sharedContext: [],
            agentSessions: [],
            pendingBridgeRequests: [],
            requirementAttachments: [],
            requirementDirectives: []
        )
    }

    private static func deriveProjectName(from requirement: String) -> String {
        let trimmed = requirement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "未命名项目" }
        let firstLine = trimmed.split(separator: "\n").first.map(String.init) ?? trimmed
        return firstLine.count > 24 ? String(firstLine.prefix(24)) + "…" : firstLine
    }

    private static func makeAgentSessions() -> [AgentSession] {
        [
            AgentSession(id: UUID(), name: "端到端规划对话", focus: "一次生成从需求到最终交付的完整计划", assignedStepIDs: [], status: .waiting, progress: 0, notes: ["等待 DeepSeek Harness 返回完整步骤图…"])
        ]
    }

    private static let contextDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    private static let handoffDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .medium
        return formatter
    }()

    private static let isoDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let filenameDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()
}
