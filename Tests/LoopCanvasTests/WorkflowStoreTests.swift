import XCTest
@testable import LoopCanvas

@MainActor
final class WorkflowStoreTests: XCTestCase {
    func testComposerPlaceholderHidesForTextAndPinyinComposition() {
        XCTAssertTrue(ComposerPlaceholderVisibility.shouldShow(text: "", hasMarkedText: false))
        XCTAssertFalse(ComposerPlaceholderVisibility.shouldShow(text: "q", hasMarkedText: false))
        XCTAssertFalse(ComposerPlaceholderVisibility.shouldShow(text: "", hasMarkedText: true))
    }

    func testApprovalUnlocksDependentStep() {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        let first = store.steps[0]
        let option = first.options[0]

        store.selectOption(option.id, for: first.id)
        store.selectedStepID = first.id
        store.runSelectedStep()
        respondToExecution(in: store, bridgeRoot: bridgeRoot)
        store.approve(stepID: first.id)

        XCTAssertEqual(store.steps.first(where: { $0.id == DemoWorkflow.architecture })?.status, .ready)
    }

    func testIndependentStepsCanChangeOrder() {
        let store = WorkflowStore(loadPersisted: false)
        let interactionIndex = store.steps.firstIndex { $0.id == DemoWorkflow.interaction }
        let stateIndex = store.steps.firstIndex { $0.id == DemoWorkflow.stateModel }
        XCTAssertNotNil(interactionIndex)
        XCTAssertNotNil(stateIndex)

        XCTAssertTrue(store.moveStep(DemoWorkflow.stateModel, before: DemoWorkflow.interaction))
        XCTAssertLessThan(
            store.steps.firstIndex { $0.id == DemoWorkflow.stateModel }!,
            store.steps.firstIndex { $0.id == DemoWorkflow.interaction }!
        )
    }

    func testDependencyCannotMoveBeforeParent() {
        let store = WorkflowStore(loadPersisted: false)
        let originalOrder = store.steps.map(\.id)

        XCTAssertFalse(store.moveStep(DemoWorkflow.prototype, before: DemoWorkflow.goal))
        XCTAssertEqual(store.steps.map(\.id), originalOrder)
    }

    func testReopeningUpstreamMarksCompletedDescendantStale() {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        completeAndApprove(DemoWorkflow.goal, in: store, bridgeRoot: bridgeRoot)
        completeAndApprove(DemoWorkflow.architecture, in: store, bridgeRoot: bridgeRoot)
        completeAndApprove(DemoWorkflow.interaction, in: store, bridgeRoot: bridgeRoot)

        store.reopenApprovedStep(stepID: DemoWorkflow.architecture)

        XCTAssertEqual(store.steps.first(where: { $0.id == DemoWorkflow.interaction })?.status, .stale)
        XCTAssertEqual(store.steps.first(where: { $0.id == DemoWorkflow.architecture })?.status, .ready)
        XCTAssertEqual(store.steps.count, 6, "总体计划必须保留")
    }

    func testPauseGeneratesTwoInMemoryHandoffsWithoutInventingProject() {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        XCTAssertNil(store.handoffDraft)

        store.togglePause()

        XCTAssertTrue(store.isPaused)
        XCTAssertNotNil(store.handoffDraft)
        let model = store.handoffDraft?.modelDocument
        let report = store.handoffDraft?.technicalReport
        XCTAssertTrue(model?.filename.contains("MODEL-HANDOFF") == true)
        XCTAssertTrue(report?.filename.contains("TECHNICAL-REPORT") == true)
        XCTAssertTrue(model?.content.contains("# LC-HANDOFF/2") == true)
        XCTAssertTrue(model?.content.contains(DemoWorkflow.objective) == true)
        XCTAssertTrue(model?.content.contains("target_project_root=UNKNOWN_NOT_CREATED_OR_NOT_REPORTED") == true)
        XCTAssertTrue(model?.content.contains("redundant_timeline_events_omitted=true") == true)
        XCTAssertTrue(report?.content.contains("# LoopCanvas 技术交接报告") == true)
        XCTAssertTrue(report?.content.contains("LocalAITeam/LoopCanvas` 是编排器本身") == true)
        XCTAssertTrue(report?.content.contains("网页、模型和交互尚未生成") == true)
        XCTAssertNotEqual(model?.content, report?.content)
    }

