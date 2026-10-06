/* =====================================================================
 * 【存档】TG 推送 · 2026-09-18 从 old-news-api.js 摘出（normal-welcomed-page）
 *
 * 这不是能直接部署的文件，只是把摘掉的代码原样留档。主文件已不再 import 任何
 * 这里的东西；文件名故意不带 .worker 后缀，wrangler 也不会碰它。
 *
 * 为什么下线：暂时不用 TG 通道了，主文件里又占着一大堆 subrequest 预算相关的
 * 逻辑（自调用 /api/cron-push、待推队列、失败重推），先摘干净，需要时再装回去。
 *
 * ── 恢复步骤 ──────────────────────────────────────────────────────────
 * 1. 把下面【一】【二】【三】三段分别贴回 old-news-api.js 对应的位置：
 *    【一】文件顶部（export default 之前）
 *    【二】主路由 handleRequest 里：/api/update-news 内 + 紧随其后的两个路由
 *    【三】handleScheduledMain 的尾部推送调用 + cronBeat 的 tg 字段
 *    【四】tgSelfCheck 整个函数（放在 CRON_* 常量之后、handleScheduled 之前）
 *    【五】Telegram 推送实现整段（放在"新闻去重 / 新增判定"之前）
 * 2. 主文件里补回 `function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }`
 *    （TG 摘掉后没人用了，现在已删除；sendTG / 推送间隔都依赖它）
 * 3. 确认 old-news-api.js 里仍有 pickFreshItems / getExistingKeys —— 这两个
 *    摘 TG 时留在主文件了（/api/update-news 与 cron 的新增判定还在用），
 *    推送需要它们，别重复定义。
 * 4. 线上密钥：TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID（--keep-vars 会保留，
 *    若已删除用 npx wrangler secret put <名> -c wrangler.old-news.toml 补）
 * 5. 把 archive/tg-push-test.mjs 挪回 normal-pages/ 下（26 项断言，覆盖只推新增、
 *    失败进队列补发、HTML 转义等），`node tg-push-test.mjs` 自测。
 * 6. 部署：./deploy.sh old-news
 *
 * ── 摘掉时主文件里的连带改动（恢复时要一并还原）────────────────────
 * - /api/update-news 返回体去掉了 tgOk / tg 字段，success 由 newsOk || tgOk
 *   改成只看 newsOk；?full=1 不再表示"全量重推"，只表示 fresh 按全量算
 * - 路由 /api/cron-push（TG_PUSH_PATH）与 /api/tg-check 已删除，现在回 404
 * - 文件顶部 globalThis.fetch 计数包裹（__fetchCount）已删除，只有
 *   /api/tg-check?burn=1 用过
 * - KV 里的旧键 tg_pending 没删，7 天 TTL 自然过期，不占额外配额
 * ===================================================================== */

/* ================= 【一】文件顶部：子请求计数 ================= */

/* 子请求计数：免费版每次 invocation 只有 50 次（fetch / D1 / KV / AI 都算）。
 * 只数 fetch 这一半，够用来判断「抓新闻到底吃掉多少」，/api/tg-check?burn=1 会返回。
 * 改写 globalThis.fetch 失败也不能拖垮整个 Worker，所以整段包 try。 */
let __fetchCount = 0;
try {
  const __origFetch = globalThis.fetch;
  globalThis.fetch = function (...args) { __fetchCount++; return __origFetch.apply(this, args); };
} catch (e) { /* 环境不允许改写 globalThis.fetch，计数不可用，不影响其它功能 */ }

