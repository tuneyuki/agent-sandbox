// ultra-light-chat 用アダプタ: src/routes/api/chat/sandbox.js に置く。
// Agent Sandbox の SSE を ultra-light-chat の SSE 形式に変換する。
//
//   ultra-light-chat                         Agent Sandbox
//   chat_id                         ⇔        session_id（無ければ作成）
//   input / input_file / input_image  →       input + files（workspace/uploads/ に保存）
//   response.output_text.delta       ←        text_delta
//   status / code_delta / code_output ←       tool_use / tool_result
//   output_file                      ←        files_changed（file_id = "sbx_" + base64url(path)）
import { env } from '$env/dynamic/private';
import { createSSEResponse } from './utils.js';

const BASE = () => (env.SANDBOX_API_URL || '').replace(/\/$/, '');

/** 認証ヘッダー: SANDBOX_API_TOKEN があれば Bearer、無ければ Cloud Run 上の ID トークン（iam モード） */
async function authHeaders() {
	if (env.SANDBOX_API_TOKEN) return { Authorization: `Bearer ${env.SANDBOX_API_TOKEN}` };
	const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(BASE())}`;
	const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
	if (!res.ok) throw new Error('failed to get ID token (set SANDBOX_API_TOKEN when not running on GCP)');
	return { Authorization: `Bearer ${await res.text()}` };
}

/** @param {string} path @param {RequestInit} [init] @param {string | null} [userId] */
export async function sandboxFetch(path, init = {}, userId = null) {
	return fetch(`${BASE()}${path}`, {
		...init,
		headers: {
			...(await authHeaders()),
			...(userId ? { 'x-user-id': userId } : {}),
			...(init.headers || {})
		}
	});
}

/** workspace 内パス ⇔ フロントの file_id */
export const toFileId = (/** @type {string} */ p) => 'sbx_' + Buffer.from(p).toString('base64url');
export const fromFileId = (/** @type {string} */ id) => Buffer.from(id.slice(4), 'base64url').toString();

/** 実行中（または直近）のターン ID */
async function latestTurnId(/** @type {string} */ sessionId, /** @type {string | null} */ userId) {
	const res = await sandboxFetch(`/v1/sessions/${sessionId}/turns`, {}, userId);
	if (!res.ok) return null;
	const turns = await res.json();
	return turns.length ? turns[turns.length - 1].id : null;
}

/** ultra-light-chat の input を { text, files } に変換 */
function convertInput(/** @type {any} */ input) {
	if (typeof input === 'string') return { text: input, files: [] };
	const files = [];
	const texts = [];
	let n = 0;
	for (const msg of input ?? []) {
		for (const c of msg.content ?? []) {
			if (c.type === 'input_text') texts.push(c.text);
			else if (c.type === 'input_file') files.push({ filename: c.filename, data: c.file_data });
			else if (c.type === 'input_image') {
				const ext = /^data:image\/(\w+)/.exec(c.image_url)?.[1] ?? 'png';
				files.push({ filename: `image-${Date.now()}-${++n}.${ext}`, data: c.image_url });
			}
		}
	}
	return { text: texts.join('\n'), files };
}

/**
 * @param {string} model  例: "sandbox:claude-opus-5-5"
 * @param {any} input
 * @param {string | null} chatId
 * @param {string | undefined} systemPrompt
 * @param {string | undefined} reasoningEffort
 * @param {string | null} userId
 */
export async function handleSandbox(model, input, chatId, systemPrompt, reasoningEffort, userId) {
	let sessionId = chatId;
	if (!sessionId) {
		const r = await sandboxFetch('/v1/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: typeof input === 'string' ? input.slice(0, 60) : 'chat' })
		}, userId);
		if (!r.ok) return new Response(await r.text(), { status: r.status });
		sessionId = (await r.json()).id;
	}

	const { text, files } = convertInput(input);
	const upstream = await sandboxFetch(`/v1/sessions/${sessionId}/messages`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			input: text,
			files,
			model: model.replace(/^sandbox:/, ''),
			effort: reasoningEffort,
			system_prompt: systemPrompt
		})
	}, userId);
	if (!upstream.ok || !upstream.body) {
		return new Response(await upstream.text(), { status: upstream.status });
	}

	const encoder = new TextEncoder();
	const send = (/** @type {ReadableStreamDefaultController} */ c, /** @type {any} */ obj) =>
		c.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

	let turnId = /** @type {string | null} */ (null);

	/** Agent Sandbox のイベントを ultra-light-chat の形式に変換して流す。done なら true */
	const forward = (/** @type {ReadableStreamDefaultController} */ controller, /** @type {any} */ ev) => {
		switch (ev.type) {
			case 'session':
				turnId = ev.turn_id;
				break;
			case 'text_delta':
				send(controller, { type: 'response.output_text.delta', delta: ev.delta });
				break;
			case 'status':
				send(controller, { type: 'status', status: `sandbox.${ev.status}` });
				break;
			case 'tool_use':
				send(controller, { type: 'status', status: `tool.${ev.name}` });
				send(controller, {
					type: 'code_delta',
					delta: `\n# ${ev.name}\n${ev.name === 'Bash' ? ev.input?.command : JSON.stringify(ev.input, null, 2)}\n`
				});
				break;
			case 'tool_result':
				send(controller, { type: 'code_output', output: ev.content });
				break;
			case 'files_changed':
				for (const f of [...ev.added, ...ev.modified]) {
					send(controller, {
						type: 'output_file',
						file_id: toFileId(f.path),
						filename: f.path,
						mime_type: 'application/octet-stream',
						container_id: sessionId
					});
				}
				break;
			case 'error':
				send(controller, { type: 'response.output_text.delta', delta: `\n\n⚠️ ${ev.message}` });
				break;
			case 'done':
				return true;
		}
		return false;
	};

	/** SSE を読み、最後に受け取ったイベント ID と done の有無を返す */
	const pump = async (/** @type {Response} */ res, /** @type {ReadableStreamDefaultController} */ controller, /** @type {number} */ lastId) => {
		const reader = /** @type {ReadableStream} */ (res.body).getReader();
		const decoder = new TextDecoder();
		let buf = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return { lastId, finished: false };
			buf += decoder.decode(value, { stream: true });
			let i;
			while ((i = buf.indexOf('\n\n')) >= 0) {
				const chunk = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const id = /^id: (\d+)$/m.exec(chunk)?.[1];
				const data = /^data: (.*)$/m.exec(chunk)?.[1];
				if (id) lastId = Number(id);
				if (data && forward(controller, JSON.parse(data))) return { lastId, finished: true };
			}
		}
	};

	const stream = new ReadableStream({
		async start(controller) {
			send(controller, { chat_id: sessionId });
			try {
				let { lastId, finished } = await pump(upstream, controller, 0);
				// 接続が切れても（長いターンなど）ターンは続いているので、続きから受け取り直す
				for (let retry = 0; !finished && retry < 100; retry++) {
					turnId ??= await latestTurnId(sessionId, userId);
					if (!turnId) break;
					await new Promise((r) => setTimeout(r, 1000));
					const res = await sandboxFetch(`/v1/sessions/${sessionId}/turns/${turnId}/events`, {
						headers: { 'Last-Event-ID': String(lastId) }
					}, userId);
					if (!res.ok || !res.body) break;
					({ lastId, finished } = await pump(res, controller, lastId));
				}
			} catch (e) {
				send(controller, { type: 'response.output_text.delta', delta: `\n\n⚠️ ${e}` });
			} finally {
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			}
		}
	});
	return createSSEResponse(stream);
}
