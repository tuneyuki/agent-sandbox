/**
 * ターン終了時に、エージェントが起動して残ったプロセス（nohup したサーバー等）を止める。
 * 対象は環境変数にターンのマーカーを持つプロセスと、cwd が /sandbox 配下のプロセス。
 * Runner 自身と祖先は対象外。
 */
import { readdir, readFile, readlink } from "node:fs/promises";

export const TURN_MARKER = "AGENT_SANDBOX_TURN";

async function ancestors(): Promise<Set<number>> {
  const set = new Set<number>([process.pid, 1]);
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      set.add(pid);
    } catch {
      break;
    }
  }
  return set;
}

export async function killStrayProcesses(sandboxRoot: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return 0; // /proc が無い環境（macOS 等）
  }
  const keep = await ancestors();
  let killed = 0;
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || keep.has(pid)) continue;
    try {
      const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
      if (environ.includes(`${TURN_MARKER}=1`) || cwd === sandboxRoot || cwd.startsWith(sandboxRoot + "/")) {
        process.kill(pid, "SIGKILL");
        killed++;
      }
    } catch {
      // 既に終了 / 権限なし
    }
  }
  return killed;
}
