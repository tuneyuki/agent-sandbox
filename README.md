# Agent Sandbox on GCP

API で指示を送ると、GCP 上の隔離されたサンドボックスの中で **Claude Code**（[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)）が動いて作業し、その様子をチャットボットにストリーミングで返す構成です。

```
 ┌───────────────┐   HTTPS (SSE)    ┌──────────────────────────┐  ID トークン + VPC   ┌──────────────────────────────┐
 │ チャット UI     │ ───────────────▶ │ Gateway (Cloud Run)       │ ──────────────────▶ │ Runner (Cloud Run, 内部専用)   │
 │ (Gateway が配信) │ ◀─────────────── │ ・認証 (IAP / Bearer)      │ ◀── NDJSON stream ── │ ・concurrency = 1             │
 └───────────────┘                  │ ・セッション管理 (Firestore)│                      │ ・Claude Agent SDK = Claude Code│
                                    │ ・GCS 署名付き URL 発行     │                      │ ・/sandbox/workspace で作業     │
                                    └────────────┬─────────────┘                      └──────┬───────────────┬────────┘
                                                 │                                           │ 署名付き URL     │ Private Google Access
                                                 ▼                                           ▼                 ▼
                                       Firestore（履歴・ロック）              GCS（作業ディレクトリ+トランスクリプト）  Vertex AI（Claude）
```

## 仕組み

1 回のユーザーメッセージ（＝ 1 ターン）は次のように処理されます。

1. Gateway がセッションのロックを取り（同じセッションで同時に 2 ターン走らせない）、そのセッション専用の GCS 署名付き URL（読み取り・書き込み）を発行して Runner を呼ぶ。
2. Runner は `/sandbox` を空にしてから、前回の状態（`workspace/` と Claude Code のトランスクリプト `claude/`）を GCS から復元する。
3. `query({ prompt, options: { resume: <前回のセッション ID>, cwd: "/sandbox/workspace", ... } })` で Claude Code を実行し、テキスト・ツール呼び出し・ツール結果を NDJSON で返す。Gateway はそれを SSE でブラウザに中継する。
4. ターンが終わったら状態を tar.gz にして GCS に保存し、`/sandbox` を消す。

Runner はリクエストごとにまっさらになるので、どのインスタンスに振られても同じセッションの続きを実行できます（ステートレス）。

## API

| メソッド | パス | 説明 |
|---|---|---|
| `POST` | `/api/sessions` | セッション作成 `{ "title": "..." }` |
| `GET` | `/api/sessions` | 自分のセッション一覧 |
| `GET` | `/api/sessions/:id` | セッション情報 + メッセージ履歴 |
| `POST` | `/api/sessions/:id/messages` | `{ "text": "..." }` を送信。応答は `text/event-stream` |
| `DELETE` | `/api/sessions/:id` | セッションと作業ディレクトリを削除 |

SSE のイベント（`data: {...}`）:

| type | 内容 |
|---|---|
| `session` | `claudeSessionId`, `model` |
| `text` | Claude の発言 |
| `tool_use` | `id`, `name`（Bash / Write など）, `input` |
| `tool_result` | `toolUseId`, `isError`, `content`（4000 文字で切り詰め） |
| `result` | `ok`, `numTurns`, `durationMs`, `costUsd`（セッション累計の推定値） |
| `error` | `message` |
| `done` | ストリーム終了 |

```bash
# 例（AUTH_MODE=token）
SID=$(curl -s -XPOST $URL/api/sessions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"demo"}' | jq -r .id)
curl -N -XPOST $URL/api/sessions/$SID/messages -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"text":"Python で素数を 10 個出力するスクリプトを書いて実行して"}'
```

## ローカルで動かす

