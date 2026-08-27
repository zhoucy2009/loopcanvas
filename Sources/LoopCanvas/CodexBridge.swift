import CryptoKit
import Foundation
import UniformTypeIdentifiers

enum CodexBridgeRequestKind: String, Codable {
    case planFirstStep = "plan_first_step"
    case planContinuation = "plan_continuation"
    case executeStep = "execute_step"
}

struct CodexBridgeStepSummary: Codable, Equatable {
    let id: UUID
    let title: String
    let purpose: String
    let status: StepStatus
    let kind: WorkflowStepKind?
    let dependencies: [UUID]

    init(
        id: UUID,
        title: String,
        purpose: String,
        status: StepStatus,
        kind: WorkflowStepKind? = nil,
        dependencies: [UUID] = []
    ) {
        self.id = id
        self.title = title
        self.purpose = purpose
        self.status = status
        self.kind = kind
        self.dependencies = dependencies
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, purpose, status, kind, dependencies
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        purpose = try container.decode(String.self, forKey: .purpose)
        status = try container.decode(StepStatus.self, forKey: .status)
        kind = try container.decodeIfPresent(WorkflowStepKind.self, forKey: .kind)
        dependencies = try container.decodeIfPresent([UUID].self, forKey: .dependencies) ?? []
    }
}

struct CodexBridgeRequest: Identifiable, Codable, Equatable {
    let id: UUID
    let createdAt: Date
    let kind: CodexBridgeRequestKind
    let agentID: UUID?
    let targetStepID: UUID?
    let userGoal: String
    let focus: String
    let modelPolicy: String
    let projectConstitution: String?
    let sharedContext: String
    let existingSteps: [CodexBridgeStepSummary]
    let selectedOption: PlanOption?
    let userFeedback: String?
    let currentArtifact: DeliverableArtifact?
    let responseInstructions: String
    let attachments: [InputAttachment]?
    let requirementDirectives: [RequirementDirective]?

    init(
        id: UUID,
        createdAt: Date,
        kind: CodexBridgeRequestKind,
        agentID: UUID?,
        targetStepID: UUID?,
        userGoal: String,
        focus: String,
        modelPolicy: String,
        projectConstitution: String? = nil,
        sharedContext: String,
        existingSteps: [CodexBridgeStepSummary],
        selectedOption: PlanOption?,
        userFeedback: String?,
        currentArtifact: DeliverableArtifact?,
        responseInstructions: String,
        attachments: [InputAttachment]? = nil,
        requirementDirectives: [RequirementDirective]? = nil
    ) {
        self.id = id
        self.createdAt = createdAt
        self.kind = kind
        self.agentID = agentID
        self.targetStepID = targetStepID
        self.userGoal = userGoal
        self.focus = focus
        self.modelPolicy = modelPolicy
        self.projectConstitution = projectConstitution
        self.sharedContext = sharedContext
        self.existingSteps = existingSteps
        self.selectedOption = selectedOption
        self.userFeedback = userFeedback
        self.currentArtifact = currentArtifact
        self.responseInstructions = responseInstructions
        self.attachments = attachments
        self.requirementDirectives = requirementDirectives
    }
}

struct CodexBridgeStep: Identifiable, Codable, Equatable {
    let id: UUID
    let title: String
    let purpose: String
    let dependencies: [UUID]
    let options: [PlanOption]
    let kind: WorkflowStepKind?
    let appliedDirectiveIDs: [UUID]?
    let riskLevel: RiskLevel?
    let impactAnalysis: ImpactAnalysis?

    init(
        id: UUID,
        title: String,
        purpose: String,
        dependencies: [UUID],
        options: [PlanOption],
        kind: WorkflowStepKind? = nil,
        appliedDirectiveIDs: [UUID]? = nil,
        riskLevel: RiskLevel? = nil,
        impactAnalysis: ImpactAnalysis? = nil
    ) {
        self.id = id
        self.title = title
        self.purpose = purpose
        self.dependencies = dependencies
        self.options = options
        self.kind = kind
        self.appliedDirectiveIDs = appliedDirectiveIDs
        self.riskLevel = riskLevel
        self.impactAnalysis = impactAnalysis
    }
}