/* ================= 【二】主路由 ================= */

  /* ---- 强制更新新闻 + TG推送（带详细返回）---- */
  if (url.pathname === '/api/update-news' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    const full = url.searchParams.get('full') === '1';
    const result = { newsOk: false, tgOk: false, count: 0, fresh: 0, tg: null, errors: [] };
    try {
      const newsData = await fetchAllNews(env);
      result.count = newsData.length;
      result.fresh = full ? newsData.length : (await pickFreshItems(env, newsData)).length;
      try {
        await clearOldNews(env);
        await saveNewsToD1(env, newsData);
        result.newsOk = true;
      } catch (e) { result.errors.push('D1: ' + (e.message || e)); }
      try {
        /* 抓取已经把 subrequest 预算烧光，推送交给自调用的一次新 invocation */
        result.tg = await pushViaChildInvocation(env, full ? newsData : [], { full });
        result.errors.push(...(result.tg.errors || []));
      } catch (e) { result.errors.push('TG: ' + (e.message || e)); }
    } catch (e) {
      result.errors.push('FETCH: ' + (e.message || e));
    }
    return jsonResp({ success: result.newsOk || result.tgOk, ...result });
  }

  /* ---- 推送专用入口：单独一次 invocation，自带 50 次 subrequest 预算 ----
   * 抓取那次（cron 或 /api/update-news）已经把预算烧光，同一次里发 TG 必挂。
   * 队列里没发完的条目每次都会被重试，所以这个入口可以随便空跑。
   * body: { items: [...] } 可选，用于 ?full=1 全量重推 */
  if (url.pathname === TG_PUSH_PATH && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    let items = [], full = url.searchParams.get('full') === '1';
    try {
      const body = await request.json();
      if (Array.isArray(body?.items)) items = body.items;
      if (body?.full === true) full = true;
    } catch (e) { /* 没 body 就用队列里的 */ }
    const stat = await pushNewsToTelegram(env, items, { onlyNew: !full });
    return jsonResp({ success: stat.fail === 0, tg: stat });
  }

  /* ---- TG 自检：查 token / chat_id 到底哪一步不通
   * GET 只读；?send=1 真发一条；?burn=1 先跑一遍抓新闻再发（复现"单独能发、推送就挂"）---- */
  if (url.pathname === '/api/tg-check' && request.method === 'GET') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return jsonResp(await tgSelfCheck(env, url.searchParams.get('send') === '1', url.searchParams.get('burn') === '1'));
  }

/* ================= 【三】cron 主任务尾部推送 ================= */

  /* 推送单独一次 invocation：本次预算已被抓取吃光，同一次里发 TG 必挂 */
  let tgStat = null, tgError = '';
  try {
    await queueTgItems(env, freshItems);
    tgStat = await pushViaChildInvocation(env);
    console.log(`[Cron] TG 推送完成: ${tgStat.ok} 段 OK / ${tgStat.fail} 段失败 / 待推 ${tgStat.fresh} 条`);
  } catch (e) { tgError = String(e?.message || e); console.error('[Cron] TG 推送失败:', e?.stack || e); }

  /* cronBeat 的最后一个参数改为： */
  await cronBeat(env, 'cron_main_result', {
    startedAt, finishedAt: Date.now(), fetched: newsData.length,
    tg: tgStat, error: fetchError || tgError
  });

/* ================= 【四】TG 自检 ================= */

/* 推送全挂时用这个定位：token 没配 / token 失效(401) / chat_id 不对(400 chat not found)
 * / 机器人不在群里(403) / 网络不通。返回 TG 原始响应，不猜。 */