GCP リソースなしで動きます（履歴はメモリ、状態はローカルボリューム）。

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
open http://localhost:8080
```

Vertex AI を使う場合は `docker-compose.yml` のコメントを参照してください。

Docker を使わない場合:

```bash
(cd runner  && npm ci && npm run build && SANDBOX_ROOT=/tmp/sbx PORT=8081 npm start) &
(cd gateway && npm ci && npm run build && AUTH_MODE=none STORE=memory RUNNER_AUTH=none RUNNER_URL=http://localhost:8081 npm start)
```

## GCP にデプロイする

前提: `gcloud`（ログイン済み）、`terraform` >= 1.6、プロジェクトのオーナー権限、そして **Vertex AI Model Garden で使う Claude モデルを有効化済み**であること。

```bash
PROJECT_ID=your-project REGION=asia-northeast1 AUTH_MODE=token ./scripts/deploy.sh
```

スクリプトは API の有効化 → Artifact Registry 作成 → Cloud Build でイメージ作成 → Terraform で残りを作成、の順に実行します。`AUTH_MODE=token` の場合は API トークンを Secret Manager に作成して表示するので、チャット UI の「API トークン設定」に入力してください。

社内向けなら `AUTH_MODE=iap` を推奨します（Google アカウントでログイン。`-var 'iap_members=["group:team@example.com"]'` で許可対象を指定）。この場合ユーザーごとにセッションが分かれます。

主な Terraform 変数（`infra/terraform/variables.tf`）:

| 変数 | 既定値 | 説明 |
|---|---|---|
| `claude_model` | `claude-opus-5-5` | Claude Code が使うモデル |
| `runner_internet_access` | `false` | `true` で Runner からインターネット（npm / pip / 任意サイト）に出られる |
| `turn_timeout_seconds` | `1800` | 1 ターンの上限（Cloud Run の上限は 3600） |
| `runner_max_instances` | `10` | 同時実行ターン数の上限（コストの上限にもなる） |
| `runner_cpu` / `runner_memory` | `2` / `4Gi` | サンドボックス 1 つあたりのリソース |
| `state_retention_days` | `30` | GCS 上の作業ディレクトリの保持期間 |

## セキュリティ設計

Claude Code には承認者がいないので、「エージェントが何をしても被害が限定される」ことを箱の側で担保しています。

- **コンテナ隔離**: Runner は Cloud Run（gen2）上で `concurrency=1`。1 コンテナで同時に動くのは 1 セッションだけで、ターンごとに `/sandbox` を消去。非 root ユーザーで実行。
- **ネットワーク**: Runner の通信はすべて VPC を通り、既定ではファイアウォールで `private.googleapis.com`（Vertex AI など Google API）以外への外向き通信を拒否。VPC 内の他リソースへの横移動も拒否。
- **権限の最小化**: Runner のサービスアカウントは `roles/aiplatform.user` のみ。エージェントは Bash からメタデータサーバー経由でこの SA のトークンを取れてしまう（Cloud Run では防げない）ため、GCS や Firestore の権限は一切付けない。状態の読み書きは Gateway が発行する「そのセッションのそのオブジェクトだけ」の短命な署名付き URL で行う。
- **API キー不要**: Claude は Vertex AI 経由（`CLAUDE_CODE_USE_VERTEX=1`）で SA の権限で呼ぶので、サンドボックス内に盗まれて困る API キーがない。
- **ツールの許可リスト**: `permissionMode: "dontAsk"` + `allowedTools`。許可リスト外のツールは自動拒否（`ALLOWED_TOOLS` / `DISALLOWED_TOOLS` 環境変数で変更可）。`settingSources: []` で外部の設定ファイルを読まない。
- **Runner は内部専用**: `INGRESS_TRAFFIC_INTERNAL_ONLY` + IAM（Gateway の SA だけが invoker）。

### 既知の制約・今後の拡張

- **`runner_internet_access=true` にした場合**、エージェントは任意のサイトと通信できます（データ持ち出しのリスク）。必要なら Secure Web Proxy などで許可ドメインを絞ってください。
- **ユーザー入力によるプロンプトインジェクション**で、そのセッション自身の作業ディレクトリが壊されることは防げません（他セッションには届きません）。
- **ターンをまたいだプロセス**（開発サーバーの常駐など）はできません。ターン終了時にコンテナを片付け、バックグラウンド実行（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`）も無効化しています。常駐プロセスやより強い隔離が必要なら、GKE Sandbox（gVisor）で「セッションごとに Pod」を立てる構成に Runner を差し替えるのが次の一歩です（Gateway と API はそのまま使えます）。
- **ファイルのアップロード・ダウンロード** API は未実装です。GCS の状態アーカイブを使って追加できます。
- `costUsd` は SDK による推定値で、請求額ではありません。

## ディレクトリ構成

```
gateway/            公開 API + チャット UI (Express, TypeScript)
  src/server.ts     ルーティング・認証・SSE
  src/store.ts      Firestore / メモリのセッションストア
  src/runner.ts     Runner 呼び出し・GCS 署名付き URL
  public/           チャット UI (素の HTML/JS)
runner/             サンドボックス (Express + Claude Agent SDK)
  src/server.ts     POST /v1/turn
  src/agent.ts      Claude Code の実行とイベント変換
  src/state.ts      作業ディレクトリの復元・保存
infra/terraform/    Cloud Run ×2, VPC/ファイアウォール/DNS, GCS, Firestore, IAM
scripts/deploy.sh   ビルド & デプロイ
docker-compose.yml  ローカル開発
```
