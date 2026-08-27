import Foundation

enum ArtifactValidator {
    static func blockingIssues(
        for artifact: DeliverableArtifact,
        allowHTTPSRemoteResources: Bool = false
    ) -> [String] {
        guard artifact.kind == .html else { return [] }
        let html = artifact.content
        var issues: [String] = []

        if html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("HTML 内容为空。")
            return issues
        }

        let remoteResources = matches(
            in: html,
            pattern: #"(?:src|href)\s*=\s*["'](https?://[^"']+)["']|(?:from\s+|import\s*\()["'](https?://[^"']+)["']"#,
            captureGroups: [1, 2]
        )
        if !remoteResources.isEmpty, !allowHTTPSRemoteResources {
            issues.append("HTML 引用了远程资源，不符合离线预览要求：\(remoteResources.joined(separator: "、"))")
        } else if allowHTTPSRemoteResources {
            let insecureResources = remoteResources.filter { $0.lowercased().hasPrefix("http://") }
            if !insecureResources.isEmpty {
                issues.append("所选方案只允许 HTTPS 远程依赖，不能使用明文 HTTP：\(insecureResources.joined(separator: "、"))")
            }
        }

        let relativeModules = matches(
            in: html,
            pattern: #"["']((?:\./|\.\./)[^"']+\.(?:js|mjs|css|wasm))["']"#,
            captureGroups: [1]
        )
        if !relativeModules.isEmpty {
            guard let root = artifact.projectRoot?.trimmingCharacters(in: .whitespacesAndNewlines), !root.isEmpty else {
                issues.append("HTML 引用了本地依赖，但 artifact 没有真实 projectRoot：\(relativeModules.joined(separator: "、"))")
                return unique(issues)
            }
            let rootURL = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
            for path in relativeModules {
                let candidate = rootURL.appendingPathComponent(path).standardizedFileURL
                guard candidate.path.hasPrefix(rootURL.path + "/"),
                      FileManager.default.fileExists(atPath: candidate.path) else {
                    issues.append("HTML 所需本地文件不存在：\(path)")
                    continue
                }
            }
        }

        let bareImports = matches(
            in: html,
            pattern: #"(?:from\s+|import\s*\()["']([@A-Za-z][^./][^"']*)["']"#,
            captureGroups: [1]
        )
        if !bareImports.isEmpty,
           html.range(of: #"<script[^>]+type\s*=\s*["']importmap["']"#, options: [.regularExpression, .caseInsensitive]) == nil {
            issues.append("ES Module 使用了浏览器无法直接解析的包名，且没有 import map：\(bareImports.joined(separator: "、"))")
        }

        if html.range(of: #"\bTHREE\."#, options: .regularExpression) != nil {
            let importsTHREE = html.range(of: #"import\s+\*\s+as\s+THREE\s+from"#, options: .regularExpression) != nil
            let definesTHREE = html.range(
                of: #"(?:const|let|var)\s+THREE\b|(?:window|globalThis)\.THREE\s*="#,
                options: .regularExpression
            ) != nil
            let loadsTHREE = html.range(
                of: #"<script[^>]+src\s*=\s*["'][^"']*three[^"']*["']"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
            if !importsTHREE, !definesTHREE, !loadsTHREE {
                issues.append("代码使用了 THREE，但没有导入、加载或定义 Three.js。")
            }
        }

        return unique(issues)
    }

    static func optionAllowsHTTPSRemoteResources(_ option: PlanOption?) -> Bool {
        guard let option else { return false }
        let text = [
            option.title,
            option.subtitle,
            option.technicalReason,
            option.downstreamImpact
        ].joined(separator: " ").lowercased()
        return text.contains("cdn")
            || text.contains("https 远程")
            || text.contains("https远程")
            || text.contains("remote dependency")
            || text.contains("remote module")
    }

    private static func matches(
        in text: String,
        pattern: String,
        captureGroups: [Int]
    ) -> [String] {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return []
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var values: [String] = []
        for match in expression.matches(in: text, range: range) {
            for group in captureGroups where group < match.numberOfRanges {
                let candidateRange = match.range(at: group)
                guard candidateRange.location != NSNotFound,
                      let swiftRange = Range(candidateRange, in: text) else { continue }
                values.append(String(text[swiftRange]))
            }
        }
        return unique(values)
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        return values.filter { seen.insert($0).inserted }
    }
}

enum HTMLPreviewSecurityPolicy {
    static func contentSecurityPolicy(
        for html: String,
        allowHTTPSRemoteResources: Bool
    ) -> String {
        let origins = allowHTTPSRemoteResources ? httpsScriptOrigins(in: html) : []
        let scriptSources = (["'unsafe-inline'"] + origins).joined(separator: " ")
        return "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src \(scriptSources); connect-src 'none'; frame-src 'none';"
    }

    static func httpsScriptOrigins(in html: String) -> [String] {
        var urls = capturedValues(
            in: html,
            pattern: #"<script[^>]+src\s*=\s*[\"'](https://[^\"']+)[\"']"#
        )
        urls += capturedValues(
            in: html,
            pattern: #"(?:from\s+|import\s*\()[\"'](https://[^\"']+)[\"']"#
        )
        let importMaps = capturedValues(
            in: html,
            pattern: #"<script(?=[^>]*type\s*=\s*[\"']importmap[\"'])[^>]*>([\s\S]*?)</script>"#
        )
        for importMap in importMaps {
            urls += capturedValues(
                in: importMap,
                pattern: #"[\"'](https://[^\"']+)[\"']"#
            )
        }

        var origins: Set<String> = []
        for url in urls {
            guard let components = URLComponents(string: url),
                  components.scheme?.lowercased() == "https",
                  let host = components.host, !host.isEmpty else { continue }
            let port = components.port.map { ":\($0)" } ?? ""
            origins.insert("https://\(host)\(port)")
        }
        return origins.sorted()
    }

    private static func capturedValues(in text: String, pattern: String) -> [String] {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return []
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.matches(in: text, range: range).compactMap { match in
            guard match.numberOfRanges > 1,
                  let swiftRange = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[swiftRange])
        }
    }
}
