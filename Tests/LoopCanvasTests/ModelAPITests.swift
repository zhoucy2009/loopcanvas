import Foundation
import XCTest
@testable import LoopCanvas

final class AgentConnectionTests: XCTestCase {
    func testLegacyTransportModesMigrateToDeepSeekHarness() {
        XCTAssertNil(ModelTransportMode(rawValue: "openAICompatible"))
        XCTAssertEqual(
            ModelAPISettingsPersistence.resolvedMode(
                environmentValue: nil,
                savedValue: "openAICompatible"
            ),
            .deepSeekHarness
        )
        XCTAssertEqual(
            ModelAPISettingsPersistence.migratedSavedMode("openAICompatible"),
            ModelTransportMode.deepSeekHarness.rawValue
        )
        XCTAssertEqual(ModelTransportMode.allCases, [.deepSeekHarness, .codexAppServer])
        XCTAssertEqual(
            ModelAPISettingsPersistence.resolvedMode(
                environmentValue: "deepSeekHarness",
                savedValue: "deepSeekHarness"
            ),
            .deepSeekHarness
        )
        XCTAssertEqual(
            ModelAPISettingsPersistence.migratedSavedMode("deepSeekHarness"),
            ModelTransportMode.deepSeekHarness.rawValue
        )
        XCTAssertEqual(
            ModelAPISettingsPersistence.resolvedMode(
                environmentValue: "codexAppServer",
                savedValue: "deepSeekHarness"
            ),
            .codexAppServer
        )
        XCTAssertEqual(
            ModelAPISettingsPersistence.migratedSavedMode("codexAppServer"),
            ModelTransportMode.codexAppServer.rawValue
        )
    }

    func testCommonDeepSeekResponseVariantsAreNormalized() throws {
        let expected = UUID()
        let object: [String: Any] = [
            "response": [
                "request_id": expected.uuidString,
                "status": "completed",
                "assistant_message": "已生成",
                "step_result": [
                    "summary": "完成基础页面",
                    "actual_changes": "创建 HTML",
                    "evidence": "返回完整源码",
                    "deviation": "未运行浏览器验证",
                    "rollback": "删除页面",
                    "artifact": [
                        "html": "<!doctype html><html><body>ok</body></html>",
                        "project_root": "/tmp/example",
                        "run_commands": "open index.html"
                    ]
                ]
            ]
        ]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)

        let response = try AgentResponseDecoder.decodeBridgeResponseText(
            text,
            expectedRequestID: expected
        )

