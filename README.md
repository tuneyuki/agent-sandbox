# Agent Sandbox on GCP

API で指示とファイルを渡すと、GCP 上の隔離された環境で **Claude Code**（[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)）が作業し、その様子をストリーミングで返し、成果物をファイルとして残す API サーバーです。チャットボット（例: [ultra-light-chat](https://github.com/tuneyuki/ultra-light-chat)）のバックエンドから呼ぶことを想定しています。

## 構成の考え方

「計算する場所」と「状態を置く場所」を分けています。

| 概念 | 実体 | 寿命 |
|---|---|---|
| **セッション**（= 1 つのチャット） | Firestore の `sessions/{id}` + GCS の `sessions/{id}/` フォルダ | ユーザーが消すまで（ファイルは既定 30 日） |
| **ターン**（= ユーザーの 1 メッセージ） | Firestore の `sessions/{id}/turns/{turnId}` | セッションと同じ |
| **サンドボックス**（Claude Code が動く場所） | Runner（Cloud Run）のコンテナ 1 つ | **1 ターンの間だけ借りる** |

Runner は状態を持ちません。ターンのたびに「セッションフォルダを展開 → Claude Code 実行 → 差分を書き戻す → 消す」を行うので、どのコンテナに当たっても同じセッションの続きが実行できます。

```
 チャットボットのバックエンド
        │  HTTPS (+SSE)
        ▼
 ┌─────────────────────────────┐       ┌───────────────────────────────────────────┐
 │ Gateway (Cloud Run)          │──────▶│ Runner (Cloud Run, 内部専用, concurrency=1)│
 │ ・認証（IAM / Bearer）         │ NDJSON│  1. sessions/{id}/ を /sandbox に展開        │
 │ ・セッション/ターン管理         │◀──────│  2. Claude Code 実行（cwd=/sandbox/workspace）│
 │ ・ファイル API                 │       │  3. 変更ファイルを書き戻し                     │
 │ ・セッション限定トークン発行     │       │  4. /sandbox を消去                          │
 └──────┬───────────────┬──────┘       └──────┬──────────────────────┬─────────────┘
        │               │                     │ sessions/{id}/ 限定      │
        ▼               ▼                     ▼ トークン                  ▼
   Firestore      GCS バケット（1 つ）  ◀──────┘                     Vertex AI (Claude)
```

### 状態の置き場所

**Firestore**（メタデータ・実行状態）

```
sessions/{sessionId}
  owner            x-user-id（エンドユーザー）
  title
  status           idle | running
  lockedUntil      実行中ロックの期限（Gateway が落ちても自動解放）
  claudeSessionId  Claude Code 側の会話 ID（resume 用、外には出さない）
  turnCount, totalCostUsd, createdAt, updatedAt
sessions/{sessionId}/turns/{turnId}
  input, attachments[], status (running|completed|failed|aborted)
  text             最終回答
  events[]         ツール呼び出し・結果など（表示・監査用）
  filesChanged     { added, modified, deleted }
  costUsd, error, startedAt, finishedAt
```

**GCS**（ファイルの実体）。バケットは 1 つだけで、フォルダでセッションを分けます。

```
gs://{project}-agent-sandbox-state/
  sessions/{sessionId}/
    workspace/               ← Claude Code の作業ディレクトリそのもの
      uploads/               ← API やチャットで渡されたファイル
      ...                    ← エージェントが作ったファイル（ダウンロード可能）
    .state/claude.tar.gz     ← Claude Code の会話記録（内部用）
    .state/deps.tar.zst      ← node_modules / .venv のアーカイブ（内部用）
```

`workspace/` はファイル単位で同期するので、ターンの外からでも API で一覧・アップロード・ダウンロード・削除ができます（実行中は 409 で拒否）。

### セッションの分離

- Runner のサービスアカウントには **バケット権限が一切ありません**（`roles/aiplatform.user` だけ）。
- Gateway はターンごとに、[Credential Access Boundary](https://cloud.google.com/iam/docs/downscoping-short-lived-credentials) で **`sessions/{id}/` 配下だけ** に絞ったトークンを作って Runner に渡します。
- エージェントがこのトークンを盗んでも、触れるのは自分のセッションのフォルダだけです。バケットを増やさずに、セッションごとにバケットがあるのと同じ分離になります。

## サンドボックスでのアプリ開発（Python / Node.js）

サンドボックスの中で、アプリを作ってビルド・テスト・実行するところまでできます。

| 項目 | 内容 |
|---|---|
| ランタイム | Python 3（`python3` / `python`）、Node.js 22 |
| パッケージ管理 | npm / pnpm / yarn、pip / uv（`python3 -m venv` も可） |
| ビルドツール | gcc / make / pkg-config、各種 `-dev` ヘッダー（ネイティブ拡張のビルド用） |
| その他 | git、curl、jq、ripgrep、sqlite3 |

**パッケージの取得**: Runner はインターネットに出られませんが、Artifact Registry の**リモートリポジトリ**（npmjs と PyPI のプロキシ）経由で `npm install` や `uv pip install` ができます。ターン開始時に Runner の SA のトークンで `~/.npmrc` と `PIP_INDEX_URL` / `UV_DEFAULT_INDEX` を設定するので、エージェントは普段どおりのコマンドを打つだけです。一度取得したパッケージはミラーにキャッシュされます。

**依存の引き継ぎ**: `node_modules/` と `.venv/` はファイル数が多いので、ファイル単位では同期しません。セッションごとに 1 つのアーカイブ（`sessions/{id}/.state/deps.tar.zst`）にまとめて保存します。中身が変わったときだけアップロードし直すので、次のターンでは再インストールなしでビルドやテストができます。`files_changed.deps` が `saved` / `unchanged` / `removed` / `too_large` のどれかで結果を示します。

**実行**: ターンの中で、ビルドとテストに加えて Web サーバーの起動もできます（バックグラウンドで起動し、`curl` で確認する）。Bash のタイムアウトは既定 10 分・最大 30 分に延ばしてあります。ターンが終わると、エージェントが起動したプロセスはすべて停止します。

```bash
curl -N -XPOST $URL/v1/sessions/$SID/messages "${H[@]}" -H 'content-type: application/json' -d '{
  "input": "FastAPI で TODO API を作って、pytest でテストし、uvicorn で起動して curl で確認して"
}'
```

## API

すべて `x-user-id` ヘッダー（エンドユーザーの ID）を付けて呼びます。セッションはユーザーごとに分かれます。

### セッション

| メソッド | パス | 説明 |
|---|---|---|
| `POST` | `/v1/sessions` | 作成 `{ "title"? }` → `{ id, ... }` |
| `GET` | `/v1/sessions` | 一覧 |
| `GET` | `/v1/sessions/:id` | `{ session, turns }` |
| `DELETE` | `/v1/sessions/:id` | 削除（GCS のフォルダごと消える） |

### ファイル（`workspace/` からの相対パス）

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/v1/sessions/:id/files` | 一覧 `[{ path, size, updated }]` |
| `PUT` | `/v1/sessions/:id/files/<path>` | 生バイナリでアップロード |
| `POST` | `/v1/sessions/:id/files` | JSON で一括 `{ files: [{ path? \| filename, data }] }`（`data` は base64 か data URL。`path` 省略時は `uploads/<filename>`） |
| `GET` | `/v1/sessions/:id/files/<path>` | ダウンロード |
| `DELETE` | `/v1/sessions/:id/files/<path>` | 削除 |

### 実行

`POST /v1/sessions/:id/messages`

```json
{
  "input": "売上データを集計してグラフを作って",
  "files": [{ "filename": "sales.csv", "data": "data:text/csv;base64,..." }],
  "model": "claude-opus-5-5",
  "effort": "high",
  "system_prompt": "回答は日本語で"
}
```

`files`・`model`・`effort`・`system_prompt` は省略できます。`model` は `ALLOWED_MODELS` に含まれるものだけ有効です。応答は `text/event-stream` で、イベントは次のとおりです。

| type | 内容 |
|---|---|
| `session` | `session_id`, `turn_id`, `attachments`（保存された添付のパス） |
| `status` | `restoring` / `running` / `saving` |
| `text_delta` | 回答テキストの差分（チャット表示用） |
| `text` | 確定したテキストブロック |
| `tool_use` | `id`, `name`（Bash / Write / Read …）, `input` |
| `tool_result` | `toolUseId`, `isError`, `content`（4000 文字まで） |
| `result` | `ok`, `numTurns`, `durationMs`, `costUsd`（セッション累計の推定値） |
| `files_changed` | `added` / `modified`（`path`, `size`, `url`）, `deleted`, `deps` |
| `error` | `message` |
| `done` | `turn_id`。ストリーム終了 |

同じセッションで同時に 2 ターンは走りません（2 つ目は 409）。

```bash
H=(-H "x-user-id: alice" -H "authorization: Bearer $TOKEN")   # iam モードなら ID トークン
SID=$(curl -s -XPOST $URL/v1/sessions "${H[@]}" | jq -r .id)
curl -XPUT $URL/v1/sessions/$SID/files/data/sales.csv "${H[@]}" --data-binary @sales.csv
curl -N -XPOST $URL/v1/sessions/$SID/messages "${H[@]}" -H 'content-type: application/json' \
  -d '{"input":"data/sales.csv を月別に集計して report.md にまとめて"}'
curl $URL/v1/sessions/$SID/files/report.md "${H[@]}"
```

ultra-light-chat への組み込み方は [`integrations/ultra-light-chat/`](integrations/ultra-light-chat/README.md) を参照してください。

## ローカルで動かす

GCP リソースなしで動きます（履歴はメモリ、セッションフォルダはローカルボリューム）。

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
curl -XPOST localhost:8080/v1/sessions -H 'x-user-id: me'
```

## GCP にデプロイする

前提: `gcloud`（ログイン済み）、`terraform` >= 1.6、プロジェクトのオーナー権限、**Vertex AI Model Garden で使う Claude モデルを有効化済み**であること。

```bash
# GCP 上のバックエンド（Cloud Run 等）から呼ぶ: IAM 認証（推奨）
PROJECT_ID=your-project AUTH_MODE=iam \
  INVOKER=serviceAccount:chat-backend@your-project.iam.gserviceaccount.com ./scripts/deploy.sh

# GCP の外（Azure 等）から呼ぶ: Bearer トークン（Secret Manager に作成して表示する）
PROJECT_ID=your-project AUTH_MODE=token ./scripts/deploy.sh
```

主な Terraform 変数（`infra/terraform/variables.tf`）:

| 変数 | 既定値 | 説明 |
|---|---|---|
| `auth_mode` / `invoker_members` | `iam` / `[]` | Gateway の認証方式と、呼び出しを許可するメンバー |
| `claude_model` / `allowed_models` | `claude-opus-5-5` / Opus・Sonnet・Haiku | 既定モデルと、リクエストで選べるモデル |
| `package_mirror` | `true` | npm / PyPI のミラー（Artifact Registry のリモートリポジトリ）を作って Runner から使う |
| `runner_internet_access` | `false` | `true` で Runner から任意のインターネット（Web・GitHub など）に出られる |
| `turn_timeout_seconds` | `1800` | 1 ターンの上限（Cloud Run の上限は 3600） |
| `runner_max_instances` | `10` | 同時に実行できるターン数（コストの上限にもなる） |
| `runner_cpu` / `runner_memory` | `4` / `8Gi` | サンドボックス 1 つあたりのリソース（Cloud Run のディスクはメモリ上にあるので、`node_modules` などもメモリを使う） |
| `state_retention_days` | `30` | GCS 上のセッションフォルダの保持期間 |

## セキュリティ

Claude Code の操作を承認する人がいないので、「何をされても被害が限られる」ことを環境側で担保しています。

- **コンテナ**: Runner は Cloud Run（gen2）で `concurrency=1`。ターンごとに `/sandbox` を消去し、非 root で実行する。バックグラウンド実行は無効（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`）。
- **ネットワーク**: Runner の通信はすべて VPC を通り、既定では Private Google Access（Vertex AI・GCS・Artifact Registry のパッケージミラー）以外への外向き通信を拒否する。
- **プロセス**: ターンの最後に、エージェントが起動して残したプロセスを止める（環境変数の印と cwd で判別）。
- **権限**: Runner の SA は Vertex AI の利用権限と、パッケージミラーの読み取り権限だけ。GCS はセッション限定トークン経由でしか触れない。API キーもサンドボックス内に置かない（Vertex AI を SA で呼ぶ）。
- **ツール**: `permissionMode: "dontAsk"` + `allowedTools`。許可リスト外のツールは自動で拒否する。`settingSources: []` で外部の設定ファイルを読まない。
- **Runner への入口**: `INGRESS_TRAFFIC_INTERNAL_ONLY` + IAM（Gateway の SA だけが呼べる）。

### 既知の制約

- `runner_internet_access=true` にすると、エージェントは任意のサイトと通信できる（データ持ち出しのリスク）。必要なら Secure Web Proxy などで行き先を絞る。
- 毎ターン、ワークスペース全体と依存アーカイブを展開するので、大きなファイル（数百 MB 以上）を多数置く用途には向かない。依存アーカイブの上限は 2 GB（`MAX_DEPS_BYTES`）。
- パッケージミラーは npm と PyPI だけ。`git clone` や、任意の URL からのダウンロード（`curl https://...`、Playwright のブラウザ取得など）は `runner_internet_access=true` にしないとできない。
- ミラーのパッケージにはマルウェア対策がかからない（公開レジストリの中身をそのまま取る）。被害はサンドボックスと、そのセッションのフォルダの中に限られる。
- 作ったアプリをユーザーがブラウザで直接触る（プレビュー URL を出す）ことはできない。ターンが終わるとサーバーは止まる。必要なら Runner を GKE Sandbox（gVisor）の「セッションごとに Pod」構成に差し替える。Gateway・API・保存形式はそのまま使える。
- `costUsd` は SDK の推定値で、請求額ではない。

## ディレクトリ構成

```
gateway/src/
  server.ts    API ルーティング・認証・SSE
  store.ts     Firestore（sessions / turns）、ローカル用のメモリ実装
  storage.ts   セッションフォルダの読み書き、セッション限定トークンの発行
  runner.ts    Runner の呼び出し
runner/src/
  server.ts    POST /v1/turn
  agent.ts     Claude Code の実行とイベントの変換
  sync.ts      セッションフォルダ ⇔ /sandbox の同期
  storage.ts   GCS（セッション限定トークン）/ ローカルのオブジェクト操作
  packages.ts  npm / PyPI ミラーの設定
  processes.ts ターン終了時の残存プロセスの停止
infra/terraform/                Cloud Run ×2、VPC・ファイアウォール・DNS、GCS、Firestore、IAM、パッケージミラー
integrations/ultra-light-chat/  ultra-light-chat 用アダプタ
scripts/deploy.sh               ビルドとデプロイ
docker-compose.yml              ローカル開発用
```
