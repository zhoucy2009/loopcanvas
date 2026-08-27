import SwiftUI

@main
struct LoopCanvasApp: App {
    @StateObject private var store = WorkflowStore()

    var body: some Scene {
        WindowGroup("LoopCanvas") {
            AppRootView()
                .environmentObject(store)
                .frame(minWidth: 980, minHeight: 700)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 920)
        .commands {
            CommandGroup(after: .sidebar) {
                if store.phase == .workspace {
                    Button(store.isPaused ? "继续任务" : "暂停任务并生成交接") {
                        store.togglePause()
                    }
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                }
            }
        }
    }
}

struct AppRootView: View {
    @EnvironmentObject private var store: WorkflowStore
    @AppStorage("LoopCanvas.sidebarCollapsed") private var sidebarCollapsed = false

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()

            HStack(spacing: 0) {
                if sidebarCollapsed {
                    VStack(spacing: 14) {
                        Button {
                            sidebarCollapsed = false
                        } label: {
                            Image(systemName: "sidebar.left")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(AppTheme.secondaryText)
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("展开侧栏")
                        Spacer()
                    }
                    .frame(width: 44)
                    .background(AppTheme.panel.opacity(0.92))
                    Divider().overlay(AppTheme.line)
                } else {
                    ConversationSidebar()
                        .frame(width: 238)
                    Divider().overlay(AppTheme.line)
                }

                Group {
                    if let configuration = store.selectedConfiguration {
                        ConfigurationWindow(surface: configuration)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        switch store.phase {
                        case .intake:
                            IntakeView()
                        case .building:
                            PlanBuildingView()
                        case .workspace:
                            ContentView()
                        }
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { store.surfacePendingAPIRequestsIfNeeded() }
        .sheet(item: Binding(
            get: { store.handoffDraft },
            set: { if $0 == nil { store.dismissHandoff() } }
        )) { draft in
            HandoffSheet(draft: draft)
                .environmentObject(store)
        }
        .alert("提示", isPresented: Binding(
            get: { store.transientMessage != nil },
            set: { if !$0 { store.transientMessage = nil } }
        )) {
            Button("知道了") { store.transientMessage = nil }
        } message: {
            Text(store.transientMessage ?? "")
        }
    }
}
