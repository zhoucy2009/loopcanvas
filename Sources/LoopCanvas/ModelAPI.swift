import Foundation

enum ModelTransportMode: String, Codable, CaseIterable, Identifiable {
    case deepSeekHarness
    case codexAppServer

    var id: String { rawValue }
}

struct ModelAPISettings: Equatable {
    var mode: ModelTransportMode
    var harnessExecutable: String = ""
    var harnessWorkingDirectory: String = ""
    var harnessModel: String = ModelAPISettings.defaultModel
    var harnessReasoningEffort: String = ModelAPISettings.defaultReasoningEffort
    var codexExecutable: String = ""
    var codexWorkingDirectory: String = ""
    var codexModel: String = ""

    static let defaultModel = "deepseek-v4-pro"
    static let modelOptions = ["deepseek-v4-pro", "deepseek-v4-flash"]

    static func modelTitle(_ value: String) -> String {
        switch value {
        case "deepseek-v4-flash": "Flash"
        case "deepseek-v4-pro": "Pro"
        default: value
        }
    }

    static let defaultReasoningEffort = "high"
    static let reasoningEffortOptions = ["off", "high", "max"]

    static func reasoningEffortTitle(_ value: String) -> String {
        switch value {
        case "off": "off"
        case "max": "max"
        default: "high"
        }
    }

    static let `default` = ModelAPISettings(mode: .deepSeekHarness)
}

enum ModelAPIError: LocalizedError, Equatable {
    case malformedResponse(String)
    case mismatchedRequestID
    case harnessNotFound
    case harnessFailure(String)
    case harnessUnsupported(String)
    case invalidHarnessWorkingDirectory
    case codexNotFound
    case codexFailure(String)
    case codexProtocol(String)
    case invalidCodexWorkingDirectory

    var errorDescription: String? {
        switch self {
        case let .malformedResponse(detail):
            "无法解析 Agent 回复：\(detail)"
        case .mismatchedRequestID:
            "Agent 回复的 requestID 与当前请求不一致。"
        case .harnessNotFound:
            "未找到 `dsh` 可执行文件。可填写完整路径，或先安装 DeepSeek Harness（`@deepseek-ai/dsh`）。"
        case let .harnessFailure(detail):
            "DeepSeek Harness 执行失败：\(detail)"
        case let .harnessUnsupported(detail):
            "DeepSeek Harness 当前不能作为 LoopCanvas 执行 Agent：\(detail)"
        case .invalidHarnessWorkingDirectory:
            "Harness 工作目录不存在或不是文件夹。请选择一个明确的项目目录。"
        case .codexNotFound:
            "未找到 `codex` 可执行文件。可填写完整路径，或安装/更新 ChatGPT Codex。"
        case let .codexFailure(detail):
            "Codex App Server 执行失败：\(detail)"
        case let .codexProtocol(detail):
            "Codex App Server 协议错误：\(detail)"
        case .invalidCodexWorkingDirectory:
            "Codex 工作目录不存在或不是文件夹。请选择一个明确的项目目录。"
        }
    }
}

struct ModelResponseDecodingFailure: LocalizedError {
    let reason: String
    let sanitizedResponse: String
    let responseWasTruncated: Bool

    var errorDescription: String? { reason }
}

enum ModelAPISettingsPersistence {
    private static let modeKey = "LoopCanvas.modelAPI.mode"
    private static let harnessExecutableKey = "LoopCanvas.modelAPI.harnessExecutable"
    private static let harnessWorkingDirectoryKey = "LoopCanvas.modelAPI.harnessWorkingDirectory"
    private static let harnessReasoningEffortKey = "LoopCanvas.modelAPI.harnessReasoningEffort"
    private static let harnessModelKey = "LoopCanvas.modelAPI.harnessModel"
    private static let codexExecutableKey = "LoopCanvas.modelAPI.codexExecutable"
    private static let codexWorkingDirectoryKey = "LoopCanvas.modelAPI.codexWorkingDirectory"
    private static let codexModelKey = "LoopCanvas.modelAPI.codexModel"

