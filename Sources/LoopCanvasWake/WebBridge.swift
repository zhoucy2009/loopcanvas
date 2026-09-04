import AppKit
import WakeCore

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class WebBridge {
    private struct Bootstrap: Decodable { let token: String; let voiceWakeVersion: Int? }
    private struct Runtime: Decodable { let nodeExecutable: String }
    private let base = URL(string: "http://127.0.0.1:4317")!
    private let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    private var server: Process?
    private var starting = false
    private let browser = BrowserReuse()

    private func request(_ path: String, token: String? = nil, body: Data? = nil) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.timeoutInterval = 8
        if let body {
            request.httpMethod = "POST"; request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(token, forHTTPHeaderField: "X-LoopCanvas-Token")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NSError(domain: "Wake", code: 1, userInfo: [NSLocalizedDescriptionKey: "工作台请求失败，请检查 4317 服务版本。"])
        }
        return data
    }
    private func bootstrap() async throws -> Bootstrap {
        let result = try JSONDecoder().decode(Bootstrap.self, from: await request("api/bootstrap"))
        guard result.voiceWakeVersion == 1 else {
            throw NSError(domain: "Wake", code: 2, userInfo: [NSLocalizedDescriptionKey: "4317 正在运行旧版工作台，请先退出旧服务。"])
        }
        return result
    }
    private func ensureServer() async throws -> Bootstrap {
        do { return try await bootstrap() }
        catch let error as URLError where error.code == .cannotConnectToHost {
            if !starting && server?.isRunning != true {
                starting = true
                defer { starting = false }
                guard let resources = Bundle.main.resourceURL else { throw error }
                let config = try JSONDecoder().decode(Runtime.self, from: Data(contentsOf: resources.appendingPathComponent("runtime.json")))
                guard FileManager.default.isExecutableFile(atPath: config.nodeExecutable) else {
                    throw NSError(domain: "Wake", code: 3, userInfo: [NSLocalizedDescriptionKey: "找不到 Node.js，请安装 Node.js 后重新打包唤醒程序。"])
                }
                let process = Process()
                process.executableURL = URL(fileURLWithPath: config.nodeExecutable)
                process.currentDirectoryURL = resources.appendingPathComponent("server/web")
                process.arguments = ["./bin/loopcanvas.js", "--no-open"]
                var environment = ProcessInfo.processInfo.environment
                environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (environment["PATH"] ?? "")
                process.environment = environment
                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                try process.run(); server = process
            }
            for _ in 0..<30 {
                try await Task.sleep(nanoseconds: 250_000_000)
                if let ready = try? await bootstrap() { return ready }
            }
            throw NSError(domain: "Wake", code: 4, userInfo: [NSLocalizedDescriptionKey: "工作台未能启动，请检查 4317 端口和本机 Node.js。"])
        }
    }
    func openWorkbench() async throws {
        _ = try await ensureServer()
        try await browser.open(base)
    }
    func wake(_ role: WakeRole) async throws {
        let boot = try await ensureServer()
        let id = UUID().uuidString.lowercased()
        let body = try JSONSerialization.data(withJSONObject: ["id": id, "role": role.rawValue])
        let data = try await request("api/voice/wake", token: boot.token, body: body)
        struct Reply: Decodable { let id: String }
        guard try JSONDecoder().decode(Reply.self, from: data).id == id else { throw URLError(.badServerResponse) }
        try await browser.open(base, wakeID: id)
    }
}
