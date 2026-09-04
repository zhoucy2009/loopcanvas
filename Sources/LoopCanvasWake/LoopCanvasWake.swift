import AppKit
import Speech
import AVFoundation
import ServiceManagement
import WakeCore

@main
@MainActor
struct LoopCanvasWakeApp {
    static func main() {
        if CommandLine.arguments.contains("--self-check") {
            let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
            let info: [String: Any] = ["onDeviceChinese": recognizer?.supportsOnDeviceRecognition ?? false,
                "speechAuthorization": SFSpeechRecognizer.authorizationStatus().rawValue,
                "microphoneAuthorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue]
            if let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
            return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = WakeAppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class WakeAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private let status = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")
    private let toggle = NSMenuItem(title: "停止后台监听", action: #selector(toggleListening), keyEquivalent: "")
    private let login = NSMenuItem(title: "登录 Mac 时启动", action: #selector(toggleLogin), keyEquivalent: "")
    private let listener = WakeListener()
    private let bridge = WebBridge()
    private let feedback = WakeFeedback()
    private var deliveries = 0
    private var message = "正在启动…"

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "mic.slash", accessibilityDescription: "LoopCanvas 后台唤醒")
        let menu = NSMenu(); menu.delegate = self
        menu.addItem(status); menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "规划 / 执行 / 审核 / 开一个新需求 / 集合", action: nil, keyEquivalent: ""))
        toggle.target = self; menu.addItem(toggle)
        let open = NSMenuItem(title: "打开工作台", action: #selector(openWorkbench), keyEquivalent: ""); open.target = self; menu.addItem(open)
        login.target = self; menu.addItem(login)
        let preview = NSMenuItem(title: "预览唤醒动画", action: #selector(previewFeedback), keyEquivalent: "")
        preview.target = self; menu.addItem(preview)
        menu.addItem(NSMenuItem(title: "仅设备端识别，不保存录音", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出唤醒（保留工作台服务）", action: #selector(quit), keyEquivalent: "q"); quit.target = self; menu.addItem(quit)
        item.menu = menu
        listener.onStatus = { [weak self] text, listening in
            guard let self else { return }
            self.message = text; self.status.title = text
            self.item.button?.image = NSImage(systemSymbolName: listening ? "mic.fill" : "mic.slash", accessibilityDescription: text)
            self.item.button?.toolTip = "LoopCanvas Wake · " + text
        }
        listener.onWake = { [weak self] role in self?.deliver(role) }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(sleeping), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(waking), name: NSWorkspace.didWakeNotification, object: nil)
        if CommandLine.arguments.contains("--preview-wake") {
            listener.stop()
            previewFeedback()
        } else if UserDefaults.standard.object(forKey: "listenEnabled") as? Bool != false {
            Task { await listener.enable() }
        } else { listener.stop() }
    }
    func menuWillOpen(_ menu: NSMenu) {
        status.title = message
        toggle.title = listener.wanted ? "停止后台监听" : "开启后台监听 / 重试权限"
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
    @objc private func toggleListening() {
        let enable = !listener.wanted
        UserDefaults.standard.set(enable, forKey: "listenEnabled")
        if enable { Task { await listener.enable() } } else { listener.stop() }
    }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch { message = "登录启动设置失败：" + error.localizedDescription }
    }
    private func deliver(_ role: WakeRole) {
        guard deliveries < 4 else { message = "唤醒提交繁忙，请稍后再说"; return }
        deliveries += 1
        Task {
            defer { deliveries -= 1 }
            do {
                try await bridge.wake(role)
                message = role == .gather || role == .newRequest
                    ? "已发送“\(role.title)”指令；仍在本地监听"
                    : "已唤醒 \(role.title) Agent；仍在本地监听"
                feedback.show(role)
            }
            catch { message = "唤醒未交付：" + error.localizedDescription }
            status.title = message
        }
    }
    @objc private func openWorkbench() {
        Task { do { try await bridge.openWorkbench() } catch { message = error.localizedDescription; status.title = message } }
    }
    @objc private func previewFeedback() { feedback.show(.plan, preview: true) }
    @objc private func sleeping() { feedback.dismiss(); listener.suspend() }
    @objc private func waking() { listener.resume() }
    @objc private func quit() { listener.stop(); NSApplication.shared.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { feedback.dismiss(); listener.stop() }
}
