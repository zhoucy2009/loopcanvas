import Foundation

public enum WakeRole: String, Codable, Sendable {
    case plan, execute, review, newRequest = "new_request", gather
    public var title: String {
        switch self { case .plan: "规划"; case .execute: "执行"; case .review: "审核"; case .newRequest: "新需求"; case .gather: "集合" }
    }
    public static func parse(_ transcript: String) -> Self? {
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "，,。.!！？?：:；;、"))
        var text = transcript.lowercased().components(separatedBy: separators).joined()
        for prefix in ["hey", "嘿", "嗨"] where text.hasPrefix(prefix) {
            text = String(text.dropFirst(prefix.count)); break
        }
        for suffix in ["agent", "智能体"] where text.hasSuffix(suffix) {
            text = String(text.dropLast(suffix.count)); break
        }
        switch text {
        case "规划": return .plan; case "执行": return .execute; case "审核": return .review
        case "开一个新需求", "打开一个新需求", "打开新需求", "新建需求", "新建一个新需求", "创建一个新需求": return .newRequest
        case "集合", "全体集合", "精灵集合": return .gather
        default: return nil
        }
    }
}

public struct WakeCooldown: Sendable {
    private var last: (WakeRole, TimeInterval)?
    public init() {}
    public mutating func accept(_ role: WakeRole, at time: TimeInterval) -> Bool {
        if let last, last.0 == role, time - last.1 < 3 { return false }
        last = (role, time)
        return true
    }
}