struct CodexBridgeResponse: Codable, Equatable {
    let requestID: UUID
    let status: Status
    let assistantMessage: String
    let steps: [CodexBridgeStep]?
    let result: StepResult?
    let error: String?

    enum Status: String, Codable {
        case success
        case failure
    }
}

enum AttachmentPolicy {
    static let maximumSingleFileBytes = 25 * 1_024 * 1_024
    static let maximumBatchBytes = 100 * 1_024 * 1_024
}

enum AttachmentStagingError: LocalizedError, Equatable {
    case fileTooLarge(actual: Int, maximum: Int)
    case batchTooLarge(maximum: Int)
    case duplicateContent
    case unsafePath

    var errorDescription: String? {
        switch self {
        case let .fileTooLarge(actual, maximum):
            "单个附件为 \(ByteCountFormatter.string(fromByteCount: Int64(actual), countStyle: .file))，超过 \(ByteCountFormatter.string(fromByteCount: Int64(maximum), countStyle: .file)) 上限。"
        case let .batchTooLarge(maximum):
            "本次附件总量超过 \(ByteCountFormatter.string(fromByteCount: Int64(maximum), countStyle: .file)) 上限。"
        case .duplicateContent:
            "相同内容的附件已经添加。"
        case .unsafePath:
            "附件路径不在 LoopCanvas 暂存目录内，已拒绝操作。"
        }
    }
}

struct AgentFileStore {
    let rootURL: URL

    var diagnosticsURL: URL { rootURL.appendingPathComponent("diagnostics", isDirectory: true) }
    var attachmentsURL: URL { rootURL.appendingPathComponent("attachments", isDirectory: true) }

    static func defaultRootURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["LOOPCANVAS_DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("LoopCanvas", isDirectory: true)
    }

    func prepare() throws {
        try FileManager.default.createDirectory(at: attachmentsURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: diagnosticsURL, withIntermediateDirectories: true)
    }

