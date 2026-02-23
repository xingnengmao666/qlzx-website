/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │          HTTP Time Server  —  Cloudflare Worker                 │
 * │                                                                 │
 * │  GET  /api/time          →  JSON 时间数据                       │
 * │  GET  /api/notice        →  获取公告列表（最多3条）             │
 * │  POST /api/notice        →  发布公告（需 PAT）                  │
 * │  DELETE /api/notice/:id  →  删除公告（需 PAT）                  │
 * │  GET  /                  →  状态页面                            │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ── 部署步骤 ──────────────────────────────────────────────────────
 * 1. 登录 dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. 粘贴此文件，Save and Deploy
 * 3. 进入 Worker 设置 → Variables → D1 Database Bindings
 *    Binding name: DB   选择或新建一个 D1 数据库
 * 4. 进入 Worker 设置 → Variables → Environment Variables
 *    PAT = 你的私有令牌（任意强密码字符串）
 * 5. 首次部署后访问 /api/notice/init 完成建表（只需执行一次）
 * 6. 绑定自定义域名 timeapi.qlzx.lol
 *
 * ── 控制台发公告 ──────────────────────────────────────────────────
 * // 发布
 * await fetch('https://timeapi.qlzx.lol/api/notice', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json',
 *              'Authorization': 'Bearer <你的PAT>' },
 *   body: JSON.stringify({ content: '公告内容', level: 'info' })
 *   // level: 'info' | 'warn' | 'error'
 * }).then(r=>r.json()).then(console.log)
 *
 * // 查看现有公告
 * await fetch('https://timeapi.qlzx.lol/api/notice').then(r=>r.json()).then(console.log)
 *
 * // 删除（id 从查看结果里拿）
 * await fetch('https://timeapi.qlzx.lol/api/notice/1', {
 *   method: 'DELETE',
 *   headers: { 'Authorization': 'Bearer <你的PAT>' }
 * }).then(r=>r.json()).then(console.log)
 */

// ── 公共 Headers ──────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

// ── PAT 鉴权 ─────────────────────────────────────────────────────────────
function authOk(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const pat  = (env.PAT || "").trim();
  if (!pat) return false;                          // PAT 未配置则拒绝一切写操作
  return auth === `Bearer ${pat}`;
}

// ── /api/time ─────────────────────────────────────────────────────────────
function handleTime(request) {
  const now   = new Date();
  const ms    = now.getTime();
  return json({
    unix_ms  : ms,
    unix_s   : ms / 1000,
    t_recv_ms: ms,
    iso      : now.toISOString(),
    utc      : now.toUTCString(),
    cf_ray   : request.headers.get("cf-ray") || "local",
    cf_colo  : request.cf ? request.cf.colo : "unknown",
    tz_offset: 0,
  });
}