    func testDetailedArtifactManifestAppearsInBothHandoffs() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: bridgeRoot)
        let first = try XCTUnwrap(store.steps.first)
        store.selectOption(first.options[0].id, for: first.id)
        store.selectedStepID = first.id
        store.runSelectedStep()
        let request = try XCTUnwrap(store.pendingBridgeRequests.last)
        let artifact = DeliverableArtifact(
            title: "苹果网站原型",
            kind: .html,
            content: "<!doctype html><h1>Apple</h1>",
            filename: "index.html",
            projectRoot: "/tmp/AppleDemo",
            files: ["index.html", "src/main.js"],
            entrypoint: "index.html",
            dependencies: ["three@0.180.0"],
            runCommands: ["npm run dev"],
            testCommands: ["npm test"],
            testResults: ["12 tests passed"]
        )
        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "生成原型",
            steps: nil,
            result: StepResult(
                summary: "完成首版",
                actualChanges: ["生成网页"],
                evidence: ["测试通过"],
                deviation: "仍待集成",
                rollback: "移除首版",
                artifact: artifact
            ),
            error: nil
        ))
        store.togglePause()

        let model = try XCTUnwrap(store.handoffDraft?.modelDocument.content)
        let report = try XCTUnwrap(store.handoffDraft?.technicalReport.content)
        for expected in ["/tmp/AppleDemo", "src/main.js", "three@0.180.0", "npm run dev", "npm test", "12 tests passed"] {
            XCTAssertTrue(model.contains(expected), "模型交接缺少 \(expected)")
            XCTAssertTrue(report.contains(expected), "技术报告缺少 \(expected)")
        }
        XCTAssertTrue(model.contains("<<<ARTIFACT_CONTENT_BEGIN>>>"))
        XCTAssertTrue(model.contains("<!doctype html><h1>Apple</h1>"))
        XCTAssertFalse(report.contains("<!doctype html><h1>Apple</h1>"), "人类报告不应重复嵌入完整产物")
    }

    func testUserCorrectionIsWrittenToSharedContext() {
        let store = WorkflowStore(loadPersisted: false)
        let first = store.steps[0]
        store.selectOption(first.options[0].id, for: first.id)

        XCTAssertTrue(store.sharedContext.contains { $0.kind == .decision && $0.stepID == first.id })
    }

    func testPlanningQueuesRequestThenImportsCompletePlan() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "做一个可以逐步验收的研究工具")
        XCTAssertEqual(store.phase, .building)
        XCTAssertTrue(store.steps.isEmpty)
        XCTAssertEqual(store.pendingBridgeRequests.count, 1)

        let request = try XCTUnwrap(store.pendingBridgeRequests.first)
        XCTAssertEqual(request.kind, .planFirstStep)
        XCTAssertTrue(request.modelPolicy.contains("通过 DeepSeek Harness 调用"))
        XCTAssertTrue(request.responseInstructions.contains("6–10"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: bridgeRoot.appendingPathComponent("requests").path))

        let ids = (0..<6).map { _ in UUID() }
        let kinds: [WorkflowStepKind] = [.decision, .decision, .build, .integrate, .verify, .deliver]
        let response = CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "已返回从决策到交付的完整步骤图。",
            steps: ids.enumerated().map { index, id in
                CodexBridgeStep(
                    id: id,
                    title: "完整计划步骤 \(index + 1)",
                    purpose: "覆盖 \(kinds[index].rawValue) 阶段。",
                    dependencies: index == 0 ? [] : [ids[0]],
                    options: testOptions(),
                    kind: kinds[index]
                )
            },
            result: nil,
            error: nil
        )
        store.receiveAgentResponse(response)

        XCTAssertEqual(store.phase, .workspace)
        XCTAssertEqual(store.steps.count, 6)
        XCTAssertEqual(store.steps.map(\.id), ids)
        XCTAssertEqual(store.steps[1].dependencies, [ids[0]])
        XCTAssertEqual(store.steps[2].dependencies, [ids[0]], "导入器必须保留模型声明的真实分支，不能偷偷串行化")
        XCTAssertEqual(store.agentSessions.count, 1)
        XCTAssertEqual(store.pendingBridgeRequests.count, 0, "完整计划返回后不应再静默追加局部规划")
        XCTAssertTrue(store.hasCompletePlan)
        XCTAssertFalse(store.isDeliverableReady)
        XCTAssertNil(store.selectedConversationID)
        XCTAssertFalse(store.isShowingSharedContext)
        XCTAssertFalse(store.isShowingDeliverable)
    }

    func testLegacyPlanUsesSafeChainAndUnambiguousRepairHandoff() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let defaults = UserDefaults.standard
        let persistenceKey = "LoopCanvas.workflow.v3"
        let projectsKey = "LoopCanvas.projects.v1"
        let prior = defaults.data(forKey: persistenceKey)
        let priorProjects = defaults.data(forKey: projectsKey)
        defer {
            if let prior { defaults.set(prior, forKey: persistenceKey) }
            else { defaults.removeObject(forKey: persistenceKey) }
            if let priorProjects { defaults.set(priorProjects, forKey: projectsKey) }
            else { defaults.removeObject(forKey: projectsKey) }
        }
        defaults.removeObject(forKey: projectsKey)

        let ids = (0..<4).map { _ in UUID() }
        let titles = ["选择素材路线", "选择 Three.js 技术路线", "确定热点与旋转交互", "确定 120 FPS 验收范围"]
        let legacySteps = ids.enumerated().map { index, id in
            WorkflowStep(
                id: id,
                title: titles[index],
                purpose: index == 3 ? "定义桌面端帧率验收目标" : "确认当前方向",
                dependencies: index == 0 ? [] : [ids[0]],
                kind: nil,
                status: .approved,
                options: testOptions(),
                selectedOptionID: nil,
                result: nil,
                revision: 1,
                lastFeedback: nil
            )
        }
        let agents = (0..<3).map { index in
            AgentSession(id: UUID(), name: "旧规划对话 \(index)", focus: "旧流程", assignedStepIDs: [], status: .complete, progress: 1, notes: [])
        }
        let snapshot = WorkflowSnapshot(
            phase: .workspace,
            requirement: "制作可旋转的 3D 苹果网站",
            steps: legacySteps,
            selectedStepID: ids[3],
            isPaused: false,
            decisionLog: [],
            sharedContext: [],
            agentSessions: agents,
            pendingBridgeRequests: []
        )
        defaults.set(try JSONEncoder().encode(snapshot), forKey: persistenceKey)
        let store = WorkflowStore(loadPersisted: true, bridgeRoot: bridgeRoot)

        XCTAssertEqual(store.effectiveDependencies(for: store.steps[1]), [ids[0]])
        XCTAssertEqual(store.effectiveDependencies(for: store.steps[2]), [ids[1]])
        XCTAssertEqual(store.effectiveDependencies(for: store.steps[3]), [ids[2]])
        XCTAssertEqual(store.effectiveKind(for: store.steps[0]), .decision)
        XCTAssertEqual(store.effectiveKind(for: store.steps[3]), .verify)
        XCTAssertTrue(store.stepKindWasInferred(store.steps[3]))
        XCTAssertFalse(store.stepRequiresArtifact(store.steps[0]))

        store.reopenApprovedStep(stepID: ids[0])
        XCTAssertEqual(store.steps[1].status, .stale)
        XCTAssertEqual(store.steps[2].status, .stale)
        XCTAssertEqual(store.steps[3].status, .stale)

        store.togglePause()
        let handoff = try XCTUnwrap(store.handoffDraft?.modelDocument.content)
        XCTAssertTrue(handoff.contains("kind=decision|kind_source=inferred_legacy|requires_artifact=false"))
        XCTAssertTrue(handoff.contains("kind=verify|kind_source=inferred_legacy|requires_artifact=false"))
        XCTAssertTrue(handoff.contains("declared_deps=\(ids[0].uuidString)|effective_deps=\(ids[1].uuidString)"))
        XCTAssertTrue(handoff.contains("NEXT|PLAN_REPAIR_ONLY"))
        XCTAssertFalse(handoff.contains("kind=legacy"))
    }

    func testIncompletePlanStaysInBuildingPhase() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "制作一个完整网站")
        let request = try XCTUnwrap(store.pendingBridgeRequests.first)
        let id = UUID()
        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "只给了一步",
            steps: [CodexBridgeStep(id: id, title: "方向", purpose: "只做决策", dependencies: [], options: testOptions(), kind: .decision)],
            result: nil,
            error: nil
        ))

        XCTAssertEqual(store.phase, .building)
        XCTAssertTrue(store.steps.isEmpty)
        XCTAssertFalse(store.planValidationIssues.isEmpty)
        XCTAssertFalse(store.hasCompletePlan)
    }

    func testUnreadableSnapshotIsPreservedForRecovery() throws {
        let storageRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: storageRoot) }
        let defaults = UserDefaults.standard
        let persistenceKey = "LoopCanvas.workflow.v3"
        let projectsKey = "LoopCanvas.projects.v1"
        let prior = defaults.data(forKey: persistenceKey)
        let priorProjects = defaults.data(forKey: projectsKey)
        defer {
            if let prior { defaults.set(prior, forKey: persistenceKey) }
            else { defaults.removeObject(forKey: persistenceKey) }
            if let priorProjects { defaults.set(priorProjects, forKey: projectsKey) }
            else { defaults.removeObject(forKey: projectsKey) }
        }
        defaults.removeObject(forKey: projectsKey)
        let corrupt = Data("not-json".utf8)
        defaults.set(corrupt, forKey: persistenceKey)

        let store = WorkflowStore(loadPersisted: true, bridgeRoot: storageRoot)

        XCTAssertEqual(store.phase, .intake)
        XCTAssertTrue(store.transientMessage?.contains("恢复数据") == true)
        let diagnostics = storageRoot.appendingPathComponent("diagnostics", isDirectory: true)
        let files = try FileManager.default.contentsOfDirectory(at: diagnostics, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(try Data(contentsOf: files[0]), corrupt)
    }

    func testUnreadableProjectsDocumentIsPreservedForRecovery() throws {
        let storageRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: storageRoot) }
        let defaults = UserDefaults.standard
        let persistenceKey = "LoopCanvas.workflow.v3"
        let projectsKey = "LoopCanvas.projects.v1"
        let prior = defaults.data(forKey: persistenceKey)
        let priorProjects = defaults.data(forKey: projectsKey)
        defer {
            if let prior { defaults.set(prior, forKey: persistenceKey) }
            else { defaults.removeObject(forKey: persistenceKey) }
            if let priorProjects { defaults.set(priorProjects, forKey: projectsKey) }
            else { defaults.removeObject(forKey: projectsKey) }
        }
        defaults.removeObject(forKey: persistenceKey)
        let corrupt = Data("not-project-json".utf8)
        defaults.set(corrupt, forKey: projectsKey)

        let store = WorkflowStore(loadPersisted: true, bridgeRoot: storageRoot)

        XCTAssertEqual(store.phase, .intake)
        XCTAssertTrue(store.transientMessage?.contains("项目数据无法读取") == true)
        let diagnostics = storageRoot.appendingPathComponent("diagnostics", isDirectory: true)
        let files = try FileManager.default.contentsOfDirectory(at: diagnostics, includingPropertiesForKeys: nil)
        let recovery = try XCTUnwrap(files.first { $0.lastPathComponent.contains("unreadable-projects") })
        XCTAssertEqual(try Data(contentsOf: recovery), corrupt)
    }

    func testProjectArchiveCheckpointAndSchemaPersistAcrossReopen() throws {
        let storageRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: storageRoot) }
        let defaults = UserDefaults.standard
        let persistenceKey = "LoopCanvas.workflow.v3"
        let projectsKey = "LoopCanvas.projects.v1"
        let prior = defaults.data(forKey: persistenceKey)
        let priorProjects = defaults.data(forKey: projectsKey)
        defer {
            if let prior { defaults.set(prior, forKey: persistenceKey) }
            else { defaults.removeObject(forKey: persistenceKey) }
            if let priorProjects { defaults.set(priorProjects, forKey: projectsKey) }
            else { defaults.removeObject(forKey: projectsKey) }
        }
        defaults.removeObject(forKey: persistenceKey)
        defaults.removeObject(forKey: projectsKey)
        let store = WorkflowStore(loadPersisted: true, bridgeRoot: storageRoot)
        let originalID = try XCTUnwrap(store.currentProjectIDValue)
        store.createCheckpoint(reason: "归档前")

        store.archiveProject(originalID)
        XCTAssertEqual(store.archivedProjectCount, 1)
        XCTAssertFalse(store.projects.contains { $0.id == originalID })
        store.restoreMostRecentlyArchivedProject()

        XCTAssertEqual(store.currentProjectIDValue, originalID)
        XCTAssertEqual(store.archivedProjectCount, 0)
        XCTAssertEqual(store.currentCheckpointCount, 1)
        let data = try XCTUnwrap(defaults.data(forKey: projectsKey))
        let document = try JSONDecoder().decode(ProjectsDocument.self, from: data)
        XCTAssertEqual(document.schemaVersion, ProjectsDocument.currentSchemaVersion)

        let reopened = WorkflowStore(loadPersisted: true, bridgeRoot: storageRoot)
        XCTAssertEqual(reopened.currentProjectIDValue, originalID)
        XCTAssertEqual(reopened.currentCheckpointCount, 1)
        reopened.startPlanning(requirement: "验证自动恢复点")
        reopened.resetToIntake()
        XCTAssertEqual(reopened.currentCheckpointCount, 2)
        reopened.restoreLatestCheckpoint()
        XCTAssertEqual(reopened.requirement, "验证自动恢复点")
        XCTAssertEqual(reopened.phase, .building)
    }

    func testProjectsDocumentRejectsFutureSchema() throws {
        let data = Data("{\"schemaVersion\":999,\"projects\":[],\"archivedProjects\":[]}".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(ProjectsDocument.self, from: data))
    }

    func testUserExplicitOptionMustPrecedeModelOption() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "我想使用原生 Three.js 制作网站")
        let directive = try XCTUnwrap(store.requirementDirectives.first)
        let request = try XCTUnwrap(store.pendingBridgeRequests.first)
        let ids = (0..<6).map { _ in UUID() }
        let kinds: [WorkflowStepKind] = [.decision, .build, .integrate, .decision, .verify, .deliver]
        let explicit = PlanOption(title: "原生 Three.js", subtitle: "用户方案", technicalReason: "忠实保留用户指定路线", advantages: ["符合需求"], tradeoffs: ["需自行组织架构"], downstreamImpact: "后续使用 Three.js", isRecommended: true, origin: .userExplicit, matchedDirectiveIDs: [directive.id], rankReason: "用户明确提出")
        let alternative = PlanOption(title: "其他引擎", subtitle: "模型备选", technicalReason: "备选", advantages: ["封装多"], tradeoffs: ["偏离原需求"], downstreamImpact: "改变技术栈", origin: .model)
        let steps = ids.enumerated().map { index, id in
            CodexBridgeStep(id: id, title: "步骤 \(index + 1)", purpose: "覆盖阶段", dependencies: index == 0 ? [] : [ids[index - 1]], options: index == 0 ? [explicit, alternative] : testOptions(), kind: kinds[index], appliedDirectiveIDs: index == 0 ? [directive.id] : [])
        }
        store.receiveAgentResponse(CodexBridgeResponse(requestID: request.id, status: .success, assistantMessage: "完整计划", steps: steps, result: nil, error: nil))

        XCTAssertEqual(store.phase, .workspace)
        XCTAssertEqual(store.steps.first?.options.first?.origin, .userExplicit)
        XCTAssertEqual(store.steps.first?.options.first?.title, "原生 Three.js")
    }

    func testAttachmentIsStagedAndIncludedInRequest() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        let data = Data("很长的需求正文".utf8)
        let attachment = try XCTUnwrap(store.stageAttachment(data: data, suggestedName: "需求.txt", source: "测试"))
        store.startPlanning(requirement: "按附件执行", attachments: [attachment])
        let request = try XCTUnwrap(store.pendingBridgeRequests.first)

        XCTAssertEqual(request.attachments?.first?.sha256, attachment.sha256)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: attachment.localPath)), data)
        XCTAssertEqual(store.restoreText(from: attachment), "很长的需求正文")
    }

    func testAttachmentDuplicateAndBatchLimitsAreRejected() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        let first = try XCTUnwrap(store.stageAttachment(
            data: Data("same".utf8),
            suggestedName: "first.txt",
            source: "测试"
        ))

        XCTAssertNil(store.stageAttachment(
            data: Data("same".utf8),
            suggestedName: "second.txt",
            source: "测试",
            existingAttachments: [first]
        ))
        XCTAssertTrue(store.transientMessage?.contains("相同内容") == true)

        let fileStore = AgentFileStore(rootURL: bridgeRoot)
        XCTAssertThrowsError(try fileStore.stageAttachment(
            data: Data([0]),
            suggestedName: "overflow.bin",
            source: "测试",
            existingByteCount: AttachmentPolicy.maximumBatchBytes
        )) { error in
            XCTAssertEqual(error as? AttachmentStagingError, .batchTooLarge(maximum: AttachmentPolicy.maximumBatchBytes))
        }
    }

    func testAttachmentSingleFileLimitAndControlledCleanup() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let fileStore = AgentFileStore(rootURL: bridgeRoot)
        XCTAssertThrowsError(try fileStore.stageAttachment(
            data: Data(count: AttachmentPolicy.maximumSingleFileBytes + 1),
            suggestedName: "large.bin",
            source: "测试"
        ))

        let attachment = try fileStore.stageAttachment(
            data: Data("draft".utf8),
            suggestedName: "../draft.txt",
            source: "测试"
        )
        XCTAssertEqual(attachment.name, "draft.txt")
        XCTAssertTrue(FileManager.default.fileExists(atPath: attachment.localPath))
        try fileStore.discardAttachment(attachment)
        XCTAssertFalse(FileManager.default.fileExists(atPath: attachment.localPath))

        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent("LoopCanvas-outside-\(UUID().uuidString).txt")
        try Data("keep".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        var unsafe = attachment
        unsafe.localPath = outside.path
        XCTAssertThrowsError(try fileStore.discardAttachment(unsafe)) { error in
            XCTAssertEqual(error as? AttachmentStagingError, .unsafePath)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
    }

    func testBuildStepRequiresArtifactBeforeReview() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: bridgeRoot)
        let first = try XCTUnwrap(store.steps.first)

        store.selectOption(first.options[0].id, for: first.id)
        store.selectedStepID = first.id
        store.runSelectedStep()
        let request = try XCTUnwrap(store.pendingBridgeRequests.last)
        let response = CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "只返回了文字，没有产物。",
            steps: nil,
            result: StepResult(
                summary: "缺少产物",
                actualChanges: [],
                evidence: [],
                deviation: "artifact 缺失",
                rollback: "重试"
            ),
            error: nil
        )
        store.receiveAgentResponse(response)

        XCTAssertEqual(store.steps.first?.status, .ready)
        XCTAssertNil(store.steps.first?.result)
        XCTAssertNotNil(store.bridgeError)
        XCTAssertNil(store.currentArtifact)
    }

    func testAgentFailureRestoresRunningStepForRetry() throws {
        let storageRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: storageRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: storageRoot)
        let step = try XCTUnwrap(store.steps.first)
        store.selectOption(step.options[0].id, for: step.id)
        store.selectedStepID = step.id
        store.runSelectedStep()
        let request = try XCTUnwrap(store.pendingBridgeRequests.last)

        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: request.id,
            status: .failure,
            assistantMessage: "执行失败",
            steps: nil,
            result: nil,
            error: "tool_failed"
        ))

        XCTAssertEqual(store.steps.first?.status, .ready)
        XCTAssertTrue(store.pendingBridgeRequests.isEmpty)
        XCTAssertEqual(store.bridgeError, "tool_failed")
    }

    func testSelectedCDNOptionProducesCompactCompatibleExecutionPolicy() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "制作 Three.js 苹果场景")
        let planningRequest = try XCTUnwrap(store.pendingBridgeRequests.first)
        let ids = (0..<6).map { _ in UUID() }
        let kinds: [WorkflowStepKind] = [.build, .decision, .integrate, .decision, .verify, .deliver]
        let cdnOption = PlanOption(
            title: "使用 HTML 单文件 + CDN 引入 Three.js",
            subtitle: "通过固定 HTTPS CDN 快速搭建",
            technicalReason: "无需复制第三方库源码",
            advantages: ["输出紧凑"],
            tradeoffs: ["依赖网络"],
            downstreamImpact: "后续步骤继续使用相同 CDN",
            isRecommended: true,
            origin: .model,
            matchedDirectiveIDs: [],
            rankReason: "快速原型备选"
        )
        let alternative = PlanOption(
            title: "本地 npm 依赖",
            subtitle: "本地构建",
            technicalReason: "可离线",
            advantages: ["离线"],
            tradeoffs: ["需要构建"],
            downstreamImpact: "使用本地依赖",
            isRecommended: false,
            origin: .model,
            matchedDirectiveIDs: [],
            rankReason: "备选"
        )
        let plan = ids.enumerated().map { index, id in
            CodexBridgeStep(
                id: id,
                title: "步骤 \(index + 1)",
                purpose: "覆盖 \(kinds[index].rawValue)",
                dependencies: index == 0 ? [] : [ids[index - 1]],
                options: index == 0 ? [cdnOption, alternative] : testOptions(),
                kind: kinds[index]
            )
        }
        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: planningRequest.id,
            status: .success,
            assistantMessage: "完整计划",
            steps: plan,
            result: nil,
            error: nil
        ))
        let first = try XCTUnwrap(store.steps.first)
        store.selectOption(cdnOption.id, for: first.id)
        store.selectedStepID = first.id
        store.runSelectedStep()

        let executionRequest = try XCTUnwrap(store.pendingBridgeRequests.last)
        XCTAssertTrue(store.allowsHTTPSRemoteArtifactResources)
        XCTAssertTrue(executionRequest.responseInstructions.contains("所选方案明确允许 CDN"))
        XCTAssertTrue(executionRequest.responseInstructions.contains("不要内嵌或复制 Three.js"))
        XCTAssertTrue(executionRequest.responseInstructions.contains("绝不能写“此处省略但保证可运行”"))
        XCTAssertFalse(executionRequest.responseInstructions.contains("不得引用 CDN、远程脚本"))
    }

    func testBuildStepRejectsHTMLWithMissingLocalModules() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: bridgeRoot)
        let first = try XCTUnwrap(store.steps.first)

        store.selectOption(first.options[0].id, for: first.id)
        store.selectedStepID = first.id
        store.runSelectedStep()
        let request = try XCTUnwrap(store.pendingBridgeRequests.last)
        let artifact = DeliverableArtifact(
            title: "苹果",
            kind: .html,
            content: """
            <script type="importmap">{"imports":{"three":"./three.module.js"}}</script>
            <script type="module">import * as THREE from 'three'; new THREE.Scene();</script>
            """,
            filename: "apple-scene.html",
            dependencies: ["three.module.js"]
        )
        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "错误地声称完成",
            steps: nil,
            result: StepResult(
                summary: "完成",
                actualChanges: ["生成 HTML"],
                evidence: ["代码存在"],
                deviation: "无",
                rollback: "删除文件",
                artifact: artifact
            ),
            error: nil
        ))

        XCTAssertEqual(store.steps.first?.status, .ready)
        XCTAssertTrue(store.bridgeError?.contains("没有真实 projectRoot") == true)
        XCTAssertNil(store.currentArtifact)
    }

    func testArtifactAppearsInDeliverableWindowWithoutPrematureCompletion() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: bridgeRoot)
        let first = try XCTUnwrap(store.steps.first)

        store.selectOption(first.options[0].id, for: first.id)
        store.selectedStepID = first.id
        store.runSelectedStep()
        let request = try XCTUnwrap(store.pendingBridgeRequests.last)
        let artifact = DeliverableArtifact(
            title: "演示页面",
            kind: .html,
            content: "<!doctype html><h1>可预览成品</h1>",
            filename: "index.html"
        )
        let response = CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "返回当前完整产物。",
            steps: nil,
            result: StepResult(
                summary: "已生成首版",
                actualChanges: ["生成页面"],
                evidence: ["artifact 已返回"],
                deviation: "仍有后续步骤",
                rollback: "清除首版",
                artifact: artifact
            ),
            error: nil
        )
        store.receiveAgentResponse(response)

        XCTAssertEqual(store.currentArtifact, artifact)
        XCTAssertEqual(store.steps.first?.status, .review)
        XCTAssertFalse(store.isDeliverableReady)
        store.showDeliverable()
        XCTAssertTrue(store.isShowingDeliverable)
        XCTAssertNil(store.selectedConversationID)
        XCTAssertFalse(store.isShowingSharedContext)
    }

    func testDeliverableBecomesReadyOnlyAfterCompletePlanIsApproved() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: bridgeRoot)

        XCTAssertTrue(store.hasCompletePlan)
        XCTAssertFalse(store.isDeliverableReady)

        for (index, step) in store.steps.enumerated() {
            store.selectOption(step.options[0].id, for: step.id)
            store.selectedStepID = step.id
            store.runSelectedStep()
            let request = try XCTUnwrap(store.pendingBridgeRequests.last)
            if index > 0 {
                XCTAssertNotNil(request.currentArtifact, "后续步骤必须收到当前完整产物")
            }

            let artifact = step.kind?.requiresArtifact == true
                ? DeliverableArtifact(
                    title: "交付版本 \(index + 1)",
                    kind: .html,
                    content: "<!doctype html><h1>版本 \(index + 1)</h1>",
                    filename: "index.html"
                )
                : nil
            store.receiveAgentResponse(CodexBridgeResponse(
                requestID: request.id,
                status: .success,
                assistantMessage: "完成当前步骤",
                steps: nil,
                result: StepResult(
                    summary: "步骤结果",
                    actualChanges: ["处理当前步骤"],
                    evidence: ["测试响应"],
                    deviation: "无",
                    rollback: "撤销本步",
                    artifact: artifact,
                    verificationPassed: step.kind == .verify ? true : nil,
                    blockingIssues: step.kind == .verify ? [] : nil
                ),
                error: nil
            ))
            XCTAssertEqual(store.steps.first(where: { $0.id == step.id })?.status, .review)
            XCTAssertFalse(store.isDeliverableReady, "最终一步被用户批准前不能标记可交付")
            store.approve(stepID: step.id)
        }

        XCTAssertEqual(store.approvedCount, store.steps.count)
        XCTAssertTrue(store.isDeliverableReady)
        XCTAssertEqual(store.currentStepTitle, "可交付成品已由用户确认")
        XCTAssertEqual(store.currentArtifact?.title, "交付版本 6")
    }

    func testFailedVerificationRemainsVisibleAndReturnsToArtifactRepair() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = try storeWithCompletePlan(bridgeRoot: bridgeRoot)

        for step in store.steps.prefix(4) {
            store.selectOption(step.options[0].id, for: step.id)
            store.selectedStepID = step.id
            store.runSelectedStep()
            let request = try XCTUnwrap(store.pendingBridgeRequests.last)
            let artifact = step.kind?.requiresArtifact == true
                ? DeliverableArtifact(
                    title: "中间版本",
                    kind: .html,
                    content: "<!doctype html><html><body>ok</body></html>",
                    filename: "index.html"
                )
                : nil
            store.receiveAgentResponse(CodexBridgeResponse(
                requestID: request.id,
                status: .success,
                assistantMessage: "完成上游步骤",
                steps: nil,
                result: StepResult(
                    summary: "完成",
                    actualChanges: ["更新当前步骤"],
                    evidence: ["测试响应"],
                    deviation: "无",
                    rollback: "回退",
                    artifact: artifact
                ),
                error: nil
            ))
            store.approve(stepID: step.id)
        }

        let verifyStep = try XCTUnwrap(store.steps.first(where: { $0.kind == .verify }))
        store.selectOption(verifyStep.options[0].id, for: verifyStep.id)
        store.selectedStepID = verifyStep.id
        store.runSelectedStep()
        let verificationRequest = try XCTUnwrap(store.pendingBridgeRequests.last)
        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: verificationRequest.id,
            status: .success,
            assistantMessage: "验证发现运行时错误",
            steps: nil,
            result: StepResult(
                summary: "验证未通过",
                actualChanges: [],
                evidence: ["页面空白"],
                deviation: "交互未运行",
                rollback: "修复后重试",
                verificationPassed: false,
                blockingIssues: ["OrbitControls 无法构造"]
            ),
            error: nil
        ))

        XCTAssertEqual(store.steps.first(where: { $0.id == verifyStep.id })?.status, .review)
        XCTAssertEqual(store.steps.first(where: { $0.id == verifyStep.id })?.result?.blockingIssues, ["OrbitControls 无法构造"])
        XCTAssertEqual(store.steps.last?.status, .locked)

        store.approve(stepID: verifyStep.id)

        XCTAssertEqual(store.steps.first(where: { $0.id == verifyStep.id })?.status, .review)
        XCTAssertEqual(store.steps.last?.status, .locked, "失败验证不能被批准，也不能解锁交付步骤")

        store.returnVerificationFailureToRepair(stepID: verifyStep.id, feedback: "修复模块导入")

        let repairStep = try XCTUnwrap(store.selectedStep)
        XCTAssertEqual(repairStep.kind, .integrate)
        XCTAssertEqual(repairStep.status, .ready)
        XCTAssertNil(repairStep.result)
        XCTAssertTrue(repairStep.lastFeedback?.contains("OrbitControls 无法构造") == true)
        XCTAssertTrue(repairStep.lastFeedback?.contains("修复模块导入") == true)
        XCTAssertEqual(store.steps.first(where: { $0.id == verifyStep.id })?.status, .stale)
        XCTAssertEqual(store.steps.last?.status, .locked)
    }

    func testSidebarConversationSelectionDoesNotChangeSharedContext() {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "验证侧栏对话")
        let contextCount = store.sharedContext.count
        let agentID = store.agentSessions[0].id

        store.showAgentConversation(agentID)
        XCTAssertEqual(store.selectedConversationID, agentID)
        XCTAssertFalse(store.isShowingSharedContext)

        store.showSharedContext()
        XCTAssertNil(store.selectedConversationID)
        XCTAssertTrue(store.isShowingSharedContext)
        XCTAssertEqual(store.sharedContext.count, contextCount)

        store.showMainLoop()
        XCTAssertNil(store.selectedConversationID)
        XCTAssertFalse(store.isShowingSharedContext)
    }

    func testAgentRequestJSONRoundTripPreservesPolicyAndDate() throws {
        let bridgeRoot = temporaryBridgeRoot()
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "测试请求编码")
        let expected = try XCTUnwrap(store.pendingBridgeRequests.first)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(CodexBridgeRequest.self, from: encoder.encode(expected))

        XCTAssertEqual(decoded.id, expected.id)
        XCTAssertEqual(decoded.kind, expected.kind)
        XCTAssertEqual(decoded.agentID, expected.agentID)
        XCTAssertEqual(decoded.userGoal, expected.userGoal)
        XCTAssertEqual(decoded.focus, expected.focus)
        XCTAssertEqual(decoded.sharedContext, expected.sharedContext)
        XCTAssertEqual(decoded.responseInstructions, expected.responseInstructions)
        XCTAssertLessThan(abs(decoded.createdAt.timeIntervalSince(expected.createdAt)), 1)
        XCTAssertTrue(decoded.modelPolicy.contains("通过 DeepSeek Harness 调用"))
    }

    private func completeAndApprove(_ stepID: UUID, in store: WorkflowStore, bridgeRoot: URL) {
        let step = store.steps.first { $0.id == stepID }!
        store.selectOption(step.options[0].id, for: stepID)
        store.selectedStepID = stepID
        store.runSelectedStep()
        respondToExecution(in: store, bridgeRoot: bridgeRoot)
        store.approve(stepID: stepID)
    }

    private func storeWithCompletePlan(bridgeRoot: URL) throws -> WorkflowStore {
        let store = WorkflowStore(loadPersisted: false, bridgeRoot: bridgeRoot)
        store.resetToIntake()
        store.startPlanning(requirement: "生成一个可演示网站")
        let request = try XCTUnwrap(store.pendingBridgeRequests.first)
        let ids = (0..<6).map { _ in UUID() }
        let kinds: [WorkflowStepKind] = [.build, .decision, .integrate, .decision, .verify, .deliver]
        let steps = ids.enumerated().map { index, id in
            CodexBridgeStep(
                id: id,
                title: "步骤 \(index + 1)",
                purpose: "测试 \(kinds[index].rawValue)",
                dependencies: index == 0 ? [] : [ids[index - 1]],
                options: testOptions(),
                kind: kinds[index]
            )
        }
        store.receiveAgentResponse(CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "完整测试计划",
            steps: steps,
            result: nil,
            error: nil
        ))
        return store
    }

    private func respondToExecution(in store: WorkflowStore, bridgeRoot: URL) {
        guard let request = store.pendingBridgeRequests.last(where: { $0.kind == .executeStep }) else {
            XCTFail("没有生成执行请求")
            return
        }
        let response = CodexBridgeResponse(
            requestID: request.id,
            status: .success,
            assistantMessage: "当前步骤已返回，等待用户判断。",
            steps: nil,
            result: StepResult(
                summary: "测试结果",
                actualChanges: ["仅处理当前步骤"],
                evidence: ["测试桥接回复"],
                deviation: "测试数据",
                rollback: "清除本步结果"
            ),
            error: nil
        )
        store.receiveAgentResponse(response)
    }

    private func temporaryBridgeRoot() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("LoopCanvasTests-\(UUID().uuidString)", isDirectory: true)
    }

    private func testOption() -> PlanOption {
        PlanOption(
            title: "先确认范围",
            subtitle: "控制第一步变量",
            technicalReason: "避免提前解决完整问题。",
            advantages: ["范围明确"],
            tradeoffs: ["需要一次用户确认"],
            downstreamImpact: "后续规划使用确认后的范围。",
            isRecommended: true
        )
    }

    private func testOptions() -> [PlanOption] {
        [
            testOption(),
            PlanOption(
                title: "直接推进",
                subtitle: "速度优先的备选",
                technicalReason: "减少一次前置确认。",
                advantages: ["更快"],
                tradeoffs: ["返工风险更高"],
                downstreamImpact: "后续可能需要回滚。",
                isRecommended: false,
                origin: .model
            )
        ]
    }
}
