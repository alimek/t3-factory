import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

// Do not inherit real T3 identities or Node options into disposable Factory processes.
function sourceProcess(args: string[], home: string, cwd?: string) {
  return [
    process.execPath,
    ["--conditions=factory-source", ...args],
    { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } },
  ] as const;
}

export function runFactoryProcess(args: string[], home: string, cwd?: string) {
  return promisify(execFile)(...sourceProcess(args, home, cwd));
}

export function spawnFactoryProcess(args: string[], home: string) {
  return spawn(...sourceProcess(args, home));
}
