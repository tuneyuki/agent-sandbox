// シンプルなチャット UI。Gateway の /api を叩き、SSE（fetch ストリーム）で応答を描画する。

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const sessionsEl = $("#sessions");
const input = $("#input");
const sendBtn = $("#send");
const stopBtn = $("#stop");

let currentId = null;
let controller = null;

function token() {
  try { return localStorage.getItem("apiToken") || ""; } catch { return ""; }
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    alert("認証エラーです。API トークンを設定してください。");
    throw new Error("unauthorized");
  }
  return res;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return input.command ?? "";
  return input.file_path ?? input.pattern ?? input.url ?? input.query ?? "";
}

/** assistant 1 ターン分の描画器。イベントを順に受け取って DOM を組み立てる。 */
function assistantView() {
  const root = el("div", "msg assistant");
  messagesEl.appendChild(root);
  const tools = new Map();
  return {
    root,
    push(ev) {
      switch (ev.type) {
        case "text":
          root.appendChild(el("div", "text", ev.text));
          break;
        case "tool_use": {
          const d = el("details", "tool");
          const s = el("summary", "", `🔧 ${ev.name} ${summarizeToolInput(ev.name, ev.input)}`.trim());
          d.appendChild(s);
          d.appendChild(el("pre", "", JSON.stringify(ev.input, null, 2)));
          root.appendChild(d);
          tools.set(ev.id, d);
          break;
        }
        case "tool_result": {
          const d = tools.get(ev.toolUseId);
          if (d) {
            if (ev.isError) d.classList.add("err");
            d.appendChild(el("pre", "", ev.content));
          }
          break;
        }
        case "result":
          root.appendChild(
            el("div", "meta",
              `${ev.ok ? "✓" : "⚠ " + ev.subtype} · ${ev.numTurns} turns · ${(ev.durationMs / 1000).toFixed(1)}s · $${Number(ev.costUsd).toFixed(4)} (累計)`),
          );
          break;
        case "error":
          root.appendChild(el("div", "error", `エラー: ${ev.message}`));
          break;
      }
      scrollBottom();
    },
  };
}

function renderMessages(messages) {
  messagesEl.replaceChildren();
  if (!messages.length) {
    messagesEl.appendChild(el("p", "empty", "メッセージを送ると、サンドボックス内の Claude Code が作業します。"));
  }
  for (const m of messages) {
    if (m.role === "user") messagesEl.appendChild(el("div", "msg user", m.text));
    else {
      const v = assistantView();
      for (const ev of m.events ?? [{ type: "text", text: m.text }]) v.push(ev);
    }
  }
  scrollBottom();
}

async function loadSessions() {
  const res = await api("/sessions");
  const list = await res.json();
  sessionsEl.replaceChildren();
  for (const s of list) {
    const li = el("li", s.id === currentId ? "active" : "", s.title);
    li.onclick = () => openSession(s.id);
    sessionsEl.appendChild(li);
  }
}

async function openSession(id) {
  currentId = id;
  const res = await api(`/sessions/${id}`);
  if (!res.ok) return;
  const { messages } = await res.json();
  renderMessages(messages);
  loadSessions();
}

async function ensureSession(firstText) {
  if (currentId) return currentId;
  const res = await api("/sessions", {
    method: "POST",
    body: JSON.stringify({ title: firstText.slice(0, 40) }),
  });
  const s = await res.json();
  currentId = s.id;
  messagesEl.replaceChildren();
  loadSessions();
  return currentId;
}

function setRunning(running) {
  sendBtn.disabled = running;
  input.disabled = running;
  stopBtn.hidden = !running;
}

async function send(text) {
  const id = await ensureSession(text);
  messagesEl.querySelector(".empty")?.remove();
  messagesEl.appendChild(el("div", "msg user", text));
  const view = assistantView();
  setRunning(true);
  controller = new AbortController();

  try {
    const res = await api(`/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      view.push({ type: "error", message: body.error ?? res.statusText });
      return;
    }
    // SSE をパース
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type !== "session" && ev.type !== "done") view.push(ev);
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") view.push({ type: "error", message: String(err) });
    else view.push({ type: "error", message: "停止しました" });
  } finally {
    setRunning(false);
    controller = null;
    input.focus();
    loadSessions();
  }
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#composer").requestSubmit();
});
stopBtn.onclick = () => controller?.abort();
$("#new-chat").onclick = () => {
  currentId = null;
  renderMessages([]);
  loadSessions();
};
$("#set-token").onclick = () => {
  const t = prompt("API トークン (AUTH_MODE=token のとき)", token());
  if (t !== null) {
    try { localStorage.setItem("apiToken", t); } catch {}
    loadSessions();
  }
};

loadSessions().catch(() => {});