    func writeModelResponseDiagnostic(
        requestID: UUID,
        transport: String,
        failure: ModelResponseDecodingFailure
    ) throws -> URL {
        try prepare()
        let record = ModelResponseDiagnostic(
            requestID: requestID,
            capturedAt: Date(),
            transport: transport,
            error: failure.reason,
            responseWasTruncated: failure.responseWasTruncated,
            sanitizedResponse: failure.sanitizedResponse
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(record)
        let url = diagnosticsURL.appendingPathComponent(
            "model-response-failure-\(requestID.uuidString.lowercased()).json"
        )
        try data.write(to: url, options: .atomic)
        return url
    }

    func writeWorkflowRecoveryData(_ data: Data, label: String = "workflow") throws -> URL {
        try prepare()
        let safeLabel = label.replacingOccurrences(of: "/", with: "-")
        let url = diagnosticsURL.appendingPathComponent("unreadable-\(safeLabel)-\(UUID().uuidString.lowercased()).data")
        try data.write(to: url, options: .atomic)
        return url
    }

    func stageAttachment(
        data: Data,
        suggestedName: String,
        source: String,
        existingByteCount: Int = 0,
        existingHashes: Set<String> = []
    ) throws -> InputAttachment {
        guard data.count <= AttachmentPolicy.maximumSingleFileBytes else {
            throw AttachmentStagingError.fileTooLarge(
                actual: data.count,
                maximum: AttachmentPolicy.maximumSingleFileBytes
            )
        }
        guard existingByteCount <= AttachmentPolicy.maximumBatchBytes - data.count else {
            throw AttachmentStagingError.batchTooLarge(maximum: AttachmentPolicy.maximumBatchBytes)
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard !existingHashes.contains(hash) else { throw AttachmentStagingError.duplicateContent }
        try prepare()
        let id = UUID()
        let baseName = URL(fileURLWithPath: suggestedName).lastPathComponent
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "\\", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let safeName = String((baseName.isEmpty ? "attachment" : baseName).prefix(120))
        let url = attachmentsURL.appendingPathComponent("\(id.uuidString.lowercased())-\(safeName)")
        try data.write(to: url, options: .atomic)
        let contentType = UTType(filenameExtension: url.pathExtension)
        let kind: AttachmentKind
        if contentType?.conforms(to: .image) == true { kind = .image }
        else if contentType?.conforms(to: .pdf) == true { kind = .pdf }
        else if contentType?.conforms(to: .text) == true { kind = .text }
        else { kind = .file }
        return InputAttachment(
            id: id,
            name: safeName,
            kind: kind,
            mimeType: contentType?.preferredMIMEType ?? "application/octet-stream",
            byteCount: data.count,
            sha256: hash,
            localPath: url.path,
            displayMode: .chip,
            source: source
        )
    }

    func discardAttachment(_ attachment: InputAttachment) throws {
        let root = attachmentsURL.resolvingSymlinksInPath().standardizedFileURL
        let candidate = URL(fileURLWithPath: attachment.localPath)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let boundary = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(boundary) else { throw AttachmentStagingError.unsafePath }
        guard FileManager.default.fileExists(atPath: candidate.path) else { return }
        try FileManager.default.removeItem(at: candidate)
    }

    static let harnessModelPolicy = """
    你由 LoopCanvas 通过 DeepSeek Harness 调用。规划请求必须一次给出从需求到交付的完整步骤图；执行请求只完成指定的当前步骤，不得越过步骤边界。当前步骤内部允许反复检查、实现、运行验证并根据错误修复，也可以使用 Harness 已授权的工具。所有完成声明必须有实际文件、命令输出、软件渲染或其他与目标对应的证据；不得把模型自评、代码阅读或退出码 0 单独当成验收。禁止启动 Chrome 或其他 GUI 浏览器（包括 headless）：不得执行 open、spawn 浏览器可执行文件或任何会拉起浏览器的命令；需要可视化验证证据时，使用纯 Node 软件渲染脚本（如 test/render-preview.js、test/render-stemLeaf.js）或既有测试命令，不得编写或运行任何启动浏览器的脚本。若当前步骤制作或更新交付物，必须把完整最新产物作为 result.artifact 返回，并如实记录真实 projectRoot、files、测试命令和测试结果。最终仍由用户验收，Harness 的自评不能代替用户确认。
    """

    static let projectConstitution = """
    《项目 AI 工程宪法》——最高优先级约束，任何任务都不得违背：
    1. 产品目标：交付用户可直接使用、可验证、可回滚的生产级成果，而非仅能运行的原型。
    2. 核心用户：当前任务的直接使用者；未来半年面向更广泛用户，方案必须考虑可扩展与可维护。
    3. 架构原则：统一能力与接口优先于局部特例；模块边界清晰；禁止用局部补丁绕过统一架构；同类场景优先抽象为通用能力。
    4. 范围纪律：完整考虑问题空间，但只实现当前合理范围；明确哪些实现、预留、降级、明确不支持，不擅自扩大或缩小范围。
    5. 禁止事项：不得伪造证据；不得越过步骤边界；不得破坏已验收成果；不得引入不可回滚的改动。
    6. 底线：安全（恶意输入不突破边界）、可靠（失败可恢复）、兼容（旧数据可迁移）、性能（避免不可接受退化）。
    7. 完成标准：功能正确 + 边界/损坏输入 + 超时/重试/幂等 + 降级与回滚 + 可观测；"能运行"不等于完成。
    """

}

private struct ModelResponseDiagnostic: Codable {
    let requestID: UUID
    let capturedAt: Date
    let transport: String
    let error: String
    let responseWasTruncated: Bool
    let sanitizedResponse: String
}
