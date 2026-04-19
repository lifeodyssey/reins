/**
 * UI: mission-control HTML/CSS/JS served as a single string.
 * Connects to the server via WebSocket for real-time streaming.
 * Uses safe DOM methods (createElement + textContent) instead of innerHTML.
 */

export const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reins \u2014 Sprint Orchestrator</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); height: 100vh; display: flex; flex-direction: column; }

  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-size: 16px; font-weight: 600; white-space: nowrap; }
  header select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; flex: 1; max-width: 240px; }
  header .actions { display: flex; gap: 6px; margin-left: auto; }
  header button { background: var(--surface); color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  header button:hover { color: var(--text); border-color: var(--accent); }
  header button.stop { color: var(--red); }
  header button.stop:hover { border-color: var(--red); }
  .conn { width: 8px; height: 8px; border-radius: 50%; background: var(--red); }
  .conn.ok { background: var(--green); }

  main { flex: 1; display: flex; overflow: hidden; }
  .chat-panel { flex: 3; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  .side-panel { flex: 1; min-width: 260px; max-width: 360px; display: flex; flex-direction: column; overflow: hidden; }

  .tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--surface); }
  .tabs button { background: none; border: none; color: var(--muted); padding: 8px 14px; font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; flex: 1; overflow: auto; padding: 12px; font-size: 13px; line-height: 1.5; }
  .tab-content.active { display: block; }

  #chat-log { flex: 1; overflow-y: auto; padding: 12px; }
  .msg { margin-bottom: 12px; max-width: 90%; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { margin-left: auto; background: #1f3a5f; border-radius: 12px 12px 4px 12px; padding: 8px 12px; }
  .msg.assistant { background: var(--surface); border-radius: 12px 12px 12px 4px; padding: 8px 12px; border: 1px solid var(--border); }
  .msg pre { background: var(--bg); border-radius: 4px; padding: 8px; overflow-x: auto; font-family: var(--mono); font-size: 12px; margin: 6px 0; }
  .msg code { font-family: var(--mono); font-size: 12px; background: var(--bg); padding: 1px 4px; border-radius: 3px; }
  .msg strong { font-weight: 600; }

  .input-bar { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface); }
  .input-bar input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; }
  .input-bar input:focus { border-color: var(--accent); }
  .input-bar button { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; }

  .side-panel .section { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .side-panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 6px; }
  #status-table { font-size: 12px; font-family: var(--mono); white-space: pre-wrap; color: var(--muted); }
  #timeline { font-size: 12px; font-family: var(--mono); white-space: pre-wrap; color: var(--muted); max-height: 300px; overflow-y: auto; }
  #board { font-size: 12px; font-family: var(--mono); white-space: pre-wrap; }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>
<header>
  <span class="conn" id="conn"></span>
  <h1>Reins</h1>
  <select id="mode">
    <option value="orchestrator">Orchestrator</option>
    <option value="Executor">Executor</option>
    <option value="Reviewer">Reviewer</option>
    <option value="Tester">Tester</option>
    <option value="Planner">Planner</option>
    <option value="Designer">Designer</option>
  </select>
  <div class="actions">
    <button class="stop" id="btn-interrupt">Stop</button>
    <button id="btn-close">Close</button>
    <button id="btn-reset">Reset</button>
  </div>
</header>

<main>
  <div class="chat-panel">
    <div class="tabs">
      <button class="active" data-tab="chat">Chat</button>
      <button data-tab="board">Sprint Board</button>
    </div>
    <div id="tab-chat" class="tab-content active">
      <div id="chat-log"></div>
    </div>
    <div id="tab-board" class="tab-content">
      <pre id="board">No active sprint.</pre>
    </div>
    <div class="input-bar">
      <input id="msg-input" type="text" placeholder="Talk to Orchestrator..." autocomplete="off" />
      <button id="btn-send">Send</button>
    </div>
  </div>

  <div class="side-panel">
    <div class="section" style="flex:1;overflow:auto;">
      <h3>Agent Status</h3>
      <div id="status-table">No agents active.</div>
    </div>
    <div class="section" style="flex:1;overflow:auto;">
      <h3>Timeline</h3>
      <div id="timeline">No events yet.</div>
    </div>
  </div>
