import AppKit
import QuartzCore
import WakeCore

/// A click-through, non-activating acknowledgment; never reports task completion.
@MainActor
final class WakeFeedback {
    private var panel: NSPanel?
    private var dismissal: Task<Void, Never>?
    private let reduceMotion: () -> Bool

    init(reduceMotion: @escaping () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }) {
        self.reduceMotion = reduceMotion
    }

    func show(_ role: WakeRole, preview: Bool = false) {
        dismiss()
        let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main
        guard let screen else { return }
        let area = screen.visibleFrame
        let width = min(CGFloat(308), area.width - 24)
        let frame = NSRect(x: area.midX - width / 2, y: area.minY + 28, width: width, height: 80)
        let window = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.ignoresMouseEvents = true
        window.isReleasedWhenClosed = false

        let view = NSView(frame: NSRect(origin: .zero, size: frame.size))
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor(srgbRed: 0.075, green: 0.095, blue: 0.12, alpha: 1).cgColor
        view.layer?.cornerRadius = 18
        view.layer?.borderWidth = 1
        view.layer?.borderColor = NSColor(srgbRed: 0.28, green: 0.38, blue: 0.39, alpha: 1).cgColor
        let icon = NSImageView(frame: NSRect(x: 18, y: 23, width: 34, height: 34))
        icon.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: "唤醒请求已发送")
        icon.contentTintColor = NSColor(srgbRed: 0.47, green: 0.85, blue: 0.72, alpha: 1)
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 30, weight: .medium)
        view.addSubview(icon)

        let prefix = role == .gather || role == .newRequest ? "已收到" : "已唤醒"
        let title = NSTextField(labelWithString: "\(prefix) · \(role.title)")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = NSColor(srgbRed: 0.94, green: 0.96, blue: 0.97, alpha: 1)
        title.frame = NSRect(x: 66, y: 41, width: width - 82, height: 23)
        view.addSubview(title)
        let detail = NSTextField(labelWithString: preview ? "动画预览 · 不会启动任务" : "唤醒请求已发送至工作台")
        detail.font = .systemFont(ofSize: 13)
        detail.textColor = NSColor(srgbRed: 0.68, green: 0.73, blue: 0.78, alpha: 1)
        detail.frame = NSRect(x: 66, y: 19, width: width - 82, height: 20)
        view.addSubview(detail)
        window.contentView = view
        panel = window
        window.orderFrontRegardless() // Does not activate the app or steal keyboard focus.

        let reduced = reduceMotion()
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0; fade.toValue = 1; fade.duration = reduced ? 0.09 : 0.18
        view.layer?.add(fade, forKey: "wake-fade")
        if !reduced {
            let rise = CABasicAnimation(keyPath: "transform.translation.y")
            rise.fromValue = -6; rise.toValue = 0; rise.duration = 0.18
            rise.timingFunction = CAMediaTimingFunction(name: .easeOut)
            view.layer?.add(rise, forKey: "wake-rise")
        }
        NSAccessibility.post(element: view, notification: .announcementRequested,
                             userInfo: [.announcement: title.stringValue + "，" + detail.stringValue,
                                        .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        dismissal = Task { [weak self, weak window] in
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            guard !Task.isCancelled, let self, let window, self.panel === window else { return }
            await NSAnimationContext.runAnimationGroup { context in
                context.duration = self.reduceMotion() ? 0.09 : 0.12
                window.animator().alphaValue = 0
            }
            guard !Task.isCancelled, self.panel === window else { return }
            self.dismiss()
        }
    }

    func dismiss() {
        dismissal?.cancel(); dismissal = nil
        panel?.orderOut(nil); panel = nil
    }
}
