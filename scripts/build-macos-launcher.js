#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (process.platform !== "darwin") throw new Error("macOS 앱 실행기는 macOS에서 빌드하세요.");
const root = path.resolve(__dirname, "..");
const bundle = path.join(root, "Agent Graph Studio.app", "Contents");
fs.mkdirSync(path.join(bundle, "MacOS"), { recursive: true });
const version = require(path.join(root, "package.json")).version;
fs.writeFileSync(path.join(bundle, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Agent Graph Studio</string>
<key>CFBundleDisplayName</key><string>Agent Graph Studio</string>
<key>CFBundleIdentifier</key><string>local.agent-graph-studio.launcher</string>
<key>CFBundleExecutable</key><string>AgentGraphStudio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
for (const [command, args] of [
  ["/usr/bin/swiftc", ["-swift-version", "5", "-O", "-framework", "AppKit", path.join(root, "launchers/macos/Launcher.swift"), "-o", path.join(bundle, "MacOS/AgentGraphStudio")]],
  ["/usr/bin/codesign", ["--force", "--sign", "-", path.dirname(bundle)]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
process.stdout.write(`더블클릭 실행 파일: ${path.dirname(bundle)}\n`);
