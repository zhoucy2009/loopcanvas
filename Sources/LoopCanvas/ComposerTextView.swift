import AppKit
import SwiftUI

enum ComposerPlaceholderVisibility {
    static func shouldShow(text: String, hasMarkedText: Bool) -> Bool {
        text.isEmpty && !hasMarkedText
    }
}

struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let onLongPaste: (String) -> Void
    let onImagePaste: (Data, String) -> Void
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let editor = PasteAwareTextView()
        editor.isRichText = false
        editor.allowsUndo = true
        editor.drawsBackground = false
        editor.font = .systemFont(ofSize: 17)
        editor.textColor = .labelColor
        editor.textContainerInset = NSSize(width: 6, height: 6)
        editor.textContainer?.lineFragmentPadding = 0
        editor.placeholder = placeholder
        editor.delegate = context.coordinator
        editor.onLongPaste = onLongPaste
        editor.onImagePaste = onImagePaste
        editor.onSubmit = onSubmit
        editor.string = text
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? PasteAwareTextView else { return }
        context.coordinator.parent = self
        editor.onLongPaste = onLongPaste
        editor.onImagePaste = onImagePaste
        editor.onSubmit = onSubmit
        editor.placeholder = placeholder
        if editor.string != text {
            editor.string = text
            editor.needsDisplay = true
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
            editor.needsDisplay = true
        }
    }

}

private final class PasteAwareTextView: NSTextView {
    var placeholder = "" {
        didSet { needsDisplay = true }
    }
    var onLongPaste: ((String) -> Void)?
    var onImagePaste: ((Data, String) -> Void)?
    var onSubmit: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard ComposerPlaceholderVisibility.shouldShow(
            text: string,
            hasMarkedText: hasMarkedText()
        ), !placeholder.isEmpty else { return }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 17),
            .foregroundColor: NSColor.placeholderTextColor
        ]
        NSAttributedString(string: placeholder, attributes: attributes)
            .draw(at: textContainerOrigin)
    }

    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        if let png = board.data(forType: .png) {
            onImagePaste?(png, "粘贴图片.png")
            return
        }
        if let tiff = board.data(forType: .tiff),
           let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            onImagePaste?(png, "粘贴图片.png")
            return
        }
        if let value = board.string(forType: .string), Self.shouldAttach(value) {
            onLongPaste?(value)
            return
        }
        super.paste(sender)
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.keyCode == 36 {
            onSubmit?()
        } else {
            super.keyDown(with: event)
            needsDisplay = true
        }
    }

    static func shouldAttach(_ text: String) -> Bool {
        text.utf8.count >= 8_192 || text.split(separator: "\n", omittingEmptySubsequences: false).count >= 120
    }
}
