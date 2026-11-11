/**
 * Claude Agent SDK（= Claude Code をライブラリとして使うもの）で 1 ターン実行し、
 * フロントに流しやすい単純なイベントに変換して返す。
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_DIR, WORKSPACE_DIR } from "./sync.js";

/** Runner → Gateway に流すイベント（NDJSON の 1 行 = 1 イベント）。 */
export type RunnerEvent =
  | { type: "session"; claudeSessionId: string; model?: string }
  /** 文字単位のストリーミング（チャット表示用） */
  | { type: "text_delta"; delta: string }
  /** 確定したテキストブロック（履歴保存用） */
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; content: string }
  | {
      type: "result";
      ok: boolean;
      subtype: string;
      result?: string;
      numTurns: number;
      durationMs: number;
      costUsd: number;
    }
  | { type: "error"; message: string };

export interface TurnInput {
  prompt: string;
  /** 前ターンの Claude Code セッション ID。あれば resume する。 */
  claudeSessionId?: string;
  /** リクエストごとの上書き（Gateway 側で検証済みのもの） */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  abortController: AbortController;
}

const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
];

function csv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

/** エージェントに渡す環境変数。Runner 自身の環境変数は必要なものだけに絞る。 */
function agentEnv(): Record<string, string> {
  const pass = [
    "PATH",
    "HOME",
    "LANG",
    "TZ",
    // Vertex AI 経由で Claude を使う（推奨: API キー不要、SA の権限で呼べる）
    "CLAUDE_CODE_USE_VERTEX",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "GOOGLE_APPLICATION_CREDENTIALS", // ローカル開発で ADC を渡す場合のみ
    // Anthropic API を直接使う場合
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "HTTPS_PROXY",
    "NO_PROXY",
  ];
  const env: Record<string, string> = {};
  for (const k of pass) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // 1 ターンごとにサンドボックスを破棄するので、ターンをまたぐバックグラウンド実行は使わせない
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return env;
}

const SYSTEM_APPEND = `
あなたはチャットボット経由でユーザーと対話しているサンドボックス内のエージェントです。
- 作業ディレクトリは ${WORKSPACE_DIR} です。ファイルはここに作成してください。
- ユーザーが渡したファイルは ${WORKSPACE_DIR}/uploads/ に置かれます。
- ユーザーは端末を見ていません。成果物はファイルとして作業ディレクトリに保存してください（ユーザーはそれをダウンロードできます）。
- 最終回答には、何をしたか・結果・作成/変更したファイルのパスを簡潔にまとめてください。
`.trim();

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : `[${c?.type ?? "content"}]`))
      .join("\n");
  }
  return JSON.stringify(content);
}

const MAX_TOOL_RESULT_CHARS = 4000;

function* convert(msg: SDKMessage): Generator<RunnerEvent> {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        yield { type: "session", claudeSessionId: msg.session_id, model: msg.model };
      }
      return;
    case "stream_event": {
      if (msg.parent_tool_use_id) return;
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
        yield { type: "text_delta", delta: ev.delta.text };
      }
      return;
    }
    case "assistant":
      // サブエージェント内部のメッセージはチャットには出さない
      if (msg.parent_tool_use_id) return;
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) yield { type: "text", text: block.text };
        else if (block.type === "tool_use")
          yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
      return;
    case "user": {
      if (msg.parent_tool_use_id) return;
      const content = msg.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content as any[]) {
        if (block?.type === "tool_result") {
          let text = toolResultText(block.content);
          if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…(truncated)";
          yield {
            type: "tool_result",
            toolUseId: block.tool_use_id,
            isError: Boolean(block.is_error),
            content: text,
          };
        }
      }
      return;
    }
    case "result":
      yield {
        type: "result",
        ok: msg.subtype === "success" && !msg.is_error,
        subtype: msg.subtype,
        result: msg.subtype === "success" ? msg.result : undefined,
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
        costUsd: msg.total_cost_usd,
      };
      return;
    default:
      return;
  }
}

export async function* runTurn(input: TurnInput): AsyncGenerator<RunnerEvent> {
  const q = query({
    prompt: input.prompt,
    options: {
      cwd: WORKSPACE_DIR,
      resume: input.claudeSessionId,
      model: input.model || process.env.CLAUDE_MODEL || undefined,
      effort: input.effort || (process.env.CLAUDE_EFFORT as any) || undefined,
      includePartialMessages: true,
      // 誰も承認ボタンを押せないので、許可リスト外のツールは自動拒否する。
      // サンドボックス自体（Cloud Run + VPC egress 制限 + 権限なし SA）で守る前提。
      permissionMode: "dontAsk",
      allowedTools: csv("ALLOWED_TOOLS", DEFAULT_ALLOWED_TOOLS),
      disallowedTools: csv("DISALLOWED_TOOLS", []),
      maxTurns: Number(process.env.MAX_TURNS ?? 50),
      // ユーザー/プロジェクトの settings.json は読まない（再現性のため）
      settingSources: [],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: input.systemPrompt ? `${SYSTEM_APPEND}\n\n${input.systemPrompt}` : SYSTEM_APPEND,
      },
      env: agentEnv(),
      abortController: input.abortController,
    },
  });

  for await (const msg of q) {
    yield* convert(msg);
  }
}