    static func load() -> ModelAPISettings {
        let defaults = UserDefaults.standard
        let environment = ProcessInfo.processInfo.environment
        let savedValue = defaults.string(forKey: modeKey)
        if let migratedValue = migratedSavedMode(savedValue), migratedValue != savedValue {
            defaults.set(migratedValue, forKey: modeKey)
        }
        return ModelAPISettings(
            mode: resolvedMode(
                environmentValue: environment["LOOPCANVAS_MODEL_TRANSPORT"],
                savedValue: migratedSavedMode(savedValue)
            ),
            harnessExecutable: environment["LOOPCANVAS_DEEPSEEK_HARNESS_EXECUTABLE"]
                ?? environment["LOOPCANVAS_DSH_EXECUTABLE"]
                ?? defaults.string(forKey: harnessExecutableKey)
                ?? "",
            harnessWorkingDirectory: environment["LOOPCANVAS_DEEPSEEK_HARNESS_WORKSPACE"]
                ?? environment["LOOPCANVAS_DSH_WORKSPACE"]
                ?? defaults.string(forKey: harnessWorkingDirectoryKey)
                ?? "",
            harnessModel: environment["LOOPCANVAS_DSH_MODEL"]
                ?? defaults.string(forKey: harnessModelKey)
                ?? ModelAPISettings.defaultModel,
            harnessReasoningEffort: environment["LOOPCANVAS_DSH_REASONING_EFFORT"]
                ?? defaults.string(forKey: harnessReasoningEffortKey)
                ?? ModelAPISettings.defaultReasoningEffort,
            codexExecutable: environment["LOOPCANVAS_CODEX_EXECUTABLE"]
                ?? defaults.string(forKey: codexExecutableKey)
                ?? "",
            codexWorkingDirectory: environment["LOOPCANVAS_CODEX_WORKSPACE"]
                ?? defaults.string(forKey: codexWorkingDirectoryKey)
                ?? "",
            codexModel: environment["LOOPCANVAS_CODEX_MODEL"]
                ?? defaults.string(forKey: codexModelKey)
                ?? ""
        )
    }

    static func save(_ settings: ModelAPISettings) throws {
        let defaults = UserDefaults.standard
        defaults.set(settings.mode.rawValue, forKey: modeKey)
        defaults.set(settings.harnessExecutable, forKey: harnessExecutableKey)
        defaults.set(settings.harnessWorkingDirectory, forKey: harnessWorkingDirectoryKey)
        defaults.set(settings.harnessReasoningEffort, forKey: harnessReasoningEffortKey)
        defaults.set(settings.harnessModel, forKey: harnessModelKey)
        defaults.set(settings.codexExecutable, forKey: codexExecutableKey)
        defaults.set(settings.codexWorkingDirectory, forKey: codexWorkingDirectoryKey)
        defaults.set(settings.codexModel, forKey: codexModelKey)
    }

    static func resolvedMode(environmentValue: String?, savedValue: String?) -> ModelTransportMode {
        if let environmentValue, let mode = ModelTransportMode(rawValue: environmentValue) { return mode }
        if let savedValue, let mode = ModelTransportMode(rawValue: savedValue) { return mode }
        return .deepSeekHarness
    }

    static func migratedSavedMode(_ savedValue: String?) -> String? {
        guard let savedValue else { return nil }
        if ModelTransportMode(rawValue: savedValue) != nil { return savedValue }
        return ModelTransportMode.deepSeekHarness.rawValue
    }
}

enum AgentResponseDecoder {
    static func decodeBridgeResponseText(_ text: String, expectedRequestID: UUID) throws -> CodexBridgeResponse {
        let candidate = extractJSONObject(from: text)
        do {
            let normalized = try normalizeAgentEnvelope(
                Data(candidate.utf8),
                expectedRequestID: expectedRequestID
            )
            let response = try JSONDecoder().decode(CodexBridgeResponse.self, from: normalized)
            guard response.requestID == expectedRequestID else { throw ModelAPIError.mismatchedRequestID }
            return response
        } catch let error as ModelAPIError {
            throw error
        } catch let error as DecodingError {
            throw ModelAPIError.malformedResponse(describe(error))
        } catch {
            throw ModelAPIError.malformedResponse(error.localizedDescription)
        }
    }

    private static func normalizeAgentEnvelope(
        _ data: Data,
        expectedRequestID: UUID
    ) throws -> Data {
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ModelAPIError.malformedResponse("Agent 回复顶层不是 JSON 对象")
        }

        object = unwrapBridgeEnvelope(object)
        moveAlias(in: &object, canonical: "requestID", aliases: ["requestId", "request_id"])
        moveAlias(in: &object, canonical: "assistantMessage", aliases: ["assistant_message", "assistant", "message"])
        moveAlias(in: &object, canonical: "steps", aliases: ["planSteps", "plan_steps"])
        moveAlias(in: &object, canonical: "result", aliases: ["stepResult", "step_result"])

