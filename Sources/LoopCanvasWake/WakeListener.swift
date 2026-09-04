import AppKit
import AVFoundation
@preconcurrency import Speech
import WakeCore

@MainActor
final class WakeListener {
    var onStatus: (String, Bool) -> Void = { _, _ in }
    var onWake: (WakeRole) -> Void = { _ in }
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private var engine: AVAudioEngine?
    private var recognition: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var generation = UUID()
    private var silence: Task<Void, Never>?
    private var rotation: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var failures = 0
    private var cooldown = WakeCooldown()
    private(set) var wanted = false

    func enable() async {
        wanted = true
        failures = 0
        onStatus("正在检查麦克风与语音权限…", false)
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        guard wanted else { return }
        guard mic else { wanted = false; onStatus("未授权麦克风，请在系统设置中允许", false); return }
        let speech: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard wanted else { return }
        guard speech == .authorized else { wanted = false; onStatus("未授权语音识别，请在系统设置中允许", false); return }
        guard recognizer?.supportsOnDeviceRecognition == true else {
            wanted = false; onStatus("中文设备端识别不可用；未启用云端监听", false); return
        }
        begin()
    }
    func stop() {
        wanted = false; retry?.cancel(); endSession()
        onStatus("后台监听已停止", false)
    }
    func suspend() { retry?.cancel(); endSession(); onStatus("系统休眠，监听已暂停", false) }
    func resume() { if wanted { failures = 0; begin() } }

    private func endSession() {
        generation = UUID()
        silence?.cancel(); rotation?.cancel()
        if let engine { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        engine = nil
        request?.endAudio(); recognition?.cancel()
        recognition = nil; request = nil
    }
    private func begin() {
        guard wanted else { return }
        endSession()
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            failed("设备端语音服务暂不可用"); return
        }
        let sessionID = generation
        let audio = AVAudioEngine()
        let bufferRequest = SFSpeechAudioBufferRecognitionRequest()
        bufferRequest.shouldReportPartialResults = true
        bufferRequest.requiresOnDeviceRecognition = true
        bufferRequest.taskHint = .confirmation
        bufferRequest.contextualStrings = ["规划", "执行", "审核", "hey 规划", "hey 执行", "hey 审核", "开一个新需求", "集合"]
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { failed("没有可用的麦克风输入"); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable buffer, _ in bufferRequest.append(buffer) }
        engine = audio; request = bufferRequest
        recognition = recognizer.recognitionTask(with: bufferRequest) { @Sendable [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let message = error?.localizedDescription
            Task { @MainActor [weak self] in
                guard let self, self.wanted, self.generation == sessionID else { return }
                if let text { self.receive(text, final: final, sessionID: sessionID) }
                else if let message { self.failed(message) }
            }
        }
        do { audio.prepare(); try audio.start() }
        catch { failed("无法启动麦克风：" + error.localizedDescription); return }
        onStatus("本地等待唤醒：规划 / 执行 / 审核", true)
        rotation = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 45_000_000_000)
            guard !Task.isCancelled, let self, self.wanted, self.generation == sessionID else { return }
            self.begin()
        }
    }
    private func receive(_ text: String, final: Bool, sessionID: UUID) {
        silence?.cancel(); failures = 0
        // Ambient transcripts never leave memory. Wait for the phrase to settle;
        // partial "执行" followed by "不要执行" must not fire immediately.
        let role = WakeRole.parse(text)
        if final { finish(role, sessionID: sessionID); return }
        silence = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard !Task.isCancelled else { return }
            self?.finish(role, sessionID: sessionID)
        }
    }
    private func finish(_ role: WakeRole?, sessionID: UUID) {
        guard wanted, generation == sessionID else { return }
        if let role, cooldown.accept(role, at: ProcessInfo.processInfo.systemUptime) { onWake(role) }
        begin()
    }
    private func failed(_ message: String) {
        endSession(); failures += 1
        guard wanted, failures <= 3 else {
            wanted = false; onStatus("监听已停止：" + message, false); return
        }
        onStatus("语音服务恢复中（\(failures)/3）", false)
        let delay = UInt64(failures * 2) * 1_000_000_000
        retry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled, let self, self.wanted else { return }
            self.begin()
        }
    }
}
