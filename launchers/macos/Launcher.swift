import AppKit

// A Finder launch does not see the PATH set in shell profiles, so ask the login shell.
func loginShellNode() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
    process.arguments = ["-lc", "command -v node"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    var output = Data()
    let finished = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        output = pipe.fileHandleForReading.readDataToEndOfFile()
        finished.signal()
    }
    if finished.wait(timeout: .now() + 3) == .timedOut {
        process.terminate()
        return nil
    }
    let line = String(decoding: output, as: UTF8.self).split(separator: "\n").last.map(String.init)
    return line?.hasPrefix("/") == true ? line : nil
}

func supportedNode(_ path: String) -> Bool {
    guard FileManager.default.isExecutableFile(atPath: path) else { return false }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = ["-p", "process.versions.node"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let major = Int((String(data: data, encoding: .utf8) ?? "").split(separator: ".").first.map(String.init) ?? "") ?? 0
        return process.terminationStatus == 0 && major >= 24
    } catch { return false }
}

func nodeExecutable() -> URL? {
    let fm = FileManager.default
    var paths = loginShellNode().map { [$0] } ?? []
    paths += (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" }
    paths.append("/usr/local/bin/node")
    let nvm = fm.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
    if let versions = try? fm.contentsOfDirectory(atPath: nvm.path) {
        paths += versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { nvm.appendingPathComponent($0 + "/bin/node").path }
    }
    paths.append("/opt/homebrew/bin/node")
    // Homebrew Node loads libuv from outside its prefix and cannot start under the Seatbelt profile.
    let homebrew = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().path.contains("/Cellar/") }
    let ordered = paths.filter { !homebrew($0) } + paths.filter(homebrew)
    return ordered.first(where: supportedNode).map { URL(fileURLWithPath: $0) }
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var status: NSTextField!
    private var progress: NSProgressIndicator!
    private var browserButton: NSButton!
    private var helper: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var browserURL: URL?
    private var waitingToQuit = false
    private let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AgentGraphStudio/launcher.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Agent Graph Studio 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 430, height: 230), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Agent Graph Studio"
        window.isReleasedWhenClosed = false
        window.center()
        let title = NSTextField(labelWithString: "Agent Graph Studio")
        title.font = .systemFont(ofSize: 23, weight: .semibold)
        title.frame = NSRect(x: 28, y: 170, width: 370, height: 32)
        window.contentView?.addSubview(title)
        status = NSTextField(wrappingLabelWithString: "실행 환경을 확인하고 있습니다.")
        status.frame = NSRect(x: 28, y: 90, width: 365, height: 70)
        status.font = .systemFont(ofSize: 13)
        window.contentView?.addSubview(status)
        progress = NSProgressIndicator(frame: NSRect(x: 28, y: 73, width: 372, height: 12))
        progress.style = .bar
        progress.isIndeterminate = true
        progress.startAnimation(nil)
        window.contentView?.addSubview(progress)
        browserButton = NSButton(title: "브라우저 열기", target: self, action: #selector(openBrowser))
        browserButton.frame = NSRect(x: 267, y: 25, width: 137, height: 32)
        browserButton.bezelStyle = .rounded
        browserButton.isEnabled = false
        window.contentView?.addSubview(browserButton)
        let logs = NSButton(title: "실행 로그", target: self, action: #selector(openLogs))
        logs.bezelStyle = .rounded
        logs.frame = NSRect(x: 28, y: 25, width: 104, height: 32)
        window.contentView?.addSubview(logs)
        let quit = NSButton(title: "종료", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        quit.bezelStyle = .rounded
        quit.frame = NSRect(x: 150, y: 25, width: 88, height: 32)
        window.contentView?.addSubview(quit)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startHelper()
    }

    private func startHelper() {
        let project = Bundle.main.bundleURL.deletingLastPathComponent()
        let script = project.appendingPathComponent("scripts/desktop-launcher.js")
        guard FileManager.default.fileExists(atPath: script.path) else {
            showError("실행기를 프로젝트 폴더 안에 두세요. scripts/desktop-launcher.js 파일이 필요합니다.")
            return
        }
        guard let node = nodeExecutable() else {
            showError("Node.js 24 이상이 필요합니다. Node.js를 설치한 뒤 앱을 다시 여세요.")
            return
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [script.path, "--project", project.path]
        process.currentDirectoryURL = project
        let stdout = Pipe(), stdin = Pipe()
        process.standardOutput = stdout
        process.standardInput = stdin
        process.standardError = FileHandle.nullDevice
        input = stdin.fileHandleForWriting
        helper = process
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.receive(data) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.waitingToQuit { NSApp.reply(toApplicationShouldTerminate: true) }
                else if process.terminationStatus != 0 { self.showError("실행기를 시작할 수 없습니다. 실행 로그를 확인하세요.") }
            }
        }
        do { try process.run() }
        catch { showError("실행기를 시작할 수 없습니다: \(error.localizedDescription)") }
    }

    private func receive(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer.prefix(upTo: newline)
            outputBuffer.removeSubrange(...newline)
            guard let payload = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let state = payload["state"] as? String else { continue }
            status.stringValue = payload["message"] as? String ?? ""
            if state == "ready", let address = payload["url"] as? String, let url = URL(string: address), url.scheme == "http", url.host == "127.0.0.1" {
                browserURL = url
                browserButton.isEnabled = true
                progress.stopAnimation(nil)
                progress.isHidden = true
                if payload["owned"] as? Bool == false { status.stringValue += "\n기존 서버는 이 실행기를 종료해도 계속 실행됩니다." }
                openBrowser()
            } else if state == "error" { showError(status.stringValue) }
        }
    }
    private func showError(_ message: String) {
        status.stringValue = message
        progress.stopAnimation(nil)
        progress.isHidden = true
    }
    @objc private func openBrowser() { if let url = browserURL { NSWorkspace.shared.open(url) } }
    @objc private func openLogs() { NSWorkspace.shared.open(logURL) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        if browserURL != nil { openBrowser() }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let helper = helper, helper.isRunning else { return .terminateNow }
        if !waitingToQuit {
            waitingToQuit = true
            status.stringValue = "서버를 안전하게 종료하고 있습니다."
            browserButton.isEnabled = false
            try? input?.write(contentsOf: Data("shutdown\n".utf8))
        }
        return .terminateLater
    }
}

if CommandLine.arguments.contains("--print-node") {
    print(nodeExecutable()?.path ?? "")
    exit(0)
}

let app = NSApplication.shared
let delegate = LauncherDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
