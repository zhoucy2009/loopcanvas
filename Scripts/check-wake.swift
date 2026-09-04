import Foundation

// No XCTest dependency: runnable on a Mac with Command Line Tools only.
@main
struct WakeCheck {
    static func main() {
        var count = 0
        for role in [WakeRole.plan, .execute, .review] {
            for text in [role.title, "hey，" + role.title, "HEY " + role.title + "。", "嘿，" + role.title, "嗨 " + role.title, role.title + " Agent"] {
                precondition(WakeRole.parse(text) == role, text); count += 1
            }
        }
        for text in ["不要执行", "我说了审核", "hey", "规划一个网站", "执行第三步", "“执行”", "hey 审核不要执行"] {
            precondition(WakeRole.parse(text) == nil, text); count += 1
        }
        var gate = WakeCooldown()
        for text in ["集合", "hey 集合", "全体集合"] { precondition(WakeRole.parse(text) == .gather); count += 1 }
        for text in ["开一个新需求", "hey，开一个新需求", "打开新需求"] { precondition(WakeRole.parse(text) == .newRequest); count += 1 }
        for text in ["不要集合", "不要开一个新需求"] { precondition(WakeRole.parse(text) == nil); count += 1 }
        precondition(gate.accept(.plan, at: 1))
        precondition(!gate.accept(.plan, at: 2))
        precondition(gate.accept(.execute, at: 2))
        precondition(gate.accept(.execute, at: 6))
        print("WakeCore: \(count + 4) checks passed")
    }
}
