import Foundation

enum AppPhase: String, Codable {
    case intake
    case building
    case workspace
}

enum ConfigurationSurface: String, CaseIterable, Identifiable {
    case modelAPI = "Agent 连接"
    case agents = "AGENTS.md"
    case skills = "Skills"
    case plugins = "插件"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .modelAPI: "person.crop.circle.badge.checkmark"
        case .agents: "doc.badge.gearshape"
        case .skills: "wand.and.stars"
        case .plugins: "puzzlepiece.extension"
        }
    }

    var subtitle: String {
        switch self {
        case .modelAPI: "DeepSeek Harness"
        case .agents: "项目规则"
        case .skills: "可复用工作流"
        case .plugins: "工具与连接器"
        }
    }
}

enum AttachmentKind: String, Codable {
    case image, text, pdf, file
}

enum AttachmentDisplayMode: String, Codable {
    case chip, inline
}

struct InputAttachment: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    var kind: AttachmentKind
    var mimeType: String
    var byteCount: Int
    var sha256: String
    var localPath: String
    var displayMode: AttachmentDisplayMode
    var source: String
}

enum RequirementDirectiveStrength: String, Codable {
    case required, preferred, suggested, forbidden
}

struct RequirementDirective: Identifiable, Codable, Equatable {
    let id: UUID
    var text: String
    var strength: RequirementDirectiveStrength
    var source: String
}

enum PlanOptionOrigin: String, Codable {
    case userExplicit, userInferred, model
}

enum AgentStatus: String, Codable {
    case queued
    case planning
    case waiting
    case complete

    var displayTitle: String {
        switch self {
        case .queued: "排队中"
        case .planning: "规划中"
        case .waiting: "等待回复"
        case .complete: "已完成"
        }
    }

    var icon: String {
        switch self {
        case .queued: "clock"
        case .planning: "brain.head.profile"
        case .waiting: "ellipsis.message"
        case .complete: "checkmark.circle.fill"
        }
    }

    var isActive: Bool { self == .planning || self == .waiting }
}

struct SharedContextEntry: Identifiable, Codable, Equatable {
    let id: UUID
    let date: Date
    let author: String
    let stepID: UUID?
    let kind: Kind
    let content: String

    enum Kind: String, Codable {
        case user
        case plan
        case decision
        case result
        case correction
        case system
    }
}

struct AgentSession: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    var focus: String
    var assignedStepIDs: [UUID]
    var status: AgentStatus
    var progress: Double
    var notes: [String]
}

struct HandoffDocument: Equatable {
    let filename: String
    let title: String
    let audience: String
    let content: String
}

struct HandoffDraft: Identifiable, Equatable {
    let id: UUID
    let createdAt: Date
    let modelDocument: HandoffDocument
    let technicalReport: HandoffDocument
}

enum StepStatus: String, Codable, CaseIterable {
    case locked
    case ready
    case running
    case review
    case approved
    case stale
}

enum WorkflowStepKind: String, Codable, CaseIterable {
    case decision
    case build
    case integrate
    case verify
    case deliver

    var requiresArtifact: Bool {
        switch self {
        case .build, .integrate, .deliver: true
        case .decision, .verify: false
        }
    }
}

enum DeliverableKind: String, Codable, CaseIterable {
    case html
    case markdown
    case text
}

struct DeliverableArtifact: Codable, Equatable {
    var title: String
    var kind: DeliverableKind
    var content: String
    var filename: String
    var projectRoot: String?
    var files: [String]?
    var entrypoint: String?
    var dependencies: [String]?
    var runCommands: [String]?
    var testCommands: [String]?
    var testResults: [String]?