        XCTAssertEqual(response.status, .success)
        XCTAssertEqual(response.assistantMessage, "已生成")
        XCTAssertEqual(response.result?.actualChanges, ["创建 HTML"])
        XCTAssertEqual(response.result?.evidence, ["返回完整源码"])
        XCTAssertEqual(response.result?.artifact?.kind, .html)
        XCTAssertEqual(response.result?.artifact?.filename, "index.html")
        XCTAssertEqual(response.result?.artifact?.projectRoot, "/tmp/example")
        XCTAssertEqual(response.result?.artifact?.runCommands, ["open index.html"])
    }

    func testExplicitNullRequiredFieldsAreNormalized() throws {
        let expected = UUID()
        let object: [String: Any] = [
            "requestID": expected.uuidString,
            "status": NSNull(),
            "assistantMessage": NSNull(),
            "steps": NSNull(),
            "result": [
                "summary": NSNull(),
                "actualChanges": NSNull(),
                "evidence": NSNull(),
                "deviation": NSNull(),
                "rollback": NSNull(),
                "artifact": [
                    "title": NSNull(),
                    "kind": NSNull(),
                    "content": "<!doctype html><html><body>ok</body></html>",
                    "filename": NSNull(),
                    "projectRoot": NSNull(),
                    "files": NSNull(),
                    "runCommands": NSNull()
                ],
                "verificationPassed": NSNull(),
                "blockingIssues": NSNull()
            ],
            "error": NSNull()
        ]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)

        let response = try AgentResponseDecoder.decodeBridgeResponseText(
            text,
            expectedRequestID: expected
        )

        XCTAssertEqual(response.status, .success)
        XCTAssertEqual(response.assistantMessage, "Agent 已返回结构化响应。")
        XCTAssertEqual(response.result?.summary, "Agent 未提供结果摘要。")
        XCTAssertEqual(response.result?.actualChanges, [])
        XCTAssertEqual(response.result?.evidence, [])
        XCTAssertEqual(response.result?.deviation, "Agent 未提供偏差说明。")
        XCTAssertEqual(response.result?.rollback, "Agent 未提供回滚说明。")
        XCTAssertEqual(response.result?.artifact?.kind, .html)
        XCTAssertEqual(response.result?.artifact?.filename, "index.html")
        XCTAssertNil(response.result?.artifact?.projectRoot)
        XCTAssertNil(response.result?.verificationPassed)
        XCTAssertNil(response.result?.blockingIssues)
    }

    func testDiagnosticResponseRedactsSecretsAndIsBounded() throws {
        let payload: [String: Any] = [
            "authorization": "Bearer top-secret-token",
            "api_key": "sk-abcdefghijk123456",
            "choices": [["message": ["content": "Bearer another-secret-token"]]]
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)

        let diagnostic = AgentResponseDecoder.sanitizedDiagnosticResponse(data, limit: 120)

        XCTAssertFalse(diagnostic.text.contains("top-secret-token"))
        XCTAssertFalse(diagnostic.text.contains("abcdefghijk123456"))
        XCTAssertFalse(diagnostic.text.contains("another-secret-token"))
        XCTAssertTrue(diagnostic.text.contains("[REDACTED]"))
        XCTAssertTrue(diagnostic.wasTruncated)
    }

    func testDiagnosticRecordIsWrittenUnderAgentDiagnostics() throws {
        let bridgeRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("LoopCanvasDiagnosticTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: bridgeRoot) }
        let transport = AgentFileStore(rootURL: bridgeRoot)
        let requestID = UUID()
        let failure = ModelResponseDecodingFailure(
            reason: "无法解析",
            sanitizedResponse: "{\"api_key\":\"[REDACTED]\"}",
            responseWasTruncated: false
        )

        let url = try transport.writeModelResponseDiagnostic(
            requestID: requestID,
            transport: "DeepSeek Harness",
            failure: failure
        )
        let content = try String(contentsOf: url, encoding: .utf8)

        XCTAssertEqual(url.deletingLastPathComponent(), transport.diagnosticsURL)
        XCTAssertTrue(content.contains(requestID.uuidString))
        XCTAssertTrue(content.contains("[REDACTED]"))
    }

    func testHarnessValidationAcceptsEmptyWorkspaceAndRejectsNonDirectory() {
        let valid = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/bin/echo",
            harnessWorkingDirectory: ""
        )
        XCTAssertNoThrow(try DeepSeekHarnessTransport.validate(settings: valid))

        let notADirectory = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/bin/echo",
            harnessWorkingDirectory: "/bin/echo"
        )
        XCTAssertThrowsError(try DeepSeekHarnessTransport.validate(settings: notADirectory)) { error in
            XCTAssertEqual(error as? ModelAPIError, .invalidHarnessWorkingDirectory)
        }
    }

    func testHarnessInstallationStatusReportsExplicitExecutable() {
        let settings = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/bin/echo",
            harnessWorkingDirectory: ""
        )

        let status = DeepSeekHarnessTransport.installationStatus(settings: settings)

        XCTAssertEqual(status.dshExecutablePath, "/bin/echo")
        XCTAssertTrue(status.hasDsh)
        XCTAssertEqual(status.isReady, status.hasNode)
    }

    func testHarnessInstallationStatusRejectsMissingExplicitExecutable() {
        let settings = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/nonexistent/dsh",
            harnessWorkingDirectory: ""
        )

        let status = DeepSeekHarnessTransport.installationStatus(settings: settings)

        XCTAssertNil(status.dshExecutablePath)
        XCTAssertFalse(status.hasDsh)
        XCTAssertFalse(status.isReady)
    }

    func testHarnessProbeRunsConfiguredExecutable() async throws {
        let settings = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/bin/echo",
            harnessWorkingDirectory: FileManager.default.temporaryDirectory.path
        )

        let result = try await DeepSeekHarnessTransport().probe(settings: settings)

        XCTAssertEqual(result.executablePath, "/bin/echo")
        XCTAssertEqual(result.version, "--version")
        XCTAssertTrue(result.supportsLoopCanvasExecution)
        XCTAssertTrue(result.compatibilityDetail.contains("尚未运行真实"))
    }

    func testHarnessCanBeSavedAsExecutionTransportWhenExecutableExists() {
        let settings = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/bin/echo",
            harnessWorkingDirectory: FileManager.default.temporaryDirectory.path
        )

        XCTAssertNoThrow(try DeepSeekHarnessTransport.validate(settings: settings))
    }

    func testHarnessValidationRejectsMissingExecutable() {
        let settings = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/nonexistent/dsh",
            harnessWorkingDirectory: ""
        )

        XCTAssertThrowsError(try DeepSeekHarnessTransport.validate(settings: settings)) { error in
            XCTAssertEqual(error as? ModelAPIError, .harnessNotFound)
        }
    }

    func testHarnessValidationRejectsMissingExplicitWorkspaceWithoutCreatingIt() {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("LoopCanvas-missing-\(UUID().uuidString)", isDirectory: true)
        let settings = ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: "/bin/echo",
            harnessWorkingDirectory: missing.path
        )

        XCTAssertThrowsError(try DeepSeekHarnessTransport.validate(settings: settings)) { error in
            XCTAssertEqual(error as? ModelAPIError, .invalidHarnessWorkingDirectory)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    func testCodexInstallationStatusReportsExplicitExecutable() {
        let settings = ModelAPISettings(
            mode: .codexAppServer,
            codexExecutable: "/bin/echo"
        )

        let status = CodexAppServerTransport.installationStatus(settings: settings)

        XCTAssertEqual(status.codexExecutablePath, "/bin/echo")
        XCTAssertTrue(status.isReady)
    }

    func testCodexValidationRejectsMissingExplicitWorkspaceWithoutCreatingIt() {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("LoopCanvas-codex-missing-\(UUID().uuidString)", isDirectory: true)
        let settings = ModelAPISettings(
            mode: .codexAppServer,
            codexExecutable: "/bin/echo",
            codexWorkingDirectory: missing.path
        )

        XCTAssertThrowsError(try CodexAppServerTransport.validate(settings: settings)) { error in
            XCTAssertEqual(error as? ModelAPIError, .invalidCodexWorkingDirectory)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    func testCodexProbeChecksVersionAndStdioCapabilityWithoutRunningTask() async throws {
        let workspace = temporaryDirectory(prefix: "CodexProbe")
        defer { try? FileManager.default.removeItem(at: workspace) }
        let script = try makeExecutableScript(
            in: workspace,
            body: """
            if [ "$1" = "--version" ]; then
              printf '%s\\n' 'codex-cli test-version'
              exit 0
            fi
            if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then
              printf '%s\\n' 'Usage: --listen stdio://'
              exit 0
            fi
            exit 9
            """
        )
        let settings = ModelAPISettings(
            mode: .codexAppServer,
            codexExecutable: script.path,
            codexWorkingDirectory: workspace.path
        )

        let result = try await CodexAppServerTransport().probe(settings: settings)

        XCTAssertEqual(result.executablePath, script.path)
        XCTAssertEqual(result.version, "codex-cli test-version")
        XCTAssertTrue(result.supportsAppServer)
        XCTAssertTrue(result.compatibilityDetail.contains("尚未提交真实模型任务"))
    }

    func testCodexAppServerSendUsesSafeLocalSettingsAndDecodesFinalItem() async throws {
        let workspace = temporaryDirectory(prefix: "CodexSend")
        defer { try? FileManager.default.removeItem(at: workspace) }
        let request = makeRequest()
        let bridgeJSON = "{\\\"requestID\\\":\\\"\(request.id.uuidString)\\\",\\\"status\\\":\\\"success\\\",\\\"assistantMessage\\\":\\\"ok\\\"}"
        let script = try makeExecutableScript(
            in: workspace,
            body: """
            while IFS= read -r line; do
              case "$line" in
                *'"id":1'*)
                  case "$line" in
                    *'"approvalPolicy":"never"'*) ;;
                    *) printf '%s\\n' '{"id":1,"error":{"message":"missing thread approval policy"}}'; exit 0 ;;
                  esac
                  case "$line" in
                    *'"sandbox":"workspace-write"'*) ;;
                    *) printf '%s\\n' '{"id":1,"error":{"message":"unsafe thread settings"}}'; exit 0 ;;
                  esac
                  printf '%s\\n' '{"id":1,"result":{"thread":{"id":"thr_test"}}}'
                  ;;
                *'"id":2'*)
                  case "$line" in
                    *'"approvalPolicy":"never"'*) ;;
                    *) printf '%s\\n' '{"id":2,"error":{"message":"missing turn approval policy"}}'; exit 0 ;;
                  esac
                  case "$line" in
                    *'"networkAccess":false'*) ;;
                    *) printf '%s\\n' '{"id":2,"error":{"message":"missing network restriction"}}'; exit 0 ;;
                  esac
                  case "$line" in
                    *'"type":"workspaceWrite"'*) ;;
                    *) printf '%s\\n' '{"id":2,"error":{"message":"unsafe turn settings"}}'; exit 0 ;;
                  esac
                  printf '%s\\n' '{"id":2,"result":{"turn":{"id":"turn_test"}}}'
                  printf '%s\\n' '{"method":"item/completed","params":{"threadId":"thr_test","turnId":"turn_test","completedAtMs":1,"item":{"id":"item_test","type":"agentMessage","text":"\(bridgeJSON)"}}}'
                  printf '%s\\n' '{"method":"turn/completed","params":{"threadId":"thr_test","turn":{"id":"turn_test","items":[],"status":"completed"}}}'
                  exit 0
                  ;;
              esac
            done
            """
        )
        let settings = ModelAPISettings(
            mode: .codexAppServer,
            codexExecutable: script.path,
            codexWorkingDirectory: workspace.path
        )

        let outcome = try await CodexAppServerTransport(executionTimeout: 2).send(
            request,
            settings: settings,
            defaultWorkingDirectory: workspace,
            deliverableBoundary: workspace
        )

        XCTAssertEqual(outcome.sessionID, "thr_test")
        XCTAssertEqual(outcome.response.requestID, request.id)
        XCTAssertEqual(outcome.response.assistantMessage, "ok")
    }

    func testHarnessSendAcceptsValidResponseFromFakeExecutable() async throws {
        let workspace = temporaryDirectory(prefix: "HarnessSuccess")
        defer { try? FileManager.default.removeItem(at: workspace) }
        let request = makeRequest()
        let script = try makeExecutableScript(
            in: workspace,
            body: "printf '%s\\n' '{\"requestID\":\"\(request.id.uuidString)\",\"status\":\"success\",\"assistantMessage\":\"ok\"}'"
        )

        let outcome = try await DeepSeekHarnessTransport(executionTimeout: 2).send(
            request,
            settings: harnessSettings(script: script, workspace: workspace),
            defaultWorkingDirectory: workspace,
            deliverableBoundary: workspace
        )

        XCTAssertEqual(outcome.response.requestID, request.id)
        XCTAssertEqual(outcome.response.assistantMessage, "ok")
    }

    func testHarnessSendSurfacesNonzeroExit() async throws {
        let workspace = temporaryDirectory(prefix: "HarnessFailure")
        defer { try? FileManager.default.removeItem(at: workspace) }
        let script = try makeExecutableScript(in: workspace, body: "printf 'fake failure' >&2\nexit 7")

        do {
            _ = try await DeepSeekHarnessTransport(executionTimeout: 2).send(
                makeRequest(),
                settings: harnessSettings(script: script, workspace: workspace),
                defaultWorkingDirectory: workspace,
                deliverableBoundary: workspace
            )
            XCTFail("应抛出非零退出错误")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("fake failure"))
        }
    }

    func testHarnessSendTimesOut() async throws {
        let workspace = temporaryDirectory(prefix: "HarnessTimeout")
        defer { try? FileManager.default.removeItem(at: workspace) }
        let script = try makeExecutableScript(in: workspace, body: "sleep 2")

        do {
            _ = try await DeepSeekHarnessTransport(executionTimeout: 0.05).send(
                makeRequest(),
                settings: harnessSettings(script: script, workspace: workspace),
                defaultWorkingDirectory: workspace,
                deliverableBoundary: workspace
            )
            XCTFail("应抛出超时错误")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("执行超过"))
        }
    }

    func testHarnessSendCanBeCancelled() async throws {
        let workspace = temporaryDirectory(prefix: "HarnessCancel")
        defer { try? FileManager.default.removeItem(at: workspace) }
        let script = try makeExecutableScript(in: workspace, body: "sleep 2")
        let request = makeRequest()
        let settings = harnessSettings(script: script, workspace: workspace)
        let task = Task {
            try await DeepSeekHarnessTransport(executionTimeout: 5).send(
                request,
                settings: settings,
                defaultWorkingDirectory: workspace,
                deliverableBoundary: workspace
            )
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("应取消运行中的进程")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
    }

    func testHarnessRejectsArtifactRootOutsideWorkspace() async throws {
        let workspace = temporaryDirectory(prefix: "HarnessBoundary")
        let outside = temporaryDirectory(prefix: "HarnessOutside")
        defer {
            try? FileManager.default.removeItem(at: workspace)
            try? FileManager.default.removeItem(at: outside)
        }
        let request = makeRequest()
        let json = "{\"requestID\":\"\(request.id.uuidString)\",\"status\":\"success\",\"assistantMessage\":\"ok\",\"result\":{\"summary\":\"x\",\"actualChanges\":[],\"evidence\":[],\"deviation\":\"\",\"rollback\":\"\",\"artifact\":{\"title\":\"x\",\"kind\":\"html\",\"content\":\"<html></html>\",\"filename\":\"index.html\",\"projectRoot\":\"\(outside.path)\"}}}"
        let script = try makeExecutableScript(in: workspace, body: "printf '%s\\n' '\(json)'")

        do {
            _ = try await DeepSeekHarnessTransport(executionTimeout: 2).send(
                request,
                settings: harnessSettings(script: script, workspace: workspace),
                defaultWorkingDirectory: workspace,
                deliverableBoundary: workspace
            )
            XCTFail("越界产物路径应被拒绝")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("projectRoot 超出"))
        }
    }

    func testArtifactValidatorRejectsMissingLocalThreeModules() {
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

        let issues = ArtifactValidator.blockingIssues(for: artifact)

        XCTAssertTrue(issues.contains { $0.contains("没有真实 projectRoot") })
        XCTAssertTrue(issues.contains { $0.contains("three.module.js") })
    }

    func testArtifactValidatorRejectsUndefinedThreeGlobal() {
        let artifact = DeliverableArtifact(
            title: "发动机",
            kind: .html,
            content: "<script>const scene = new THREE.Scene();</script>",
            filename: "engine.html"
        )

        XCTAssertTrue(
            ArtifactValidator.blockingIssues(for: artifact)
                .contains { $0.contains("没有导入、加载或定义 Three.js") }
        )
    }

    func testArtifactValidatorAllowsSelfContainedHTML() {
        let artifact = DeliverableArtifact(
            title: "静态预览",
            kind: .html,
            content: "<!doctype html><html><body><h1>可显示</h1></body></html>",
            filename: "index.html"
        )

        XCTAssertTrue(ArtifactValidator.blockingIssues(for: artifact).isEmpty)
    }

    func testArtifactValidatorAllowsHTTPSOnlyWhenCDNPolicyIsSelected() {
        let artifact = DeliverableArtifact(
            title: "CDN 场景",
            kind: .html,
            content: "<script src=\"https://cdn.example/three.min.js\"></script><script>new THREE.Scene()</script>",
            filename: "index.html",
            dependencies: ["https://cdn.example/three.min.js"]
        )
        let cdnOption = PlanOption(
            title: "使用 CDN 引入 Three.js",
            subtitle: "HTTPS 远程模块",
            technicalReason: "快速原型",
            advantages: ["简单"],
            tradeoffs: ["依赖网络"],
            downstreamImpact: "后续继续使用 CDN",
            isRecommended: true
        )

        XCTAssertFalse(ArtifactValidator.blockingIssues(for: artifact).isEmpty)
        XCTAssertTrue(ArtifactValidator.optionAllowsHTTPSRemoteResources(cdnOption))
        XCTAssertTrue(
            ArtifactValidator.blockingIssues(
                for: artifact,
                allowHTTPSRemoteResources: true
            ).isEmpty
        )

        var insecure = artifact
        insecure.content = artifact.content.replacingOccurrences(of: "https://", with: "http://")
        XCTAssertTrue(
            ArtifactValidator.blockingIssues(
                for: insecure,
                allowHTTPSRemoteResources: true
            ).contains { $0.contains("明文 HTTP") }
        )
    }

    func testPreviewCSPWhitelistsOnlyObservedHTTPSOriginsForScripts() {
        let html = """
        <script type="importmap">
        {"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}
        </script>
        <img src="https://images.example/apple.png">
        """

        let offline = HTMLPreviewSecurityPolicy.contentSecurityPolicy(
            for: html,
            allowHTTPSRemoteResources: false
        )
        let cdn = HTMLPreviewSecurityPolicy.contentSecurityPolicy(
            for: html,
            allowHTTPSRemoteResources: true
        )

        XCTAssertFalse(offline.contains("https://cdn.jsdelivr.net"))
        XCTAssertTrue(cdn.contains("script-src 'unsafe-inline' https://cdn.jsdelivr.net"))
        XCTAssertFalse(cdn.contains("https://images.example"), "远程图片源站不能进入脚本白名单")
        XCTAssertFalse(cdn.contains("three@0.160.0"), "CSP 只应放行源站，不包含具体路径")
        XCTAssertTrue(cdn.contains("img-src data: blob:"), "远程图片仍应被阻止")
        XCTAssertTrue(cdn.contains("connect-src 'none'"), "fetch/WebSocket 仍应被阻止")
    }

    private func makeRequest() -> CodexBridgeRequest {
        CodexBridgeRequest(
            id: UUID(),
            createdAt: Date(timeIntervalSince1970: 0),
            kind: .planFirstStep,
            agentID: nil,
            targetStepID: nil,
            userGoal: "测试目标",
            focus: "生成完整计划",
            modelPolicy: "只处理一次请求。",
            projectConstitution: "测试宪法。",
            sharedContext: "测试上下文",
            existingSteps: [],
            selectedOption: nil,
            userFeedback: nil,
            currentArtifact: nil,
            responseInstructions: "返回 JSON。",
            attachments: [],
            requirementDirectives: []
        )
    }

    private func temporaryDirectory(prefix: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("LoopCanvas-\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeExecutableScript(in directory: URL, body: String) throws -> URL {
        let url = directory.appendingPathComponent("fake-dsh.sh")
        try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    private func harnessSettings(script: URL, workspace: URL) -> ModelAPISettings {
        ModelAPISettings(
            mode: .deepSeekHarness,
            harnessExecutable: script.path,
            harnessWorkingDirectory: workspace.path
        )
    }
}
