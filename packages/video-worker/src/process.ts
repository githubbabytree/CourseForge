import { spawn } from "node:child_process";

export interface ProcessResult { readonly stdout: string; readonly stderr: string }
export async function runProcess(executable: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal, cwd?: string): Promise<ProcessResult> {
  if (!executable.startsWith("/") || args.some((value) => value.includes("\u0000"))) throw new Error("unsafe_process_argv");
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], cwd, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    let stdout = "", stderr = ""; const limit = 1024 * 1024;
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString("utf8", 0, limit - stdout.length); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString("utf8", 0, limit - stderr.length); });
    const terminate = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(terminate, timeoutMs); signal?.addEventListener("abort", terminate, { once: true });
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", terminate); reject(error); });
    child.once("exit", (code, killedBy) => { clearTimeout(timer); signal?.removeEventListener("abort", terminate); if (code === 0) resolve({ stdout, stderr }); else reject(new Error(`process_failed:${code ?? killedBy ?? "unknown"}:${stderr.slice(-500)}`)); });
  });
}