    init(
        title: String,
        kind: DeliverableKind,
        content: String,
        filename: String,
        projectRoot: String? = nil,
        files: [String]? = nil,
        entrypoint: String? = nil,
        dependencies: [String]? = nil,
        runCommands: [String]? = nil,
        testCommands: [String]? = nil,
        testResults: [String]? = nil
    ) {
        self.title = title
        self.kind = kind
        self.content = content
        self.filename = filename
        self.projectRoot = projectRoot
        self.files = files
        self.entrypoint = entrypoint
        self.dependencies = dependencies
        self.runCommands = runCommands
        self.testCommands = testCommands
        self.testResults = testResults
    }

    /// 若产物在磁盘上有真实项目目录且入口文件存在，返回可直接用 WKWebView 加载的文件 URL，
    /// 让 HTML 里相对引用的 `js/…`、`vendor/…` 等本地脚本能正确解析。
    var previewFileURL: URL? {
        guard let projectRoot, !projectRoot.isEmpty else { return nil }
        let directory = URL(fileURLWithPath: projectRoot)
        let file = directory.appendingPathComponent(filename)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else { return nil }
        return file
    }
}

struct PlanOption: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var subtitle: String
    var technicalReason: String
    var advantages: [String]
    var tradeoffs: [String]
    var downstreamImpact: String
    var isRecommended: Bool
    var origin: PlanOptionOrigin?
    var matchedDirectiveIDs: [UUID]?
    var rankReason: String?

    init(
        id: UUID = UUID(),
        title: String,
        subtitle: String,
        technicalReason: String,
        advantages: [String],
        tradeoffs: [String],
        downstreamImpact: String,
        isRecommended: Bool = false,
        origin: PlanOptionOrigin? = nil,
        matchedDirectiveIDs: [UUID]? = nil,
        rankReason: String? = nil
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.technicalReason = technicalReason
        self.advantages = advantages
        self.tradeoffs = tradeoffs
        self.downstreamImpact = downstreamImpact
        self.isRecommended = isRecommended
        self.origin = origin
        self.matchedDirectiveIDs = matchedDirectiveIDs
        self.rankReason = rankReason
    }
}

struct StepResult: Codable, Equatable {
    var summary: String
    var actualChanges: [String]
    var evidence: [String]
    var deviation: String
    var rollback: String
    var artifact: DeliverableArtifact?
    var verificationPassed: Bool?
    var blockingIssues: [String]?

    init(
        summary: String,
        actualChanges: [String],
        evidence: [String],
        deviation: String,
        rollback: String,
        artifact: DeliverableArtifact? = nil,
        verificationPassed: Bool? = nil,
        blockingIssues: [String]? = nil
    ) {
        self.summary = summary
        self.actualChanges = actualChanges
        self.evidence = evidence
        self.deviation = deviation
        self.rollback = rollback
        self.artifact = artifact
        self.verificationPassed = verificationPassed
        self.blockingIssues = blockingIssues
    }
}

enum RiskLevel: String, Codable, CaseIterable, Equatable {
    case l0 = "L0"
    case l1 = "L1"
    case l2 = "L2"
    case l3 = "L3"

    var requiresReview: Bool { self == .l2 || self == .l3 }

    var detail: String {
        switch self {
        case .l0: "文案/样式/小范围修正"
        case .l1: "单模块功能修改"
        case .l2: "跨模块/公共能力/数据变更"
        case .l3: "安全/生产数据/基础设施/不可逆"
        }
    }
}

struct ImpactAnalysis: Codable, Equatable {
    var surfaceProblem: String = ""
    var problemCategory: String = ""
    var relatedScenarios: [String] = []
    var isLocalPatch: Bool = false
    var scope: String = "implement"
    var affectedModules: [String] = []
    var requiresMainFlowChange: Bool = false
}

struct WorkflowStep: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var purpose: String
    var dependencies: [UUID]
    var kind: WorkflowStepKind? = nil
    var status: StepStatus
    var options: [PlanOption]
    var selectedOptionID: UUID?
    var result: StepResult?
    var revision: Int
    var lastFeedback: String?
    var appliedDirectiveIDs: [UUID]? = nil
    var conversationID: String? = nil
    var conversationMessages: [ConversationMessage]? = nil
    var riskLevel: RiskLevel? = nil
    var impactAnalysis: ImpactAnalysis? = nil

    var selectedOption: PlanOption? {
        options.first { $0.id == selectedOptionID }
    }
}