async function tgSelfCheck(env, doSend, doBurn) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const out = {
    success: true,
    token: token ? `已配置(${String(token).split(':')[0]}…)` : '未配置',
    chatId: chatId || '未配置',
    steps: []
  };
  if (!token || !chatId) {
    out.success = false;
    out.hint = '缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，用 npx wrangler secret put <名> -c wrangler.old-news.toml 补上';
    return out;
  }

  const call = async (method, body) => {
    const step = { method, ok: false, status: 0, body: '' };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      step.status = res.status;
      step.body = (await res.text()).slice(0, 400);
      step.ok = res.ok;
    } catch (e) {
      step.body = 'fetch 异常: ' + (e?.message || e?.name || e);
    }
    out.steps.push(step);
    return step.ok;
  };

  /* burn=1：先跑一遍抓新闻（和线上同一批 fetch），复现"单独能发、一推送就挂" */
  if (doBurn) {
    const t0 = Date.now();
    const before = __fetchCount;
    try {
      const news = await fetchAllNews(env);
      out.fetched = news.length;
    } catch (e) {
      out.fetched = -1;
      out.burnError = 'fetchAllNews 异常: ' + (e?.message || e?.name || e);
    }
    out.fetchUsed = __fetchCount - before; /* 抓新闻用掉多少次 fetch（上限 50，D1/KV 还要另算） */
    out.burnMs = Date.now() - t0;
  }

  await call('getMe');
  await call('getChat', { chat_id: chatId });
  /* 自检消息必须和线上推送同参数（HTML + 链接 + 开预览），否则测出来的是另一条路 */
  if (doSend) {
    await call('sendMessage', {
      chat_id: chatId,
      text: '<b>🔧 TG 自检</b> · 与线上推送同参数（HTML + 链接）\n1. <a href="https://qlzx.lol/news">点这里看新闻页</a>',
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
  }
  out.success = out.steps.every(s => s.ok);
  if (!out.success) out.hint = '看 steps 里第一条 !ok 的 body：401=token 失效，400 chat not found=chat_id 错，403=机器人被踢/无发言权限';
  return out;
}

/* ================= 【五】Telegram 推送实现 ================= */

/* ---------- 原 old-news-api.js 的 "================= Telegram 推送 ================= 段 ---------- */

const TG_SRC_EMOJI = {
  'Hacker News': '🧵', 'GitHub Trending': '⭐', 'V2EX热门': '💬', '微博热搜': '🔥',
  '少数派': '✍️', 'IT之家': '🖥', '百度热搜': '🔍',
  'BBC中文': '📰', '纽约时报中文': '🗽', '爱范儿': '📱', '中新网': '🏛', 'ESPN体育': '🏀',
  '华尔街见闻': '💰', '财联社': '📈', '豆瓣电影': '🎬', '今日头条热榜': '📋', '网易体育': '⚽',
  'NewsAPI体育': '🏅',
  '其他': '📌'
};

/* 单次推送预算：免费版每个 invocation 只有 50 subrequests，一次 fetch = 1。
 * 这里把上限写成常量，超出的部分记日志而不是静默丢弃。 */
const TG_MSG_MAX_LEN  = 3800; /* TG 单条消息 4096 上限，留出 HTML 标签余量 */
const TG_MAX_MESSAGES = 8;    /* 正文消息条数上限 */
const TG_SEND_GAP_MS  = 1200; /* 发送间隔：TG 频道约 20 条/分钟 */

/* 推送必须单独一次 invocation：
 * 实测「抓取 + 推送」挤在一起时，抓取那 18 个源就把免费版每次调用 50 次 subrequest
 * 预算吃光，随后连 api.telegram.org 的 getMe 都抛
 * "Too many subrequests by single Worker invocation" —— 整条推送全挂就是这个原因。
 * 所以：抓取那次只把新增条目塞进下面的 KV 队列，再自调用 /api/cron-push
 * 换一份全新预算去发。队列同时也是失败重推表：发成功才划掉。 */
const SELF_ORIGIN = 'https://qlzx.lol'; /* Worker 自己的域名，用于自调用推送 */
const TG_PUSH_PATH = '/api/cron-push';

/* 待推队列（KV）：存完整条目对象，不只是 key —— 补发时不必再回 D1 查一遍，
 * 也避免条目被 clearOldNews 清掉后补发内容拿不到。 */
const TG_PENDING_KEY = 'tg_pending';
const TG_PENDING_MAX = 300;
const TG_PENDING_TTL = 7 * 86400;

function tgItemKey(it) { return it.link || ('t:' + (it.title || '')); }

/* 队列里是老版本只存 key 的数组时按 [key] 兼容成对象，避免升级瞬间丢条目 */
async function getTgPending(env) {
  try {
    const raw = await env.FILES_KV.get(TG_PENDING_KEY, { type: 'json' });
    if (!Array.isArray(raw)) return [];
    return raw.filter(Boolean).map(it => typeof it === 'string' ? { link: it } : it);
  } catch (e) {
    console.error('[TG] 读取待推队列失败:', e?.message || e);
    return [];
  }
}

/* 待推条目按 key 去重，超上限丢最旧的（队列里的顺序 = 加入顺序） */
function dedupeTgItems(items) {
  const map = new Map();
  for (const it of items || []) {
    if (!it || (!it.link && !it.title)) continue;
    map.delete(tgItemKey(it)); /* 重新 set 让它排到队尾（新的在后，超上限时先丢旧的） */
    map.set(tgItemKey(it), it);
  }
  const uniq = [...map.values()];
  if (uniq.length > TG_PENDING_MAX) {
    console.warn(`[TG] 待推队列超过 ${TG_PENDING_MAX} 条，只保留最新的`);
    uniq.splice(0, uniq.length - TG_PENDING_MAX);
  }
  return uniq;
}

async function saveTgPending(env, items, hadPending) {
  const uniq = dedupeTgItems(items);
  if (!uniq.length && !hadPending) return; /* 本来就没有待重推的，别白写一次 KV */
  try {
    if (uniq.length) await env.FILES_KV.put(TG_PENDING_KEY, JSON.stringify(uniq), { expirationTtl: TG_PENDING_TTL });
    else await env.FILES_KV.delete(TG_PENDING_KEY);
  } catch (e) {
    console.error('[TG] 待重推列表写入失败:', e?.message || e);
  }
}

/* 抓取那次 invocation 把新增条目塞进队列，推送留给 /api/cron-push 去发 */
async function queueTgItems(env, items) {
  if (!items?.length) return;
  try {
    const prev = await getTgPending(env);
    await saveTgPending(env, [...prev, ...items], true);
  } catch (e) {
    console.error('[TG] 待推队列写入失败:', e?.message || e);
  }
}

/* 自调用一次推送：换一份新的 50 次 subrequest 预算。
 * 返回子调用的 tg 统计；自调用本身失败不抛，交给调用方记进 errors（条目还在队列里，下轮补）。 */
async function pushViaChildInvocation(env, items, opts) {
  const empty = { ok: 0, fail: 0, fresh: 0, skipped: 0, retry: 0, errors: [] };
  if (!env.ADMIN_TOKEN) {
    empty.errors.push('未配置 ADMIN_TOKEN，无法自调用推送');
    return empty;
  }
  try {
    const res = await fetch(SELF_ORIGIN + TG_PUSH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      body: JSON.stringify({ items: items || [], full: opts?.full === true })
    });
    const body = await res.text();
    if (!res.ok) {
      empty.errors.push(`自调用推送 ${res.status}: ${body.slice(0, 200)}`);
      return empty;
    }
    const j = JSON.parse(body);
    return j && j.tg ? j.tg : empty;
  } catch (e) {
    empty.errors.push('自调用推送失败: ' + (e?.message || e?.name || e));
    return empty;
  }
}

