# ultra-light-chat との接続

[ultra-light-chat](https://github.com/tuneyuki/ultra-light-chat) のサーバー側（SvelteKit の `/api/chat`）に「sandbox」プロバイダーを 1 つ足すだけで繋がります。ブラウザは Agent Sandbox を直接呼びません。

```
Browser ──▶ ultra-light-chat /api/chat ──(sandbox.js)──▶ Agent Sandbox Gateway /v1/...
```

## 1. アダプタを置く

`sandbox.js` を `src/routes/api/chat/sandbox.js` にコピーします。

## 2. 環境変数

| 変数 | 説明 |
|---|---|
| `SANDBOX_API_URL` | Gateway の URL（例: `https://agent-sandbox-gateway-xxxx.a.run.app`） |
| `SANDBOX_API_TOKEN` | `auth_mode=token` のときのトークン。未設定なら Cloud Run のメタデータサーバーから ID トークンを取る（`auth_mode=iam`） |

## 3. 差分

`src/routes/api/chat/utils.js`
```js
export function getProvider(modelId) {
    if (modelId.startsWith('sandbox:')) return 'sandbox';
    if (modelId.startsWith('gemini-')) return 'gemini';
    return 'openai';
}
```

`src/routes/api/chat/+server.js`
```js
import { handleSandbox } from './sandbox.js';
// ...
if (provider === 'sandbox') {
    return handleSandbox(resolvedModel, input, chat_id, system_prompt, reasoning_effort, userId);
}
```

`src/lib/models.js`（`MODELS` に追加。`provider` の型にも `'sandbox'` を足す）
```js
{ id: 'sandbox:claude-opus-5-5', label: 'Claude Code (Sandbox)', provider: 'sandbox', supportsImage: true, supportsImageGen: false, supportsCodeInterpreter: false, supportsWebSearch: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
```

`src/routes/api/files/[fileId]/+server.js`（先頭に追加。エージェントが作ったファイルのダウンロード）
```js
import { sandboxFetch, fromFileId } from '../../chat/sandbox.js';
// GET の先頭で:
if (params.fileId.startsWith('sbx_') && containerId) {
    const p = fromFileId(params.fileId).split('/').map(encodeURIComponent).join('/');
    const userId = request.headers.get('x-ms-client-principal-name');
    const up = await sandboxFetch(`/v1/sessions/${containerId}/files/${p}`, {}, userId);
    return new Response(up.body, { status: up.status, headers: {
        'Content-Type': up.headers.get('Content-Type') || 'application/octet-stream',
        'Content-Disposition': up.headers.get('Content-Disposition') || 'attachment'
    }});
}
```
（`GET({ params, url, request })` のように `request` も受け取る）

## 対応関係

| ultra-light-chat | Agent Sandbox |
|---|---|
| `chat_id` | `session_id`（初回に自動作成） |
| 添付ファイル・画像 | `workspace/uploads/` に保存され、エージェントに場所が伝わる |
| テキストのストリーミング | `text_delta` |
| コード / 実行結果の表示 | `tool_use` / `tool_result` |
| 出力ファイル | `files_changed`（エージェントが作成・変更したファイル） |

ターンは接続から切り離されているので、途中で上流の接続が切れても（長い作業で 60 分を超えた場合など）、アダプタが `Last-Event-ID` を付けて `/turns/:turnId/events` に自動で再接続し、続きをそのままブラウザに流します。