struct ConversationMessage: Identifiable, Codable, Equatable {
    let id: UUID
    let role: Role
    let text: String

    enum Role: String, Codable {
        case user
        case assistant
        case system
    }
}

struct DecisionLogEntry: Identifiable, Codable, Equatable {
    let id: UUID
    let date: Date
    let stepID: UUID?
    let title: String
    let detail: String
    let kind: Kind

    enum Kind: String, Codable {
        case decision
        case execution
        case revision
        case system
    }
}

struct WorkflowSnapshot: Codable {
    var phase: AppPhase
    var requirement: String
    var steps: [WorkflowStep]
    var selectedStepID: UUID?
    var isPaused: Bool
    var decisionLog: [DecisionLogEntry]
    var sharedContext: [SharedContextEntry]
    var agentSessions: [AgentSession]
    var pendingBridgeRequests: [CodexBridgeRequest]
    var requirementAttachments: [InputAttachment]?
    var requirementDirectives: [RequirementDirective]?
}

struct WorkflowCheckpoint: Identifiable, Codable {
    let id: UUID
    let createdAt: Date
    let reason: String
    let snapshot: WorkflowSnapshot
}

struct Project: Identifiable, Codable {
    let id: UUID
    var name: String
    var createdAt: Date
    var snapshot: WorkflowSnapshot
    var checkpoints: [WorkflowCheckpoint]

    init(
        id: UUID,
        name: String,
        createdAt: Date,
        snapshot: WorkflowSnapshot,
        checkpoints: [WorkflowCheckpoint] = []
    ) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.snapshot = snapshot
        self.checkpoints = checkpoints
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, createdAt, snapshot, checkpoints
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        snapshot = try values.decode(WorkflowSnapshot.self, forKey: .snapshot)
        checkpoints = try values.decodeIfPresent([WorkflowCheckpoint].self, forKey: .checkpoints) ?? []
    }
}

struct ProjectSummary: Identifiable, Equatable {
    let id: UUID
    let name: String
}

struct ProjectsDocument: Codable {
    static let currentSchemaVersion = 2

    var schemaVersion: Int
    var projects: [Project]
    var archivedProjects: [Project]
    var currentProjectID: UUID?

    init(
        projects: [Project],
        archivedProjects: [Project] = [],
        currentProjectID: UUID?
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.projects = projects
        self.archivedProjects = archivedProjects
        self.currentProjectID = currentProjectID
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, projects, archivedProjects, currentProjectID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        guard schemaVersion <= Self.currentSchemaVersion else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: values,
                debugDescription: "项目数据来自更高版本（schema \(schemaVersion)），当前版本最多支持 \(Self.currentSchemaVersion)。"
            )
        }
        projects = try values.decode([Project].self, forKey: .projects)
        archivedProjects = try values.decodeIfPresent([Project].self, forKey: .archivedProjects) ?? []
        currentProjectID = try values.decodeIfPresent(UUID.self, forKey: .currentProjectID)
    }
}

enum DemoWorkflow {
    static let objective = "设计一套由用户掌控的可视化 Loop Engineering 工作流"
    static let objectiveDetail = "把复杂任务拆成可检查的步骤；每一步先选方案、再执行、再验收。局部修改不会抹掉总体方向。"

    static let goal = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
    static let architecture = UUID(uuidString: "10000000-0000-0000-0000-000000000002")!
    static let interaction = UUID(uuidString: "10000000-0000-0000-0000-000000000003")!
    static let stateModel = UUID(uuidString: "10000000-0000-0000-0000-000000000004")!
    static let prototype = UUID(uuidString: "10000000-0000-0000-0000-000000000005")!
    static let evaluation = UUID(uuidString: "10000000-0000-0000-0000-000000000006")!