/* 待推队列里的条目 + 调用方给的条目合并去重（队列是主，调用方给的只是兜底）。
 * opts.onlyNew=false 可强制全量重推（调试用）；默认只推 D1 里没有的新条目。 */
async function pushNewsToTelegram(env, newsData, opts) {
  opts = opts || {};
  const token  = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const stat = { ok: 0, fail: 0, fresh: 0, skipped: 0, retry: 0, errors: [] };
  if (!token || !chatId) {
    console.error('[TG] 跳过推送：TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 未配置');
    return stat;
  }

  /* 队列里的条目上一轮已经确认没发出去/还没轮到，必须当新增处理 */
  const pending = opts.onlyNew === false ? [] : await getTgPending(env);
  const pendingSet = new Set(pending.map(tgItemKey));
  const merged = dedupeTgItems([...(newsData || []), ...pending]);
  if (!merged.length) {
    console.log('[TG] 无待推条目，跳过推送');
    return stat;
  }

  /* 只推新增：每 4 小时把全部 ~300 条重推一遍既刷屏又吃满 subrequests */
  const existing = opts.onlyNew === false ? null : await getExistingKeys(env);
  const fresh = existing
    ? merged.filter(it => {
        const k = tgItemKey(it);
        if (pendingSet.has(k)) return true; /* 队列里的（含上轮没发出去的），补发 */
        return it.link ? !existing.links.has(it.link) : !existing.titles.has(it.title);
      })
    : merged.slice();
  stat.fresh = fresh.length;
  stat.retry = fresh.filter(it => pendingSet.has(tgItemKey(it))).length;
  if (!fresh.length) {
    console.log('[TG] 无新增条目，跳过推送');
    return stat;
  }
  // 新的排前面，这样消息条数被截断时留下的是最新内容
  fresh.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

  /* 失败原因（最多留 3 条）透给调用方，/api/update-news 会返回，方便没日志时排查 */
  const noteErr = (e) => { if (e && stat.errors.length < 3) stat.errors.push(e); };

  // 头部总览：独立一条
  const head = `🗞 <b>新闻更新</b> · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n新增 ${fresh.length} 条`;
  const headRes = await sendTG(token, chatId, head);
  if (headRes.ok) stat.ok++; else { stat.fail++; noteErr(headRes.error); }
  await sleep(TG_SEND_GAP_MS);

  // 按来源分组：一个来源一个小节
  const grouped = {};
  for (const it of fresh) (grouped[it.source || '其他'] ||= []).push(it);

  /* 每个小节按 3800 字符切段（段里记住含哪些条目，失败才好回填待重推），
   * 再把相邻段并进同一条消息 —— 十几个来源从十几次调用压到 2~4 次 */
  const blocks = [];
  for (const [src, items] of Object.entries(grouped)) {
    const emoji = TG_SRC_EMOJI[src] || '📌';
    const header = `<b>${emoji} ${escTg(src)}</b>`;
    let text = header, curItems = [], n = 0;
    for (const it of items) {
      n++;
      const t = escTg(it.title || '');
      let line = it.link ? `${n}. <a href="${escTg(it.link)}">${t}</a>` : `${n}. ${t}`;
      if (it.description) line += `\n   <i>${escTg(it.description)}</i>`;
      if (line.length > TG_MSG_MAX_LEN) line = line.slice(0, TG_MSG_MAX_LEN);
      if (curItems.length && text.length + 1 + line.length > TG_MSG_MAX_LEN) {
        blocks.push({ text, items: curItems });
        text = header; curItems = [];
      }
      text += '\n' + line;
      curItems.push(it);
    }
    if (curItems.length) blocks.push({ text, items: curItems });
  }
  const messages = [];
  for (const b of blocks) {
    const last = messages[messages.length - 1];
    if (last && last.text.length + 2 + b.text.length <= TG_MSG_MAX_LEN) {
      last.text += '\n\n' + b.text;
      last.items.push(...b.items);
    } else {
      messages.push({ text: b.text, items: b.items.slice() });
    }
  }

  const sendList = messages.slice(0, TG_MAX_MESSAGES);
  /* 被条数上限砍掉的段不算发出去，进待重推，下轮补 */
  const undone = messages.slice(TG_MAX_MESSAGES);
  if (undone.length) {
    stat.skipped += undone.length;
    console.warn(`[TG] 正文超上限，本次只发前 ${TG_MAX_MESSAGES} 段，其余 ${undone.length} 段下轮补发`);
  }

  const sentItems = [], failItems = [];
  for (let i = 0; i < sendList.length; i++) {
    const msg = sendList[i];
    const r = await sendTG(token, chatId, msg.text);
    if (r.ok) { stat.ok++; sentItems.push(...msg.items); }
    else { stat.fail++; noteErr(r.error); failItems.push(...msg.items); }
    if (i < sendList.length - 1) await sleep(TG_SEND_GAP_MS);
  }
  for (const m of undone) failItems.push(...m.items);

  /* 发成功的从队列划掉；没发成功的连着内容留在队列里，下轮补发 */
  const sentSet = new Set(sentItems.map(tgItemKey));
  const kept = [...pending, ...failItems].filter(it => !sentSet.has(tgItemKey(it)));
  await saveTgPending(env, kept, pending.length > 0);

  /* 图集/单图推送已下线：豆瓣图床改防盗链后 /api/img 拿不到图，
   * TG 抓图必 400，还白吃 subrequest（免费版每次调用 50 上限）。这里只推文字。 */

  console.log(`[TG] 完成: 新增 ${stat.fresh} 条, ${stat.ok} 段 OK, ${stat.fail} 段失败, ${stat.skipped} 段跳过`);
  if (stat.ok === 0 && stat.fail > 0) {
    console.error('[TG] 一条都没发出去，用 /api/tg-check 查 token/chat_id/网络');
  }
  return stat;
}

