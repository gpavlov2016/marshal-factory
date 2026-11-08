import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { resolveT3Path } from "../lib/platform";

// Installs the runner as a background process:
//   macOS — launchd LaunchAgent (KeepAlive), log ~/Library/Logs/marshal-factory/runner.log
//   Windows — Scheduled Task at logon with restart-on-failure, log %LOCALAPPDATA%\marshal-factory\runner.log
//   bun scripts/install-runner.ts [--uninstall]

export const LABEL = "com.marshal-factory.runner";
export const WINDOWS_TASK = "MarshalFactoryRunner";
const root = join(import.meta.dirname, "..");

const whichUnix = (bin: string) => execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
const whichWin = (bin: string) =>
  execFileSync("where", [bin], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)[0]!;

function installDarwin(uninstall: boolean) {
  const plistPath = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  const logPath = join(homedir(), "Library/Logs/marshal-factory/runner.log");
  const domain = `gui/${userInfo().uid}`;
  const launchctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" });
  const loaded = () => {
    try {
      launchctl("print", `${domain}/${LABEL}`);
      return true;
    } catch {
      return false;
    }
  };

  if (uninstall) {
    if (loaded()) launchctl("bootout", `${domain}/${LABEL}`);
    console.log(`unloaded  ${LABEL}; ${plistPath} left in place`);
    return;
  }

  const tools = ["bun", "git"].map(whichUnix);
  const t3 = resolveT3Path("darwin") ?? whichUnix("t3");
  const path = [...new Set([...tools.map(dirname), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escape(tools[0]!)}</string><string>${escape(join(root, "runner/index.ts"))}</string></array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(path)}</string>
    <key>HOME</key><string>${escape(homedir())}</string>
    <key>T3CODE_CLI_PATH</key><string>${escape(t3)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(logPath)}</string>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const changed = !existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist;
  if (changed) writeFileSync(plistPath, plist);
  if (changed && loaded()) {
    launchctl("bootout", `${domain}/${LABEL}`);
    for (let i = 0; i < 50 && loaded(); i++) execFileSync("/bin/sleep", ["0.2"]);
  }
  const wasLoaded = loaded();
  if (changed || !wasLoaded) launchctl("bootstrap", domain, plistPath);
  console.log(`${changed ? "installed" : wasLoaded ? "unchanged" : "loaded"} ${LABEL}; log ${logPath}`);
}

function installWindows(uninstall: boolean) {
  const logDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "marshal-factory");
  const logPath = join(logDir, "runner.log");
  const launchCmd = join(logDir, "run-runner.cmd");
  const bun = whichWin("bun");
  const runner = join(root, "runner", "index.ts");
  const t3 = resolveT3Path("win32");

  if (uninstall) {
    try {
      execFileSync("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { encoding: "utf8", stdio: "pipe" });
      console.log(`removed Scheduled Task ${WINDOWS_TASK}`);
    } catch {
      console.log(`Scheduled Task ${WINDOWS_TASK} was not installed`);
    }
    return;
  }

  mkdirSync(logDir, { recursive: true });
  const lines = [
    "@echo off",
    `cd /d "${root}"`,
    `set "HOME=${homedir()}"`,
    `set "USERPROFILE=${homedir()}"`,
    ...(t3 ? [`set "T3CODE_CLI_PATH=${t3}"`] : []),
    `"${bun}" "${runner}" >> "${logPath}" 2>&1`,
  ];
  writeFileSync(launchCmd, `${lines.join("\r\n")}\r\n`);

  // Current-user logon task via PowerShell — avoids elevation that `schtasks /SC ONLOGON` often needs.
  const ps = `
$ErrorActionPreference = 'Stop'
$name = '${WINDOWS_TASK}'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute '${launchCmd.replace(/'/g, "''")}'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $name
`.trim();
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFileSync(powershell, ["-NoProfile", "-Command", ps], { encoding: "utf8", stdio: "pipe" });
  console.log(`installed Scheduled Task ${WINDOWS_TASK}; log ${logPath}`);
}

const uninstall = process.argv.includes("--uninstall");
if (process.platform === "win32") installWindows(uninstall);
else if (process.platform === "darwin") installDarwin(uninstall);
else {
  console.error(`install-runner supports macOS and Windows; this host is ${process.platform}`);
  process.exit(1);
}
