import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { freemem, hostname, totalmem } from "node:os";
import { join } from "node:path";

/** Where a host machine id came from. */
export type IdFrom = "config" | "ioreg" | "machineGuid" | "hostname";

export type DiskSample = { freeBytes: number; totalBytes: number };
export type MemorySample = { usedBytes: number; totalBytes: number };

/**
 * OS probes the runner uses for identity and heartbeats. Regressions pass fakes; production uses
 * {@link defaultPlatform}.
 */
export type Platform = {
  readonly kind: "darwin" | "win32" | "linux" | "other";
  computerName(): Promise<string>;
  /** Stable hardware id, or null when the OS probe fails. */
  hardwareId(): Promise<{ id: string; idFrom: Exclude<IdFrom, "config" | "hostname"> } | null>;
  /** Absolute path to bash for host recipe checks, or null when none is usable. */
  bashPath(): string | null;
  /** Absolute path to the t3 CLI when known, else null (caller may still try PATH). */
  t3Path(): string | null;
  /**
   * Whether this host may start factory threads in its own T3 (not Modal). False on Windows until
   * bash is available for host checks; still requires a live T3 for an actual local launch.
   */
  localJobsSupported(): boolean;
};

/** Parses `reg query` output for MachineGuid. */
export function parseMachineGuid(output: string): string | null {
  const match = /^\s*MachineGuid\s+REG_SZ\s+(\S+)\s*$/im.exec(output);
  return match?.[1] ?? null;
}

/** Parses a single `used,free` line from PowerShell Get-PSDrive. */
export function parseWinDriveLine(output: string): DiskSample {
  const [used, free] = output.trim().split(",").map(Number);
  if (!Number.isFinite(used) || !Number.isFinite(free) || used! + free! <= 0) throw new Error("Get-PSDrive row has no sizes");
  return { freeBytes: free!, totalBytes: used! + free! };
}

function whichOnPath(bin: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

const GIT_BASH_CANDIDATES = [
  () => process.env.CLAUDE_CODE_GIT_BASH_PATH,
  () => process.env.FACTORY_BASH_PATH,
  () => join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
  () => join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
];

/** Resolves a bash executable for host-side recipe checks. */
export function resolveBashPath(platform = process.platform, which: (bin: string) => string | null = whichOnPath): string | null {
  if (platform === "win32") {
    for (const candidate of GIT_BASH_CANDIDATES) {
      const path = candidate();
      if (path && existsSync(path)) return path;
    }
    return which("bash.exe") ?? which("bash");
  }
  return which("bash") ?? "bash";
}

/** Unwrap a Windows `t3.cmd` shim that execs a quoted `t3.exe` path. */
function t3ExeFromCmdShim(cmdPath: string): string | null {
  try {
    const match = /"([^"]+t3\.exe)"/i.exec(readFileSync(cmdPath, "utf8"));
    return match?.[1] && existsSync(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

/** Newest `…/.t3/runtime/versions/<ver>/t3.exe` when present. */
function newestRuntimeT3(home: string): string | null {
  const root = join(home, ".t3", "runtime", "versions");
  if (!existsSync(root)) return null;
  try {
    for (const ver of readdirSync(root).sort().reverse()) {
      const exe = join(root, ver, "t3.exe");
      if (existsSync(exe)) return exe;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolves a real t3 executable for `execFile`/`spawn` (not a `.cmd` shim — those EINVAL on Windows).
 */
export function resolveT3Path(platform = process.platform, home = process.env.HOME || process.env.USERPROFILE || ""): string | null {
  const fromEnv = process.env.T3CODE_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    if (platform === "win32" && /\.cmd$/i.test(fromEnv)) {
      const unwrapped = t3ExeFromCmdShim(fromEnv);
      if (unwrapped) return unwrapped;
    } else {
      return fromEnv;
    }
  }
  if (platform === "win32") {
    const candidates = [
      newestRuntimeT3(home),
      join(home, ".local", "bin", "t3.exe"),
      join(home, ".t3", "bin", "t3.exe"),
      join(home, ".t3", "bin", "t3"),
    ].filter((p): p is string => Boolean(p));
    const hit = candidates.find(existsSync);
    if (hit) return hit;
    const shim = join(home, ".local", "bin", "t3.cmd");
    if (existsSync(shim)) return t3ExeFromCmdShim(shim);
    return null;
  }
  return [join(home, ".t3", "bin", "t3"), join(home, ".local", "bin", "t3")].find(existsSync) ?? null;
}

export function platformKind(platform = process.platform): Platform["kind"] {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "other";
}

async function darwinHardwareId(run: (cmd: string, args: string[]) => Promise<string>) {
  const out = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const id = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1];
  return id ? ({ id, idFrom: "ioreg" } as const) : null;
}

async function winHardwareId(run: (cmd: string, args: string[]) => Promise<string>) {
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  const out = await run(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
  const id = parseMachineGuid(out);
  return id ? ({ id, idFrom: "machineGuid" } as const) : null;
}

export type PlatformRun = (cmd: string, args: string[]) => Promise<string>;

export function makePlatform(opts: { platform?: NodeJS.Platform; run?: PlatformRun; which?: (bin: string) => string | null } = {}): Platform {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? whichOnPath;
  const run =
    opts.run ??
    (async (cmd, args) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return (await promisify(execFile)(cmd, args, { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;
    });

  return {
    kind: platformKind(platform),
    async computerName() {
      if (platform === "darwin") {
        return (await run("scutil", ["--get", "ComputerName"]).then((out) => out.trim(), () => "")) || hostname();
      }
      if (platform === "win32") return process.env.COMPUTERNAME?.trim() || hostname();
      return hostname();
    },
    async hardwareId() {
      if (platform === "darwin") return darwinHardwareId(run).catch(() => null);
      if (platform === "win32") return winHardwareId(run).catch(() => null);
      return null;
    },
    bashPath() {
      return resolveBashPath(platform, which);
    },
    t3Path() {
      return resolveT3Path(platform);
    },
    localJobsSupported() {
      if (platform === "win32") return Boolean(resolveBashPath("win32", which));
      return true;
    },
  };
}

export const defaultPlatform: Platform = makePlatform();

/** Node freemem-based memory sample for unit tests and non-macOS heartbeats. */
export const nodeMemory = (totalBytes = totalmem()): MemorySample => ({
  usedBytes: Math.max(0, totalBytes - freemem()),
  totalBytes,
});

/** Reads Windows C: free/total via PowerShell. */
export async function winDisk(run?: PlatformRun): Promise<DiskSample> {
  const exec =
    run ??
    (async (cmd, args) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return (await promisify(execFile)(cmd, args, { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;
    });
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const out = await exec(ps, ["-NoProfile", "-Command", '$d=Get-PSDrive -Name C; Write-Output ("{0},{1}" -f $d.Used,$d.Free)']);
  return parseWinDriveLine(out);
}
