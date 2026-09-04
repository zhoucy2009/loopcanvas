import AppKit
import WakeCore

// Compile together with WakeFeedback.swift and the built WakeCore module.
// This check never starts microphone recognition or sends a workbench request.
@main
@MainActor
struct WakeFeedbackCheck {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            let presenter = WakeFeedback()
            let focused = NSWorkspace.shared.frontmostApplication?.processIdentifier
            presenter.show(.plan, preview: true)
            guard let first = app.windows.first(where: { $0.isVisible }) else { fatalError("Missing feedback window") }
            precondition(first.ignoresMouseEvents && !first.isKeyWindow)
            precondition(NSWorkspace.shared.frontmostApplication?.processIdentifier == focused, "Focus was stolen")
            precondition(first.frame.width <= 308 && first.frame.height == 80)
            try? await Task.sleep(nanoseconds: 250_000_000)
            if let view = first.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "/tmp/loopcanvas-wake-feedback.png"))
            }
            presenter.show(.execute, preview: true)
            precondition(!first.isVisible, "Repeated wake left a stacked window")
            guard let second = app.windows.first(where: { $0.isVisible }) else { fatalError("Missing replacement") }
            let labels = second.contentView!.subviews.compactMap { ($0 as? NSTextField)?.stringValue }
            precondition(labels.contains("已唤醒 · 执行"))
            precondition(labels.contains("动画预览 · 不会启动任务"))
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            precondition(second.isVisible, "Old dismissal removed the new acknowledgment")
            try? await Task.sleep(nanoseconds: 500_000_000)
            precondition(!second.isVisible, "Acknowledgment did not dismiss")
            presenter.show(.review, preview: true)
            presenter.dismiss()
            precondition(!app.windows.contains(where: { $0.isVisible }))
            let reduced = WakeFeedback(reduceMotion: { true })
            reduced.show(.review, preview: true)
            let reducedWindow = app.windows.first(where: { $0.isVisible })!
            precondition(reducedWindow.contentView?.layer?.animation(forKey: "wake-rise") == nil)
            precondition(reducedWindow.contentView?.layer?.animation(forKey: "wake-fade")?.duration == 0.09)
            reduced.dismiss()
            print("Wake feedback: display, roles, click-through, focus, replacement, dismissal and reduced motion passed")
            app.terminate(nil)
        }
        app.run()
    }
}
