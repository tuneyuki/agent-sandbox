# Agent Sandbox on GCP

API で指示とファイルを渡すと、GCP 上の隔離された環境で **Claude Code**（[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)）が作業し、その様子をストリーミングで返し、成果物をファイルとして残す API サーバーです。チャットボット（例: [ultra-light-chat](https://github.com/tuneyuki/ultra-light-chat)）のバックエンドから呼ぶことを想定しています。

## 構成の考え方

「計算する場所」と「状態を置く場所」を分けています。

| 概念 | 実体 | 寿命 |
|---|---|---|
| **セッション**（= 1 つのチャット） | Firestore の `sessions/{id}` + GCS の `sessions/{id}/` フォルダ | ユーザーが消すまで（ファイルは既定 30 日） |
| **ターン**（= ユーザーの 1 メッセージ） | Firestore の `sessions/{id}/turns/{turnId}` | セッションと同じ |
| **サンドボックス**（Claude Code が動く場所） | Runner = **Cloud Run Jobs の 1 実行** | **1 ターンの間だけ借りる** |

Runner は状態を持ちません。ターンのたびに「セッションフォルダを展開 → Claude Code 実行 → 差分を書き戻す → 消す」を行うので、どの実行でも同じセッションの続きができます。

ターンは HTTP 接続から切り離されています。Gateway はメッセージを受けると **Cloud Run Jobs の実行を 1 つ起動** するだけで、Runner は進捗を Gateway に報告し、Gateway がそれを Firestore に書きます。クライアントは Firestore に溜まったイベントを SSE で受け取るので、接続が切れても作業は止まらず、`Last-Event-ID` で続きから受け取り直せます。

```
 チャットボットのバックエンド
        │ ① POST /messages        ⑤ SSE（Last-Event-ID で再開可）
        ▼                          ▲
 ┌──────────────────────────────────┴┐  ② ジョブ実行   ┌────────────────────────────────────────┐
 │ Gateway (Cloud Run)                │───────────────▶│ Runner (Cloud Run Jobs, 1 実行 = 1 ターン) │
 │ ・認証（IAM / Bearer）              │                │  sessions/{id}/ を展開 → Claude Code 実行  │
 │ ・セッション/ターン/イベント管理       │◀───────────────│  → 変更を書き戻し → 終了                    │
 │ ・ファイル API                      │ ③ 進捗報告       └──────┬───────────────────────┬─────────┘
 │ ・セッション限定トークン発行          │ （ターン専用トークン）    │ sessions/{id}/ 限定トークン │
 └──────┬─────────────────┬──────────┘                       ▼                         ▼
   ④ 書き込み│                 │                        GCS バケット（1 つ）         Vertex AI (Claude)
        ▼                 └──────────────────────────────▶
   Firestore
```

### 状態の置き場所

**Firestore**（メタデータ・実行状態）

```
sessions/{sessionId}
  owner            x-user-id（エンドユーザー）
  title
  status           idle | running
  activeTurnId     実行中のターン
  lockedUntil      実行中ロックの期限。Runner の生存報告（20 秒ごと）で延長される
  claudeSessionId  Claude Code 側の会話 ID（resume 用、外には出さない）
  turnCount, totalCostUsd, createdAt, updatedAt
sessions/{sessionId}/turns/{turnId}
  input, attachments[], options
  status           queued | running | completed | failed | aborted
  text             最終回答
  filesChanged     { added, modified, deleted, deps }
  cancelRequested  中断要求
  tokenHash        Runner 認証用トークンのハッシュ
  costUsd, error, lastSeq, startedAt, finishedAt
sessions/{sessionId}/turns/{turnId}/events/{seq}
  seq, type, json  イベント本体（SSE で流すもの。連番で再開できる）
```

Runner が異常終了して生存報告が 3 分途絶えると、そのターンは `failed`（`runner stopped responding`）になり、ロックが外れます。

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
- Runner には Firestore の権限もありません。進捗報告は Gateway の `/internal` API に、**そのターン専用のトークン**（ハッシュだけを Firestore に保存）で送ります。ターンが終わるとトークンは使えなくなります。

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

**実行**: ターンの中で、ビルドとテストに加えて Web サーバーの起動もできます（バックグラウンドで起動し、`curl` で確認する）。ターンが終わると、エージェントが起動したプロセスはすべて停止します。

```bash
curl -N -XPOST $URL/v1/sessions/$SID/messages "${H[@]}" -H 'content-type: application/json' -d '{
  "input": "FastAPI で TODO API を作って、pytest でテストし、uvicorn で起動して curl で確認して"
}'
```

## Web 検索（Gemini の Google Search grounding）

サンドボックスはインターネットに出られませんが、**Web を調べる能力だけ** は Gemini の Google Search grounding で渡しています。

- Claude Code に `mcp__web__google_search` というツールを追加します（Runner のプロセス内で動く MCP ツール）。
- ツールは Vertex AI の Gemini に `tools: [{ googleSearch: {} }]` 付きで問い合わせ、検索結果に基づく回答と出典 URL を返します。
- Vertex AI には Private Google Access で届くので、サンドボックスから任意のサイトに接続することはありません。検索は Google 側で行われます。
- 有効なときは Claude Code 標準の `WebSearch` / `WebFetch` を無効にします（`WebFetch` はサンドボックス内から URL を取りに行くため、そもそも使えない）。
- URL を指定してページを読む機能（Gemini の URL context）は付けていません。任意の URL へのリクエスト経路になるためです。
- 1 ターンあたりの検索回数に上限があります（`GROUNDING_MAX_CALLS`、既定 20）。Grounding with Google Search は Gemini の利用料とは別に課金されます。

| 変数（Terraform） | 既定値 | 説明 |
|---|---|---|
| `gemini_grounding` | `true` | 有効にするか |
| `grounding_model` | `gemini-2.5-flash` | 使う Gemini のモデル（プロジェクトで使えるものを指定する） |
| `grounding_location` | `global` | Vertex AI のロケーション |

ローカル開発では `GEMINI_API_KEY` を渡すと、Vertex AI の代わりに Gemini API を使います。

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

`files`・`model`・`effort`・`system_prompt` は省略できます。`model` は `ALLOWED_MODELS` に含まれるものだけ有効です。

応答には 2 つのモードがあります。どちらでもターンは裏で進み、**接続を切っても止まりません**。

- **ストリーミング（既定）**: `text/event-stream` でイベントを流す。最初に `session` イベント（`turn_id` 入り）が来る。
- **非同期**: `"async": true` を付けると、すぐに `202 { session_id, turn_id, events_url, turn_url }` を返す。

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/v1/sessions/:id/turns` | ターン一覧 |
| `GET` | `/v1/sessions/:id/turns/:turnId` | ターンの状態（`status`, `text`, `filesChanged`, `costUsd` …） |
| `GET` | `/v1/sessions/:id/turns/:turnId/events` | イベントの SSE。`Last-Event-ID` ヘッダーか `?after=<seq>` で続きから。`?stream=false` なら JSON 配列で返す |
| `POST` | `/v1/sessions/:id/turns/:turnId/cancel` | 中断（20 秒以内に止まり、`aborted` になる） |

SSE の各イベントには `id: <seq>` が付きます。`done` が届いたらそのターンは終わりです。それより前に接続が切れたら（長いターンでは Gateway の 1 接続の上限 60 分で切れる）、最後に受け取った `id` を `Last-Event-ID` にして `events` を呼び直してください。ブラウザの `EventSource` なら自動で再接続されます。

| type | 内容 |
|---|---|
| `session` | `session_id`, `turn_id`, `attachments`, `events_url`（ストリーミングモードの最初だけ。`id` なし） |
| `status` | `restoring` / `running` / `saving` |
| `text_delta` | 回答テキストの差分（チャット表示用） |
| `text` | 確定したテキストブロック |
| `tool_use` | `id`, `name`（Bash / Write / Read …）, `input` |
| `tool_result` | `toolUseId`, `isError`, `content`（4000 文字まで） |
| `result` | `ok`, `numTurns`, `durationMs`, `costUsd`（セッション累計の推定値） |
| `files_changed` | `added` / `modified`（`path`, `size`, `url`）, `deleted`, `deps` |
| `error` | `message` |
| `done` | `turn_id`, `status`（`completed` / `failed` / `aborted`）, `error`, `cost_usd`（このターンの分）。ストリーム終了 |

同じセッションで同時に 2 ターンは走りません（2 つ目は 409）。全体の同時実行数が `max_running_turns` に達していると 429 を返します。

### 時間の上限

| 制限 | 既定値 | 変更方法 |
|---|---|---|
| 1 ターンの実行時間 | 30 分 | `turn_timeout_seconds`（最大 85500 秒 ≒ 23.75 時間。Cloud Run Jobs の上限 24 時間から、復元・保存用の 15 分を引いた値） |
| 1 コマンド（Bash 1 回） | 既定 10 分 / 最大 30 分 | Runner の `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` |
| SSE の 1 接続 | 60 分 | Cloud Run の上限。再接続で続きを受け取る |
| 1 ターン内でのやり取りの往復回数 | 50 | `max_agent_turns` |

上限を超えたターンは `aborted`（`timeout`）になりますが、そこまでのファイルと依存は保存されます。「続けて」と送れば会話の続きとして再開できます。

```bash
H=(-H "x-user-id: alice" -H "authorization: Bearer $TOKEN")   # iam モードなら ID トークン
SID=$(curl -s -XPOST $URL/v1/sessions "${H[@]}" | jq -r .id)
curl -XPUT $URL/v1/sessions/$SID/files/data/sales.csv "${H[@]}" --data-binary @sales.csv

# ストリーミング
curl -N -XPOST $URL/v1/sessions/$SID/messages "${H[@]}" -H 'content-type: application/json' \
  -d '{"input":"data/sales.csv を月別に集計して report.md にまとめて"}'

# 非同期（長い作業向け）
TID=$(curl -s -XPOST $URL/v1/sessions/$SID/messages "${H[@]}" -H 'content-type: application/json' \
  -d '{"input":"テストが全部通るまで直して","async":true}' | jq -r .turn_id)
curl -N $URL/v1/sessions/$SID/turns/$TID/events "${H[@]}"                        # 進捗を見る
curl -N $URL/v1/sessions/$SID/turns/$TID/events "${H[@]}" -H 'Last-Event-ID: 42'  # 続きから
curl -s $URL/v1/sessions/$SID/turns/$TID "${H[@]}" | jq .status                   # 状態だけ
curl -XPOST $URL/v1/sessions/$SID/turns/$TID/cancel "${H[@]}"                     # 中断

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
| `turn_timeout_seconds` | `1800` | 1 ターンの上限（最大 85500） |
| `max_running_turns` | `10` | 全セッション合計で同時に実行するターン数（コストの歯止め。0 で無制限） |
| `runner_cpu` / `runner_memory` | `4` / `8Gi` | サンドボックス 1 つあたりのリソース（Cloud Run のディスクはメモリ上にあるので、`node_modules` などもメモリを使う） |
| `state_retention_days` | `30` | GCS 上のセッションフォルダの保持期間 |

## セキュリティ

Claude Code の操作を承認する人がいないので、「何をされても被害が限られる」ことを環境側で担保しています。

- **コンテナ**: Runner は Cloud Run Jobs（gen2）。1 実行 = 1 ターンで、終わればコンテナごと消える。非 root で実行する。バックグラウンド実行は無効（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`）。
- **ネットワーク**: Runner の通信はすべて VPC を通り、既定では Private Google Access（Vertex AI・GCS・Artifact Registry のパッケージミラー）以外への外向き通信を拒否する。
- **プロセス**: ターンの最後に、エージェントが起動して残したプロセスを止める（環境変数の印と cwd で判別）。
- **権限**: Runner の SA は Vertex AI の利用権限と、パッケージミラーの読み取り権限だけ。GCS はセッション限定トークン経由でしか触れない。API キーもサンドボックス内に置かない（Vertex AI を SA で呼ぶ）。
- **ツール**: `permissionMode: "dontAsk"` + `allowedTools`。許可リスト外のツールは自動で拒否する。`settingSources: []` で外部の設定ファイルを読まない。
- **Runner の起動**: ジョブを実行できるのは Gateway の SA だけ（`roles/run.jobsExecutorWithOverrides`）。
- **進捗報告**: Runner → Gateway はターン専用トークンで認証し、`iam` モードでは加えて Runner の SA の ID トークンも要る。ターン専用トークンはジョブ実行の環境変数で渡すため、プロジェクトでジョブ実行の詳細を見られる人には見える（有効なのはそのターンの実行中だけ）。

### 既知の制約

- `runner_internet_access=true` にすると、エージェントは任意のサイトと通信できる（データ持ち出しのリスク）。必要なら Secure Web Proxy などで行き先を絞る。
- 毎ターン、ワークスペース全体と依存アーカイブを展開するので、大きなファイル（数百 MB 以上）を多数置く用途には向かない。依存アーカイブの上限は 2 GB（`MAX_DEPS_BYTES`）。
- パッケージミラーは npm と PyPI だけ。`git clone` や、任意の URL からのダウンロード（`curl https://...`、Playwright のブラウザ取得など）は `runner_internet_access=true` にしないとできない。
- ミラーのパッケージにはマルウェア対策がかからない（公開レジストリの中身をそのまま取る）。被害はサンドボックスと、そのセッションのフォルダの中に限られる。
- 作ったアプリをユーザーがブラウザで直接触る（プレビュー URL を出す）ことはできない。ターンが終わるとサーバーは止まる。必要なら Runner を GKE Sandbox（gVisor）の「セッションごとに Pod」構成に差し替える。Gateway・API・保存形式はそのまま使える。
- `costUsd` は SDK の推定値で、請求額ではない（Gemini の grounding の費用も含まない）。
- Runner の SA は Vertex AI を呼べる（Claude を使うために必要）。そのため、エージェントが Bash からメタデータサーバーのトークンを使って Gemini を直接呼び、URL context などのツールで Google 側から任意の URL にアクセスさせることは、理屈の上ではできてしまう（データ持ち出しの経路になり得る）。これは grounding ツールの有無に関係なく、Runner に Vertex AI の権限を与えている時点で存在する。塞ぐには、Runner の SA が呼べるモデルを Anthropic のモデルだけに絞る必要がある（IAM の条件などで実現できるかは要検証）。その場合、Gemini の呼び出しは Gateway 経由に移す。
- ジョブの起動に毎回数秒〜十数秒かかる（Cloud Run Jobs のコンテナ起動）。短い質問でも、最初の応答まで少し待つ。

## ディレクトリ構成

```
gateway/src/
  server.ts    API ルーティング・認証・SSE
  store.ts     Firestore（sessions / turns / events）、ローカル用のメモリ実装
  storage.ts   セッションフォルダの読み書き、セッション限定トークンの発行
  executor.ts  ターンの起動（Cloud Run Jobs / ローカル）
runner/src/
  server.ts    エントリポイント（ジョブとして 1 ターン実行 / ローカルでは簡易サーバー）
  job.ts       1 ターンの流れ（復元 → 実行 → 保存 → 報告）
  callback.ts  Gateway への進捗報告
  agent.ts     Claude Code の実行とイベントの変換
  sync.ts      セッションフォルダ ⇔ /sandbox の同期
  storage.ts   GCS（セッション限定トークン）/ ローカルのオブジェクト操作
  packages.ts  npm / PyPI ミラーの設定
  grounding.ts Gemini の Google Search grounding ツール
  processes.ts ターン終了時の残存プロセスの停止
infra/terraform/                Cloud Run（Gateway）+ Cloud Run Jobs（Runner）、VPC・ファイアウォール・DNS、GCS、Firestore、IAM、パッケージミラー
integrations/ultra-light-chat/  ultra-light-chat 用アダプタ
scripts/deploy.sh               ビルドとデプロイ
docker-compose.yml              ローカル開発用
```