</main>

<script>
(function() {
  var chatLog = document.getElementById("chat-log");
  var input = document.getElementById("msg-input");
  var modeSelect = document.getElementById("mode");
  var connDot = document.getElementById("conn");

  var ws;
  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");
    ws.onopen = function() { connDot.classList.add("ok"); };
    ws.onclose = function() { connDot.classList.remove("ok"); setTimeout(connect, 2000); };
    ws.onerror = function() { ws.close(); };
    ws.onmessage = function(ev) {
      var data = JSON.parse(ev.data);
      if (data.type === "history") renderHistory(data.history);
      if (data.type === "status") document.getElementById("status-table").textContent = data.status;
      if (data.type === "timeline") document.getElementById("timeline").textContent = data.timeline;
      if (data.type === "board") document.getElementById("board").textContent = data.board;
      if (data.type === "full") {
        renderHistory(data.history);
        document.getElementById("status-table").textContent = data.status;
        document.getElementById("timeline").textContent = data.timeline;
        document.getElementById("board").textContent = data.board;
      }
    };
  }
  connect();

  /** Render chat history using safe DOM methods (no innerHTML). */
  function renderHistory(history) {
    // Clear chat log safely
    while (chatLog.firstChild) chatLog.removeChild(chatLog.firstChild);

    for (var i = 0; i < history.length; i++) {
      var msg = history[i];
      var div = document.createElement("div");
      div.className = "msg " + msg.role;
      // Parse content into safe DOM nodes
      appendParsedContent(div, msg.content);
      chatLog.appendChild(div);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  /** Parse markdown-like content into DOM nodes safely. */
  function appendParsedContent(parent, text) {
    var lines = text.split("\\n");
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) parent.appendChild(document.createElement("br"));
      // Check for code block start
      if (lines[i].match(/^\`\`\`/)) {
        var codeLines = [];
        i++; // skip opening fence
        while (i < lines.length && !lines[i].match(/^\`\`\`/)) {
          codeLines.push(lines[i]);
          i++;
        }
        var pre = document.createElement("pre");
        pre.textContent = codeLines.join("\\n");
        parent.appendChild(pre);
        continue;
      }
      appendInlineContent(parent, lines[i]);
    }
  }

  /** Parse inline markdown (bold, code) into DOM nodes safely. */
  function appendInlineContent(parent, text) {
    // Split by **bold** and \`code\` patterns
    var parts = text.split(/(\\*\\*[^*]+\\*\\*|\`[^\`]+\`)/);
    for (var j = 0; j < parts.length; j++) {
      var part = parts[j];
      if (!part) continue;
      if (part.match(/^\\*\\*(.+)\\*\\*$/)) {
        var strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        parent.appendChild(strong);
      } else if (part.match(/^\`(.+)\`$/)) {
        var code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  function send(type, extra) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type: type }, extra || {})));
  }

  document.getElementById("btn-send").onclick = function() {
    var text = input.value.trim();
    if (!text) return;
    send("chat", { message: text, mode: modeSelect.value });
    input.value = "";
  };
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("btn-send").click(); }
  });

  document.getElementById("btn-interrupt").onclick = function() { send("interrupt", { mode: modeSelect.value }); };
  document.getElementById("btn-close").onclick = function() { send("close", { mode: modeSelect.value }); };
  document.getElementById("btn-reset").onclick = function() { send("reset"); };

  modeSelect.onchange = function() {
    send("switch_mode", { mode: modeSelect.value });
    input.placeholder = modeSelect.value === "orchestrator" ? "Talk to Orchestrator..." : "Talk to " + modeSelect.value + "...";
  };

  // Tabs
  var tabBtns = document.querySelectorAll(".tabs button");
  for (var t = 0; t < tabBtns.length; t++) {
    tabBtns[t].onclick = function() {
      for (var b = 0; b < tabBtns.length; b++) tabBtns[b].classList.remove("active");
      var tabs = document.querySelectorAll(".tab-content");
      for (var c = 0; c < tabs.length; c++) tabs[c].classList.remove("active");
      this.classList.add("active");
      document.getElementById("tab-" + this.dataset.tab).classList.add("active");
    };
  }
})();
</script>
</body>
</html>`;
