import Foundation

@main
struct BrowserReuseCheck {
    static func main() async throws {
        let accepted = ["http://127.0.0.1:4317", "http://127.0.0.1:4317/", "http://localhost:4317/?test=1#voice-wake=old", "http://127.0.0.1:4317/index.html#abc"]
        let rejected = ["https://example.com/workflow", "http://127.0.0.1:4317/preview", "http://127.0.0.1:43170/", "http://localhost:4317.evil.test/", "http://localhost:4317/remote", "http://example.com/?url=http://localhost:4317"]
        for browser in ["com.google.Chrome", "com.apple.Safari"] {
            let source = BrowserTabScript.source(for: browser)
            for url in accepted {
                let result = try await BrowserTabScript.run(source, arguments: ["check-url", url])
                precondition(result == "true", "Expected match: \(url)")
            }
            for url in rejected {
                let result = try await BrowserTabScript.run(source, arguments: ["check-url", url])
                precondition(result == "false", "Unexpected match: \(url)")
            }
        }
        print("Browser reuse: 20 URL boundary and Chrome/Safari script checks passed")
        if CommandLine.arguments.contains("--probe") {
            let result = try await BrowserTabScript.run(BrowserTabScript.source(for: "com.google.Chrome"), arguments: ["probe", ""])
            print("Chrome read-only Workflow Web detection: \(result)")
        }
        if CommandLine.arguments.contains("--focus") {
            let count = "tell application id \"com.google.Chrome\" to count tabs of window 1"
            let before = try await BrowserTabScript.run(count, arguments: [])
            let result = try await BrowserTabScript.run(BrowserTabScript.source(for: "com.google.Chrome"), arguments: ["focus", ""])
            let after = try await BrowserTabScript.run(count, arguments: [])
            precondition(result == "reused" && before == after)
            print("Chrome existing-tab focus passed; tab count unchanged: \(after)")
        }
    }
}
