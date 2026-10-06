// worker.js — 考试模式界面（Cloudflare Worker）
// 部署：wrangler deploy 或在 Cloudflare Dashboard 直接粘贴

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>考试模式</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Noto+Serif+SC:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg: #f6f3ec;            /* 米白 */
    --ink: #1a1a1a;           /* 主墨 */
    --ink-soft: #4a4a4a;      /* 次墨 */
    --line: #c8bfae;          /* 分割线 */
    --accent: #8a1c1c;        /* 印泥红 */
    --panel: rgba(255,255,255,.78);
    --shadow: 0 6px 24px rgba(0,0,0,.06);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#10110f; --ink:#ece7d8; --ink-soft:#a8a293;
      --line:#3a3a36; --accent:#c45a5a;
      --panel:rgba(28,28,26,.78); --shadow:0 6px 24px rgba(0,0,0,.4);
    }
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;
    background:var(--bg);
    color:var(--ink);
    font-family:"Noto Serif SC","Cormorant Garamond",ui-serif,Georgia,"Times New Roman",serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:100vh;
    padding:48px 24px;
    overflow-x:hidden;
  }
  /* 顶部考试标题 */
  .title{
    text-align:center;
    letter-spacing:.4em;
    font-weight:600;
    font-size:clamp(16px,2.2vw,22px);
    color:var(--ink-soft);
    border-top:1px solid var(--line);
    border-bottom:1px solid var(--line);
    padding:10px 28px;
    margin-bottom:48px;
    user-select:none;
  }
  .title .subject{
    margin-left:1.2em;letter-spacing:.3em;color:var(--accent);font-weight:700;
  }
  /* 居中时钟 */
  .clock-wrap{
    text-align:center;
    line-height:1;
  }
  .clock{
    font-family:"Cormorant Garamond","Noto Serif SC",serif;
    font-weight:500;
    font-variant-numeric:tabular-nums;
    /* 关键：限制大小，避免铺满 */
    font-size:clamp(56px,9vw,140px);
    letter-spacing:.04em;
    color:var(--ink);
  }
  .clock .sep{ opacity:.55; padding:0 .05em }
  .date{
    margin-top:14px;
    font-size:clamp(13px,1.4vw,18px);
    letter-spacing:.35em;
    color:var(--ink-soft);
  }

  /* 进度与剩余时间 */
  .status{
    margin-top:48px;
    width:min(560px,90vw);
    text-align:center;
  }
  .status .row{
    display:flex;justify-content:space-between;align-items:baseline;
    font-size:14px;color:var(--ink-soft);letter-spacing:.15em;
    margin-bottom:8px;
  }
  .remain{
    font-family:"Cormorant Garamond",serif;
    font-variant-numeric:tabular-nums;
    font-size:clamp(28px,4vw,42px);
    letter-spacing:.06em;
    color:var(--ink);
    margin:6px 0 14px;
  }
  .remain.warn{ color:var(--accent) }
  .bar{
    height:3px;background:var(--line);position:relative;border-radius:2px;overflow:hidden;
  }
  .bar > span{
    position:absolute;inset:0 auto 0 0;width:0%;
    background:var(--ink);transition:width .5s linear;
  }
  .bar.warn > span{ background:var(--accent) }
  .meta{
    display:flex;justify-content:space-between;
    margin-top:10px;font-size:12px;color:var(--ink-soft);letter-spacing:.1em;
  }
  .badge{
    display:inline-block;margin-top:18px;padding:4px 14px;
    border:1px solid var(--line);border-radius:999px;
    font-size:12px;letter-spacing:.3em;color:var(--ink-soft);
  }
  .badge.live{ color:#fff;background:var(--accent);border-color:var(--accent) }
  .badge.done{ color:var(--ink);background:var(--line);border-color:var(--line) }

  /* 设置控件 */
  .gear{
    position:fixed;top:18px;right:18px;
    width:38px;height:38px;border-radius:50%;
    background:var(--panel);backdrop-filter:blur(8px);
    border:1px solid var(--line);box-shadow:var(--shadow);
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;font-size:18px;color:var(--ink-soft);
    transition:transform .3s ease;
    z-index:20;
  }
  .gear:hover{ transform:rotate(60deg);color:var(--ink) }

  .panel{
    position:fixed;top:0;right:0;height:100vh;width:min(360px,90vw);
    background:var(--panel);backdrop-filter:blur(12px);
    border-left:1px solid var(--line);box-shadow:var(--shadow);
    transform:translateX(100%);transition:transform .35s cubic-bezier(.2,.7,.2,1);
    padding:28px 26px;overflow-y:auto;z-index:15;
  }
  .panel.open{ transform:translateX(0) }
  .panel h2{
    font-size:16px;letter-spacing:.3em;margin:6px 0 22px;
    border-bottom:1px solid var(--line);padding-bottom:10px;
  }
  .field{ margin-bottom:16px }
  .field label{
    display:block;font-size:12px;letter-spacing:.2em;
    color:var(--ink-soft);margin-bottom:6px;
  }
  .field input{
    width:100%;padding:9px 12px;
    background:transparent;color:var(--ink);
    border:1px solid var(--line);border-radius:6px;
    font-family:inherit;font-size:14px;
    outline:none;transition:border-color .2s;
  }
  .field input:focus{ border-color:var(--ink) }
  .actions{ display:flex;gap:10px;margin-top:20px }
  /* 时长预设：六颗窄按钮自动折行，比等宽的 .btn 更紧凑 */
  .actions.quick{ flex-wrap:wrap;gap:8px;margin-top:14px }
  .actions.quick .btn{ flex:0 1 auto;padding:8px 12px;font-size:12px;letter-spacing:0 }
  .btn{
    flex:1;padding:10px 14px;
    border:1px solid var(--ink);background:transparent;color:var(--ink);
    border-radius:6px;cursor:pointer;
    font-family:inherit;font-size:13px;letter-spacing:.2em;
    transition:all .2s;
  }
  .btn:hover{ background:var(--ink);color:var(--bg) }
  .btn.primary{ background:var(--ink);color:var(--bg) }
  .btn.primary:hover{ background:var(--accent);border-color:var(--accent) }
  .hint{ font-size:11px;color:var(--ink-soft);line-height:1.7;margin-top:14px;letter-spacing:.05em }

  /* 全屏按钮 */
  .fs{
    position:fixed;bottom:18px;right:18px;
    background:var(--panel);backdrop-filter:blur(8px);
    border:1px solid var(--line);border-radius:6px;
    padding:6px 12px;font-size:12px;letter-spacing:.2em;color:var(--ink-soft);
    cursor:pointer;z-index:20;
  }
  .fs:hover{ color:var(--ink) }
</style>
</head>
<body>

  <div class="title" id="examTitle">
    <span id="titleText">学业水平测试</span><span class="subject" id="subjectText">语文</span>
  </div>

  <div class="clock-wrap">
    <div class="clock" id="clock">--<span class="sep">:</span>--<span class="sep">:</span>--</div>
    <div class="date" id="date">—</div>
  </div>

  <div class="status">
    <div class="row">
      <span>剩 余 时 间</span>
      <span id="phaseLabel">未开始</span>
    </div>
    <div class="remain" id="remain">--:--:--</div>
    <div class="bar" id="bar"><span id="barFill"></span></div>
    <div class="meta">
      <span id="startMeta">开始 —</span>
      <span id="endMeta">结束 —</span>
    </div>
    <div class="badge" id="badge">待 开 始</div>
  </div>

  <div class="gear" id="gear" title="设置">⚙</div>
  <button class="fs" id="fsBtn">全 屏</button>

  <aside class="panel" id="panel">
    <h2>考 试 设 置</h2>
    <div class="field">
      <label>考试名称</label>
      <input id="inpTitle" type="text" placeholder="如：学业水平测试" />
    </div>
    <div class="field">
      <label>科目 / 副标题</label>
      <input id="inpSubject" type="text" placeholder="如：语文" />
    </div>
    <div class="field">
      <label>开始时间</label>
      <input id="inpStart" type="datetime-local" step="60" />
    </div>
    <div class="field">
      <label>结束时间</label>
      <input id="inpEnd" type="datetime-local" step="60" />
    </div>
    <div class="actions quick" id="quickRow">
      <button class="btn" data-min="40">+40 分</button>
      <button class="btn" data-min="60">+1 小时</button>
      <button class="btn" data-min="90">+90 分</button>
      <button class="btn" data-min="100">+100 分</button>
      <button class="btn" data-min="120">+2 小时</button>
      <button class="btn" data-min="150">+150 分</button>
    </div>
    <div class="actions">
      <button class="btn primary" id="btnSave">保 存</button>
      <button class="btn" id="btnNow">开始=现在</button>
      <button class="btn" id="btnReset">清 空</button>
    </div>
    <p class="hint">
      • 数据仅保存在本机浏览器（localStorage）。<br>
      • 时间显示为本机系统时间，请确保系统时间准确。<br>
      • 按 <b>F</b> 切换全屏，按 <b>S</b> 打开/关闭设置。
    </p>
  </aside>

<script>
(function(){
  const $ = sel => document.querySelector(sel);
  const KEY = 'exam-mode-config-v1';

  const cfg = Object.assign({
    title:'学业水平测试',
    subject:'语文',
    start:'',
    end:''
  }, JSON.parse(localStorage.getItem(KEY)||'{}'));

  // —— 工具函数 ——
  const pad = n => String(n).padStart(2,'0');
  const fmtClock = d =>
    \`\${pad(d.getHours())}<span class="sep">:</span>\${pad(d.getMinutes())}<span class="sep">:</span>\${pad(d.getSeconds())}\`;
  const weekCN = ['日','一','二','三','四','五','六'];
  const fmtDate = d =>
    \`\${d.getFullYear()} 年 \${pad(d.getMonth()+1)} 月 \${pad(d.getDate())} 日　星期\${weekCN[d.getDay()]}\`;
  const fmtDur = ms => {
    if(ms<0) ms=0;
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600);
    const m = Math.floor(s%3600/60);
    const sec = s%60;
    return \`\${pad(h)}:\${pad(m)}:\${pad(sec)}\`;
  };
  const toLocalInput = iso => {
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d)) return '';
    const off = d.getTimezoneOffset();
    const local = new Date(d.getTime() - off*60000);
    return local.toISOString().slice(0,16);
  };
  const fromLocalInput = v => v ? new Date(v).toISOString() : '';
  const fmtMeta = iso => {
    if(!iso) return '—';
    const d = new Date(iso);
    return \`\${pad(d.getMonth()+1)}/\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}\`;
  };

  // —— 渲染 ——
  function renderTitle(){
    $('#titleText').textContent  = cfg.title || '考 试';
    $('#subjectText').textContent= cfg.subject || '';
    document.title = (cfg.title||'考试模式') + (cfg.subject?' · '+cfg.subject:'');
  }

  function tick(){
    const now = new Date();
    $('#clock').innerHTML = fmtClock(now);
    $('#date').textContent = fmtDate(now);

    const start = cfg.start ? new Date(cfg.start) : null;
    const end   = cfg.end   ? new Date(cfg.end)   : null;
    const remainEl = $('#remain');
    const barFill  = $('#barFill');
    const bar      = $('#bar');
    const badge    = $('#badge');
    const phase    = $('#phaseLabel');

    $('#startMeta').textContent = '开始 ' + fmtMeta(cfg.start);
    $('#endMeta').textContent   = '结束 ' + fmtMeta(cfg.end);

    if(!start || !end || end<=start){
      remainEl.textContent='--:--:--';
      barFill.style.width='0%';
      bar.classList.remove('warn');
      remainEl.classList.remove('warn');
      badge.textContent='未 设 置'; badge.className='badge';
      phase.textContent='未设置';
      return;
    }

    const total = end - start;
    if(now < start){
      const toStart = start - now;
      remainEl.textContent = '距开始 ' + fmtDur(toStart);
      barFill.style.width = '0%';
      bar.classList.remove('warn'); remainEl.classList.remove('warn');
      badge.textContent='待 开 始'; badge.className='badge';
      phase.textContent='待开始';
    } else if(now < end){
      const left = end - now;
      const passed = now - start;
      remainEl.textContent = fmtDur(left);
      barFill.style.width = (passed/total*100).toFixed(2) + '%';
      const warn = left <= 5*60*1000;        // 最后 5 分钟标红
      bar.classList.toggle('warn', warn);
      remainEl.classList.toggle('warn', warn);
      badge.textContent='进 行 中'; badge.className='badge live';
      phase.textContent= warn ? '即将结束' : '进行中';
    } else {
      remainEl.textContent = '00:00:00';
      barFill.style.width = '100%';
      bar.classList.remove('warn'); remainEl.classList.remove('warn');
      badge.textContent='已 结 束'; badge.className='badge done';
      phase.textContent='已结束';
    }
  }

  // —— 设置面板 ——
  function fillForm(){
    $('#inpTitle').value   = cfg.title || '';
    $('#inpSubject').value = cfg.subject || '';
    $('#inpStart').value   = toLocalInput(cfg.start);
    $('#inpEnd').value     = toLocalInput(cfg.end);
  }

  function save(){
    cfg.title   = $('#inpTitle').value.trim();
    cfg.subject = $('#inpSubject').value.trim();
    cfg.start   = fromLocalInput($('#inpStart').value);
    cfg.end     = fromLocalInput($('#inpEnd').value);
    localStorage.setItem(KEY, JSON.stringify(cfg));
    renderTitle();
    tick();
    togglePanel(false);
  }

  function togglePanel(open){
    const p = $('#panel');
    if(open===undefined) p.classList.toggle('open');
    else p.classList.toggle('open', open);
  }

  $('#gear').onclick = ()=> togglePanel();
  $('#btnSave').onclick = save;
  $('#btnReset').onclick = ()=>{
    if(confirm('清空所有设置？')){
      localStorage.removeItem(KEY);
      Object.assign(cfg,{title:'',subject:'',start:'',end:''});
      fillForm(); renderTitle(); tick();
    }
  };
  $('#btnNow').onclick = ()=>{
    const d = new Date();
    $('#inpStart').value = toLocalInput(d.toISOString());
  };
  /* 时长预设：按开始时间往后推 N 分钟填结束时间。
   * 开始时间为空就以「现在」为起点并顺手填上，跟老的单颗 +150 分钟按钮行为一致。 */
  $('#quickRow').querySelectorAll('[data-min]').forEach(btn=>{
    btn.onclick = ()=>{
      const s = $('#inpStart').value ? new Date($('#inpStart').value) : new Date();
      if(!$('#inpStart').value) $('#inpStart').value = toLocalInput(s.toISOString());
      const e = new Date(s.getTime() + Number(btn.dataset.min)*60*1000);
      $('#inpEnd').value = toLocalInput(e.toISOString());
    };
  });

  // —— 全屏 / 快捷键 ——
  $('#fsBtn').onclick = ()=>{
    if(!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  };
  document.addEventListener('keydown', e=>{
    if(e.target.tagName==='INPUT') return;
    if(e.key==='f'||e.key==='F') $('#fsBtn').click();
    if(e.key==='s'||e.key==='S') togglePanel();
    if(e.key==='Escape') togglePanel(false);
  });

  // —— 启动 ——
  fillForm();
  renderTitle();
  tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    return new Response(HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  },
};