// ── /api/notice/init  （建表，只需执行一次）──────────────────────────────
async function handleInit(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      content   TEXT    NOT NULL,
      level     TEXT    NOT NULL DEFAULT 'info',
      created_at INTEGER NOT NULL
    );
  `);
  return json({ ok: true, msg: "D1 table ready" });
}

// ── GET /api/notice ───────────────────────────────────────────────────────
async function handleGetNotice(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, content, level, created_at FROM notices ORDER BY created_at DESC LIMIT 3"
  ).all();
  return json({ ok: true, notices: results });
}

// ── POST /api/notice ──────────────────────────────────────────────────────
async function handlePostNotice(request, env) {
  if (!authOk(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const content = (body.content || "").trim();
  if (!content) return json({ ok: false, error: "content is required" }, 400);

  const level = ["info", "warn", "error"].includes(body.level) ? body.level : "info";
  const now   = Date.now();

  // 超出3条时删除最旧的
  const { results: existing } = await env.DB.prepare(
    "SELECT id FROM notices ORDER BY created_at DESC"
  ).all();

  if (existing.length >= 3) {
    const toDelete = existing.slice(2);           // 保留前2条，新的插入后正好3条
    for (const row of toDelete) {
      await env.DB.prepare("DELETE FROM notices WHERE id = ?").bind(row.id).run();
    }
  }

  const result = await env.DB.prepare(
    "INSERT INTO notices (content, level, created_at) VALUES (?, ?, ?)"
  ).bind(content, level, now).run();

  return json({ ok: true, id: result.meta.last_row_id, content, level, created_at: now });
}

// ── DELETE /api/notice/:id ────────────────────────────────────────────────
async function handleDeleteNotice(request, env, id) {
  if (!authOk(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  const { meta } = await env.DB.prepare("DELETE FROM notices WHERE id = ?").bind(Number(id)).run();
  if (meta.changes === 0) return json({ ok: false, error: "Not found" }, 404);
  return json({ ok: true, deleted_id: Number(id) });
}

// ── OPTIONS preflight ─────────────────────────────────────────────────────
function handleOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── HTML 状态页 ───────────────────────────────────────────────────────────
function handlePage(request) {
  const colo = request.cf ? request.cf.colo : "??";
  const ray  = request.headers.get("cf-ray") || "local";
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF Time Server · timeapi.qlzx.lol</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:      #090912;
    --surface: #0f0f1e;
    --card:    #14142a;
    --border:  #1e1e3f;
    --accent:  #4f8eff;
    --green:   #3dd68c;
    --yellow:  #f5c842;
    --red:     #f87171;
    --text:    #e8eaf6;
    --muted:   #6b6d8a;
    --mono:    'DM Mono', monospace;
    --sans:    'Syne', sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: var(--sans); min-height: 100vh;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center; padding: 2rem;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 40px 40px;
  }
  .glow {
    position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
    width: 600px; height: 400px;
    background: radial-gradient(ellipse, #4f8eff18 0%, transparent 70%);
    pointer-events: none;
  }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 2.5rem 3rem;
    max-width: 700px; width: 100%; position: relative;
    box-shadow: 0 0 60px #4f8eff0a, 0 24px 48px #00000060;
  }
  .card::before {
    content: ''; position: absolute; inset: 0; border-radius: 16px;
    background: linear-gradient(135deg, #4f8eff08, transparent 60%);
    pointer-events: none;
  }
  .back-btn {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--mono); font-size: .75rem; color: var(--muted);
    background: transparent; border: 1px solid var(--border);
    border-radius: 999px; padding: 5px 14px 5px 10px;
    margin-bottom: 1.2rem; text-decoration: none !important;
    transition: color .18s, border-color .18s, background .18s;
  }
  .back-btn:hover { color: var(--text); border-color: var(--accent); background: #4f8eff0d; }
  .back-btn:hover svg { transform: translateX(-2px); }
  .back-btn svg { transition: transform .18s; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: .7rem; color: var(--green);
    background: #3dd68c12; border: 1px solid #3dd68c30;
    border-radius: 999px; padding: 4px 12px; margin-bottom: 1.4rem;
  }
  .badge .dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--green);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }
  h1 {
    font-size: 2rem; font-weight: 800; letter-spacing: -.02em;
    background: linear-gradient(135deg, var(--text) 40%, var(--accent));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: .4rem;
  }
  .subtitle { color: var(--muted); font-size: .9rem; margin-bottom: 2rem; }
  #clock {
    font-family: var(--mono); font-size: 3.2rem; font-weight: 300;
    color: var(--accent); text-shadow: 0 0 40px #4f8eff40; margin-bottom: .4rem;
  }
  #date-str { font-family: var(--mono); font-size: .85rem; color: var(--muted); margin-bottom: 2rem; }
  .stats {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
    background: var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 2rem;
  }
  .stat { background: var(--surface); padding: .9rem 1.2rem; }
  .stat label { display: block; font-size: .7rem; font-weight: 700; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; margin-bottom: .3rem; }
  .stat value { font-family: var(--mono); font-size: .95rem; color: var(--text); }
  .stat value.accent { color: var(--accent); }
  .stat value.green  { color: var(--green); }

  /* ── 公告区块 ── */
  .notices-block {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 1.2rem 1.4rem; margin-bottom: 1.2rem;
  }
  .notices-block h3 {
    font-size: .75rem; font-weight: 700; letter-spacing: .1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: .8rem;
  }
  .notice-item {
    display: flex; align-items: flex-start; gap: .7rem;
    padding: .6rem .8rem; border-radius: 7px; margin-bottom: .5rem;
    font-size: .85rem; line-height: 1.5;
  }
  .notice-item:last-child { margin-bottom: 0; }
  .notice-item.info  { background: #4f8eff12; border-left: 3px solid var(--accent); }
  .notice-item.warn  { background: #f5c84212; border-left: 3px solid var(--yellow); }
  .notice-item.error { background: #f8717112; border-left: 3px solid var(--red); }
  .notice-icon { font-size: 1rem; flex-shrink: 0; margin-top: .05rem; }
  .notice-content { flex: 1; }
  .notice-time { font-family: var(--mono); font-size: .7rem; color: var(--muted); margin-top: .2rem; }
  .no-notice { color: var(--muted); font-size: .85rem; font-family: var(--mono); }

  .api-block {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 1.2rem 1.4rem; margin-bottom: 1.2rem;
  }
  .api-block h3 { font-size: .75rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: .8rem; }
  .endpoint { display: flex; align-items: center; gap: .7rem; margin-bottom: .6rem; }
  .method { font-family: var(--mono); font-size: .72rem; font-weight: 500; background: #4f8eff20; color: var(--accent); border-radius: 4px; padding: 2px 8px; }
  .method.post   { background: #3dd68c20; color: var(--green); }
  .method.delete { background: #f8717120; color: var(--red); }
  .path { font-family: var(--mono); font-size: .85rem; color: var(--text); }
  .desc { font-size: .8rem; color: var(--muted); margin-left: calc(.72rem + 1.4rem + .7rem); margin-bottom: .5rem; }
  pre {
    font-family: var(--mono); font-size: .78rem;
    background: #00000040; border: 1px solid var(--border);
    border-radius: 8px; padding: 1rem 1.2rem; color: #a5b4fc;
    overflow-x: auto; line-height: 1.7; white-space: pre-wrap;
  }
  .key { color: #93c5fd; } .num { color: var(--green); } .str { color: #fcd34d; }
  #latency-badge {
    display: inline-block; font-family: var(--mono); font-size: .75rem;
    color: var(--green); background: #3dd68c12; border: 1px solid #3dd68c30;
    border-radius: 6px; padding: 2px 10px; margin-top: .6rem;
  }
  footer { margin-top: 1.6rem; font-size: .75rem; color: var(--muted); text-align: center; line-height: 1.8; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="glow"></div>
<div class="card">
  <a class="back-btn" href="https://qlzx.lol">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    返回 qlzx.lol
  </a>
  <div class="badge"><span class="dot"></span> ONLINE · ${colo}</div>
  <h1>CF Time Server</h1>
  <p class="subtitle">timeapi.qlzx.lol &nbsp;·&nbsp; CF-Ray: <code style="font-family:var(--mono);font-size:.8rem">${ray}</code></p>

  <div id="clock">--:--:--</div>
  <div id="date-str">正在获取服务器时间…</div>

  <div class="stats">
    <div class="stat"><label>Unix 时间戳 (ms)</label><value class="accent" id="s-unix">—</value></div>
    <div class="stat"><label>往返时延 RTT</label><value class="green" id="s-rtt">—</value></div>
    <div class="stat"><label>边缘节点</label><value id="s-colo">${colo}</value></div>
    <div class="stat"><label>时钟偏差（估算）</label><value class="green" id="s-offset">—</value></div>
  </div>

  <!-- 公告区 -->
  <div class="notices-block">
    <h3>📢 系统公告 <span id="notice-count" style="color:var(--muted);font-weight:400"></span></h3>
    <div id="notice-list"><span class="no-notice">加载中…</span></div>
  </div>

  <div class="api-block">
    <h3>API 端点</h3>
    <div class="endpoint"><span class="method">GET</span><span class="path">/api/time</span></div>
    <div class="desc">返回 JSON 时间数据</div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/api/notice</span></div>
    <div class="desc">获取公告列表（最多 3 条）</div>
    <div class="endpoint"><span class="method post">POST</span><span class="path">/api/notice</span></div>
    <div class="desc">发布公告，需 Authorization: Bearer &lt;PAT&gt;</div>
    <div class="endpoint"><span class="method delete">DELETE</span><span class="path">/api/notice/:id</span></div>
    <div class="desc">删除公告，需 Authorization: Bearer &lt;PAT&gt;</div>
  </div>

  <div class="api-block">
    <h3>控制台快捷命令</h3>
    <pre id="console-hint">// 发布公告（在浏览器控制台粘贴执行）
await fetch('https://timeapi.qlzx.lol/api/notice', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer &lt;你的PAT&gt;'
  },
  body: JSON.stringify({
    content: '公告内容',
    level: 'info'   // info | warn | error
  })
}).then(r=&gt;r.json()).then(console.log)

// 查看公告（获取 id 用于删除）
await fetch('/api/notice').then(r=&gt;r.json()).then(console.log)

// 删除公告
await fetch('/api/notice/1', {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer &lt;你的PAT&gt;' }
}).then(r=&gt;r.json()).then(console.log)</pre>
  </div>

  <div class="api-block">
    <h3>时间 API 响应 &nbsp;<span id="latency-badge" style="display:none"></span></h3>
    <pre id="json-preview">正在请求…</pre>
  </div>

  <footer>
    Cloudflare Workers + D1 · UTC 精度 &lt; 5ms<br>
    <a href="/api/time" target="_blank">/api/time</a> &nbsp;·&nbsp;
    <a href="/api/notice" target="_blank">/api/notice</a>
  </footer>
</div>

<script>
  // ── 时间同步 ──────────────────────────────────────────────
  let _offset_ms = 0;
  async function syncTime() {
    const t0 = performance.now(), t0u = Date.now();
    try {
      const res  = await fetch('/api/time?_=' + t0u);
      const t1   = performance.now(), t1u = Date.now();
      const data = await res.json();
      const rtt  = t1 - t0;
      const srv  = data.unix_ms;
      const off  = srv - (t0u + rtt / 2);
      document.getElementById('s-unix').textContent   = srv;
      document.getElementById('s-rtt').textContent    = rtt.toFixed(1) + ' ms';
      document.getElementById('s-offset').textContent = (off>=0?'+':'') + off.toFixed(1) + ' ms';
      const pretty = JSON.stringify(data, null, 2)
        .replace(/"([^"]+)":/g, '<span class="key">"$1"</span>:')
        .replace(/: "([^"]+)"/g, ': <span class="str">"$1"</span>')
        .replace(/: (-?\d+\.?\d*)/g, ': <span class="num">$1</span>');
      document.getElementById('json-preview').innerHTML = pretty;
      const lb = document.getElementById('latency-badge');
      lb.textContent = 'RTT ' + rtt.toFixed(1) + ' ms';
      lb.style.display = 'inline-block';
      return off;
    } catch(e) {
      document.getElementById('json-preview').textContent = '请求失败: ' + e.message;
      return 0;
    }
  }
  function tick() {
    const now = new Date(Date.now() + _offset_ms);
    const pad = n => String(n).padStart(2,'0');
    document.getElementById('clock').textContent =
      pad(now.getUTCHours())+':'+pad(now.getUTCMinutes())+':'+pad(now.getUTCSeconds())+' UTC';
    const days = ['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('date-str').textContent =
      now.getUTCFullYear()+'年'+pad(now.getUTCMonth()+1)+'月'+pad(now.getUTCDate())+'日  '+days[now.getUTCDay()];
  }

  // ── 公告渲染 ──────────────────────────────────────────────
  const ICON = { info: 'ℹ️', warn: '⚠️', error: '🔴' };
  async function loadNotices() {
    try {
      const data = await fetch('/api/notice').then(r => r.json());
      const list = document.getElementById('notice-list');
      const cnt  = document.getElementById('notice-count');
      if (!data.notices || data.notices.length === 0) {
        list.innerHTML = '<span class="no-notice">暂无公告</span>';
        cnt.textContent = '';
        return;
      }
      cnt.textContent = '(' + data.notices.length + '/3)';
      list.innerHTML = data.notices.map(n => {
        const d   = new Date(n.created_at);
        const pad = x => String(x).padStart(2,'0');
        const ts  = d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())
                  +' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+' UTC';
        const lvl = ['info','warn','error'].includes(n.level) ? n.level : 'info';
        return \`<div class="notice-item \${lvl}">
          <span class="notice-icon">\${ICON[lvl]}</span>
          <div class="notice-content">
            <div>\${n.content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
            <div class="notice-time">#\${n.id} · \${ts}</div>
          </div>
        </div>\`;
      }).join('');
    } catch(e) {
      document.getElementById('notice-list').innerHTML =
        '<span class="no-notice">公告加载失败: ' + e.message + '</span>';
    }
  }

  // ── 初始化 ────────────────────────────────────────────────
  (async () => {
    _offset_ms = await syncTime();
    loadNotices();
    setInterval(tick, 1000);
    setInterval(() => syncTime().then(o => { _offset_ms = o; }), 30000);
    setInterval(loadNotices, 60000);   // 每分钟刷新公告
    tick();
  })();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ── 路由入口 ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;
    const path   = url.pathname;

    if (method === "OPTIONS")                          return handleOptions();
    if (path === "/api/time")                          return handleTime(request);
    if (path === "/api/notice/init")                   return handleInit(env);
    if (path === "/api/notice" && method === "GET")    return handleGetNotice(env);
    if (path === "/api/notice" && method === "POST")   return handlePostNotice(request, env);

    // DELETE /api/notice/:id
    const delMatch = path.match(/^\/api\/notice\/(\d+)$/);
    if (delMatch && method === "DELETE") return handleDeleteNotice(request, env, delMatch[1]);

    return handlePage(request);
  },
};
