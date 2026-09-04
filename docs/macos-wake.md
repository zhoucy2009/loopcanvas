# macOS 免点击唤醒

新增“集合”和“开一个新需求”，与网页右上角的 [四精灵胶囊](agent-sprites.md) 联动；这些界面命令不需要等待正在运行的 Agent 完成。

`LoopCanvas Wake.app` 是独立菜单栏程序，不是浏览器语音按钮。启动并授权后，网页关闭或不在前台时仍能监听。无需运行旧 SwiftUI 工作台。

## 构建与使用

```sh
node Scripts/package-wake.mjs
open "dist/LoopCanvas Wake.app"
```

首次启动时允许“麦克风”和“语音识别”。菜单栏显示“本地等待唤醒”后，单独说“规划”“执行”“审核”，也可说“hey，规划”“嘿，执行”“嗨，审核”。短暂停顿后复用已有工作台页面或打开系统默认浏览器，并把唤醒交给对应 Agent。

唤醒时先查找已有工作台：优先当前前台浏览器，其次默认浏览器，再检查其他已运行的 Chrome、Safari、Edge、Brave、Vivaldi。只匹配本机 4317 的工作台首页，不把演示页、Remote 页或其他网站当作工作台。找到后选中原标签页，只更新唤醒 fragment，保留原 URL 的主机、查询参数和页面状态；没有找到才打开新页面。“打开工作台”菜单也复用已有页。

首次检查浏览器时，macOS 可能请求“LoopCanvas Wake 控制浏览器”的自动化权限。拒绝或浏览器超时时会报错并停止，不会以新开页掩盖检测失败；可在系统设置 → 隐私与安全性 → 自动化中允许后重试。其他未支持自动化的浏览器仍使用系统默认打开方式。已有工作台需刷新一次以加载连续唤醒接收队列；不需要重启服务。

- 规划：使用当前项目目标；没有目标时提示补充。
- 执行：绑定当时的就绪步骤，打开现有写入确认，确认后才开始执行。
- 审核：绑定当时已有结果的步骤。
- 唤醒请求交付工作台并打开浏览器后，屏幕底部显示对应角色的成功提示：180ms 轻浮现，停留约 2 秒后淡出。不抢键盘焦点、不拦截点击；系统开启“减少动态效果”时仅短淡入淡出。它表示唤醒请求已发送，不表示 Agent 任务执行成功。
- 菜单栏“预览唤醒动画”可直接查看效果，不使用麦克风、不调用 Agent；连续触发会替换提示，不堆叠窗口。
- 首次浏览器不需要申请麦克风权限，录音由菜单栏程序负责。
- 菜单栏“停止后台监听”立即释放麦克风；“退出唤醒”退出监听程序，但不停止工作台服务。
- “登录 Mac 时启动”默认关闭，用户可自行勾选；若 macOS 要求批准，请在系统设置的登录项中完成。
- 系统休眠期间暂停，唤醒后尝试恢复。退出程序、注销或关机后不会监听，不能唤醒睡眠中的电脑。

## 隐私与范围

使用 Apple Speech 的中文设备端识别，设置 `requiresOnDeviceRecognition = true`，并检查 [Apple 设备端识别支持标志](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition)。不支持设备端识别时停止并提示，不回落到网络识别。不保存音频，不把日常谈话文本发给工作台或 Codex。只传递 `plan / execute / review` 角色与随机事件编号。

这不是 Siri 的专用低功耗唤醒引擎：麦克风和本地语音识别会持续工作，CPU、电量与识别准确率应在实际设备上验证。短词存在误唤醒可能；建议说“hey，…”降低歧义。程序不会绕过系统麦克风授权，也不会自动修改隐私设置。

菜单栏程序内置当前打包版本的 Web 服务资源。4317 没有服务时自动启动内置服务；已有兼容服务则复用。遇到不支持后台唤醒的旧服务时明确报错，不会杀死未知进程。Node.js 必须仍安装在打包时记录的位置。

唤醒只经本机 `127.0.0.1:4317` 通信：先获取会话令牌，再提交白名单事件。浏览器通过 URL fragment 接收随机事件 ID，使用受令牌保护的 POST 一次性领取。事件两分钟过期；网页刷新不重复调用 Agent。项目切换或步骤消失时拒绝原唤醒。关闭网页不影响后台监听；网页接收事件时仍由原有 Agent 调用链处理任务权限和确认。

## 本地打包限制

当前是本机 ad-hoc 签名构建，非公证的公开发行包。请固定程序路径使用；重新打包或移动位置可能需要重新授权。打包器保留上次 `.app` 为 `dist/LoopCanvas Wake.previous-时间戳.app`，但不要同时启动多个版本。

## 验证

```sh
swift test --filter WakeWordTests
cd web && npm test
```

`swift test` 需要包含 XCTest 的完整 Xcode。仅安装 Command Line Tools 时，可运行独立检查：`swiftc Sources/WakeCore/WakeWord.swift Scripts/check-wake.swift -o /tmp/loopcanvas-wake-check && /tmp/loopcanvas-wake-check`。

Apple Silicon Mac 构建 release 后，可运行动画检查（不打开麦克风、不调用 Agent）：

```sh
swiftc -parse-as-library -swift-version 5 -I .build/arm64-apple-macosx/release/Modules Sources/LoopCanvasWake/WakeFeedback.swift Scripts/check-wake-feedback.swift .build/arm64-apple-macosx/release/WakeCore.build/WakeWord.swift.o -o /tmp/loopcanvas-wake-feedback-check
/tmp/loopcanvas-wake-feedback-check
```

检查涵盖角色文案、点击穿透、不抢焦点、连续替换、自动消失、减少动态效果，并把提示截图保存为 `/tmp/loopcanvas-wake-feedback.png`。

浏览器脚本与 URL 边界检查：`swiftc -parse-as-library -swift-version 5 Sources/LoopCanvasWake/BrowserReuse.swift Scripts/check-browser-reuse.swift -o /tmp/loopcanvas-browser-reuse-check && /tmp/loopcanvas-browser-reuse-check`。可选 `--probe` 只读检查当前 Chrome 是否有工作台；`--focus` 切换已有工作台并验证标签页数量不变，不调用 Agent。

`dist/LoopCanvas Wake.app/Contents/MacOS/LoopCanvasWake --self-check` 只读取本机识别支持情况和已有授权状态，不打开麦克风。真实远场拾音、耗电、长时间稳定性、睡眠恢复与登录启动仍需在目标 Mac 上实测。
