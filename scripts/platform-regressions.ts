import "./test-guard";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { join } from "node:path";
import { makePlatform, parseMachineGuid, parseWinDriveLine, resolveBashPath, resolveT3Path } from "../lib/platform";
import { identify, systemCollectors } from "../runner/heartbeat";

assert.equal(parseMachineGuid("\n    MachineGuid    REG_SZ    ABC-123-DEF\n"), "ABC-123-DEF");
assert.equal(parseMachineGuid("nope"), null);

assert.deepEqual(parseWinDriveLine("100,50"), { freeBytes: 50, totalBytes: 150 });
assert.throws(() => parseWinDriveLine("x,y"), /no sizes/);

assert.equal(resolveBashPath("linux", () => "/bin/bash"), "/bin/bash");

const savedProg = process.env.ProgramFiles;
const savedProg86 = process.env["ProgramFiles(x86)"];
const savedClaudeBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
const savedFactoryBash = process.env.FACTORY_BASH_PATH;
process.env.ProgramFiles = join(import.meta.dirname, "fixtures", "no-git");
process.env["ProgramFiles(x86)"] = join(import.meta.dirname, "fixtures", "no-git");
delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
delete process.env.FACTORY_BASH_PATH;
assert.equal(resolveBashPath("win32", () => null), null, "without Git Bash Windows has no host bash");
process.env.ProgramFiles = savedProg;
process.env["ProgramFiles(x86)"] = savedProg86;
if (savedClaudeBash !== undefined) process.env.CLAUDE_CODE_GIT_BASH_PATH = savedClaudeBash;
if (savedFactoryBash !== undefined) process.env.FACTORY_BASH_PATH = savedFactoryBash;

const fakeHome = join(import.meta.dirname, "fixtures", "no-t3-home");
assert.equal(resolveT3Path("win32", fakeHome), null);

const failing = makePlatform({
  platform: "darwin",
  run: async () => {
    throw new Error("no");
  },
});
assert.deepEqual(await failing.hardwareId(), null);
assert.equal(await failing.computerName(), hostname());

const winId = makePlatform({
  platform: "win32",
  run: async () => "\nMachineGuid    REG_SZ    win-guid-1\n",
});
assert.deepEqual(await winId.hardwareId(), { id: "win-guid-1", idFrom: "machineGuid" });

const identified = await identify(undefined, winId);
assert.equal(identified.id, "win-guid-1");
assert.equal(identified.idFrom, "machineGuid");

process.env.ProgramFiles = join(import.meta.dirname, "fixtures", "no-git");
process.env["ProgramFiles(x86)"] = join(import.meta.dirname, "fixtures", "no-git");
delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
delete process.env.FACTORY_BASH_PATH;
assert.equal(makePlatform({ platform: "win32", which: () => null }).localJobsSupported(), false, "Windows without bash cannot run local jobs");
process.env.FACTORY_BASH_PATH = join(import.meta.dirname, "platform-regressions.ts");
assert.equal(makePlatform({ platform: "win32", which: () => null }).localJobsSupported(), true, "FACTORY_BASH_PATH that exists enables local jobs");
delete process.env.FACTORY_BASH_PATH;
process.env.ProgramFiles = savedProg;
process.env["ProgramFiles(x86)"] = savedProg86;

const { planLaunch } = await import("../runner/overrides");
const settings = { harness: { provider: "claudeAgent", model: "m", from: "settings" as const }, execution: "local" as const };
const baseCan = {
  local: true,
  checkout: true,
  hostLocal: false,
  modal: null as string | null,
  claude: true,
  codexSlot: true,
  driverOf: (p: string) => p,
  codexModel: "c",
};
assert.deepEqual(
  planLaunch({ harness: [], runsOn: [], repository: [] }, settings, null, baseCan),
  {
    kind: "launch",
    execution: "modal",
    harness: { provider: "claudeAgent", model: "m" },
    ticket: { notes: ["This runner cannot run local jobs yet, so it runs in a cloud sandbox."] },
  },
  "Settings local on a host without local tooling falls back to Modal",
);
assert.equal(
  planLaunch({ harness: [], runsOn: [], repository: [] }, settings, null, { ...baseCan, modal: "no image" }).kind,
  "wait",
  "without Modal and without local tooling the job waits",
);

const collectors = systemCollectors(async () => ({ max: 1, inFlight: 0 }), makePlatform({ platform: "linux" }));
const mem = await collectors.memory();
assert.ok(typeof mem === "object" && mem !== null && "usedBytes" in mem);

const shimHome = join(import.meta.dirname, "fixtures", "t3-shim-home");
const savedT3 = process.env.T3CODE_CLI_PATH;
process.env.T3CODE_CLI_PATH = join(shimHome, ".local", "bin", "t3.cmd");
assert.equal(
  resolveT3Path("win32", shimHome)?.replaceAll("\\", "/").toLowerCase(),
  join(shimHome, ".t3", "runtime", "versions", "0.0.1-test", "t3.exe").replaceAll("\\", "/").toLowerCase(),
  "T3CODE_CLI_PATH=.cmd unwraps to t3.exe",
);
if (savedT3 !== undefined) process.env.T3CODE_CLI_PATH = savedT3;
else delete process.env.T3CODE_CLI_PATH;

console.log("platform regressions passed");
