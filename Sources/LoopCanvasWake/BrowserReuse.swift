import AppKit

enum BrowserTabScript {
    // Only applications whose scripting dictionaries implement these tab APIs.
    static let supported = ["com.google.Chrome", "com.apple.Safari", "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi"]

    static func source(for bundleID: String) -> String {
        precondition(supported.contains(bundleID))
        let selection = bundleID == "com.apple.Safari"
            ? "set current tab of browserWindow to candidateTab"
            : "set active tab index of browserWindow to tabIndex"
        let restore = bundleID == "com.apple.Safari" ? "miniaturized" : "minimized"
        return """
        on isWorkflowURL(candidateURL)
            if candidateURL is missing value then return false
            set cleanURL to candidateURL as text
            set AppleScript's text item delimiters to "#"
            set cleanURL to first text item of cleanURL
            set AppleScript's text item delimiters to "?"
            set cleanURL to first text item of cleanURL
            set AppleScript's text item delimiters to ""
            return cleanURL is in {"http://127.0.0.1:4317", "http://127.0.0.1:4317/", "http://127.0.0.1:4317/index.html", "http://localhost:4317", "http://localhost:4317/", "http://localhost:4317/index.html"}
        end isWorkflowURL

        on run argv
            if item 1 of argv is "check-url" then return my isWorkflowURL(item 2 of argv)
            if application id "\(bundleID)" is not running then return "missing"
            with timeout of 4 seconds
                tell application id "\(bundleID)"
                    repeat with browserWindow in windows
                        set tabIndex to 0
                        repeat with candidateTab in tabs of browserWindow
                            set tabIndex to tabIndex + 1
                            set currentURL to URL of candidateTab
                            if my isWorkflowURL(currentURL) then
                                if item 1 of argv is "probe" then return "found"
                                if item 1 of argv is "wake" then
                                    set AppleScript's text item delimiters to "#"
                                    set pageURL to first text item of currentURL
                                    set AppleScript's text item delimiters to ""
                                    set URL of candidateTab to pageURL & "#voice-wake=" & item 2 of argv
                                end if
                                try
                                    \(selection)
                                    set index of browserWindow to 1
                                    set \(restore) of browserWindow to false
                                    activate
                                end try
                                return "reused"
                            end if
                        end repeat
                    end repeat
                end tell
            end timeout
            return "missing"
        end run
        """
    }

    static func run(_ source: String, arguments: [String]) async throws -> String {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-e", source, "--"] + arguments
            let output = Pipe(); let errors = Pipe()
            process.standardOutput = output; process.standardError = errors
            try process.run()
            // Also bound permission dialogs or a stalled scripting process.
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 12, execute: timeout)
            defer { timeout.cancel() }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                throw NSError(domain: "WakeBrowser", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey:
                    "无法检查已有浏览器页面。请允许 LoopCanvas Wake 的浏览器自动化权限，或确认浏览器可响应后重试；未打开新页面。",
                    NSDebugDescriptionErrorKey: String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)])
            }
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }.value
    }
}

@MainActor
final class BrowserReuse {
    private var previous: Task<Void, Error>?

    func open(_ base: URL, wakeID: String? = nil) async throws {
        if let wakeID, UUID(uuidString: wakeID) == nil { throw URLError(.badURL) }
        let predecessor = previous
        let task = Task { @MainActor in
            // Serialise tab selection so simultaneous commands cannot race this decision.
            _ = try? await predecessor?.value
            let running = NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier)
            let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            let preferred = NSWorkspace.shared.urlForApplication(toOpen: base).flatMap { Bundle(url: $0)?.bundleIdentifier }
            var browsers: [String] = []
            for id in [front, preferred].compactMap({ $0 }) + BrowserTabScript.supported {
                if running.contains(id), BrowserTabScript.supported.contains(id), !browsers.contains(id) { browsers.append(id) }
            }
            for id in browsers {
                let result = try await BrowserTabScript.run(BrowserTabScript.source(for: id), arguments: [wakeID == nil ? "focus" : "wake", wakeID ?? ""])
                if result == "reused" { return }
                guard result == "missing" else { throw URLError(.badServerResponse) }
            }
            let url = wakeID.flatMap { URL(string: base.absoluteString + "/#voice-wake=" + $0) } ?? base
            guard NSWorkspace.shared.open(url) else { throw URLError(.cannotOpenFile) }
        }
        previous = task
        try await task.value
    }
}