    static let orderedIDs = [goal, architecture, interaction, stateModel, prototype, evaluation]

    static func makeStep(id: UUID) -> WorkflowStep? {
        makeSteps().first { $0.id == id }
    }

    static func makeSteps() -> [WorkflowStep] {
        [
            WorkflowStep(
                id: goal,
                title: "对齐目标",
                purpose: "先确定这次工作流真正需要验证什么，避免后续在错误目标上高速迭代。",
                dependencies: [],
                kind: .decision,
                status: .ready,
                options: [
                    PlanOption(
                        title: "验证交互闭环",
                        subtitle: "优先验证用户是否能掌控每一步",
                        technicalReason: "当前最大未知不是模型质量，而是可视化门控是否降低返工成本。先固定执行结果，能隔离交互变量。",
                        advantages: ["控制变量清晰", "开发周期最短", "容易观察用户决策"],
                        tradeoffs: ["暂时无法测量真实模型表现", "执行结果使用模拟数据"],
                        downstreamImpact: "后续步骤围绕本地原型与状态流转展开。",
                        isRecommended: true
                    ),
                    PlanOption(
                        title: "同时验证模型编排",
                        subtitle: "第一版就加入 API 与并发执行",
                        technicalReason: "能更早看到完整系统，但交互问题和模型问题会混在一起，难以判断失败来源。",
                        advantages: ["体验更接近最终产品", "可提前收集延迟与成本数据"],
                        tradeoffs: ["变量过多", "需要密钥、预算与失败恢复设计"],
                        downstreamImpact: "后续必须增加模型路由、成本控制和并发调度。"
                    )
                ],
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            ),
            WorkflowStep(
                id: architecture,
                title: "确定工作流结构",
                purpose: "决定用户看到的是线性步骤、依赖图，还是二者结合。",
                dependencies: [goal],
                kind: .decision,
                status: .locked,
                options: [
                    PlanOption(
                        title: "DAG + 线性投影",
                        subtitle: "底层是依赖图，界面保持一条可读时间线",
                        technicalReason: "依赖图负责正确性，线性投影负责降低认知负担；拖动后由系统验证拓扑顺序。",
                        advantages: ["能表达并行与固定顺序", "用户阅读成本低", "可精确传播修改影响"],
                        tradeoffs: ["需要处理拖拽冲突提示", "复杂项目可能需要分组视图"],
                        downstreamImpact: "交互设计需要同时显示连接关系和顺序约束。",
                        isRecommended: true
                    ),
                    PlanOption(
                        title: "纯线性向导",
                        subtitle: "始终一次只显示一个步骤",
                        technicalReason: "实现最简单，但无法自然表达可互换步骤和下游影响。",
                        advantages: ["界面极简", "用户不会迷失当前焦点"],
                        tradeoffs: ["总体方向不够可见", "无法表达并发和依赖"],
                        downstreamImpact: "后续交互会更像传统安装向导。"
                    )
                ],
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            ),
            WorkflowStep(
                id: interaction,
                title: "设计验收交互",
                purpose: "确定每一步如何提出方案、展示证据并等待用户判断。",
                dependencies: [architecture],
                kind: .decision,
                status: .locked,
                options: [
                    PlanOption(
                        title: "显式三段式门控",
                        subtitle: "方案选择 → 单步执行 → 结果验收",
                        technicalReason: "把意图、动作和判断分开保存，能准确定位返工发生在哪一层。",
                        advantages: ["决策路径清晰", "随时暂停", "结果与选择可以单独追溯"],
                        tradeoffs: ["步骤很多时会产生审批疲劳"],
                        downstreamImpact: "需要提供批量批准或风险分级作为未来优化。",
                        isRecommended: true
                    ),
                    PlanOption(
                        title: "持续执行 + 异常暂停",
                        subtitle: "默认自动前进，只在偏差时询问",
                        technicalReason: "吞吐更高，但用户可能在多个步骤后才发现主观方向不符。",
                        advantages: ["交互次数少", "适合标准化任务"],
                        tradeoffs: ["控制感较弱", "主观偏差发现较晚"],
                        downstreamImpact: "需要可靠的风险评分与异常检测。"
                    )
                ],
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            ),
            WorkflowStep(
                id: stateModel,
                title: "定义状态与影响",
                purpose: "定义暂停、通过、返工、回退和上游修改后的状态传播。",
                dependencies: [architecture],
                kind: .decision,
                status: .locked,
                options: [
                    PlanOption(
                        title: "版本化节点 + 失效传播",
                        subtitle: "保留计划，只让受影响的下游进入需复核",
                        technicalReason: "局部修改不能静默污染下游，也不应抹掉不受影响的成果；依赖遍历可精确标记影响范围。",
                        advantages: ["总体计划不丢", "变化影响可见", "支持局部回滚"],
                        tradeoffs: ["状态机复杂度较高", "需要区分未开始与已失效"],
                        downstreamImpact: "原型与评估必须覆盖上游变更场景。",
                        isRecommended: true
                    ),
                    PlanOption(
                        title: "修改后整体重置",
                        subtitle: "任何上游变化都清空后续进度",
                        technicalReason: "一致性最容易保证，但会造成大量不必要的返工。",
                        advantages: ["规则简单", "不会保留过期结果"],
                        tradeoffs: ["丢失已完成工作", "用户不敢尝试局部调整"],
                        downstreamImpact: "实现简单，但背离局部可修改的核心目标。"
                    )
                ],
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            ),
            WorkflowStep(
                id: prototype,
                title: "构建可操作原型",
                purpose: "把已确认的结构和状态规则组合成一个可实际操作的界面。",
                dependencies: [interaction, stateModel],
                kind: .build,
                status: .locked,
                options: [
                    PlanOption(
                        title: "原生 macOS 原型",
                        subtitle: "SwiftUI、本地状态、无外部服务",
                        technicalReason: "原生拖拽、窗口和状态更新足以验证核心交互，同时没有网络与 API 变量。",
                        advantages: ["启动快", "原生体验", "离线可用"],
                        tradeoffs: ["暂不覆盖跨平台", "部分视觉需要后续打磨"],
                        downstreamImpact: "评估聚焦桌面端使用效率。",
                        isRecommended: true
                    ),
                    PlanOption(
                        title: "浏览器原型",
                        subtitle: "Web 技术快速迭代",
                        technicalReason: "更便于分享，但不能完全代表原生 macOS 的窗口、菜单和拖拽体验。",
                        advantages: ["跨平台", "部署方便"],
                        tradeoffs: ["桌面集成较弱", "需要浏览器运行时"],
                        downstreamImpact: "评估需要额外区分浏览器限制。"
                    )
                ],
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            ),
            WorkflowStep(
                id: evaluation,
                title: "验证 Loop",
                purpose: "观察用户能否理解计划、发现偏差、修改局部并继续推进。",
                dependencies: [prototype],
                kind: .verify,
                status: .locked,
                options: [
                    PlanOption(
                        title: "场景化走查",
                        subtitle: "用成功、返工、回退三条路径验证",
                        technicalReason: "核心假设是过程控制而非吞吐量，三条路径能最直接暴露状态与心智模型问题。",
                        advantages: ["反馈具体", "能验证异常路径", "无需大样本"],
                        tradeoffs: ["无法得出统计性结论"],
                        downstreamImpact: "下一轮根据走查记录决定是否接入真实 API。",
                        isRecommended: true
                    ),
                    PlanOption(
                        title: "仅完成顺畅路径",
                        subtitle: "只验证从第一步走到最后一步",
                        technicalReason: "适合演示，但不会验证局部修改和影响传播这两个核心价值。",
                        advantages: ["最快完成", "演示路径简单"],
                        tradeoffs: ["关键风险未被覆盖"],
                        downstreamImpact: "接 API 前仍需补做异常路径验证。"
                    )
                ],
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            )
        ]
    }
}
