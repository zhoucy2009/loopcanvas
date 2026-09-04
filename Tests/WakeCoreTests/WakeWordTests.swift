import XCTest
import WakeCore

final class WakeWordTests: XCTestCase {
    func testWakeWords() {
        for role in [WakeRole.plan, .execute, .review] {
            for text in [role.title, "hey，" + role.title, "HEY " + role.title + "。", "嘿，" + role.title, "嗨 " + role.title, role.title + " Agent"] {
                XCTAssertEqual(WakeRole.parse(text), role, text)
            }
        }
    }
    func testAmbientSpeechIsIgnored() {
        for text in ["不要执行", "我说了审核", "hey", "规划一个网站", "执行第三步", "“执行”", "hey 审核不要执行"] {
            XCTAssertNil(WakeRole.parse(text), text)
        }
    }
    func testDuplicateCooldown() {
        var gate = WakeCooldown()
        XCTAssertTrue(gate.accept(.plan, at: 1))
        XCTAssertFalse(gate.accept(.plan, at: 2))
        XCTAssertTrue(gate.accept(.execute, at: 2))
        XCTAssertTrue(gate.accept(.execute, at: 6))
    }
}