        if object["result"] == nil,
           object["artifact"] != nil || object["summary"] != nil || object["actualChanges"] != nil || object["actual_changes"] != nil {
            var result: [String: Any] = [:]
            for key in [
                "summary", "actualChanges", "actual_changes", "changes", "evidence", "deviation",
                "rollback", "artifact", "verificationPassed", "verification_passed", "blockingIssues",
                "blocking_issues"
            ] where object[key] != nil {
                result[key] = object.removeValue(forKey: key)
            }
            object["result"] = result
        }

        if var result = object["result"] as? [String: Any] {
            normalizeResult(&result)
            object["result"] = result
        }

        if let singleStep = object["steps"] as? [String: Any] {
            object["steps"] = [singleStep]
        }
        if var steps = object["steps"] as? [[String: Any]] {
            for index in steps.indices { normalizeStep(&steps[index]) }
            object["steps"] = steps
        }

        if let rawID = object["requestID"] as? String, !rawID.isEmpty {
            guard UUID(uuidString: rawID) == expectedRequestID else {
                throw ModelAPIError.mismatchedRequestID
            }
        } else {
            // Agent responses are already bound to one in-flight request. Filling
            // this correlation field cannot redirect another request.
            object["requestID"] = expectedRequestID.uuidString
        }

        if let status = object["status"] as? String {
            switch status.lowercased() {
            case "ok", "completed", "complete", "succeeded": object["status"] = "success"
            case "error", "failed": object["status"] = "failure"
            default: break
            }
        }
        if isMissingOrNull(object["status"]) {
            let hasFailure = (object["error"] as? String)?.isEmpty == false
            let hasPayload = !isMissingOrNull(object["steps"]) || !isMissingOrNull(object["result"])
            if hasFailure {
                object["status"] = "failure"
            } else if hasPayload {
                object["status"] = "success"
            }
        }
        if isMissingOrNull(object["assistantMessage"]) {
            object["assistantMessage"] = "Agent 已返回结构化响应。"
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private static func unwrapBridgeEnvelope(_ original: [String: Any]) -> [String: Any] {
        for key in ["response", "data", "output"] {
            guard let nested = original[key] as? [String: Any] else { continue }
            let bridgeKeys = [
                "requestID", "requestId", "request_id", "status", "steps", "result", "stepResult",
                "step_result", "artifact", "summary"
            ]
            if bridgeKeys.contains(where: { nested[$0] != nil }) { return nested }
        }
        if let nested = original["message"] as? [String: Any] {
            return unwrapBridgeEnvelope(nested)
        }
        return original
    }

    private static func normalizeResult(_ result: inout [String: Any]) {
        moveAlias(in: &result, canonical: "actualChanges", aliases: ["actual_changes", "changes"])
        moveAlias(in: &result, canonical: "verificationPassed", aliases: ["verification_passed"])
        moveAlias(in: &result, canonical: "blockingIssues", aliases: ["blocking_issues"])
        coerceStringArray(in: &result, key: "actualChanges")
        coerceStringArray(in: &result, key: "evidence")
        coerceStringArray(in: &result, key: "blockingIssues")

        if isMissingOrNull(result["summary"]) { result["summary"] = "Agent 未提供结果摘要。" }
        if isMissingOrNull(result["actualChanges"]) { result["actualChanges"] = [] }
        if isMissingOrNull(result["evidence"]) { result["evidence"] = [] }
        if isMissingOrNull(result["deviation"]) { result["deviation"] = "Agent 未提供偏差说明。" }
        if isMissingOrNull(result["rollback"]) { result["rollback"] = "Agent 未提供回滚说明。" }

        if let content = result["artifact"] as? String {
            result["artifact"] = inferredArtifact(content: content)
        } else if var artifact = result["artifact"] as? [String: Any] {
            normalizeArtifact(&artifact)
            result["artifact"] = artifact
        }
    }

    private static func normalizeArtifact(_ artifact: inout [String: Any]) {
        moveAlias(in: &artifact, canonical: "content", aliases: ["html", "code", "source"])
        moveAlias(in: &artifact, canonical: "projectRoot", aliases: ["project_root"])
        moveAlias(in: &artifact, canonical: "entrypoint", aliases: ["entry_point", "entryPoint"])
        moveAlias(in: &artifact, canonical: "runCommands", aliases: ["run_commands"])
        moveAlias(in: &artifact, canonical: "testCommands", aliases: ["test_commands"])
        moveAlias(in: &artifact, canonical: "testResults", aliases: ["test_results"])
        for key in ["files", "dependencies", "runCommands", "testCommands", "testResults"] {
            coerceStringArray(in: &artifact, key: key)
        }

        if isMissingOrNull(artifact["content"]) { artifact["content"] = "" }
        let content = artifact["content"] as? String ?? ""
        let inferredKind = inferArtifactKind(content: content, filename: artifact["filename"] as? String)
        if isMissingOrNull(artifact["kind"]) { artifact["kind"] = inferredKind }
        if isMissingOrNull(artifact["filename"]) {
            artifact["filename"] = defaultFilename(for: artifact["kind"] as? String ?? inferredKind)
        }
        if isMissingOrNull(artifact["title"]) {
            artifact["title"] = artifact["filename"] as? String ?? "Agent 产物"
        }
    }

    private static func normalizeStep(_ step: inout [String: Any]) {
        moveAlias(in: &step, canonical: "appliedDirectiveIDs", aliases: ["applied_directive_ids"])
        moveAlias(in: &step, canonical: "riskLevel", aliases: ["risk_level", "risk"])
        if let risk = step["riskLevel"] as? String {
            step["riskLevel"] = risk.uppercased()
        }
        if var impact = step["impactAnalysis"] as? [String: Any] {
            normalizeImpact(&impact)
            step["impactAnalysis"] = impact
        } else if var impact = step["impact_analysis"] as? [String: Any] {
            normalizeImpact(&impact)
            step["impactAnalysis"] = impact
        }
        if step["dependencies"] is String { coerceStringArray(in: &step, key: "dependencies") }
        if let singleOption = step["options"] as? [String: Any] { step["options"] = [singleOption] }
        if var options = step["options"] as? [[String: Any]] {
            for index in options.indices {
                moveAlias(in: &options[index], canonical: "technicalReason", aliases: ["technical_reason"])
                moveAlias(in: &options[index], canonical: "downstreamImpact", aliases: ["downstream_impact"])
                moveAlias(in: &options[index], canonical: "isRecommended", aliases: ["is_recommended", "recommended"])
                moveAlias(in: &options[index], canonical: "matchedDirectiveIDs", aliases: ["matched_directive_ids"])
                moveAlias(in: &options[index], canonical: "rankReason", aliases: ["rank_reason"])
                coerceStringArray(in: &options[index], key: "advantages")
                coerceStringArray(in: &options[index], key: "tradeoffs")
            }
            step["options"] = options
        }
    }

    private static func normalizeImpact(_ impact: inout [String: Any]) {
        moveAlias(in: &impact, canonical: "surfaceProblem", aliases: ["surface_problem"])
        moveAlias(in: &impact, canonical: "problemCategory", aliases: ["problem_category"])
        moveAlias(in: &impact, canonical: "relatedScenarios", aliases: ["related_scenarios"])
        moveAlias(in: &impact, canonical: "isLocalPatch", aliases: ["is_local_patch", "localPatch"])
        moveAlias(in: &impact, canonical: "affectedModules", aliases: ["affected_modules"])
        moveAlias(in: &impact, canonical: "requiresMainFlowChange", aliases: ["requires_main_flow_change"])
        coerceStringArray(in: &impact, key: "relatedScenarios")
        coerceStringArray(in: &impact, key: "affectedModules")
        if impact["surfaceProblem"] == nil { impact["surfaceProblem"] = "" }
        if impact["problemCategory"] == nil { impact["problemCategory"] = "" }
        if impact["relatedScenarios"] == nil { impact["relatedScenarios"] = [] }
        if impact["affectedModules"] == nil { impact["affectedModules"] = [] }
        if impact["scope"] == nil { impact["scope"] = "implement" }
    }

    private static func inferredArtifact(content: String) -> [String: Any] {
        let kind = inferArtifactKind(content: content, filename: nil)
        return [
            "title": "模型产物",
            "kind": kind,
            "content": content,
            "filename": defaultFilename(for: kind)
        ]
    }

    private static func inferArtifactKind(content: String, filename: String?) -> String {
        let extensionValue = filename.map { URL(fileURLWithPath: $0).pathExtension.lowercased() }
        if extensionValue == "html" || content.range(of: "<html", options: .caseInsensitive) != nil || content.range(of: "<!doctype html", options: .caseInsensitive) != nil {
            return "html"
        }
        if extensionValue == "md" || extensionValue == "markdown" { return "markdown" }
        return "text"
    }

    private static func defaultFilename(for kind: String) -> String {
        switch kind {
        case "html": "index.html"
        case "markdown": "artifact.md"
        default: "artifact.txt"
        }
    }

    private static func moveAlias(in object: inout [String: Any], canonical: String, aliases: [String]) {
        guard isMissingOrNull(object[canonical]) else { return }
        for alias in aliases where !isMissingOrNull(object[alias]) {
            object[canonical] = object.removeValue(forKey: alias)
            return
        }
    }

    private static func isMissingOrNull(_ value: Any?) -> Bool {
        value == nil || value is NSNull
    }

    private static func coerceStringArray(in object: inout [String: Any], key: String) {
        if let value = object[key] as? String { object[key] = [value] }
    }

    static func sanitizedDiagnosticResponse(_ data: Data, limit: Int = 1_000_000) -> (text: String, wasTruncated: Bool) {
        let initial: String
        if let value = try? JSONSerialization.jsonObject(with: data),
           JSONSerialization.isValidJSONObject(value),
           let sanitized = try? JSONSerialization.data(
               withJSONObject: sanitizeJSON(value, key: nil),
               options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
           ) {
            initial = String(decoding: sanitized, as: UTF8.self)
        } else {
            initial = String(decoding: data, as: UTF8.self)
        }
        let redacted = redactSecrets(in: initial)
        guard redacted.utf8.count > limit else { return (redacted, false) }
        let prefix = String(decoding: Data(redacted.utf8.prefix(limit)), as: UTF8.self)
        return (prefix + "\n[TRUNCATED_BY_LOOPCANVAS]", true)
    }

    private static func sanitizeJSON(_ value: Any, key: String?) -> Any {
        let normalizedKey = key?.lowercased().replacingOccurrences(of: "-", with: "_")
        let sensitiveKeys: Set<String> = [
            "authorization", "api_key", "apikey", "access_token", "refresh_token", "secret", "password"
        ]
        if let normalizedKey, sensitiveKeys.contains(normalizedKey) { return "[REDACTED]" }
        if let object = value as? [String: Any] {
            var sanitized: [String: Any] = [:]
            for (childKey, rawValue) in object {
                sanitized[childKey] = sanitizeJSON(rawValue, key: childKey)
            }
            return sanitized
        }
        if let array = value as? [Any] { return array.map { sanitizeJSON($0, key: key) } }
        if let string = value as? String { return redactSecrets(in: string) }
        return value
    }

    private static func redactSecrets(in text: String) -> String {
        var result = text
        let patterns = [
            "(?i)Bearer\\s+[A-Za-z0-9._~+\\-/=]+",
            "(?i)\\bsk-[A-Za-z0-9_-]{8,}"
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(result.startIndex..<result.endIndex, in: result)
            result = regex.stringByReplacingMatches(in: result, range: range, withTemplate: "[REDACTED]")
        }
        return result
    }

    private static func describe(_ error: DecodingError) -> String {
        func path(_ codingPath: [any CodingKey], appending key: (any CodingKey)? = nil) -> String {
            let keys = codingPath.map(\.stringValue) + (key.map { [$0.stringValue] } ?? [])
            return keys.isEmpty ? "顶层 JSON" : keys.joined(separator: ".")
        }

        switch error {
        case let .keyNotFound(key, context):
            return "缺少必填字段 `\(path(context.codingPath, appending: key))`。"
        case let .valueNotFound(_, context):
            return "字段 `\(path(context.codingPath))` 不应为 null。"
        case let .typeMismatch(_, context):
            return "字段 `\(path(context.codingPath))` 的数据类型不正确。"
        case let .dataCorrupted(context):
            return "JSON 不完整或格式错误（\(path(context.codingPath))）：\(context.debugDescription)"
        @unknown default:
            return error.localizedDescription
        }
    }

    static func extractJSONObject(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.firstIndex(of: "{"),
              let end = trimmed.lastIndex(of: "}"), start <= end else { return trimmed }
        let candidate = String(trimmed[start...end])
        return Self.balanceTruncatedJSON(candidate)
    }

    /// 模型输出可能因达到上限被截断而缺少收尾括号；按词法平衡补全（跳过字符串内部），让可修复的截断 JSON 恢复。
    private static func balanceTruncatedJSON(_ json: String) -> String {
        var objectDepth = 0
        var arrayDepth = 0
        var inString = false
        var escaped = false
        for character in json {
            if inString {
                if escaped { escaped = false }
                else if character == "\\" { escaped = true }
                else if character == "\"" { inString = false }
                continue
            }
            switch character {
            case "\"": inString = true
            case "{": objectDepth += 1
            case "}": objectDepth = max(0, objectDepth - 1)
            case "[": arrayDepth += 1
            case "]": arrayDepth = max(0, arrayDepth - 1)
            default: break
            }
        }
        var repaired = json
        if arrayDepth > 0 { repaired += String(repeating: "]", count: arrayDepth) }
        if objectDepth > 0 { repaired += String(repeating: "}", count: objectDepth) }
        return repaired
    }

}
