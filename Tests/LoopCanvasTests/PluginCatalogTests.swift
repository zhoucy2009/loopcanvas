import XCTest
@testable import LoopCanvas

@MainActor
final class PluginCatalogTests: XCTestCase {

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "LoopCanvas.pluginStates.v1")
        super.tearDown()
    }

    func testBundledCatalogLoadsOfficialPlugins() {
        let catalog = PluginCatalog()
        XCTAssertGreaterThanOrEqual(catalog.entries.count, 30, "内置插件应不少于 30 个，实际 \(catalog.entries.count)")
        let byID = Dictionary(uniqueKeysWithValues: catalog.entries.compactMap { entry in
            entry.manifest.map { ($0.id, entry) }
        })
        XCTAssertNotNil(byID["standard"], "应包含标准模式 preset")
        XCTAssertEqual(byID["standard"]?.enabled, true, "标准模式应为默认启用")
        XCTAssertEqual(byID["minimal"]?.enabled, false, "极简模式应为默认关闭")
        XCTAssertEqual(byID["tool-web"]?.manifest?.package, "@deepseek-ai/dsh-tool-web")
        for entry in catalog.entries {
            guard let manifest = entry.manifest else {
                XCTFail("插件 \(entry.id) 缺少清单：\(entry.error ?? "未知错误")")
                continue
            }
            XCTAssertFalse(manifest.description.isEmpty, "\(manifest.id) 应有简介")
            XCTAssertFalse(manifest.problem.isEmpty, "\(manifest.id) 应说明解决的问题")
            XCTAssertFalse(manifest.audience.isEmpty, "\(manifest.id) 应说明推荐人群")
        }
    }

    func testSetEnabledPersistsToUserDefaults() {
        let catalog = PluginCatalog()
        let id = "tool-ralph"
        XCTAssertEqual(catalog.enabled(id, defaultEnabled: true), true)

        catalog.setEnabled(id, false)
        XCTAssertEqual(catalog.enabled(id, defaultEnabled: true), false)

        let reloaded = PluginCatalog()
        XCTAssertEqual(reloaded.enabled(id, defaultEnabled: true), false, "重启后应保留停用状态")

        reloaded.setEnabled(id, true)
        XCTAssertEqual(PluginCatalog().enabled(id, defaultEnabled: true), true)
    }
}