/* 返回 { ok, error }：error 里带 TG 原始响应，/api/update-news 会把它透出来，
 * 没权限翻 CF 日志时也能看到失败原因 */
async function sendTG(token, chatId, text) {
  const out = { ok: false, error: '' };
  // 重试 2 次即可：每次失败都吃 subrequest，过多会触发 CF 单次调用上限
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false })
      });
      if (res.ok) { out.ok = true; out.error = ''; return out; }
      const errBody = await res.text();
      out.error = `${res.status}: ${errBody.slice(0, 200)}`;
      console.error(`[TG] 第${attempt}次失败 ${out.error}`);
      if (res.status === 429) {
        try { const j = JSON.parse(errBody); await sleep((j.parameters?.retry_after || 1) * 1000); }
        catch { await sleep(2000); }
      } else if (res.status >= 400 && res.status < 500) {
        return out; // 参数/权限类错误，重试无意义
      } else {
        await sleep(800); // 5xx 服务端错误，稍后重试
      }
    } catch (e) {
      out.error = 'fetch 异常: ' + (e?.message || e?.name || e);
      console.error(`[TG] 第${attempt}次异常:`, out.error);
      await sleep(1000);
    }
  }
  return out;
}

/* HTML 模式转义：引号也要转，链接里带 " 会被 TG 判成非法实体直接 400 */
function escTg(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* 切段逻辑已并入 pushNewsToTelegram：那里要同时记住每段包含哪些条目，
 * 好把发失败的条目回填进待重推列表 */

/* 注意：pickFreshItems / getExistingKeys 原本夹在这一段里，摘 TG 时留在主文件了
 * （主文件 "新闻去重 / 新增判定" 段），恢复时不要再复制一份进来。 */
