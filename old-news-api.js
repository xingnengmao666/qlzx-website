/* =====================================================================
 * 清流中学非官方站 · Cloudflare Worker 主文件
 * 模块: 维护模式 / 新闻聚合(含HN翻译+标注+AI抽检+搜索) /
 *       倒计时 / 临时云盘 / 上传风控 / 毕业留言墙
 * Bindings 需要: DB(D1) FILES_KV(KV) AI(Workers AI)
 *
 * TG 推送已暂时下线（存档见 archive/tg-push.js，恢复步骤写着文件头）。
 * ===================================================================== */

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, ctx, event.cron));
  }
};

/* ================= 主路由 ================= */

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const country = request.cf?.country || 'UNKNOWN';
  const isChina = country === 'CN';

  /* ---- 维护模式管理 ---- */
  if (url.pathname === '/api/maintenance/enable' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('maintenance_mode', 'true').run();
    return jsonResp({ success: true, message: '维护模式已开启' });
  }
  if (url.pathname === '/api/maintenance/disable' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('maintenance_mode', 'false').run();
    return jsonResp({ success: true, message: '维护模式已关闭' });
  }
  if (url.pathname === '/api/maintenance/status') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return jsonResp({ success: true, maintenanceMode: await checkMaintenanceMode(env) });
  }

  /* ---- 维护模式拦截（主页/404 除外）---- */
  if (url.pathname !== '/' && url.pathname !== '/404' && url.pathname !== '/404.html') {
    if (await checkMaintenanceMode(env)) {
      return pageResp(get404HTML(), { status: 404 });
    }
  }

  /* ---- 新闻 ---- */
  if (url.pathname === '/news.html' || url.pathname === '/news') {
    return pageResp(getNewsHTML(), { headers: { 'Cache-Control': 'no-cache' } });
  }
  if (url.pathname === '/api/news') return handleNewsAPI(request, env, ctx);
  if (url.pathname === '/api/news/suggest') return handleNewsSuggest(request, env);

  /* ---- 图片代理：解决豆瓣图床防盗链(418)，仅白名单域可转发 ---- */
  if (url.pathname === '/api/img') return handleImgProxy(request, env);

  /* ---- 管理后台：新闻标注 + AI 随机抽检 ---- */
  if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    return pageResp(getAdminHTML(), { headers: { 'Cache-Control': 'no-cache' } });
  }
  if (url.pathname === '/api/admin/flags' && request.method === 'GET') {
    /* 带 days/only/limit/offset，默认最近 7 天 */
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAdminListFlags(env, url);
  }
  if (url.pathname === '/api/admin/flags' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAdminSetFlag(request, env);
  }
  if (url.pathname === '/api/admin/flags' && request.method === 'DELETE') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAdminDelFlag(request, env);
  }
  if (url.pathname === '/api/admin/review' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAdminReview(request, env);
  }
  if (url.pathname === '/api/admin/review/quota') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAdminReviewQuota(env);
  }
  /* 令牌校验：仅供 /admin 页面解锁前验证密码用，不返回任何后台数据 */
  if (url.pathname === '/api/admin/verify' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return jsonResp({ success: true });
  }

  /* ---- 倒计时 ---- */
  if (url.pathname === '/countdown.html' || url.pathname === '/countdown') {
    return pageResp(getCountdownHTML());
  }
  if (url.pathname === '/api/countdowns') return handleCountdownsAPI(env);
  if (url.pathname === '/api/countdown/add' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAddCountdown(request, env);
  }
  if (url.pathname === '/api/countdown/delete' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDeleteCountdown(request, env);
  }

  /* ---- 强制更新新闻（带详细返回）---- */
  if (url.pathname === '/api/update-news' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    const full = url.searchParams.get('full') === '1';
    const result = { newsOk: false, count: 0, fresh: 0, errors: [] };
    try {
      const newsData = await fetchAllNews(env);
      result.count = newsData.length;
      result.fresh = full ? newsData.length : (await pickFreshItems(env, newsData)).length;
      try {
        await clearOldNews(env);
        await saveNewsToD1(env, newsData);
        result.newsOk = true;
      } catch (e) { result.errors.push('D1: ' + (e.message || e)); }
    } catch (e) {
      result.errors.push('FETCH: ' + (e.message || e));
    }
    return jsonResp({ success: result.newsOk, ...result });
  }

  /* ---- cron 心跳：cron 到底有没有跑起来 ---- */
  if (url.pathname === '/api/cron-status' && request.method === 'GET') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    const [started, result] = await Promise.all([
      env.FILES_KV.get('cron_main_started', { type: 'json' }).catch(() => null),
      env.FILES_KV.get('cron_main_result', { type: 'json' }).catch(() => null)
    ]);
    const now = Date.now();
    return jsonResp({
      success: true, now,
      lastStartedAt: started?.at || 0, sinceStartMin: started?.at ? Math.round((now - started.at) / 60000) : null,
      lastResult: result || null, sinceFinishMin: result?.finishedAt ? Math.round((now - result.finishedAt) / 60000) : null,
      hint: 'lastStartedAt 为 0 = cron 从未触发（查 CF 后台 Triggers）；lastResult.error 有值 = 那一步挂了'
    });
  }

  /* ---- 新闻抓取诊断：最近一轮每源多少条、谁抛错、豆瓣接口回了什么状态码 ----
   * 从 D1 读，不依赖 CF 控制台日志（tail.developers.workers.dev 国内连不上） */
  if (url.pathname === '/api/admin/news-diag' && request.method === 'GET') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'news_diag'").first().catch(() => null);
    let diag = null;
    try { diag = row && row.value ? JSON.parse(row.value) : null; } catch { diag = null; }
    return jsonResp({ success: true, now: Date.now(), diag });
  }

  /* ---- 临时云盘 ---- */
  if (url.pathname === '/drive' || url.pathname === '/drive.html') {
    return pageResp(getDriveHTML());
  }
  /* 分片上传：init 建会话 -> chunk × N -> complete 收尾；任何一步失败都该调 abort 清理 */
  if (url.pathname === '/api/drive/upload/init' && request.method === 'POST') {
    return handleDriveUploadInit(request, env);
  }
  if (url.pathname === '/api/drive/upload/chunk' && request.method === 'POST') {
    return handleDriveUploadChunk(request, env);
  }
  if (url.pathname === '/api/drive/upload/complete' && request.method === 'POST') {
    return handleDriveUploadComplete(request, env, ctx);
  }
  if (url.pathname === '/api/drive/upload/abort' && request.method === 'POST') {
    return handleDriveUploadAbort(request, env);
  }
  if (url.pathname === '/api/drive/usage') {
    return handleDriveUsage(env);
  }
  /* 老页面（缓存的 HTML）还在用的一次性上传，保留 */
  if (url.pathname === '/api/drive/upload' && request.method === 'POST') {
    return handleDriveUpload(request, env, ctx);
  }
  /* 自定义短链 /s/<别名>：公开访问，别名即地址 */
  if (url.pathname.startsWith('/s/') && url.pathname.length > 3) {
    return handleDriveShort(decodeURIComponent(url.pathname.slice(3)), env, request);
  }
  if (url.pathname === '/api/drive/short' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDriveShortCreate(request, env);
  }
  if (url.pathname === '/api/drive/shorts') {
    /* 短链列表含文件 id，跟文件列表一样只给管理员 */
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDriveShortList(env);
  }
  if (url.pathname === '/api/drive/short/delete' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDriveShortDelete(request, env);
  }
  if (url.pathname === '/api/drive/list') {
    /* 文件列表含全部文件 id/名称，仅管理员可见，防遍历下载 */
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDriveList(env);
  }
  if (url.pathname.startsWith('/api/drive/file/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/drive/file/', ''));
    return handleDriveDownload(id, env, request);
  }
  if (url.pathname === '/api/drive/delete' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDriveDelete(request, env);
  }
  if (url.pathname === '/api/drive/rl/status') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleRlStatus(request, env);
  }
  if (url.pathname === '/api/drive/rl/unblock' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleRlUnblock(request, env);
  }
  /* ---- 考试模式（集成自 exam-mode-web，功能不变） ---- */
  if (url.pathname === '/exam' || url.pathname === '/exam.html') {
    return pageResp(getExamHTML());
  }

  /* ---- 毕业留言墙 ---- */
  if (url.pathname === '/wall' || url.pathname === '/wall.html') {
    return pageResp(getWallHTML(), { headers: { 'Cache-Control': 'no-cache' } });
  }
  if (url.pathname === '/api/wall/config') return handleWallConfig(env);
  if (url.pathname === '/api/wall/messages') return handleWallList(request, env);
  if (url.pathname === '/api/wall/message' && request.method === 'POST') return handleWallCreate(request, env, ctx);
  if (url.pathname.startsWith('/api/wall/message/')) return handleWallDetail(request, env, url);
  if (url.pathname === '/api/wall/report' && request.method === 'POST') return handleWallReport(request, env);
  /* 留言墙管理端：复用现有 ADMIN_TOKEN 鉴权与 /admin 后台，不新建后台 */
  /* ---- 班费收支（高一（7）班公开账本）----
   * 公开只读；写入走 /api/admin/fund/*，主后台 ADMIN_TOKEN 或班费后台 FUND_ADMIN_TOKEN
   * 任一通过即可（指导2 §30：鉴权在路由层，不靠前端藏按钮） */
  if (url.pathname === '/fund' || url.pathname === '/fund.html') {
    return pageResp(getFundHTML(), { headers: { 'Cache-Control': 'no-cache' } });
  }
  if (url.pathname === '/fund-admin' || url.pathname === '/fund-admin.html') {
    return pageResp(getFundAdminHTML(), { headers: { 'Cache-Control': 'no-cache' } });
  }
  if (url.pathname === '/api/fund/ledger') return handleFundLedger(request, env);
  if (url.pathname.startsWith('/api/fund/record/')) return handleFundRecord(env, url);
  if (url.pathname === '/api/fund-admin/verify' && request.method === 'POST') {
    return handleFundAdminVerify(request, env);
  }
  if (url.pathname.startsWith('/api/admin/fund/')) {
    if (!isAnyAdmin(request, env)) {
      /* 口令短的公开接口：失败尝试按 IP 计数，超限直接 429 */
      if (await fundAdminBlocked(env, request)) {
        return jsonResp({ success: false, error: '尝试次数过多，请 15 分钟后再试' }, 429);
      }
      await fundAdminFail(env, request);
      return new Response('Unauthorized', { status: 401 });
    }
    return handleAdminFund(request, env, url);
  }

  if (url.pathname.startsWith('/api/admin/wall/')) {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAdminWall(request, env, url);
  }

  /* ---- 404 / 主页 ---- */
  if (url.pathname === '/404' || url.pathname === '/404.html') {
    return pageResp(get404HTML(), { status: 404 });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return pageResp(getLandingHTML());
  }

  return pageResp(get404HTML(), { status: 404 });
}

/* ================= 通用工具 ================= */

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'X-Content-Type-Options': 'nosniff', ...extraHeaders }
  });
}

/* 全站页面安全头：CSP(防外域脚本注入/点击劫持) + nosniff + frame 禁嵌 */
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' https: data: blob:; connect-src 'self'; font-src 'self' https: data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};
function pageResp(body, opts = {}) {
  return new Response(body, {
    status: opts.status || 200,
    headers: { 'content-type': 'text/html;charset=UTF-8', ...SECURITY_HEADERS, ...(opts.headers || {}) }
  });
}

function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false; /* 未配置令牌一律拒绝，防字面量 "Bearer undefined" 绕过 */
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;
}

/* 班费账本独立后台口令（环境变量 FUND_ADMIN_TOKEN）。
 * 目的：班费可以单独交给生活委员维护，不必把全站 ADMIN_TOKEN 给出去。
 * 口令短、接口公开，所以失败尝试按 IP 计数封禁（见 FUND_ADMIN_RL）。 */
function isFundAdmin(request, env) {
  if (!env.FUND_ADMIN_TOKEN) return false; /* 未配置一律拒绝，防 "Bearer undefined" 绕过 */
  return request.headers.get('Authorization') === `Bearer ${env.FUND_ADMIN_TOKEN}`;
}
/* 主后台与班费后台都能改账目：两条口令任一通过即可 */
function isAnyAdmin(request, env) {
  return isAdmin(request, env) || isFundAdmin(request, env);
}

/* ================= 维护模式 ================= */

async function checkMaintenanceMode(env) {
  try {
    const { results } = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('maintenance_mode').all();
    if (results && results.length > 0) return results[0].value === 'true';
    return false;
  } catch (error) {
    console.error('检查维护模式失败:', error);
    return false;
  }
}

/* ================= Cron 调度 ================= */

/* D1/AI 偶发失败（如 D1_ERROR: internal error）时自动重试 */
async function withRetry(fn, { retries = 2, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/* news 表不存在时自动建表（D1 重建后自愈） */
async function ensureNewsTable(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      link TEXT,
      description TEXT,
      source TEXT,
      image TEXT,
      pub_date INTEGER,
      created_at INTEGER
    )`).run();
  } catch (e) { /* 表已存在或 D1 暂时不可用, 后续写入时会再报 */ }
  /* 存量库补 image 列：CREATE IF NOT EXISTS 不会给已有表加列，ALTER 报"列已存在"直接吞掉 */
  try {
    await env.DB.prepare('ALTER TABLE news ADD COLUMN image TEXT').run();
  } catch (e) { /* 已存在或 D1 暂不可用，下次 cron 再试 */ }
}

/* 新闻管理标注表：按 link(稳定 URL) 存，news 表每次刷新清空重插不影响标注 */
async function ensureNewsReviewsTable(env) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  } catch (e) { /* D1 暂不可用，下次再试 */ }
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS news_reviews (
      link TEXT PRIMARY KEY,
      title TEXT,
      source TEXT,
      flags TEXT DEFAULT '[]',
      note TEXT,
      method TEXT,
      reviewed_at INTEGER,
      reviewer TEXT
    )`).run();
    /* 「已标注列表」按时间倒序取最近几天，走索引别全表扫 */
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_review_time ON news_reviews(reviewed_at DESC)').run();
  } catch (e) { /* D1 暂不可用，下次再试 */ }
}

/* Cron 分两个时间点，各自独立 invocation = 各自一份 50 subrequests 预算。
 * 挤在一次里跑（抓取 18 + D1 + AI 抽检）会把额度吃光，后半段整批丢。
 * 见 wrangler.old-news.toml 的 crons 配置。 */
const CRON_MAIN = '0 */4 * * *';    /* 抓取 + 入库 */
const CRON_REVIEW = '30 */4 * * *'; /* AI 抽检，错开 30 分钟单独跑 */

async function handleScheduled(env, ctx, cron) {
  if (cron === CRON_REVIEW) return handleScheduledReview(env);
  if (cron && cron !== CRON_MAIN) console.log(`[Cron] 未知 cron 表达式: ${cron}，按主任务处理`);
  return handleScheduledMain(env);
}

/* cron 心跳：写进 KV，/api/cron-status 读出来。
 * 新闻没更新时先看这里 —— 时间戳是旧的说明 cron 根本没触发，比翻日志快 */
async function cronBeat(env, key, value) {
  try {
    await env.FILES_KV.put(key, JSON.stringify(value), { expirationTtl: 7 * 86400 });
  } catch (e) { /* 心跳失败不影响主流程 */ }
}

async function handleScheduledMain(env) {
  const t0 = Date.now();
  const startedAt = Date.now();
  console.log('[Cron] 开始:', new Date().toISOString());
  await cronBeat(env, 'cron_main_started', { at: startedAt });

  await ensureNewsTable(env);

  let newsData = [];
  let fetchError = '';
  try {
    newsData = await fetchAllNews(env);
    console.log(`[Cron] 抓到 ${newsData.length} 条`);
  } catch (e) { fetchError = String(e?.message || e); console.error('[Cron] 抓取失败:', e?.stack || e); }

  /* 判断新增要读 D1 里的旧链接，必须在 clearOldNews 之前 */
  let freshItems = [];
  try {
    freshItems = await pickFreshItems(env, newsData);
    console.log(`[Cron] 新增 ${freshItems.length} 条`);
  } catch (e) { console.error('[Cron] 判定新增失败:', e?.stack || e); }

  try {
    await clearOldNews(env);
    await saveNewsToD1(env, newsData);
    console.log('[Cron] D1 写入完成');
  } catch (e) { console.error('[Cron] D1 写入失败:', e?.stack || e); }

  console.log(`[Cron] 全部结束,用时 ${Date.now() - t0}ms`);
  await cronBeat(env, 'cron_main_result', {
    startedAt, finishedAt: Date.now(), fetched: newsData.length, fresh: freshItems.length,
    error: fetchError
  });
}

/* AI 随机抽检：5 条，受全天额度限制，用尽则跳过 */
async function handleScheduledReview(env) {
  try {
    const r = await runAIReview(env, 5);
    console.log(`[Cron:AI] 抽检完成: reviewed=${r.reviewed.length} failed=${r.failed.length} skipped=${r.skipped}`);
  } catch (e) { console.error('[Cron:AI] 抽检失败:', e?.stack || e); }
}

/* ================= 新闻抓取 ================= */

/* 源→抓取函数表：模块级，供 fetchAllNews 与自愈刷新(检查缺源)共用。
 * 需要 env 的抓取函数签名 (env)，其余忽略该参数。新增源：此表 + CAT_MAP + SRC_EMOJI */
const NEWS_SOURCE_FETCHERS = {
  'V2EX热门':        () => fetchV2EXHot(),
  '微博热搜':        () => fetchWeiboHotNew(),
  'Hacker News':     env => fetchHackerNews(env),
  'GitHub Trending': env => fetchGitHubTrending(env),
  '少数派':          () => fetchSsPaiNews(),
  'IT之家':          () => fetchITHome(),
  '百度热搜':        () => fetchBaiduHot(),
  /* 无 key 源：RSS 直抓 + 公开 JSON 接口，按大类补充（源→大类见页面 CAT_MAP） */
  'BBC中文':         () => fetchRSS('https://feeds.bbci.co.uk/zhongwen/trad/rss.xml', 10),
  '纽约时报中文':    () => fetchRSS('https://cn.nytimes.com/rss/', 10),
  '爱范儿':          () => fetchRSS('https://www.ifanr.com/feed', 10),
  '中新网':          () => fetchRSS('https://www.chinanews.com.cn/rss/scroll-news.xml', 12),
  'ESPN体育':        env => fetchESPN(env),
  '华尔街见闻':      () => fetchWallStreetCn(),
  '财联社':          () => fetchClsTelegraph(),
  '豆瓣电影':        () => fetchDoubanMovie(),
  '今日头条热榜':    () => fetchToutiaoHot(),
  '网易体育':        () => fetchNetEaseSports(),
  'NewsAPI体育':     env => fetchNewsAPI(env) /* 需 NEWSAPI_KEY 密钥 */
};

/* 每源诊断：抓取函数可以往里塞一行说明（HTTP 状态、格式异常等），fetchAllNews 结束后
 * 整体落库到 settings.news_diag。起因：豆瓣这类源失败只在 console 留痕，而 wrangler tail
 * 用的 tail.developers.workers.dev 在国内被 DNS 污染 + 连接重置，控制台日志根本拉不下来；
 * 落进 D1 就能随时 wrangler d1 execute --remote 查。
 * 只留最近一次运行，最多 60 行，取不到日志时这条是唯一线索。 */
const SOURCE_DIAG = [];
function sourceNote(text) {
  if (SOURCE_DIAG.length < 60) SOURCE_DIAG.push(text);
}

/* 并发闸门：Workers 同时打开连接上限是 6（免费/付费同值），18 源一次性全发会被运行时
 * 排队甚至取消（"stalled HTTP response was canceled to prevent deadlock" 一类报错）。 */
const FETCH_CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function fetchAllNews(env) {
  const names = Object.keys(NEWS_SOURCE_FETCHERS);
  const started = Date.now();
  SOURCE_DIAG.length = 0;
  translateReset(); /* 翻译预算按轮重置 */
  const per = {};
  const lists = await mapLimit(names, FETCH_CONCURRENCY, async name => {
    const t0 = Date.now();
    try {
      const list = (await NEWS_SOURCE_FETCHERS[name](env)) || [];
      per[name] = { n: list.length, ms: Date.now() - t0 };
      /* 每条源都留一行：以前只有抛错才记日志，静默返回空数组的源在日志里根本不出现，
       * 于是「某个源一条都没有」只能靠翻数据库才发现 */
      if (!list.length) { console.error(`[新闻源] ${name} 返回 0 条`); sourceNote(`[新闻源] ${name} 返回 0 条`); }
      else console.log(`[新闻源] ${name} ${list.length} 条`);
      return list.map(it => ({ ...it, source: name }));
    } catch (err) {
      per[name] = { n: 0, ms: Date.now() - t0, err: String(err?.message || err) };
      console.error(`[新闻源] ${name} 抛错:`, err?.stack || err);
      sourceNote(`[新闻源] ${name} 抛错: ${err?.message || err}`);
      return [];
    }
  });
  try {
    await saveNewsDiag(env, names.map(n => ({ name: n, ...(per[n] || { n: 0 }) })), Date.now() - started);
  } catch (e) {
    console.error('[诊断] 落库失败:', e?.message || e);
  }
  return lists.flat();
}

/* 把本轮每源的条数/耗时/错误 + 抓取过程中记下的说明写进 settings.news_diag。
 * 诊断自己出问题绝不能影响抓取，所以调用处已经包了 try/catch。 */
async function saveNewsDiag(env, sources, ms) {
  if (!env || !env.DB) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  const payload = { at: Date.now(), ms, zero: sources.filter(s => !s.n).length, translate: translateSpent, sources, notes: SOURCE_DIAG.slice() };
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind('news_diag', JSON.stringify(payload)).run();
}

/* NewsAPI 体育（用户付费/免费 key，服务端读取，绝不下发客户端） */
async function fetchNewsAPI(env) {
  if (!env.NEWSAPI_KEY) return [];
  try {
    const r = await fetch(`https://newsapi.org/v2/top-headlines?category=sports&language=en&pageSize=12&apiKey=${encodeURIComponent(env.NEWSAPI_KEY)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return [];
    const j = await r.json();
    if (!j || !Array.isArray(j.articles)) return [];
    const list = j.articles.map(a => ({
      title: (a.title || '').slice(0, 120),
      link: a.url || '',
      description: (a.description || '').slice(0, 100),
      image: a.urlToImage || '',
      pubDate: a.publishedAt ? new Date(a.publishedAt).getTime() : Date.now()
    })).filter(it => it.title);
    return translateItems(env, list);
  } catch (e) {
    console.error('NewsAPI 获取失败:', e);
    return [];
  }
}

async function fetchV2EXHot() {
  const r = await fetch('https://www.v2ex.com/api/topics/hot.json', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.slice(0, 15).map(it => ({
    title: it.title,
    link: `https://www.v2ex.com/t/${it.id}`,
    description: it.content ? it.content.slice(0, 100) : '',
    pubDate: it.created ? it.created * 1000 : Date.now()
  }));
}

async function fetchHackerNews(env) {
  try {
    const r = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const ids = await r.json();
    if (!Array.isArray(ids)) return [];

    // 控制条数：减少 subrequest，避免超 CF 单次调用 50 次 fetch 上限
    const items = await Promise.all(ids.slice(0, 8).map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) })
        .then(x => x.json()).catch(() => null)
    ));

    const alive = items.filter(Boolean);
    const zh = await translateBatchToZh(env, alive.map(it => it.title)); /* 8 个标题一次翻完 */
    return alive.map(it => {
      const t = zh.get(it.title);
      return {
        title: t && t !== it.title ? `${t}（${it.title}）` : it.title,
        link: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
        description: `${it.score || 0} points | ${it.descendants || 0} comments`,
        pubDate: it.time ? it.time * 1000 : Date.now()
      };
    });
  } catch (e) {
    console.error('Hacker News 获取失败:', e);
    return [];
  }
}

let translateWarned = false;

/* ---- 翻译的子请求预算 ----
 * 单次 invocation 的 subrequest 上限是 50 次。以前英文源逐条翻译（HN 8 条 + GitHub 10 条 +
 * ESPN 10 条 × 标题/描述，每条还要顺次试 m2m100 → glm → 谷歌），随便就吃满，
 * 排在抓取表后面的豆瓣电影 / 今日头条热榜 / 网易体育 于是全部
 * "Too many subrequests by single Worker invocation" 直接 0 条 —— 豆瓣「接口有问题」的真身。
 * 对策：同一轮里同一段文本只翻一次 + 整轮翻译子请求封顶，超了保留原文（宁可没译文，
 * 也不能让后面的源整条消失）。 */
const TRANSLATE_MAX_PER_RUN = 20;
const translateMemo = new Map();
let translateSpent = 0;
function translateReset() { translateMemo.clear(); translateSpent = 0; }

/* Workers AI 的返回形状不稳定：老的文本模型给 { response }，对话模型给
 * OpenAI 那套 { choices:[{message:{content}}] }，有的还带 <redacted_reasoning> 思考段。
 * 统一在这里取正文，思考段一律丢掉（里面也有编号列表，会污染批量翻译的逐行解析）。 */
function aiText(res) {
  if (!res) return '';
  let t = '';
  if (typeof res === 'string') t = res;
  else if (typeof res.response === 'string') t = res.response;
  else {
    const c = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if (typeof c === 'string') t = c;
    else if (Array.isArray(c)) t = c.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
    else if (res.result && typeof res.result.response === 'string') t = res.result.response;
  }
  return t.replace(/^[\s\S]*<\/redacted_reasoning>/, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

/* 带预算与去重的单条翻译：真正干活的是 translateToZhRaw */
async function translateToZh(env, text) {
  if (!text) return text;
  if (translateMemo.has(text)) return translateMemo.get(text);
  if (translateSpent >= TRANSLATE_MAX_PER_RUN) return text;
  translateSpent++;
  const out = await translateToZhRaw(env, text);
  translateMemo.set(text, out);
  return out;
}

/* 批量翻译：一次 Workers AI 调用翻一批，替代「一条一个子请求」。
 * 走对话模型 + 编号列表 —— m2m100 这类翻译模型只吃单条字符串，塞数组直接报错，
 * 之前「批量」实际退化成逐条，预算照样被吃光。
 * 返回 Map<原文, 译文>；查不到的（空文本 / 预算用尽 / 调用失败）调用方保留原文。 */
async function translateBatchToZh(env, texts) {
  const out = new Map();
  const todo = [];
  for (const t of (texts || [])) {
    if (!t) continue;
    if (translateMemo.has(t)) { out.set(t, translateMemo.get(t)); continue; }
    if (!todo.includes(t)) todo.push(t);
  }
  if (!todo.length || !env.AI || translateSpent >= TRANSLATE_MAX_PER_RUN) return out;
  const batch = todo.slice(0, 30); /* 一次别塞太多，模型有输入上限 */
  const model = env.TRANSLATE_FALLBACK || '@cf/zai-org/glm-4.7-flash';
  translateSpent++;
  try {
    const res = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '把用户给的编号列表逐条翻译成简体中文。必须保持条数和编号一一对应，只输出译文列表，不要解释、不要合并或拆分行。' },
        { role: 'user', content: batch.map((t, i) => `${i + 1}. ${t}`).join('\n') }
      ]
    });
    const got = [];
    for (const line of aiText(res).split('\n')) {
      const m = line.match(/^\s*(\d+)\s*[.、)]\s*(.+?)\s*$/);
      if (m) got[Number(m[1]) - 1] = m[2]; /* 后出现的覆盖先出现的：思考过程里的编号行会被正文盖掉 */
    }
    batch.forEach((t, i) => {
      const v = got[i] && got[i].trim();
      if (v && v !== t) { translateMemo.set(t, v); out.set(t, v); }
    });
    if (!got.filter(Boolean).length) sourceNote(`[翻译] 批量返回无法解析（${model}）`);
  } catch (e) {
    console.warn('批量翻译失败:', e?.message || e);
    sourceNote(`[翻译] 批量调用失败: ${e?.message || e}`);
  }
  /* 批量没覆盖到的，用 m2m100 单条补最多 6 条 —— 兜底有上限，
   * 否则一个源就能把整轮预算吃光，后面的源又要整条消失 */
  let topped = 0;
  for (const t of batch) {
    if (topped >= 6 || translateSpent >= TRANSLATE_MAX_PER_RUN) break;
    if (out.has(t)) continue;
    topped++;
    const zh = await translateToZh(env, t);
    if (zh && zh !== t) out.set(t, zh);
  }
  return out;
}

async function translateToZhRaw(env, text) {
  if (!text) return text;

  // 1) Workers AI 专用翻译模型 m2m100-1.2b（省 token），可环境变量覆盖
  if (env.AI) {
    try {
      const primary = env.TRANSLATE_MODEL || '@cf/meta/m2m100-1.2b';
      const res = await env.AI.run(primary, {
        text, source_lang: 'english', target_lang: 'chinese'
      });
      const zh = (res && res.translated_text) ? String(res.translated_text).trim() : '';
      if (zh) return zh;
    } catch (e) { /* 继续兜底 */ }
  }

  // 2) 快速多语模型 glm-4.7-flash
  if (env.AI) {
    try {
      const fallback = env.TRANSLATE_FALLBACK || '@cf/zai-org/glm-4.7-flash';
      if (fallback) {
        const res = await env.AI.run(fallback, {
          messages: [
            { role: 'system', content: 'Translate the following English text into natural Chinese. Reply with the translation only.' },
            { role: 'user', content: text }
          ]
        });
        const out = aiText(res);
        if (out) return out;
      }
    } catch (e) { /* 继续兜底 */ }
  }

  // 3) 谷歌翻译（最后兜底，翻译质量差）
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const j = await r.json();
      const t = (Array.isArray(j) && Array.isArray(j[0]) && Array.isArray(j[0][0])) ? j[0][0][0] : null;
      if (t && t.trim() && t.trim() !== text) return t.trim();
    }
  } catch (e) { /* 全部失败，返回原文 */ }

  // 翻译只是锦上添花，失败不影响抓取；只告警一次避免刷屏
  if (!translateWarned) {
    console.warn('翻译不可用(仅告警一次): 所有翻译通道均失败');
    translateWarned = true;
  }
  return text;
}

/* 英文源统一翻译：标题必翻，描述非空则翻（keepDescription=true 时跳过描述）。
 * 走批量接口，整源只花 1 次子请求（以前每 title/description 各一次）。 */
async function translateItems(env, items, opts) {
  opts = opts || {};
  const texts = [];
  for (const it of items) {
    texts.push(it.title || '');
    if (it.description && !opts.keepDescription) texts.push(it.description);
  }
  const zh = await translateBatchToZh(env, texts);
  return items.map(it => {
    let title = it.title || '';
    const zhT = zh.get(title);
    if (zhT && zhT !== title) title = `${zhT}（${title}）`;
    let description = it.description || '';
    if (description && !opts.keepDescription) {
      const zhD = zh.get(description);
      if (zhD && zhD !== description) description = zhD;
    }
    return { ...it, title, description };
  });
}

async function fetchGitHubTrending(env) {
  // GitHub 官方搜索 API：近 7 天创建、按 star 排序（未认证限 60 次/时，定时任务够用）
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const r = await fetch(
    `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=10`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return [];
  const data = await r.json();
  if (!Array.isArray(data.items)) return [];
  /* repo 名保留原文，仅翻译英文描述；描述字段星标/语言不翻 */
  const items = data.items.slice(0, 10);
  const zh = await translateBatchToZh(env, items.map(it => it.description || '')); /* 10 条描述一次翻完 */
  return items.map(it => {
    const name = it.name || '';
    const desc = it.description || '';
    const d = zh.get(desc);
    const descZh = d && d !== desc ? `${d}（${desc}）` : desc;
    return {
      title: desc ? `${name} - ${descZh}` : name,
      link: it.html_url || `https://github.com/${it.full_name}`,
      description: `⭐ ${it.stargazers_count || 0} | ${it.language || 'Unknown'}`,
      pubDate: it.created_at ? new Date(it.created_at).getTime() : Date.now()
    };
  });
}

async function fetchSsPaiNews() {
  const r = await fetch('https://sspai.com/feed', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  return parseRSS(await r.text()).slice(0, 10);
}

/* 微博热搜：官方 API 优先（需带 Referer），多源兜底 */
const WEIBO_APIS = [
  { url: 'https://weibo.com/ajax/side/hotSearch',
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'Referer': 'https://weibo.com/' },
    pick: d => d?.data?.realtime },
  { url: 'https://weibo.com/ajax/statuses/hot_band',
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'Referer': 'https://weibo.com/' },
    pick: d => d?.data?.band_list },
  { url: 'https://api.vvhan.com/api/hotlist/wbHot',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    pick: d => d?.data },
  { url: 'https://orz.ai/api/v1/dailynews/?platform=weibo',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    pick: d => d?.data }
];
async function fetchWeiboHotNew() {
  for (const { url, headers, pick } of WEIBO_APIS) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();
      let list = pick(data);
      if (!Array.isArray(list) && Array.isArray(data)) list = data;
      if (!Array.isArray(list) || !list.length) continue;
      return list.slice(0, 15).map(it => {
        const title = it.word || it.word_scheme || it.title || it.query || '';
        const hot = it.num || it.raw_hot || it.hot;
        return {
          title,
          link: it.url || it.link || `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`,
          description: hot ? `${hot.toLocaleString()} 热度` : (it.note || ''),
          pubDate: it.timestamp ? it.timestamp * 1000 : Date.now()
        };
      });
    } catch (e) { /* 换下一个 API */ }
  }
  return [];
}

async function fetchITHome() {
  const r = await fetch('https://www.ithome.com/rss/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  return parseRSS(await r.text()).slice(0, 10);
}

async function fetchBaiduHot() {
  const r = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  const data = await r.json();
  const cards = (data && data.data && Array.isArray(data.data.cards)) ? data.data.cards : [];
  const out = [];
  for (const c of cards) {
    if (c.component !== 'tabTextList' || !Array.isArray(c.content)) continue;
    for (const row of c.content) {
      if (!Array.isArray(row.content)) continue;
      for (const it of row.content) {
        if (it && it.word) out.push({
          title: it.word,
          link: it.url || `https://www.baidu.com/s?wd=${encodeURIComponent(it.word)}`,
          description: '',
          pubDate: Date.now()
        });
      }
    }
  }
  return out.slice(0, 15);
}

/* 通用 RSS 抓取：新增 RSS 源复用（parseRSS 只认 RSS 2.0，RDF RSS 1.0 源勿用） */
async function fetchRSS(url, n = 10) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  return parseRSS(await r.text()).slice(0, n);
}

/* ESPN 体育（英文）：RSS 抓取后整体翻译标题+摘要 */
async function fetchESPN(env) {
  const items = await fetchRSS('https://www.espn.com/espn/rss/news', 10);
  return translateItems(env, items);
}

/* 华尔街见闻 7x24 全球快讯（官方移动端公开接口，免 key） */
async function fetchWallStreetCn() {
  const r = await fetch('https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=20', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://wallstreetcn.com/' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  const j = await r.json();
  const items = (j && j.data && Array.isArray(j.data.items)) ? j.data.items : [];
  return items.map(it => ({
    title: it.title || '',
    link: it.uri || `https://wallstreetcn.com/livenews/${it.id}`,
    description: it.content_text ? it.content_text.slice(0, 100) : '',
    pubDate: it.display_time ? it.display_time * 1000 : Date.now()
  })).filter(it => it.title);
}

/* 财联社 A 股电报快讯（社区逆向公开缓存接口，带 Referer 更稳，改版后可能需 sign） */
async function fetchClsTelegraph() {
  const r = await fetch('https://www.cls.cn/api/cache?app=CailianpressWeb&name=telegraph&os=web&sv=8.7.9', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cls.cn/telegraph' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  const j = await r.json();
  const rows = (j && j.data && Array.isArray(j.data.roll_data)) ? j.data.roll_data : [];
  return rows.map(it => ({
    title: it.title || '',
    link: `https://www.cls.cn/detail/${it.id}`,
    description: it.brief || '',
    pubDate: it.ctime ? it.ctime * 1000 : Date.now()
  })).filter(it => it.title);
}

/* 豆瓣电影 热门榜单。
 * 豆瓣对机房 / 海外 IP 时松时紧：网页版接口 /j/search_subjects 从 Cloudflare 出口经常整段
 * 403/418，所以主接口拿不到就退到移动端 rexxar 接口（对海外宽松些）。
 * 每一步都写日志 —— 以前这里 `if (!r.ok) return []` 一声不吭，日志里什么都看不到，
 * 结果就是「豆瓣长期 0 条但没人知道为什么」。 */
async function fetchDoubanMovie() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120';
  const tries = [
    {
      label: 'web j/search_subjects',
      url: 'https://movie.douban.com/j/search_subjects?type=movie&tag=' + encodeURIComponent('热门') + '&sort=recommend&page_limit=20&page_start=0',
      headers: { 'User-Agent': UA, 'Referer': 'https://movie.douban.com/explore' },
      pick: j => (j && Array.isArray(j.subjects) ? j.subjects : []).map(it => ({
        title: it.title || '', link: it.url || '',
        description: it.rate ? `豆瓣评分 ${it.rate}` : '',
        image: it.cover || ''
      }))
    },
    {
      label: 'm rexxar movie_showing',
      url: 'https://m.douban.com/rexxar/api/v2/subject_collection/movie_showing/items?os=android&for_mobile=1&start=0&count=20',
      headers: { 'User-Agent': UA, 'Referer': 'https://m.douban.com/subject_collection/movie_showing' },
      pick: j => (j && Array.isArray(j.subject_collection_items) ? j.subject_collection_items : []).map(it => ({
        title: it.title || '', link: it.url || '',
        description: (it.rating && it.rating.value) ? `豆瓣评分 ${it.rating.value}` : (it.card_subtitle || ''),
        image: (it.cover && it.cover.url) || it.pic || ''
      }))
    }
  ];
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { headers: t.headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.error(`[豆瓣电影] ${t.label} HTTP ${r.status}`); sourceNote(`[豆瓣电影] ${t.label} HTTP ${r.status}`); continue; }
      const j = await r.json().catch(() => null);
      const list = t.pick(j).filter(it => it.title && it.link).map(it => ({
        ...it,
        image: it.image ? '/api/img?u=' + encodeURIComponent(it.image) : '', /* 走本站代理，带豆瓣 Referer 抓图，绕开 418 防盗链 */
        pubDate: Date.now()
      }));
      if (!list.length) {
        console.error(`[豆瓣电影] ${t.label} 返回 0 条（格式变了或被拦了）`);
        sourceNote(`[豆瓣电影] ${t.label} 返回 0 条（格式变了或被拦了）`);
        continue;
      }
      console.log(`[豆瓣电影] ${t.label} 取到 ${list.length} 条`);
      return list;
    } catch (e) {
      console.error(`[豆瓣电影] ${t.label} 请求失败: ${e?.message || e}`);
      sourceNote(`[豆瓣电影] ${t.label} 请求失败: ${e?.message || e}`);
    }
  }
  console.error('[豆瓣电影] 两个接口都没取到，本轮跳过');
  sourceNote('[豆瓣电影] 两个接口都没取到');
  return [];
}

/* 今日头条热榜（官方接口，需 UA + Referer） */
async function fetchToutiaoHot() {
  const r = await fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', 'Referer': 'https://www.toutiao.com/' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  const j = await r.json();
  const arr = (j && Array.isArray(j.data)) ? j.data : [];
  return arr.map(it => ({
    title: it.Title || it.title || '',
    link: it.Url || it.url || '',
    description: it.Label || '',
    pubDate: Date.now()
  })).filter(it => it.title);
}

/* 网易体育（官方 JSONP，GBK 编码：剥函数壳后按 GBK 解码再 JSON.parse） */
async function fetchNetEaseSports() {
  const r = await fetch('https://temp.163.com/special/00804KVA/cm_sports.js', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  const buf = await r.arrayBuffer();
  let txt;
  try { txt = new TextDecoder('gbk').decode(buf); }
  catch (e) { txt = new TextDecoder('utf-8').decode(buf); }
  const s = txt.indexOf('['), e = txt.lastIndexOf(']');
  if (s < 0 || e < 0) return [];
  let arr;
  try { arr = JSON.parse(txt.slice(s, e + 1)); } catch (err) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(it => ({
    title: it.title || '',
    link: it.docurl || '',
    description: it.digest || '',
    pubDate: Date.now()
  })).filter(it => it.title);
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const c = m[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(c) || /<title>(.*?)<\/title>/.exec(c) || [])[1];
    /* 部分源（如 cn.nytimes.com）把 link 也塞进 CDATA，不剥掉会存成
       "<![CDATA[https://...]]>"，前端当相对路径解析 → 跳到 本站/<编码后的垃圾> */
    const link  = (/<link><!\[CDATA\[(.*?)\]\]><\/link>/.exec(c) || /<link>(.*?)<\/link>/.exec(c) || [])[1];
    const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(c) || /<description>(.*?)<\/description>/.exec(c) || [])[1];
    const date  = (/<pubDate>(.*?)<\/pubDate>/.exec(c) || [])[1];
    if (title) items.push({
      title: decodeEntities(title).trim(),
      link: link ? link.trim() : '',
      // 先解码实体（&lt;a&gt; → <a>）再剥标签，避免残留垃圾 HTML
      description: desc ? stripHtml(decodeEntities(desc).trim()).slice(0, 100) : '',
      image: extractImage(c, desc || ''),
      pubDate: date ? new Date(date).getTime() : Date.now()
    });
  }
  return items;
}

/* HTML 实体解码（&amp; 最后解，防止双重编码） */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/* RSS 图片提取：enclosure / media:content / description 内嵌 img 三处兜底，无图返回空串 */
function extractImage(c, desc) {
  var m = (/<enclosure[^>]+url="([^"]+)"/i.exec(c) ||
           /<media:content[^>]+url="([^"]+)"/i.exec(c) ||
           /<img[^>]+src="([^"]+)"/i.exec(desc) || [])[1];
  return m ? m.trim() : '';
}

/* ================= 新闻 D1 / API ================= */

async function clearOldNews(env) {
  try {
    await withRetry(() => env.DB.prepare('DELETE FROM news').run());
    return true;
  } catch (e) {
    console.error('清空数据失败:', e?.stack || e);
    return false;
  }
}

async function saveNewsToD1(env, arr) {
  if (!arr || !arr.length) return;
  const stmt = env.DB.prepare(
    'INSERT OR IGNORE INTO news (title, link, description, source, image, pub_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  /* 表有 UNIQUE(title,source)：同源内重复标题会整批报错。先按 (title,source) 去重再写 */
  const seen = new Set();
  const batch = [];
  for (const it of arr) {
    const key = (it.title || '') + '\u0000' + (it.source || '');
    if (seen.has(key)) continue;
    seen.add(key);
    batch.push(stmt.bind(it.title, it.link, it.description || '', it.source, it.image || '', it.pubDate, Date.now()));
  }
  /* D1 batch 单次上限 100 条 statement，源多后总量超限，按 90 分块写入 */
  for (let i = 0; i < batch.length; i += 90) {
    await withRetry(() => env.DB.batch(batch.slice(i, i + 90)));
  }
}

/* 新闻管理标注目录：key → 中文标签。服务端校验 + 页面渲染共用 */
const NEWS_FLAGS = [
  ['political', '疑似夹带第三国政治立场'],
  ['biased', '探究方向不客观'],
  ['subjective', '内容属个人主观判断'],
  ['clickbait', '标题党·夸大事实'],
  ['unverified', '事实存疑·缺乏来源'],
  ['ad', '软广·商业推广']
];
const NEWS_FLAG_KEYS = NEWS_FLAGS.map(f => f[0]);

/* AI 随机抽检目标源：限定来源（管理员要求仅此四项） */
const REVIEW_TARGETS = ['BBC中文', '纽约时报中文', '中新网', '今日头条热榜'];

async function handleNewsAPI(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    let sql = 'SELECT title, link, description, source, image, pub_date, created_at FROM news';
    let binds = [];
    if (q) {
      /* 用 instr 子串查找替代 LIKE：LIKE 对部分长标题/特殊字符会触发 SQLite "pattern too complex" 500 */
      sql += ' WHERE instr(lower(title), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0';
      binds = [q, q];
    }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT 400';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    const data = results.map(r => ({
      title: r.title, link: r.link, description: r.description, source: r.source, image: r.image || '', pubDate: r.pub_date
    }));
    /* 打乱顺序：同一源一次入库的 created_at 相同，DB 排序会让来源整段连续。
     * 瀑布流贪心插最矮列 + 单列列表都按数组序取，不打乱则同源新闻扎堆一列。搜索模式不随机，按相关度/时间排。 */
    if (!q) {
      for (let i = data.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [data[i], data[j]] = [data[j], data[i]];
      }
    }
    /* 批量注入管理标注：link 存在 news_reviews 则带 flags[]。D1 单条 SQL 变量数有限，分块查 */
    if (data.length && env.DB) {
      await ensureNewsReviewsTable(env).catch(() => {});
      const links = data.map(it => it.link).filter(Boolean);
      const flagMap = {};
      if (links.length) {
        for (let i = 0; i < links.length; i += 90) {
          const chunk = links.slice(i, i + 90);
          const { results: rev } = await env.DB.prepare(
            'SELECT link, flags FROM news_reviews WHERE link IN (' + chunk.map(() => '?').join(',') + ')'
          ).bind(...chunk).all();
          (rev || []).forEach(r => { try { flagMap[r.link] = JSON.parse(r.flags || '[]'); } catch (e) { flagMap[r.link] = []; } });
        }
      }
      data.forEach(it => { it.flags = flagMap[it.link] || []; });
    }
    const { results: u } = await env.DB.prepare('SELECT MAX(created_at) as last_update FROM news').all();
    const lastUpdate = u[0]?.last_update || Date.now();
    maybeAutoRefresh(env, ctx, data, lastUpdate); /* 缺源/过期 → 后台补抓，KV 锁防并发 */
    return jsonResp({
      success: true, data, count: data.length, search: q || '',
      updateTime: new Date(lastUpdate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    }, 200, { 'Cache-Control': q ? 'public, max-age=10' : 'public, max-age=60' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 搜索建议：库里已有新闻按标题匹配，供下拉推荐 */
async function handleNewsSuggest(request, env) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return jsonResp({ success: true, data: [] });
    const { results } = await env.DB.prepare(
      'SELECT title, link, source FROM news WHERE instr(lower(title), lower(?)) > 0 ORDER BY created_at DESC LIMIT 20'
    ).bind(q).all();
    return jsonResp({ success: true, data: results });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 图片代理：豆瓣图床防盗链(非 douban.com Referer 返回 418)，前端无法直连。
 * 由 Worker 带正确 Referer 抓取后回传，前端从本站加载。白名单仅放行豆瓣图床域名，防 SSRF。 */
const IMG_PROXY_ALLOWED = /^img\d+\.doubanio\.com$/;
async function handleImgProxy(request) {
  const u = new URL(request.url).searchParams.get('u');
  if (!u) return new Response('bad request', { status: 400 });
  let target;
  try { target = new URL(u); }
  catch (e) { return new Response('bad url', { status: 400 }); }
  if (target.protocol !== 'https:' || !IMG_PROXY_ALLOWED.test(target.hostname)) {
    return new Response('forbidden host', { status: 403 });
  }
  try {
    const r = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', 'Referer': 'https://movie.douban.com/' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return new Response('upstream ' + r.status, { status: 502 });
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      headers: {
        'Content-Type': r.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (e) {
    return new Response('proxy error', { status: 500 });
  }
}

/* ================= 管理后台：新闻标注 + AI 随机抽检 ================= */

/* 列表：默认只看最近 7 天、最近在前、按页取。
 * 这一栏回答的是「最近抽检到什么了」，不是「历史上一共抽检过什么」——
 * 立项至今的全都堆上来，翻不到尽头，等于没法看。
 * 参数：days（0 = 不限时间）、only=flagged（只看有问题的）、limit/offset 翻页 */
const FLAG_LIST_DEFAULT_DAYS = 7;
const FLAG_LIST_DEFAULT_LIMIT = 50;
const FLAG_LIST_MAX_LIMIT = 200;
const FLAG_LIST_MAX_DAYS = 3650;

function flagsWhere({ since, onlyFlagged }) {
  const w = [], args = [];
  if (since) { w.push('reviewed_at >= ?'); args.push(since); }
  if (onlyFlagged) w.push("flags IS NOT NULL AND flags NOT IN ('', '[]')");
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', args };
}

async function handleAdminListFlags(env, url) {
  try {
    await ensureNewsReviewsTable(env).catch(() => {});
    const q = url ? url.searchParams : new URLSearchParams();
    const daysRaw = parseInt(q.get('days') || String(FLAG_LIST_DEFAULT_DAYS), 10);
    const days = Number.isFinite(daysRaw) && daysRaw >= 0 ? Math.min(daysRaw, FLAG_LIST_MAX_DAYS) : FLAG_LIST_DEFAULT_DAYS;
    const onlyFlagged = q.get('only') === 'flagged';
    const limit = Math.min(Math.max(parseInt(q.get('limit') || String(FLAG_LIST_DEFAULT_LIMIT), 10) || FLAG_LIST_DEFAULT_LIMIT, 1), FLAG_LIST_MAX_LIMIT);
    const offset = Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0);
    const since = days > 0 ? Date.now() - days * 86400000 : 0;

    const listW = flagsWhere({ since, onlyFlagged });
    const allW = flagsWhere({ since, onlyFlagged: false });
    const flaggedW = flagsWhere({ since, onlyFlagged: true });

    const [rows, totalRow, flaggedRow] = await Promise.all([
      env.DB.prepare(
        'SELECT link, title, source, flags, note, method, reviewed_at, reviewer FROM news_reviews' + listW.sql +
        ' ORDER BY reviewed_at DESC LIMIT ? OFFSET ?'
      ).bind(...listW.args, limit, offset).all(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM news_reviews' + allW.sql).bind(...allW.args).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM news_reviews' + flaggedW.sql).bind(...flaggedW.args).first()
    ]);
    const list = (rows.results || []).map(r => {
      let flags = [];
      try { flags = JSON.parse(r.flags || '[]'); } catch (e) {}
      return { ...r, flags };
    });
    return jsonResp({
      success: true, data: list, flags: NEWS_FLAGS,
      days, only: onlyFlagged ? 'flagged' : 'all', offset, limit,
      since: since || null,
      total: onlyFlagged ? Number(flaggedRow?.n) || 0 : Number(totalRow?.n) || 0,
      counts: { total: Number(totalRow?.n) || 0, flagged: Number(flaggedRow?.n) || 0, shown: list.length },
      hasMore: offset + list.length < (onlyFlagged ? Number(flaggedRow?.n) || 0 : Number(totalRow?.n) || 0)
    });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 手动标注 upsert */
async function handleAdminSetFlag(request, env) {
  try {
    const body = await request.json();
    const link = (body.link || '').trim();
    if (!link) return jsonResp({ success: false, error: '缺少 link' }, 400);
    let flags = Array.isArray(body.flags) ? body.flags.filter(f => NEWS_FLAG_KEYS.includes(f)) : [];
    flags = [...new Set(flags)];
    const note = String(body.note || '').slice(0, 500);
    const title = String(body.title || '').slice(0, 300);
    const source = String(body.source || '').slice(0, 60);
    await ensureNewsReviewsTable(env).catch(() => {});
    await env.DB.prepare(
      `INSERT INTO news_reviews (link, title, source, flags, note, method, reviewed_at, reviewer)
       VALUES (?, ?, ?, ?, ?, 'manual', ?, 'admin')
       ON CONFLICT(link) DO UPDATE SET title=excluded.title, source=excluded.source,
         flags=excluded.flags, note=excluded.note, method='manual', reviewed_at=excluded.reviewed_at, reviewer='admin'`
    ).bind(link, title, source, JSON.stringify(flags), note, Date.now()).run();
    return jsonResp({ success: true, link, flags });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 删除标注 */
async function handleAdminDelFlag(request, env) {
  try {
    const body = await request.json();
    const link = String(body.link || '').trim();
    if (!link) return jsonResp({ success: false, error: '缺少 link' }, 400);
    await env.DB.prepare('DELETE FROM news_reviews WHERE link = ?').bind(link).run();
    return jsonResp({ success: true, link });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 配额状态：settings 表按日计数 */
async function getReviewQuotaState(env) {
  const quota = Math.max(1, parseInt(env.AI_REVIEW_QUOTA || '30', 10) || 30);
  const today = new Date().toISOString().slice(0, 10);
  let used = 0;
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
      .bind('ai_review_date', 'ai_review_used').all();
    let date = null;
    (results || []).forEach(r => { if (r.key === 'ai_review_date') date = r.value; else if (r.key === 'ai_review_used') used = parseInt(r.value, 10) || 0; });
    if (date !== today) used = 0; /* 跨天重置 */
  } catch (e) { /* 读失败按 0 处理 */ }
  return { quota, used, date: today };
}

async function handleAdminReviewQuota(env) {
  try {
    await ensureNewsReviewsTable(env).catch(() => {});
    const q = await getReviewQuotaState(env);
    return jsonResp({ success: true, ...q });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* AI 审查：解析模型输出的 JSON，容错只留已知 flag key */
function parseAIReview(raw) {
  const s = String(raw || '').trim();
  let obj = null;
  try {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) obj = JSON.parse(s.slice(a, b + 1));
  } catch (e) { obj = null; }
  if (!obj || typeof obj !== 'object') return null;
  const flags = Array.isArray(obj.flags)
    ? [...new Set(obj.flags.filter(f => NEWS_FLAG_KEYS.includes(f)))]
    : [];
  const note = String(obj.note || '').slice(0, 300);
  const confidence = Math.max(0, Math.min(1, parseFloat(obj.confidence) || 0));
  return { flags, note, confidence };
}

async function aiReviewOne(env, it) {
  const model = env.REVIEW_MODEL || '@cf/zai-org/glm-4.7-flash';
  const prompt = `你是校园新闻聚合站的内容审查助手。审查下面这条新闻，判断它是否存在以下问题，严格输出 JSON，不要任何多余文字：
- political: 疑似夹带第三国政治立场（隐含境外政治倾向、站队、立场引导）
- biased: 探究方向不客观（片面取材、预设立场、诱导性措辞）
- subjective: 内容属个人主观判断（无依据的个人观点、情绪化表达）
- clickbait: 标题党、夸大事实
- unverified: 事实存疑、缺乏来源依据
- ad: 软广、商业推广

标题：${it.title || ''}
来源：${it.source || ''}
描述：${(it.description || '').slice(0, 300)}

输出：{"flags":["上面提到的key，没有则为空数组"],"note":"一句中文说明","confidence":0到1之间的小数}`;
  const res = await env.AI.run(model, {
    messages: [
      { role: 'system', content: '你是严格的中文内容审查助手，只输出 JSON。' },
      { role: 'user', content: prompt }
    ]
  });
  /* Workers AI chat 返回 OpenAI 风格 choices[].message.content，个别模型是 {response} */
  const out = res && (
    (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ||
    res.response || res.result
  );
  const parsed = parseAIReview(out);
  if (parsed) return parsed;
  return { __err: '解析失败: ' + JSON.stringify(res).slice(0, 400) };
}

/* 随机抽检：从目标源随机取未审新闻，AI 审查写库；日配额受控 */
async function runAIReview(env, requested) {
  const count = Math.max(1, Math.min(parseInt(requested, 10) || 5, 30));
  const targets = REVIEW_TARGETS;
  const sql = `SELECT title, link, description, source FROM news
     WHERE source IN (${targets.map(() => '?').join(',')})
       AND link NOT IN (SELECT link FROM news_reviews)
     ORDER BY RANDOM() LIMIT ?`;
  let cand;
  try {
    cand = await env.DB.prepare(sql).bind(...targets, count).all();
  } catch (e) {
    return { reviewed: [], failed: [{ link: '', title: 'SQL错误', note: e.message }], skipped: 0, quota: await getReviewQuotaState(env), reason: 'SQL错误: ' + e.message };
  }
  const items = cand?.results || [];
  if (!items.length) return { reviewed: [], skipped: 0, quota: await getReviewQuotaState(env), reason: '目标源无可抽检的未审新闻', debug: { count, targetN: targets.length, bindN: [...targets, count].length } };

  /* 并发 3 条控制墙钟；每条先占配额槽位，失败释放，绝不超日额度 */
  const reviewed = [], failed = [];
  const q0 = await getReviewQuotaState(env);
  let usedNow = q0.used;
  const CHUNK = 3;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (it) => {
      let reserved = false;
      if (usedNow >= q0.quota) return;
      usedNow++; reserved = true; /* 预占槽位 */
      const got = await aiReviewOne(env, it).catch(e => ({ __err: (e && e.message) || String(e) }));
      if (!got || got.__err) { if (reserved) usedNow--; failed.push({ link: it.link, title: it.title, note: got ? 'AI: ' + got.__err : 'AI 审查失败' }); return; }
      const model = env.REVIEW_MODEL || '@cf/zai-org/glm-4.7-flash';
      await env.DB.prepare(
        `INSERT OR REPLACE INTO news_reviews (link, title, source, flags, note, method, reviewed_at, reviewer)
         VALUES (?, ?, ?, ?, ?, 'ai', ?, ?)`
      ).bind(it.link, it.title, it.source, JSON.stringify(got.flags),
        (got.flags.length ? `[${got.confidence.toFixed(2)}] ` : '') + got.note, Date.now(), model).run().catch(() => {});
      reviewed.push({ link: it.link, title: it.title, source: it.source, flags: got.flags, note: got.note, confidence: got.confidence });
    }));
  }
  /* 结束后统一落一次配额（并发中逐条写会踩到失败释放的槽位，导致计数虚高） */
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind('ai_review_used', String(usedNow)).run().catch(() => {});
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind('ai_review_date', q0.date).run().catch(() => {});
  return { reviewed, failed, skipped: items.length - reviewed.length, quota: await getReviewQuotaState(env) };
}

async function handleAdminReview(request, env) {
  try {
    await ensureNewsReviewsTable(env).catch(() => {});
    const body = await request.json().catch(() => ({}));
    const q = await getReviewQuotaState(env);
    if (q.used >= q.quota) return jsonResp({ success: false, error: `今日 AI 抽检额度已用完 (${q.used}/${q.quota})` }, 429);
    const result = await runAIReview(env, body.count || 5);
    return jsonResp({ success: true, ...result });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 自愈刷新：D1 缺源 / 数据过少 / 超过 6 小时未更 → 触发后台补抓。
 * KV 锁 2 小时：首次部署后首个页面请求即补全新源；后续源挂了也会自愈，但不至于刷爆配额。 */
function maybeAutoRefresh(env, ctx, data, lastUpdate) {
  if (!env.FILES_KV || !ctx) return;
  const now = Date.now();
  const has = new Set(data.map(it => it.source));
  const missing = Object.keys(NEWS_SOURCE_FETCHERS).some(n => !has.has(n));
  const stale = now - (lastUpdate || 0) > 6 * 3600 * 1000;
  const tooFew = data.length < 15;
  if (!missing && !stale && !tooFew) return;
  ctx.waitUntil((async () => {
    try {
      const lock = await env.FILES_KV.get('news_auto_refresh').catch(() => null);
      if (lock && now - Number(lock) < 2 * 3600 * 1000) return;
      await env.FILES_KV.put('news_auto_refresh', String(now)).catch(() => {});
      const newsData = await fetchAllNews(env);
      if (newsData.length) {
        await clearOldNews(env);
        await saveNewsToD1(env, newsData);
        console.log(`[AutoRefresh] 补抓完成 ${newsData.length} 条`);
      }
    } catch (e) { console.error('[AutoRefresh] 失败:', e?.stack || e); }
    finally { await env.FILES_KV.delete('news_auto_refresh').catch(() => {}); }
  })());
}

/* ================= 新闻去重 / 新增判定 ================= */

/* 挑出 D1 里还没有的条目（= 本次真正的新增）。必须在写 D1 之前调用 */
async function pickFreshItems(env, newsData) {
  const existing = await getExistingKeys(env);
  if (!existing) return newsData.slice(); /* D1 读失败按全量兜底 */
  return newsData.filter(it => it.link ? !existing.links.has(it.link) : !existing.titles.has(it.title));
}

/* 已入库条目的键：链接为主，少数没链接的源退回按标题判重。
 * 读失败返回 null，调用方按全量处理 */
async function getExistingKeys(env) {
  try {
    const { results } = await env.DB.prepare('SELECT link, title FROM news').all();
    const links = new Set(), titles = new Set();
    for (const r of results || []) {
      if (r.link) links.add(r.link);
      if (r.title) titles.add(r.title);
    }
    return { links, titles };
  } catch (e) {
    console.error('[News] 读取已有条目失败，本次按全量处理:', e?.message || e);
    return null;
  }
}

/* ================= 倒计时 ================= */

async function handleCountdownsAPI(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, title, target_time, created_at FROM countdowns ORDER BY target_time ASC'
    ).all();
    return jsonResp({ success: true, data: results }, 200, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleAddCountdown(request, env) {
  try {
    const { title, target_time } = await request.json();
    const titleStr = String(title || '').slice(0, 60);
    if (!titleStr || !target_time) return jsonResp({ success: false, error: '标题和目标时间不能为空' }, 400);
    const ts = new Date(target_time).getTime();
    if (isNaN(ts)) return jsonResp({ success: false, error: '无效的时间格式' }, 400);
    await env.DB.prepare('INSERT INTO countdowns (title, target_time, created_at) VALUES (?, ?, ?)')
      .bind(titleStr, ts, Date.now()).run();
    return jsonResp({ success: true, message: '倒计时添加成功' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleDeleteCountdown(request, env) {
  try {
    const { id } = await request.json();
    if (!id) return jsonResp({ success: false, error: 'ID 不能为空' }, 400);
    await env.DB.prepare('DELETE FROM countdowns WHERE id = ?').bind(id).run();
    return jsonResp({ success: true, message: '倒计时删除成功' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* ================= 临时云盘 + 风控 ================= */

const DRIVE_PREFIX = 'file:';
const DRIVE_SHORT_PREFIX = 'short:';              /* 短链别名 -> 文件 id */
const DRIVE_TTL_SECONDS = 12 * 60 * 60;           /* 匿名上传：12 小时 */
const DRIVE_SHARE_TTL_SECONDS = 14 * 24 * 3600;   /* 临时口令上传 = 短链默认寿命：14 天 */
const DRIVE_SHORT_MAX_DAYS = 365;
const DRIVE_SHORT_RE = /^[A-Za-z0-9_-]{3,32}$/;   /* 短链别名：够短、够安全，别放奇怪字符 */
const DRIVE_MAX_BYTES = 25 * 1024 * 1024;         /* 兼容老页面：multipart 单次上传的硬上限 */

/* ---- 分片存储 ----
 * KV 单值上限 25MiB，大文件只能切开存：file:<id>:<n>，n 从 0 起。
 * 片大小取 24MiB 而不是 25MiB，留 1MiB 余量，别卡在边界上。
 * 老格式 file:<id>（KV metadata 里没有 chunkCount）照样能读能删，不用迁移。 */
const DRIVE_CHUNK_BYTES = 24 * 1024 * 1024;
const DRIVE_MAX_FILE_BYTES = 500 * 1024 * 1024;   /* 单文件上限，前端也校验一遍 */
const DRIVE_SESSION_PREFIX = 'up:';               /* 上传会话：声明大小 + 身份，complete 时凭它记账 */
const DRIVE_SESSION_TTL = 3600;

/* 免费版 KV 存储 1GB/命名空间，且这个命名空间是两个 worker 共用的。
 * 从这里读的是「云端盘占用」，超了就拒新上传，别等 KV 自己报错。 */
const DRIVE_KV_LIMIT_BYTES = 1024 * 1024 * 1024;
const DRIVE_KV_SOFT_LIMIT_BYTES = 950 * 1024 * 1024;

/* 别名不能撞站点已有路由，否则 /s/xxx 会被前面的路由先截走 */
const DRIVE_SHORT_RESERVED = new Set([
  'api', 's', 'drive', 'drive.html', 'admin', 'fund', 'fund-admin', 'fund.html', 'fund-admin.html',
  'wall', 'wall.html', 'news', 'news.html', 'exam', 'exam.html', 'countdown', 'img', 'index', 'index.html',
  '404', '404.html', 'robots.txt', 'sitemap.xml', 'favicon.ico'
]);

/* 自定义短链：格式 / 保留字 / 是否被占用，一次说清楚怎么改 */
function driveShortValidate(alias) {
  const a = String(alias || '').trim();
  if (!a) return { error: '请填写短链名字' };
  if (!DRIVE_SHORT_RE.test(a)) return { error: '短链只能用 3-32 位字母、数字、下划线、短横线' };
  if (DRIVE_SHORT_RESERVED.has(a.toLowerCase())) return { error: '「' + a + '」是站点已有地址，换一个' };
  return { value: a };
}
async function driveShortGet(env, alias) {
  try { return await env.FILES_KV.get(DRIVE_SHORT_PREFIX + alias, { type: 'json' }); }
  catch (e) { return null; }
}
/* days=0 表示永不过期（只有管理员能这么建）；其余 1..365（临时口令封顶 14 天） */
function driveShortTtlSeconds(days, { allowForever, maxDays }) {
  const n = Number(days);
  const d = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), maxDays || DRIVE_SHORT_MAX_DAYS) : 14;
  if (allowForever && n === 0) return 0;
  return d * 24 * 3600;
}
/* 短链只对「口令上传的文件」有意义：匿名文件 12 小时就没了，链还在也打不开 */
async function driveShortPut(env, { alias, id, name, size, type, days, allowForever, maxDays, createdBy }) {
  const ttl = driveShortTtlSeconds(days, { allowForever, maxDays });
  const now = Date.now();
  const data = {
    alias, id,
    name: name || '', size: size || 0, type: type || '',
    createdAt: now,
    expiresAt: ttl ? now + ttl * 1000 : null,
    createdBy: createdBy || 'admin'
  };
  const opts = { metadata: { id } };
  if (ttl) opts.expirationTtl = ttl;
  await env.FILES_KV.put(DRIVE_SHORT_PREFIX + alias, JSON.stringify(data), opts);
  return data;
}
function driveShortUrl(alias) { return '/s/' + alias; }

const RL_KEY_BLOCK = 'rl:bl:';
const RL_KEY_COUNT = 'rl:cnt:';
const RL_KEY_BYTES = 'rl:byte:';

function getRateLimitConfig(country) {
  return country === 'CN'
    ? { label: 'CN',    windowSec: 3600, maxCount: 15, maxBytes: 200 * 1024 * 1024, blockSec: 30 * 60 }
    : { label: 'OTHER', windowSec: 3600, maxCount: 6,  maxBytes: 80  * 1024 * 1024, blockSec: 2 * 60 * 60 };
}

async function checkUploadAllowed(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const country = request.cf?.country || 'UNKNOWN';
  const cfg = getRateLimitConfig(country);

  const blocked = await env.FILES_KV.get(RL_KEY_BLOCK + ip, { type: 'json' });
  if (blocked && blocked.until && blocked.until > Date.now()) {
    return { allowed: false, ip, country, cfg, blocked,
      retryAfterSec: Math.ceil((blocked.until - Date.now()) / 1000) };
  }
  const [c, b] = await Promise.all([
    env.FILES_KV.get(RL_KEY_COUNT + ip),
    env.FILES_KV.get(RL_KEY_BYTES + ip)
  ]);
  return { allowed: true, ip, country, cfg,
    curCount: parseInt(c || '0', 10) || 0, curBytes: parseInt(b || '0', 10) || 0 };
}

function recordUpload(env, ctx, ip, fileSize, cfg) {
  const task = (async () => {
    try {
      const [c, b] = await Promise.all([
        env.FILES_KV.get(RL_KEY_COUNT + ip),
        env.FILES_KV.get(RL_KEY_BYTES + ip)
      ]);
      const newCnt = (parseInt(c || '0', 10) || 0) + 1;
      const newBytes = (parseInt(b || '0', 10) || 0) + (fileSize || 0);
      await Promise.all([
        env.FILES_KV.put(RL_KEY_COUNT + ip, String(newCnt), { expirationTtl: cfg.windowSec }),
        env.FILES_KV.put(RL_KEY_BYTES + ip, String(newBytes), { expirationTtl: cfg.windowSec })
      ]);
      if (newCnt > cfg.maxCount || newBytes > cfg.maxBytes) {
        const reason = newCnt > cfg.maxCount ? 'too_many_uploads' : 'too_much_bytes';
        await env.FILES_KV.put(RL_KEY_BLOCK + ip, JSON.stringify({
          reason, region: cfg.label, count: newCnt, bytes: newBytes,
          blockedAt: Date.now(), until: Date.now() + cfg.blockSec * 1000
        }), { expirationTtl: cfg.blockSec });
        console.warn(`[风控] 已封禁 IP=${ip} 区域=${cfg.label} 原因=${reason}`);
      }
    } catch (e) { console.error('风控记录失败:', e); }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(task); else return task;
}

/* ================= 分片存储：公共小工具 ================= */

/* 片数：老格式（metadata 里没写过 chunkCount）算 0，代表「单键、无下标」 */
function driveChunkCount(meta) {
  const n = Number(meta && meta.chunkCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function driveChunkKey(id, i, total) {
  return total > 0 ? DRIVE_PREFIX + id + ':' + i : DRIVE_PREFIX + id;
}
function driveAllKeys(id, total) {
  if (!total) return [DRIVE_PREFIX + id];
  const out = [];
  for (let i = 0; i < total; i++) out.push(DRIVE_PREFIX + id + ':' + i);
  return out;
}
function driveChunkCountForSize(size) {
  return Math.max(1, Math.ceil((Number(size) || 0) / DRIVE_CHUNK_BYTES));
}

/* 找一份文件的元信息：要么是分片的 <id>:0，要么是老格式的 <id>。
 * 用 list 而不是 get，因为 get 会把整个 24MB 读进来，这里只要 metadata。
 * 键名按字典序，file:<id> 排在 file:<id>:0 前面，limit 2 够用。 */
async function driveReadMeta(env, id) {
  const base = DRIVE_PREFIX + id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await env.FILES_KV.list({ prefix: base, limit: 2 });
    for (const k of page.keys) {
      /* expiration 是秒；列表和文件详情都要用它算「还剩多久」 */
      if (k.name === base + ':0') return { meta: k.metadata || {}, total: driveChunkCount(k.metadata), legacy: false, expiration: k.expiration || null };
      if (k.name === base) return { meta: k.metadata || {}, total: 0, legacy: true, expiration: k.expiration || null };
    }
    /* 刚传完的片可能还没在本地边缘生效，隔一会儿再看一眼 */
    if (attempt < 2) await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

/* 云盘占用：只认每份文件的「片 0」（或老格式单键），整份大小记在它的 metadata 里，
 * 非 0 号片不写 metadata，所以不会重复计。 */
async function driveUsage(env) {
  let bytes = 0, files = 0, cursor;
  do {
    const page = await env.FILES_KV.list({ prefix: DRIVE_PREFIX, cursor });
    for (const k of page.keys) {
      const rest = k.name.slice(DRIVE_PREFIX.length);
      const colon = rest.indexOf(':');
      if (colon >= 0 && rest.slice(colon + 1) !== '0') continue;
      bytes += Number((k.metadata || {}).size) || 0;
      files++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { bytes, files, limitBytes: DRIVE_KV_LIMIT_BYTES, softLimitBytes: DRIVE_KV_SOFT_LIMIT_BYTES };
}

/* 边取边吐：pull() 由运行时按下游消费速度回调，内存里最多压着一两片。
 * 分片丢失只会在流已经开始之后发现，客户端表现为下载中断 —— 日志里留痕。 */
function driveBodyStream(env, id, total, start, end) {
  const size = DRIVE_CHUNK_BYTES;
  let idx = Math.floor(start / size);
  let offset = start - idx * size;
  let remain = end - start + 1;
  return new ReadableStream({
    async pull(controller) {
      if (remain <= 0) { controller.close(); return; }
      try {
        const buf = await env.FILES_KV.get(driveChunkKey(id, idx, total), { type: 'arrayBuffer' });
        if (!buf) throw new Error('分片 ' + idx + ' 丢失或已过期');
        const take = Math.min(remain, buf.byteLength - offset);
        if (take <= 0) throw new Error('分片 ' + idx + ' 长度异常');
        controller.enqueue(new Uint8Array(buf, offset, take));
        remain -= take;
        offset = 0;
        idx++;
        if (remain <= 0) controller.close();
      } catch (e) {
        console.error('[Drive] 分片流出错 id=' + id + ' 片=' + idx + ':', e?.message || e);
        controller.error(e);
      }
    }
  });
}

/* 单段 Range：只认 bytes=a-b / bytes=a- / bytes=-n，多段不接（返回整份即可） */
function driveParseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasA = m[1] !== '', hasB = m[2] !== '';
  if (!hasA && !hasB) return null;
  let start, end;
  if (!hasA) {
    const n = parseInt(m[2], 10);
    if (!n) return { invalid: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasB ? parseInt(m[2], 10) : size - 1;
    if (end > size - 1) end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

async function driveSessionGet(env, id) {
  if (!id) return null;
  try { return await env.FILES_KV.get(DRIVE_SESSION_PREFIX + id, { type: 'json' }); }
  catch (e) { return null; }
}

/* ================= 分片上传：init / chunk / complete / abort =================
 * 为什么不在 Worker 里拆：Worker 请求体上限按 CF 套餐（免费/Pro 100MB）封顶，
 * 内存又只有 128MB，formData + arrayBuffer + 切片拷贝三轮下来实际安全线 60~80MB。
 * 所以由浏览器 File.slice() 切片，每片 ≤24MiB 单独发上来，Worker 只负责存。 */

async function handleDriveUploadInit(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || 'unnamed').slice(0, 200);
    const size = Number(body.size) || 0;
    const type = String(body.type || 'application/octet-stream').slice(0, 120);
    const pwd = String(body.admin_token || '').trim();
    if (!(size > 0)) return jsonResp({ success: false, error: '文件大小无效' }, 400);
    if (size > DRIVE_MAX_FILE_BYTES) return jsonResp({
      success: false, error: `文件 ${(size / 1048576).toFixed(1)}MB 超过单文件 ${DRIVE_MAX_FILE_BYTES / 1048576}MB 上限`
    }, 400);

    const isAdminUpload = !!pwd && !!env.ADMIN_TOKEN && pwd === env.ADMIN_TOKEN;
    const isGuestUpload = !isAdminUpload && !!pwd && !!env.GUEST_UPLOAD_TOKEN && pwd === env.GUEST_UPLOAD_TOKEN;
    const maxDays = isGuestUpload ? DRIVE_SHARE_TTL_SECONDS / 86400 : DRIVE_SHORT_MAX_DAYS;

    /* 短链别名在这儿就校验：别等 500MB 传完了才说「别名被占了」 */
    let alias = '';
    const wantAlias = String(body.alias || '').trim();
    if (wantAlias) {
      if (!isAdminUpload && !isGuestUpload) {
        return jsonResp({ success: false, error: '自定义短链需要口令：匿名上传的文件 12 小时就过期，短链会变成死链' }, 400);
      }
      const av = driveShortValidate(wantAlias);
      if (av.error) return jsonResp({ success: false, error: av.error }, 400);
      if (await driveShortGet(env, av.value)) return jsonResp({ success: false, error: '短链「' + av.value + '」已被占用，换一个' }, 409);
      alias = av.value;
    }

    /* 风控按「声明总大小」一次算清：分片上传是 N 个请求，按请求计数会把 IP 自己封了 */
    let ip = '', rlCfg = null;
    if (!isAdminUpload) {
      const rl = await checkUploadAllowed(env, request);
      ip = rl.ip;
      rlCfg = rl.cfg;
      if (!rl.allowed) {
        return new Response(JSON.stringify({
          success: false, error: '上传过于频繁，IP 已被临时限制，请稍后再试',
          region: rl.cfg.label, retryAfterSec: rl.retryAfterSec, blockedUntil: rl.blocked?.until
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Retry-After': String(rl.retryAfterSec || 60) }
        });
      }
      if (rl.curBytes + size > rl.cfg.maxBytes) {
        return jsonResp({
          success: false, error: '本次上传将超过该 IP 在当前时段的总流量配额',
          region: rl.cfg.label, remainBytes: Math.max(0, rl.cfg.maxBytes - rl.curBytes)
        }, 429);
      }
    }

    /* 存储余量：免费版 KV 只有 1GB，还是两个 worker 共用，超了写入会直接失败 */
    const usage = await driveUsage(env);
    if (usage.bytes + size > DRIVE_KV_SOFT_LIMIT_BYTES) {
      return jsonResp({
        success: false,
        error: `云盘空间不足：已用 ${(usage.bytes / 1048576).toFixed(0)}MB / ${(DRIVE_KV_LIMIT_BYTES / 1048576).toFixed(0)}MB，本次还需 ${(size / 1048576).toFixed(0)}MB`,
        usage
      }, 507);
    }

    const id = crypto.randomUUID();
    const chunkCount = driveChunkCountForSize(size);
    const now = Date.now();
    const ttlSeconds = isAdminUpload ? 0 : (isGuestUpload ? DRIVE_SHARE_TTL_SECONDS : DRIVE_TTL_SECONDS);
    const session = {
      id, name, size, type, chunkCount, ttlSeconds, maxDays, alias, ip, rlCfg,
      permanent: !!isAdminUpload, guest: !!isGuestUpload,
      uploadedAt: now, expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : null,
      days: body.days === undefined || body.days === '' ? null : body.days
    };
    await env.FILES_KV.put(DRIVE_SESSION_PREFIX + id, JSON.stringify(session), { expirationTtl: DRIVE_SESSION_TTL });

    return jsonResp({
      success: true, id, chunkSize: DRIVE_CHUNK_BYTES, chunkCount,
      permanent: session.permanent, guest: session.guest, expiresAt: session.expiresAt,
      maxFileBytes: DRIVE_MAX_FILE_BYTES, usage
    });
  } catch (e) {
    console.error('上传初始化失败:', e);
    return jsonResp({ success: false, error: e.message || '上传初始化失败' }, 500);
  }
}

async function handleDriveUploadChunk(request, env) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '';
    const idx = parseInt(url.searchParams.get('i'), 10);
    if (!id || !Number.isInteger(idx) || idx < 0) return jsonResp({ success: false, error: '参数不完整' }, 400);

    const session = await driveSessionGet(env, id);
    if (!session) return jsonResp({ success: false, error: '上传会话不存在或已过期，请重新上传' }, 409);
    if (idx >= session.chunkCount) return jsonResp({ success: false, error: '分片序号越界' }, 400);

    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return jsonResp({ success: false, error: '分片为空' }, 400);
    if (buf.byteLength > DRIVE_CHUNK_BYTES) return jsonResp({ success: false, error: '分片超过 ' + (DRIVE_CHUNK_BYTES / 1048576) + 'MB' }, 413);
    const expect = Math.min(DRIVE_CHUNK_BYTES, session.size - idx * DRIVE_CHUNK_BYTES);
    if (buf.byteLength !== expect) {
      return jsonResp({ success: false, error: `分片大小不对：期望 ${expect} 字节，收到 ${buf.byteLength} 字节` }, 400);
    }

    /* metadata 只挂在片 0 上：它既是「文件已成型」的凭证，也是用量统计的唯一出处。
     * 上传中途放弃的残留片没有片 0，过期后由 TTL 自己清掉（永久文件的残留片要等 abort 或人工清）。 */
    const opts = {};
    if (idx === 0) {
      opts.metadata = {
        name: session.name, size: session.size, type: session.type,
        uploadedAt: session.uploadedAt, permanent: session.permanent, guest: session.guest,
        expiresAt: session.expiresAt, chunkCount: session.chunkCount
      };
    }
    if (session.ttlSeconds) opts.expirationTtl = session.ttlSeconds;
    await env.FILES_KV.put(DRIVE_PREFIX + id + ':' + idx, buf, opts);
    return jsonResp({ success: true, i: idx });
  } catch (e) {
    console.error('分片上传失败:', e);
    return jsonResp({ success: false, error: e.message || '分片上传失败' }, 500);
  }
}

async function handleDriveUploadComplete(request, env, ctx) {
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || '');
    const session = await driveSessionGet(env, id);
    if (!session) return jsonResp({ success: false, error: '上传会话不存在或已过期，请重新上传' }, 409);

    /* 片是否到齐。KV 最终一致，同机房立即可见，但网络抖动时给两次重试再判死刑。 */
    const prefix = DRIVE_PREFIX + id + ':';
    let missing = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = new Set();
      let cursor;
      do {
        const page = await env.FILES_KV.list({ prefix, cursor });
        for (const k of page.keys) got.add(Number(k.name.slice(prefix.length)));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      missing = [];
      for (let i = 0; i < session.chunkCount; i++) if (!got.has(i)) missing.push(i);
      if (!missing.length) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, 400));
    }
    if (missing.length) {
      return jsonResp({
        success: false, error: '还有分片没传完：' + missing.slice(0, 10).join(', ') + (missing.length > 10 ? ' …' : ''),
        missing
      }, 409);
    }

    /* 短链在文件落库之后建：建链失败不该让整次上传白干，只回一个提示 */
    let shortLink = null, aliasError = '';
    if (session.alias) {
      try {
        const data = await driveShortPut(env, {
          alias: session.alias, id, name: session.name, size: session.size, type: session.type,
          days: session.days === null ? undefined : session.days,
          allowForever: !!session.permanent, maxDays: session.maxDays,
          createdBy: session.permanent ? 'admin' : 'guest'
        });
        shortLink = { alias: data.alias, url: driveShortUrl(data.alias), expiresAt: data.expiresAt };
      } catch (e) {
        console.error('[Drive] 短链写入失败:', e?.message || e);
        aliasError = '短链没建成：' + (e?.message || e);
      }
    }

    /* 风控记账走一次（不是一片一次），否则一个 500MB 文件就能把 IP 顶到封禁 */
    if (session.ip && session.rlCfg) recordUpload(env, ctx, session.ip, session.size, session.rlCfg);
    await env.FILES_KV.delete(DRIVE_SESSION_PREFIX + id);

    const usage = await driveUsage(env);
    return jsonResp({
      success: true, id, url: `/api/drive/file/${id}`,
      permanent: !!session.permanent, guest: !!session.guest, expiresAt: session.expiresAt,
      name: session.name, size: session.size, type: session.type, uploadedAt: session.uploadedAt,
      chunkCount: session.chunkCount, short: shortLink, shortError: aliasError, usage
    });
  } catch (e) {
    console.error('上传收尾失败:', e);
    return jsonResp({ success: false, error: e.message || '上传收尾失败' }, 500);
  }
}

/* 中途放弃：把已传的片删干净。
 * 会话在 complete 之后就被删了，所以「没有会话」时绝不动手 —— 否则会把一份已完成的文件误删。 */
async function handleDriveUploadAbort(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || '');
    const session = await driveSessionGet(env, id);
    if (!session) return jsonResp({ success: false, error: '上传会话不存在或已完成' }, 409);
    await Promise.all(driveAllKeys(id, session.chunkCount).map(k => env.FILES_KV.delete(k)));
    await env.FILES_KV.delete(DRIVE_SESSION_PREFIX + id);
    return jsonResp({ success: true });
  } catch (e) {
    return jsonResp({ success: false, error: e.message || '清理失败' }, 500);
  }
}

async function handleDriveUsage(env) {
  try {
    const usage = await driveUsage(env);
    return jsonResp({ success: true, ...usage });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 兼容老页面：multipart 单次上传（≤25MB，写老格式单键） */
async function handleDriveUpload(request, env, ctx) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    const pwd  = (form.get('admin_token') || '').toString();
    const wantAlias = (form.get('alias') || '').toString().trim();
    const wantDays = form.get('days');
    if (!file || typeof file === 'string') return jsonResp({ success: false, error: '请选择文件' }, 400);
    if (file.size > DRIVE_MAX_BYTES) return jsonResp({
      success: false, error: `文件 ${(file.size / 1024 / 1024).toFixed(2)}MB 超过 KV 25MB 上限`
    }, 400);

    /* 三种身份：
     *   管理员密钥  -> 永久保存，可建永久短链
     *   临时口令    -> 专门给「别人的设备/不想登录」用：只传文件，存 14 天，短链最长也是 14 天，
     *                  拿不到文件列表、删不掉东西（列表/删除接口只认 ADMIN_TOKEN）
     *   什么都不填  -> 匿名，12 小时，跟以前一样 */
    const isAdminUpload = !!pwd && !!env.ADMIN_TOKEN && pwd === env.ADMIN_TOKEN;
    const isGuestUpload = !isAdminUpload && !!pwd && !!env.GUEST_UPLOAD_TOKEN && pwd === env.GUEST_UPLOAD_TOKEN;
    const maxDays = isGuestUpload ? DRIVE_SHARE_TTL_SECONDS / 86400 : DRIVE_SHORT_MAX_DAYS;

    /* 短链先校验再存文件：不合规就别把 25MB 写进 KV 再报错 */
    let alias = '';
    if (wantAlias) {
      if (!isAdminUpload && !isGuestUpload) {
        return jsonResp({ success: false, error: '自定义短链需要口令：匿名上传的文件 12 小时就过期，短链会变成死链' }, 400);
      }
      const av = driveShortValidate(wantAlias);
      if (av.error) return jsonResp({ success: false, error: av.error }, 400);
      if (await driveShortGet(env, av.value)) return jsonResp({ success: false, error: '短链「' + av.value + '」已被占用，换一个' }, 409);
      alias = av.value;
    }

    let rl = null;
    if (!isAdminUpload) {
      rl = await checkUploadAllowed(env, request);
      if (!rl.allowed) {
        return new Response(JSON.stringify({
          success: false, error: '上传过于频繁，IP 已被临时限制，请稍后再试',
          region: rl.cfg.label, retryAfterSec: rl.retryAfterSec, blockedUntil: rl.blocked?.until
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Retry-After': String(rl.retryAfterSec || 60) }
        });
      }
      if (rl.curBytes + file.size > rl.cfg.maxBytes) {
        return jsonResp({
          success: false, error: '本次上传将超过该 IP 在当前时段的总流量配额',
          region: rl.cfg.label, remainBytes: Math.max(0, rl.cfg.maxBytes - rl.curBytes)
        }, 429);
      }
    }

    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();
    const now = Date.now();
    const ttlSeconds = isAdminUpload ? 0 : (isGuestUpload ? DRIVE_SHARE_TTL_SECONDS : DRIVE_TTL_SECONDS);
    const metadata = {
      name: file.name || 'unnamed', size: file.size,
      type: file.type || 'application/octet-stream',
      uploadedAt: now, permanent: !!isAdminUpload, guest: !!isGuestUpload,
      expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : null
    };
    const opts = { metadata };
    if (ttlSeconds) opts.expirationTtl = ttlSeconds;
    await env.FILES_KV.put(DRIVE_PREFIX + id, buffer, opts);

    /* 短链在文件落库之后建：建链失败不该让整次上传白干，只回一个提示 */
    let shortLink = null, aliasError = '';
    if (alias) {
      try {
        const data = await driveShortPut(env, {
          alias, id, name: metadata.name, size: metadata.size, type: metadata.type,
          days: wantDays === null || wantDays === '' ? undefined : wantDays,
          allowForever: isAdminUpload, maxDays,
          createdBy: isAdminUpload ? 'admin' : 'guest'
        });
        shortLink = { alias: data.alias, url: driveShortUrl(data.alias), expiresAt: data.expiresAt };
      } catch (e) {
        console.error('[Drive] 短链写入失败:', e?.message || e);
        aliasError = '短链没建成：' + (e?.message || e);
      }
    }

    if (!isAdminUpload && rl) recordUpload(env, ctx, rl.ip, file.size, rl.cfg);

    return jsonResp({
      success: true, id, url: `/api/drive/file/${id}`,
      permanent: !!isAdminUpload, guest: !!isGuestUpload,
      expiresAt: metadata.expiresAt,
      short: shortLink, shortError: aliasError,
      ...metadata
    });
  } catch (e) {
    console.error('上传失败:', e);
    return jsonResp({ success: false, error: e.message || '上传失败' }, 500);
  }
}

/* 短链落地：/s/<别名> 直接吐文件，不跳转（这样短链本身就是唯一地址） */
async function handleDriveShort(alias, env, request) {
  const data = await driveShortGet(env, alias);
  if (!data || !data.id) return new Response('短链不存在或已过期', { status: 404, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
  const res = await handleDriveDownload(data.id, env, request);
  return res.status === 404
    ? new Response('文件不存在或已过期', { status: 404, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
    : res;
}

/* 管理员：给已有文件补一条短链（上传时没填别名的场合） */
async function handleDriveShortCreate(request, env) {
  try {
    const body = await request.json();
    const av = driveShortValidate(body.alias);
    if (av.error) return jsonResp({ success: false, error: av.error }, 400);
    const id = String(body.id || '').trim();
    if (!id) return jsonResp({ success: false, error: '缺少文件 id' }, 400);

    const existing = await driveShortGet(env, av.value);
    if (existing && existing.id !== id) return jsonResp({ success: false, error: '短链「' + av.value + '」已被别的文件占用' }, 409);

    /* 文件本体信息（名字/大小）从 KV 里取，别信前端传的。分片文件认片 0，老文件认单键。 */
    const found = await driveReadMeta(env, id);
    if (!found) return jsonResp({ success: false, error: '文件不存在或已过期' }, 404);
    const meta = found.meta || {};
    const key = { expiration: found.expiration };

    /* 短链不能比文件活得久：文件先没了，链还在，就是死链 */
    const wantTtl = driveShortTtlSeconds(body.days, { allowForever: true });
    if (key.expiration && wantTtl) {
      const fileExpiresAt = key.expiration * 1000;
      if (Date.now() + wantTtl * 1000 > fileExpiresAt) {
        return jsonResp({
          success: false,
          error: '这个文件 ' + new Date(fileExpiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 就过期了，短链撑不到那么久',
          fileExpiresAt
        }, 400);
      }
    }

    const data = await driveShortPut(env, {
      alias: av.value, id, name: meta.name, size: meta.size, type: meta.type,
      days: body.days, allowForever: true, createdBy: 'admin'
    });
    return jsonResp({ success: true, short: { alias: data.alias, url: driveShortUrl(data.alias), expiresAt: data.expiresAt } });
  } catch (e) {
    return jsonResp({ success: false, error: '建短链失败：' + (e?.message || e) }, 500);
  }
}

async function handleDriveShortList(env) {
  try {
    const out = [];
    let cursor;
    do {
      const page = await env.FILES_KV.list({ prefix: DRIVE_SHORT_PREFIX, cursor });
      for (const k of page.keys) {
        const d = k.metadata || {};
        out.push({
          alias: k.name.slice(DRIVE_SHORT_PREFIX.length),
          id: d.id || '',
          expiration: k.expiration ? k.expiration * 1000 : null
        });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return jsonResp({ success: true, data: out });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleDriveShortDelete(request, env) {
  try {
    const { alias } = await request.json();
    const a = String(alias || '').trim();
    if (!a) return jsonResp({ success: false, error: '缺少短链名' }, 400);
    await env.FILES_KV.delete(DRIVE_SHORT_PREFIX + a);
    return jsonResp({ success: true });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleDriveList(env) {
  try {
    const out = [];
    let cursor;
    do {
      const page = await env.FILES_KV.list({ prefix: DRIVE_PREFIX, cursor });
      page.keys.forEach(k => {
        /* 分片文件只认片 0，不然一个 500MB 文件会在列表里出现 21 次 */
        const rest = k.name.slice(DRIVE_PREFIX.length);
        const colon = rest.indexOf(':');
        if (colon >= 0 && rest.slice(colon + 1) !== '0') return;
        out.push({
          id: colon >= 0 ? rest.slice(0, colon) : rest,
          ...(k.metadata || {}),
          expiration: k.expiration ? k.expiration * 1000 : null
        });
      });
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    /* 带上短链：列表里要能一眼看出哪个文件有短链、链是什么 */
    const shortRes = await handleDriveShortList(env);
    const shorts = (await shortRes.json()).data || [];
    const byId = {};
    for (const s of shorts) if (s.id) (byId[s.id] = byId[s.id] || []).push(s);
    for (const f of out) f.shorts = byId[f.id] || [];
    return jsonResp({ success: true, data: out, shorts });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 下载白名单：仅这些无害扩展名可内联预览；其余(含 html/svg/js/xml 等可执行/可渲染类型)一律 octet-stream+attachment 强制下载，杜绝存储型 XSS */
const DRIVE_SAFE_TYPES = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
  mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4',
  mp3:'audio/mpeg', wav:'audio/wav', m4a:'audio/mp4', ogg:'audio/ogg',
  pdf:'application/pdf'
};
async function handleDriveDownload(id, env, request) {
  try {
    const found = await driveReadMeta(env, id);
    if (!found) return new Response('File not found or expired', { status: 404 });
    const meta = found.meta || {};
    const size = Number(meta.size) || 0;
    if (!size) return new Response('File metadata missing', { status: 404 });
    const safe = encodeURIComponent(meta.name || 'file');
    const ext = String(meta.name || '').split('.').pop().toLowerCase();
    const safeType = DRIVE_SAFE_TYPES[ext];
    const base = {
      'Content-Type': safeType || 'application/octet-stream',
      'Content-Disposition': `${safeType ? 'inline' : 'attachment'}; filename*=UTF-8''${safe}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
      'Accept-Ranges': 'bytes'
    };

    /* Range：视频拖动进度条全靠它，不支持的话浏览器只能整份下完才播 */
    const range = driveParseRange(request?.headers.get('Range'), size);
    if (range && range.invalid) {
      return new Response('Range Not Satisfiable', { status: 416, headers: { ...base, 'Content-Range': 'bytes */' + size } });
    }
    if (range) {
      return new Response(driveBodyStream(env, id, found.total, range.start, range.end), {
        status: 206,
        headers: {
          ...base,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`
        }
      });
    }
    return new Response(driveBodyStream(env, id, found.total, 0, size - 1), {
      headers: { ...base, 'Content-Length': String(size) }
    });
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}

async function handleDriveDelete(request, env) {
  try {
    const { id } = await request.json();
    if (!id) return jsonResp({ success: false, error: 'ID 不能为空' }, 400);
    /* KV binding 不支持批量删（只有 REST API 支持），一个文件多少片就删多少次 */
    const found = await driveReadMeta(env, id);
    await Promise.all(driveAllKeys(id, found ? found.total : 0).map(k => env.FILES_KV.delete(k)));
    /* 文件删了，指向它的短链一起清掉，别留一堆打不开的死链 */
    let removedShorts = 0;
    try {
      let cursor;
      do {
        const page = await env.FILES_KV.list({ prefix: DRIVE_SHORT_PREFIX, cursor });
        for (const k of page.keys) {
          if ((k.metadata || {}).id === id) { await env.FILES_KV.delete(k.name); removedShorts++; }
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
    } catch (e) { console.error('[Drive] 清理短链失败:', e?.message || e); }
    return jsonResp({ success: true, removedShorts });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleRlStatus(request, env) {
  const ip = new URL(request.url).searchParams.get('ip');
  if (!ip) return jsonResp({ success: false, error: '缺少 ip 参数' }, 400);
  const [block, c, b] = await Promise.all([
    env.FILES_KV.get(RL_KEY_BLOCK + ip, { type: 'json' }),
    env.FILES_KV.get(RL_KEY_COUNT + ip),
    env.FILES_KV.get(RL_KEY_BYTES + ip)
  ]);
  return jsonResp({
    success: true, ip, blocked: block || null,
    count: parseInt(c || '0', 10), bytes: parseInt(b || '0', 10)
  });
}

async function handleRlUnblock(request, env) {
  try {
    const { ip } = await request.json();
    if (!ip) return jsonResp({ success: false, error: '缺少 ip' }, 400);
    await Promise.all([
      env.FILES_KV.delete(RL_KEY_BLOCK + ip),
      env.FILES_KV.delete(RL_KEY_COUNT + ip),
      env.FILES_KV.delete(RL_KEY_BYTES + ip)
    ]);
    return jsonResp({ success: true, message: `IP ${ip} 已解封` });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* =====================================================================
 * 毕业留言墙（qlzx.lol/wall）
 * 复用：settings 表存配置 / FILES_KV 做限流 / ADMIN_TOKEN 做管理鉴权
 * 新增：wall_messages / wall_reports 两张表，首次调用自动建表
 *       （DDL 同步留档：migrations/graduation-wall.sql）
 * ===================================================================== */

/* 便签纸色：低饱和莫奈色。服务端定色，前端塞什么都不会出现突兀颜色 */
const WALL_PAPERS = ['cream', 'butter', 'mist', 'sage', 'blush', 'lilac'];

/* 举报原因白名单 */
const WALL_REASONS = ['不当内容', '人身攻击', '广告', '隐私泄露', '其他'];

/* 单条留言长度上限（按 Unicode 码点算，emoji 不背锅） */
const WALL_LIMITS = { body: 200, signature: 20, target: 30, classLabel: 20, reportDetail: 100 };

/* 限流：同 IP 15 秒一条 / 10 分钟 6 条 / 一天 40 条，超限封 30 分钟 */
const WALL_RL = { gapMs: 15000, winSec: 600, winMax: 6, daySec: 86400, dayMax: 40, blockSec: 1800 };

/* 配置默认值：存 settings 表，key 前缀 grad_wall_，后台「留言墙配置」可改 */
const WALL_DEFAULTS = {
  grad_wall_title: '2026 届毕业留言墙',
  grad_wall_year: '2026',
  grad_wall_slogan: '把想说的话，留在这一年的墙上。',
  grad_wall_open: 'true',
  grad_wall_closed_note: '这一年的留言已经收好了。',
  /* 班级下拉项：JSON 数组字符串，后台按行编辑 */
  grad_wall_classes: '["高三(1)班","高三(2)班","高三(3)班","高三(4)班","高三(5)班","高三(6)班","初三(1)班","初三(2)班","初三(3)班","初三(4)班","其他"]'
};

/* 纸色兜底：同一条留言永远同一个纸色，刷新不变 */
function wallPaperOf(id) { return WALL_PAPERS[Math.abs(id) % WALL_PAPERS.length]; }

/* ---- 建表（D1 重建后自愈；列已存在/表已存在都直接吞掉）---- */
async function ensureWallTables(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS wall_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      class_label TEXT NOT NULL DEFAULT '',
      paper TEXT NOT NULL DEFAULT 'cream',
      anonymous INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'visible',
      report_count INTEGER NOT NULL DEFAULT 0,
      client_token TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wall_token ON wall_messages(client_token) WHERE client_token <> ''`,
    `CREATE INDEX IF NOT EXISTS idx_wall_feed ON wall_messages(status, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wall_class ON wall_messages(class_label, id DESC)`,
    `CREATE TABLE IF NOT EXISTS wall_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      ip_hash TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      handled_at INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wall_report_once ON wall_reports(message_id, ip_hash) WHERE ip_hash <> ''`,
    `CREATE INDEX IF NOT EXISTS idx_wall_report_status ON wall_reports(status, id DESC)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在或 D1 暂不可用，下次再试 */ }
  }
  await upgradeWallIpColumns(env);
}

/* 存量库补 ip 明文列（CREATE IF NOT EXISTS 不给旧表加列）。
 * 每个 isolate 只查一次 PRAGMA，避免每次留言墙请求都白跑一条失败语句 */
let wallIpColumnsChecked = false;
async function upgradeWallIpColumns(env) {
  if (wallIpColumnsChecked) return;
  try {
    for (const table of ['wall_messages', 'wall_reports']) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      const has = (info.results || []).some(c => c.name === 'ip');
      if (!has) {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ip TEXT NOT NULL DEFAULT ''`).run();
        console.log(`[留言墙] 已为 ${table} 补 ip 列`);
      }
    }
    wallIpColumnsChecked = true;
  } catch (e) {
    console.error('留言墙 ip 列升级失败（下次再试）:', e?.message || e);
  }
}

/* ---- 输入清洗：控制字符去掉、压缩空行、按码点判长 ---- */
function wallClean(v, max) {
  let s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  s = s.replace(/\r\n?/g, '\n')
       .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
       .replace(/[ \t]+\n/g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  const chars = Array.from(s);
  if (chars.length > max) return { ok: false, value: chars.slice(0, max).join(''), len: chars.length };
  return { ok: true, value: s, len: chars.length };
}

/* ---- 访客真实 IP：CF 边缘注入的 CF-Connecting-IP 为准，退回代理链首跳 ----
 * 明文只进后台（管理端接口），公开接口一律不返回 */
function wallClientIp(request) {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct && direct.trim()) return direct.trim().slice(0, 45);
  const xff = request.headers.get('X-Forwarded-For') || '';
  const first = xff.split(',')[0].trim();
  if (first) return first.slice(0, 45);
  return request.headers.get('X-Real-IP')?.trim().slice(0, 45) || 'unknown';
}

/* 后台展示用：优先明文 IP；老数据（补列前入库的）没有明文，退回哈希前 8 位 */
function wallAdminIp(r) {
  if (r && r.ip) return r.ip;
  const h = (r && r.ip_hash) || '';
  return h ? 'hash:' + h.slice(0, 8) : 'unknown';
}

/* ---- IP 哈希：只用于限流与举报去重（不落明文，索引也建在哈希上）---- */
async function wallIpHash(env, request) {
  const ip = wallClientIp(request);
  const salt = env.ADMIN_TOKEN || env.JWT_SECRET || 'grad-wall';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/* ---- 配置读取 ---- */
async function getWallSettings(env) {
  const cfg = Object.assign({}, WALL_DEFAULTS);
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings WHERE key LIKE ?')
      .bind('grad_wall_%').all();
    (results || []).forEach(r => {
      if (r && r.key && typeof r.value === 'string' && r.value !== '') cfg[r.key] = r.value;
    });
  } catch (e) { console.error('读取留言墙配置失败:', e); }
  return cfg;
}

function wallClasses(cfg) {
  try {
    const arr = JSON.parse(cfg.grad_wall_classes || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, WALL_LIMITS.classLabel)).slice(0, 80);
  } catch (e) { return []; }
}

async function wallCount(env) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM wall_messages WHERE status = 'visible'").first();
    return (row && row.n) || 0;
  } catch (e) { return 0; }
}

/* ---- 限流（复用 FILES_KV，与云盘风控互不干扰，key 前缀 gw:）---- */
async function wallRateCheck(env, ipHash) {
  const bl = await env.FILES_KV.get('gw:bl:' + ipHash, { type: 'json' });
  if (bl && bl.until && bl.until > Date.now()) {
    return { ok: false, reason: 'blocked', retryAfterSec: Math.ceil((bl.until - Date.now()) / 1000) };
  }
  const [last, win, day] = await Promise.all([
    env.FILES_KV.get('gw:last:' + ipHash),
    env.FILES_KV.get('gw:win:' + ipHash),
    env.FILES_KV.get('gw:day:' + ipHash)
  ]);
  const now = Date.now();
  if (last && now - (parseInt(last, 10) || 0) < WALL_RL.gapMs) {
    return { ok: false, reason: 'too_fast', retryAfterSec: Math.ceil((WALL_RL.gapMs - (now - last)) / 1000) };
  }
  if ((parseInt(win || '0', 10) || 0) >= WALL_RL.winMax) return { ok: false, reason: 'too_many', retryAfterSec: 600 };
  if ((parseInt(day || '0', 10) || 0) >= WALL_RL.dayMax) return { ok: false, reason: 'too_many_day', retryAfterSec: 3600 };
  return { ok: true };
}

function wallRateBlock(env, ipHash, reason) {
  return env.FILES_KV.put('gw:bl:' + ipHash, JSON.stringify({ reason, blockedAt: Date.now(), until: Date.now() + WALL_RL.blockSec * 1000 }),
    { expirationTtl: WALL_RL.blockSec }).catch(e => console.error('留言墙封禁写入失败:', e));
}

async function wallRateRecord(env, ipHash) {
  try {
    const [win, day] = await Promise.all([
      env.FILES_KV.get('gw:win:' + ipHash),
      env.FILES_KV.get('gw:day:' + ipHash)
    ]);
    const newWin = (parseInt(win || '0', 10) || 0) + 1;
    const newDay = (parseInt(day || '0', 10) || 0) + 1;
    await Promise.all([
      env.FILES_KV.put('gw:last:' + ipHash, String(Date.now()), { expirationTtl: 3600 }),
      env.FILES_KV.put('gw:win:' + ipHash, String(newWin), { expirationTtl: WALL_RL.winSec }),
      env.FILES_KV.put('gw:day:' + ipHash, String(newDay), { expirationTtl: WALL_RL.daySec })
    ]);
    if (newWin > WALL_RL.winMax || newDay > WALL_RL.dayMax) {
      await wallRateBlock(env, ipHash, newWin > WALL_RL.winMax ? 'too_many' : 'too_many_day');
    }
  } catch (e) { console.error('留言墙限流记录失败:', e); }
}

function wallRateText(reason) {
  if (reason === 'too_fast') return '刚投过一张，歇一小会儿再写。';
  if (reason === 'too_many') return '写得有点急，过几分钟再来。';
  if (reason === 'too_many_day') return '今天写得够多了，明天再来吧。';
  return '纸条箱满了，歇一会儿再来。';
}

/* ---- 公开：配置 ---- */
async function handleWallConfig(env) {
  await ensureWallTables(env);
  const cfg = await getWallSettings(env);
  const total = await wallCount(env);
  return jsonResp({
    success: true,
    title: cfg.grad_wall_title,
    year: cfg.grad_wall_year,
    slogan: cfg.grad_wall_slogan,
    open: cfg.grad_wall_open === 'true',
    closedNote: cfg.grad_wall_closed_note,
    classes: wallClasses(cfg),
    total
  }, 200, { 'Cache-Control': 'no-store' });
}

/* ---- 公开：留言列表（游标分页，id 倒序）---- */
async function handleWallList(request, env) {
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get('limit') || '24', 10);
  const limit = Math.min(Math.max(isNaN(limitRaw) ? 24 : limitRaw, 1), 48);
  const cursor = parseInt(url.searchParams.get('cursor') || '', 10);
  const cls = (url.searchParams.get('class') || '').trim().slice(0, WALL_LIMITS.classLabel);
  await ensureWallTables(env);

  let sql = "SELECT id, body, signature, target, class_label, paper, anonymous, created_at FROM wall_messages WHERE status = 'visible'";
  const binds = [];
  if (cls) { sql += ' AND class_label = ?'; binds.push(cls); }
  if (!isNaN(cursor) && cursor > 0) { sql += ' AND id < ?'; binds.push(cursor); }
  sql += ' ORDER BY id DESC LIMIT ?';
  binds.push(limit + 1);

  let rows = [];
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all();
    rows = res.results || [];
  } catch (e) {
    console.error('留言墙列表查询失败:', e);
    return jsonResp({ success: false, error: '墙上暂时看不清，稍后再试' }, 500);
  }
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(wallPublicItem);
  /* 当前筛选下的总数，用于顶部计数（不带筛选时就是全校墙的总数） */
  let total = null;
  try {
    const cntSql = cls
      ? "SELECT COUNT(*) AS n FROM wall_messages WHERE status = 'visible' AND class_label = ?"
      : "SELECT COUNT(*) AS n FROM wall_messages WHERE status = 'visible'";
    const cntRow = await env.DB.prepare(cntSql).bind(...(cls ? [cls] : [])).first();
    if (cntRow && typeof cntRow.n === 'number') total = cntRow.n;
  } catch (e) { console.error('留言墙计数失败:', e); }
  return jsonResp({
    success: true,
    items,
    hasMore,
    total,
    nextCursor: items.length ? items[items.length - 1].id : null
  }, 200, { 'Cache-Control': 'no-store' });
}

function wallPublicItem(r) {
  const anon = !!r.anonymous;
  const paper = WALL_PAPERS.indexOf(r.paper) >= 0 ? r.paper : wallPaperOf(r.id);
  return {
    id: r.id,
    body: r.body,
    anonymous: anon,
    /* 匿名只影响展示：署名一律不出库；后台仍能看到真实 IP 与留言原文 */
    signature: anon ? '' : (r.signature || ''),
    target: r.target || '',
    classLabel: r.class_label || '',
    paper,
    createdAt: r.created_at
  };
}

/* ---- 公开：单条详情 ---- */
async function handleWallDetail(request, env, url) {
  const id = parseInt(url.pathname.replace('/api/wall/message/', ''), 10);
  if (isNaN(id) || id <= 0) return jsonResp({ success: false, state: 'bad_id', error: '这张纸条不见了' }, 400);
  await ensureWallTables(env);
  try {
    const row = await env.DB.prepare('SELECT id, body, signature, target, class_label, paper, anonymous, status, created_at FROM wall_messages WHERE id = ?')
      .bind(id).first();
    if (!row) return jsonResp({ success: false, state: 'gone', error: '这张纸条已经不在墙上了。' }, 404);
    if (row.status !== 'visible') {
      const text = row.status === 'hidden' ? '这张纸条暂时被收起来了。' : '这张纸条已经不在墙上了。';
      return jsonResp({ success: false, state: row.status, error: text }, 404);
    }
    return jsonResp({ success: true, item: wallPublicItem(row) });
  } catch (e) {
    console.error('留言详情查询失败:', e);
    return jsonResp({ success: false, error: '读不到这张纸条，稍后再试' }, 500);
  }
}

/* ---- 公开：创建留言（幂等 + 限流 + 服务端校验）---- */
async function handleWallCreate(request, env, ctx) {
  let payload;
  try { payload = await request.json(); }
  catch (e) { return jsonResp({ success: false, error: '纸条读不出来，刷新页面再试' }, 400); }
  if (!payload || typeof payload !== 'object') return jsonResp({ success: false, error: '纸条读不出来，刷新页面再试' }, 400);

  await ensureWallTables(env);
  const cfg = await getWallSettings(env);
  if (cfg.grad_wall_open !== 'true') {
    return jsonResp({ success: false, code: 'closed', error: cfg.grad_wall_closed_note }, 403);
  }

  /* 幂等：同一次草稿重复提交（含网络重试）只落一条 */
  const token = wallClean(payload.clientToken, 64).value;
  if (token) {
    try {
      const dup = await env.DB.prepare('SELECT id, body, signature, target, class_label, paper, anonymous, created_at FROM wall_messages WHERE client_token = ?')
        .bind(token).first();
      if (dup) {
        return jsonResp({ success: true, dedup: true, item: wallPublicItem(dup), total: await wallCount(env) });
      }
    } catch (e) { /* 查不到就正常往下走 */ }
  }

  const body = wallClean(payload.body, WALL_LIMITS.body);
  if (!body.value) return jsonResp({ success: false, code: 'empty', error: '还没写内容呢' }, 400);
  if (!body.ok) return jsonResp({ success: false, code: 'too_long', error: '写得有点长，最多 ' + WALL_LIMITS.body + ' 字，删一点再投。' }, 400);

  const signature = wallClean(payload.signature, WALL_LIMITS.signature);
  const target = wallClean(payload.target, WALL_LIMITS.target);
  const classLabel = wallClean(payload.classLabel, WALL_LIMITS.classLabel);
  if (!signature.ok) return jsonResp({ success: false, code: 'too_long', error: '署名太长啦，' + WALL_LIMITS.signature + ' 字以内就好。' }, 400);
  if (!target.ok) return jsonResp({ success: false, code: 'too_long', error: '「写给谁」太长啦，' + WALL_LIMITS.target + ' 字以内就好。' }, 400);
  if (!classLabel.ok) return jsonResp({ success: false, code: 'too_long', error: '班级名太长啦，' + WALL_LIMITS.classLabel + ' 字以内就好。' }, 400);

  const anon = payload.anonymous ? 1 : 0;
  const requested = typeof payload.paper === 'string' ? payload.paper : '';
  const paper = WALL_PAPERS.indexOf(requested) >= 0
    ? requested
    : WALL_PAPERS[Math.floor(Math.random() * WALL_PAPERS.length)];

  const clientIp = wallClientIp(request);
  const ipHash = await wallIpHash(env, request);
  const rl = await wallRateCheck(env, ipHash);
  if (!rl.ok) {
    return jsonResp({
      success: false, code: 'rate_limited', reason: rl.reason,
      retryAfterSec: rl.retryAfterSec, error: wallRateText(rl.reason)
    }, 429, { 'Retry-After': String(rl.retryAfterSec) });
  }

  const now = Date.now();
  const bindArgs = [body.value, anon ? '' : signature.value, target.value, classLabel.value, paper, anon, 'visible', token, ipHash, clientIp, now, now];
  try {
    let res;
    try {
      res = await env.DB.prepare(
        'INSERT INTO wall_messages (body, signature, target, class_label, paper, anonymous, status, client_token, ip_hash, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(...bindArgs).run();
    } catch (e) {
      /* 极少数情况：ip 明文列还没补上。退回不含 ip 的插入，别让纸条投不进来 */
      if (!/no such column|has no column/i.test(String(e && e.message || e))) throw e;
      await upgradeWallIpColumns(env).catch(() => {});
      res = await env.DB.prepare(
        'INSERT INTO wall_messages (body, signature, target, class_label, paper, anonymous, status, client_token, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(...bindArgs.slice(0, 9), bindArgs[10], bindArgs[11]).run();
    }
    const id = res.meta && res.meta.last_row_id ? res.meta.last_row_id : null;
    if (ctx && ctx.waitUntil) ctx.waitUntil(wallRateRecord(env, ipHash)); else await wallRateRecord(env, ipHash);
    const item = {
      id, body: body.value, anonymous: !!anon, signature: anon ? '' : signature.value,
      target: target.value, classLabel: classLabel.value, paper, createdAt: now
    };
    return jsonResp({ success: true, item, total: await wallCount(env) });
  } catch (e) {
    /* 并发重复提交撞唯一索引：把已存在那条当作成功返回 */
    const msg = String(e && e.message || e);
    if (/UNIQUE|constraint/i.test(msg) && token) {
      try {
        const dup = await env.DB.prepare('SELECT id, body, signature, target, class_label, paper, anonymous, created_at FROM wall_messages WHERE client_token = ?')
          .bind(token).first();
        if (dup) return jsonResp({ success: true, dedup: true, item: wallPublicItem(dup), total: await wallCount(env) });
      } catch (e2) { /* 落到下面统一报错 */ }
    }
    console.error('留言写入失败:', e);
    return jsonResp({ success: false, code: 'db', error: '纸条没投进去，再试一次？' }, 500);
  }
}

/* ---- 公开：举报 ---- */
async function handleWallReport(request, env) {
  let payload;
  try { payload = await request.json(); }
  catch (e) { return jsonResp({ success: false, error: '举报没提交上，稍后再试' }, 400); }

  const id = parseInt(payload && payload.messageId, 10);
  if (isNaN(id) || id <= 0) return jsonResp({ success: false, error: '找不到这张纸条' }, 400);
  const reason = WALL_REASONS.indexOf(payload.reason) >= 0 ? payload.reason : '';
  if (!reason) return jsonResp({ success: false, error: '选一个举报原因' }, 400);
  const detail = wallClean(payload.detail, WALL_LIMITS.reportDetail);
  if (!detail.ok) return jsonResp({ success: false, error: '补充说明太长了' }, 400);

  await ensureWallTables(env);
  try {
    const row = await env.DB.prepare('SELECT id, status FROM wall_messages WHERE id = ?').bind(id).first();
    if (!row || row.status === 'deleted') return jsonResp({ success: false, error: '这张纸条已经不在墙上了' }, 404);

    const ipHash = await wallIpHash(env, request);
    const reportArgs = [id, reason, detail.value, ipHash, wallClientIp(request), Date.now()];
    let ins;
    try {
      ins = await env.DB.prepare(
        "INSERT OR IGNORE INTO wall_reports (message_id, reason, detail, status, ip_hash, ip, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)"
      ).bind(...reportArgs).run();
    } catch (e) {
      if (!/no such column|has no column/i.test(String(e && e.message || e))) throw e;
      await upgradeWallIpColumns(env).catch(() => {});
      ins = await env.DB.prepare(
        "INSERT OR IGNORE INTO wall_reports (message_id, reason, detail, status, ip_hash, created_at) VALUES (?, ?, ?, 'pending', ?, ?)"
      ).bind(...reportArgs.slice(0, 4), reportArgs[5]).run();
    }
    const changed = ins.meta && typeof ins.meta.changes === 'number' ? ins.meta.changes : 1;
    if (changed > 0) {
      await env.DB.prepare('UPDATE wall_messages SET report_count = report_count + 1 WHERE id = ?').bind(id).run();
    }
    return jsonResp({ success: true, duplicate: changed === 0, message: changed === 0 ? '这张纸条你已经举报过了，我们会看的。' : '已经收到，谢谢你。' });
  } catch (e) {
    console.error('举报写入失败:', e);
    return jsonResp({ success: false, error: '举报没提交上，稍后再试' }, 500);
  }
}

/* ---- 管理端：留言墙（全部走 isAdmin，路由处已拦）---- */
async function handleAdminWall(request, env, url) {
  const p = url.pathname;
  const method = request.method;

  if (p === '/api/admin/wall/init' && method === 'POST') {
    await ensureWallTables(env);
    for (const [k, v] of Object.entries(WALL_DEFAULTS)) {
      try {
        await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
      } catch (e) { /* 已存在 */ }
    }
    return jsonResp({ success: true });
  }

  if (p === '/api/admin/wall/config') {
    await ensureWallTables(env);
    if (method === 'GET') {
      const cfg = await getWallSettings(env);
      return jsonResp({
        success: true,
        title: cfg.grad_wall_title, year: cfg.grad_wall_year, slogan: cfg.grad_wall_slogan,
        open: cfg.grad_wall_open === 'true', closedNote: cfg.grad_wall_closed_note,
        classes: wallClasses(cfg), total: await wallCount(env)
      });
    }
    if (method === 'POST') {
      let b;
      try { b = await request.json(); } catch (e) { return jsonResp({ success: false, error: '参数错误' }, 400); }
      const title = wallClean(b.title, 40);
      const year = wallClean(b.year, 8);
      const slogan = wallClean(b.slogan, 60);
      const closedNote = wallClean(b.closedNote, 60);
      if (!title.value) return jsonResp({ success: false, error: '标题不能为空' }, 400);
      if (!closedNote.value) return jsonResp({ success: false, error: '关闭文案不能为空' }, 400);
      let classes = [];
      if (Array.isArray(b.classes)) {
        classes = b.classes.filter(x => typeof x === 'string' && x.trim())
          .map(x => x.trim().slice(0, WALL_LIMITS.classLabel)).slice(0, 80);
      }
      if (!classes.length) return jsonResp({ success: false, error: '至少留一个班级选项' }, 400);
      const pairs = [
        ['grad_wall_title', title.value],
        ['grad_wall_year', year.value],
        ['grad_wall_slogan', slogan.value],
        ['grad_wall_closed_note', closedNote.value],
        ['grad_wall_open', b.open ? 'true' : 'false'],
        ['grad_wall_classes', JSON.stringify(classes)]
      ];
      try {
        for (const [k, v] of pairs) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
        }
      } catch (e) {
        console.error('留言墙配置保存失败:', e);
        return jsonResp({ success: false, error: '保存失败，稍后再试' }, 500);
      }
      return jsonResp({ success: true });
    }
    return jsonResp({ success: false, error: '方法不支持' }, 405);
  }

  if (p === '/api/admin/wall/messages' && method === 'GET') {
    await ensureWallTables(env);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const cls = (url.searchParams.get('class') || '').trim().slice(0, WALL_LIMITS.classLabel);
    const status = (url.searchParams.get('status') || 'visible').trim();
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);

    let where = ' WHERE 1=1';
    const binds = [];
    if (status && status !== 'all') { where += ' AND status = ?'; binds.push(status); }
    if (cls) { where += ' AND class_label = ?'; binds.push(cls); }
    if (q) { where += ' AND (instr(body, ?) > 0 OR instr(signature, ?) > 0 OR instr(target, ?) > 0)'; binds.push(q, q, q); }
    try {
      const totalRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM wall_messages' + where).bind(...binds).first();
      const rows = await env.DB.prepare(
        'SELECT id, body, signature, target, class_label, paper, anonymous, status, report_count, ip_hash, ip, created_at FROM wall_messages' + where +
        ' ORDER BY id DESC LIMIT ? OFFSET ?'
      ).bind(...binds, limit, (page - 1) * limit).all();
      return jsonResp({
        success: true,
        total: (totalRow && totalRow.n) || 0,
        page, limit,
        items: (rows.results || []).map(r => ({
          id: r.id, body: r.body, signature: r.signature, target: r.target, classLabel: r.class_label,
          anonymous: !!r.anonymous, status: r.status, reportCount: r.report_count || 0,
          ip: wallAdminIp(r), createdAt: r.created_at
        }))
      });
    } catch (e) {
      console.error('留言管理列表查询失败:', e);
      return jsonResp({ success: false, error: '查询失败' }, 500);
    }
  }

  if (p === '/api/admin/wall/message' && method === 'POST') {
    let b;
    try { b = await request.json(); } catch (e) { return jsonResp({ success: false, error: '参数错误' }, 400); }
    const id = parseInt(b.id, 10);
    const action = String(b.action || '');
    if (isNaN(id) || id <= 0) return jsonResp({ success: false, error: '缺少留言 id' }, 400);
    const map = { hide: 'hidden', restore: 'visible', delete: 'deleted' };
    try {
      if (action === 'purge') {
        await env.DB.prepare('DELETE FROM wall_messages WHERE id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM wall_reports WHERE message_id = ?').bind(id).run();
        return jsonResp({ success: true, purged: true });
      }
      const next = map[action];
      if (!next) return jsonResp({ success: false, error: '未知操作' }, 400);
      await env.DB.prepare('UPDATE wall_messages SET status = ?, updated_at = ? WHERE id = ?')
        .bind(next, Date.now(), id).run();
      return jsonResp({ success: true, status: next });
    } catch (e) {
      console.error('留言状态更新失败:', e);
      return jsonResp({ success: false, error: '操作失败' }, 500);
    }
  }

  if (p === '/api/admin/wall/reports' && method === 'GET') {
    await ensureWallTables(env);
    const status = (url.searchParams.get('status') || 'pending').trim();
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);
    let where = ' WHERE 1=1';
    const binds = [];
    if (status && status !== 'all') { where += ' AND r.status = ?'; binds.push(status); }
    try {
      const totalRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM wall_reports r' + where).bind(...binds).first();
      const rows = await env.DB.prepare(
        'SELECT r.id, r.message_id, r.reason, r.detail, r.status, r.created_at, r.handled_at, r.ip_hash, r.ip, ' +
        'm.body, m.signature, m.anonymous, m.status AS msg_status, m.class_label ' +
        'FROM wall_reports r LEFT JOIN wall_messages m ON m.id = r.message_id' + where +
        ' ORDER BY r.id DESC LIMIT ? OFFSET ?'
      ).bind(...binds, limit, (page - 1) * limit).all();
      return jsonResp({
        success: true,
        total: (totalRow && totalRow.n) || 0,
        page, limit,
        items: (rows.results || []).map(r => ({
          id: r.id, messageId: r.message_id, reason: r.reason, detail: r.detail, status: r.status,
          createdAt: r.created_at, handledAt: r.handled_at, ip: wallAdminIp(r),
          body: r.body, signature: r.signature, anonymous: !!r.anonymous,
          msgStatus: r.msg_status || 'gone', classLabel: r.class_label || ''
        }))
      });
    } catch (e) {
      console.error('举报列表查询失败:', e);
      return jsonResp({ success: false, error: '查询失败' }, 500);
    }
  }

  if (p === '/api/admin/wall/report' && method === 'POST') {
    let b;
    try { b = await request.json(); } catch (e) { return jsonResp({ success: false, error: '参数错误' }, 400); }
    const id = parseInt(b.id, 10);
    const action = String(b.action || '');
    if (isNaN(id) || id <= 0) return jsonResp({ success: false, error: '缺少举报 id' }, 400);
    const map = { resolve: 'resolved', dismiss: 'dismissed', pending: 'pending' };
    const next = map[action];
    if (!next) return jsonResp({ success: false, error: '未知操作' }, 400);
    try {
      await env.DB.prepare('UPDATE wall_reports SET status = ?, handled_at = ? WHERE id = ?')
        .bind(next, Date.now(), id).run();
      /* 处理举报时顺手隐藏留言，少点一次 */
      if (action === 'resolve' && b.hideMessage) {
        const mid = parseInt(b.messageId, 10);
        if (!isNaN(mid) && mid > 0) {
          await env.DB.prepare("UPDATE wall_messages SET status = 'hidden', updated_at = ? WHERE id = ?")
            .bind(Date.now(), mid).run();
        }
      }
      return jsonResp({ success: true, status: next });
    } catch (e) {
      console.error('举报处理失败:', e);
      return jsonResp({ success: false, error: '操作失败' }, 500);
    }
  }

  return jsonResp({ success: false, error: '未知接口' }, 404);
}

/* =====================================================================
 * 班费收支（高一（7）班公开账本）
 *
 * 数据存本 Worker 现有的 D1（qlzx-news-db），复用现有 /admin 后台与 ADMIN_TOKEN
 * 权限体系，不新建用户/后台/数据库（指导2 §22 / §24 / §63）。
 *
 * 金额一律以「分」为单位的整数存取（amount_cents），任何汇总都不碰浮点，
 * 余额 = 累计收入 - 累计支出 由 SQL 现算，服务端为准（指导2 §19 / §20 / §28）。
 * ===================================================================== */

const FUND_DEFAULTS = {
  class_label: '高一（7）班',
  title: '班费收支',
  slogan: '每一笔班费，都清清楚楚地记录在这里。'
};
/* 账户不是只能「微信」：这里是后台表单的候选，历史数据里出现过的账户也会一并出现在筛选里（指导2 §15） */
const FUND_ACCOUNTS = ['微信', '支付宝', '现金', '银行卡'];
const FUND_LIMITS = { note: 60, account: 20, pageMax: 60, auditKeep: 500 };

/* 班费后台口令短（人记得住的那种），而 /api/admin/fund/* 与 /api/fund-admin/verify 是公开可打的，
 * 所以失败尝试按 IP 计数封禁。只数失败，成功一次就清零，正常使用碰不到。 */
const FUND_ADMIN_RL = {
  verifyMax: 8,     /* 登录接口：15 分钟内错 8 次锁 */
  apiMax: 30,       /* 业务接口：未授权请求 15 分钟内 30 次锁 */
  windowSec: 900
};
function fundAdminRlKey(scope, request) {
  return 'fundadmin_rl_' + scope + '_' + (wallClientIp(request) || 'unknown');
}
async function fundAdminBlocked(env, request, scope) {
  try {
    const cur = parseInt(await env.FILES_KV.get(fundAdminRlKey(scope, request)) || '0', 10) || 0;
    return cur >= (scope === 'verify' ? FUND_ADMIN_RL.verifyMax : FUND_ADMIN_RL.apiMax);
  } catch (e) { return false; } /* KV 挂了不能把人锁在门外 */
}
async function fundAdminFail(env, request, scope) {
  try {
    const key = fundAdminRlKey(scope, request);
    const cur = parseInt(await env.FILES_KV.get(key) || '0', 10) || 0;
    await env.FILES_KV.put(key, String(cur + 1), { expirationTtl: FUND_ADMIN_RL.windowSec });
  } catch (e) { /* 计数失败就放行，别误伤 */ }
}
async function fundAdminFailClear(env, request, scope) {
  try { await env.FILES_KV.delete(fundAdminRlKey(scope, request)); } catch (e) { /* 忽略 */ }
}

/* 班费独立后台的登录校验：只认 FUND_ADMIN_TOKEN，和主后台 ADMIN_TOKEN 分开 */
async function handleFundAdminVerify(request, env) {
  if (!env.FUND_ADMIN_TOKEN) {
    return jsonResp({ success: false, error: '后台口令未配置：请先设置环境变量 FUND_ADMIN_TOKEN' }, 503);
  }
  /* 先看有没有被封：锁定期内连正确口令也不放行，否则暴力破解只要蒙对一次就进来了 */
  if (await fundAdminBlocked(env, request, 'verify')) {
    return jsonResp({ success: false, error: '口令错误次数过多，请 15 分钟后再试' }, 429);
  }
  if (!isFundAdmin(request, env)) {
    await fundAdminFail(env, request, 'verify');
    return new Response('Unauthorized', { status: 401 });
  }
  await fundAdminFailClear(env, request, 'verify');
  return jsonResp({ success: true, scope: 'fund' });
}

/* ---- 记账凭证（支付截图）----
 * 存 KV 里另一段前缀，和云盘文件（file:）分开放：云盘列表按 file: 前缀列，所以凭证
 * 不会出现在 /drive 里，也不会被短链指到。凭证跟着账目走 —— 换一张、删账目都一起删。
 * 只收图片，而且认文件头不认文件名：免得有人把 .png 的网页传上来当图存。 */
const FUND_EVIDENCE_PREFIX = 'fundev:';
const FUND_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
const FUND_EVIDENCE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const FUND_EVIDENCE_RE = /^fundev:[0-9a-f-]{36}$/;

function fundEvidenceValid(key) {
  const s = String(key == null ? '' : key).trim();
  return FUND_EVIDENCE_RE.test(s) ? s : '';
}
function fundEvidenceSniff(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}
async function fundEvidenceExists(env, key) {
  try {
    const listed = await env.FILES_KV.list({ prefix: key, limit: 1 });
    return !!(listed.keys || []).some(k => k.name === key);
  } catch (e) { return false; }
}
async function fundEvidenceDrop(env, key) {
  const k = fundEvidenceValid(key);
  if (!k) return;
  try { await env.FILES_KV.delete(k); } catch (e) { /* 凭证没删掉不影响账目本身，记日志 */ console.error('[Fund] 凭证删除失败:', e?.message || e); }
}

/* 上传凭证（后台）。不设过期时间：账目是长期的，截图跟着账目一起留 */
async function handleFundEvidenceUpload(request, env) {
  if (!env.FILES_KV) return jsonResp({ success: false, error: '这个环境没接 KV，暂不能存凭证' }, 503);
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return jsonResp({ success: false, error: '请选择截图' }, 400);
    if (!file.size) return jsonResp({ success: false, error: '这个文件是空的' }, 400);
    if (file.size > FUND_EVIDENCE_MAX_BYTES) return jsonResp({
      success: false, error: `截图 ${(file.size / 1048576).toFixed(2)}MB 超过 ${FUND_EVIDENCE_MAX_BYTES / 1048576}MB 上限`
    }, 400);
    const buffer = await file.arrayBuffer();
    const type = fundEvidenceSniff(buffer);
    if (!type) return jsonResp({ success: false, error: '只收 jpg / png / webp / gif 图片' }, 400);

    const key = FUND_EVIDENCE_PREFIX + crypto.randomUUID();
    const name = wallClean(file.name, 80).value || ('凭证.' + FUND_EVIDENCE_TYPES[type]);
    await env.FILES_KV.put(key, buffer, { metadata: { name, size: file.size, type, uploadedAt: Date.now() } });
    return jsonResp({ success: true, key, name, size: file.size, type });
  } catch (e) {
    console.error('[Fund] 凭证上传失败:', e?.stack || e);
    return jsonResp({ success: false, error: '凭证上传失败：' + (e?.message || e) }, 500);
  }
}

/* 看凭证（后台）。只认自己存过的格式，一律 inline + nosniff，绝不当网页执行 */
async function handleFundEvidenceGet(key, env) {
  const k = fundEvidenceValid(key);
  if (!k) return jsonResp({ success: false, error: '凭证不存在' }, 404);
  if (!env.FILES_KV) return jsonResp({ success: false, error: '这个环境没接 KV' }, 503);
  try {
    const { value, metadata } = await env.FILES_KV.getWithMetadata(k, { type: 'arrayBuffer' });
    if (!value) return jsonResp({ success: false, error: '凭证不存在或已删除' }, 404);
    const meta = metadata || {};
    const type = FUND_EVIDENCE_TYPES[meta.type] ? meta.type : fundEvidenceSniff(value);
    if (!type) return jsonResp({ success: false, error: '凭证格式不认识' }, 415);
    return new Response(value, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name || 'evidence')}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300'
      }
    });
  } catch (e) {
    return jsonResp({ success: false, error: '凭证读取失败' }, 500);
  }
}

async function handleFundEvidenceDelete(request, env) {
  try {
    const body = await request.json();
    const k = fundEvidenceValid(body.key);
    if (!k) return jsonResp({ success: false, error: '凭证不存在' }, 404);
    await fundEvidenceDrop(env, k);
    return jsonResp({ success: true });
  } catch (e) {
    return jsonResp({ success: false, error: e?.message || '删除失败' }, 500);
  }
}

/* 建表：幂等，D1 重建后自愈。列定义与 migrations/class-fund.sql 保持一致 */
async function ensureFundTables(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS class_fund (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_label TEXT NOT NULL DEFAULT '高一（7）班',
      kind TEXT NOT NULL,
      occurred_on TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT '微信',
      amount_cents INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      evidence_key TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    /* 老库补列：已经有列时这句会报错，吞掉即可 */
    `ALTER TABLE class_fund ADD COLUMN evidence_key TEXT NOT NULL DEFAULT ''`,
    'CREATE INDEX IF NOT EXISTS idx_fund_date ON class_fund(occurred_on DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_fund_kind ON class_fund(kind, occurred_on DESC)',
    'CREATE INDEX IF NOT EXISTS idx_fund_verify ON class_fund(verified)',
    `CREATE TABLE IF NOT EXISTS class_fund_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '',
      after_json TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_fund_audit_time ON class_fund_audit(created_at DESC)',
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)'
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在或 D1 暂不可用，下次再试 */ }
  }
}

/* 页面文案走 settings，不写死在 HTML 里（指导2 §53 同理：展示数据不硬编码） */
async function fundConfig(env) {
  const cfg = { ...FUND_DEFAULTS };
  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('fund_class_label','fund_title','fund_slogan')"
    ).all();
    for (const r of results || []) {
      const k = String(r.key).replace(/^fund_/, '');
      if (cfg[k] !== undefined && r.value) cfg[k] = r.value;
    }
  } catch (e) { /* 读不到就用默认，不影响页面 */ }
  return cfg;
}

/* 初始数据（来源表格原样，见 migrations/class-fund.sql）。固定 id + INSERT OR IGNORE，
 * 已导过就打标记，重复点「初始化」不会重复插一笔（指导2 §54）。 */
async function fundSeed(env) {
  await ensureFundTables(env);
  let done = false;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fund_seeded'").first();
    done = !!row;
  } catch (e) { /* 读不到当没导过 */ }
  if (done) return { seeded: false, reason: '已初始化过，未重复导入' };

  const now = Date.now();
  const rows = [
    ['income', '2026-09-01', '微信', 44000, '', ''],
    ['expense', '2026-08-31', '微信', 579, '钟表挂钩', ''],
    ['expense', '2026-09-02', '微信', 400, '白板笔1黑+1红', ''],
    ['expense', '2026-09-05', '微信', 16000, '教师节老师礼物16盆植物', ''],
    ['expense', '2026-09-11', '微信', 670, '扫把挂钩四个', ''],
    ['expense', '2026-09-16', '微信', 2080, '磁性座位表', '']
  ];
  let inserted = 0;
  for (let i = 0; i < rows.length; i++) {
    const [kind, date, account, cents, note] = rows[i];
    try {
      const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO class_fund (id, class_label, kind, occurred_on, account, amount_cents, verified, note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'seed', ?, ?)`
      ).bind(i + 1, FUND_DEFAULTS.class_label, kind, date, account, cents, note, now, now).run();
      if (r?.meta?.changes) inserted++;
    } catch (e) { /* 单条失败不拖垮其它，后面 /api/admin/fund/records 能看出来 */ }
  }
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('fund_seeded', '1')").run();
  } catch (e) { /* 标记写失败只是下次再导一遍，INSERT OR IGNORE 挡得住重复 */ }
  return { seeded: true, inserted };
}

/* 金额：只收「1234」「1234.5」「1234.56」这类，转成整数分。
 * 不走 Number(s)*100 的四舍五入歧义路径，直接按字符串拆，避免 1.1*100 = 110.00000000000001 */
function fundParseAmount(input) {
  const s = String(input == null ? '' : input).trim().replace(/^[¥￥]/, '');
  if (!s) return { error: '请填写金额' };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return { error: '金额格式不对，最多两位小数，例如 20.80' };
  const [yuan, dec = ''] = s.split('.');
  const cents = Number(yuan) * 100 + Number((dec + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) return { error: '金额必须大于 0' };
  return { cents };
}

/* 分 → 展示用字符串，两位小数（指导2 §14：统一 ¥X.XX） */
function fundYuan(cents) { return (Number(cents || 0) / 100).toFixed(2); }

function fundParseDate(input) {
  const v = String(input == null ? '' : input).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: '日期格式应为 YYYY-MM-DD' };
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return { error: '日期不存在，请检查' };
  if (v < '2000-01-01' || v > '2100-12-31') return { error: '日期超出合理范围' };
  return { value: v };
}

/* 一条账目 → 前端结构：分为单位的原值 + 两位小数字符串都带上，前端不用自己算 */
function fundRowOut(r) {
  return {
    id: r.id,
    kind: r.kind,
    date: r.occurred_on,
    month: String(r.occurred_on || '').slice(0, 7),
    account: r.account,
    amountCents: r.amount_cents,
    amount: fundYuan(r.amount_cents),
    verified: !!r.verified,
    note: r.note || '',
    hasEvidence: !!(r.evidence_key),
    createdBy: r.created_by || 'admin',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/* 汇总：累计收入 / 累计支出 / 当前余额，全部走 SQL 整数求和。
 * 用一条 GROUP BY 拿两边，避免两次查询之间数据变化导致对不上（指导2 §20）。 */
async function fundSummary(env) {
  const out = {
    incomeCents: 0, expenseCents: 0, balanceCents: 0,
    incomeCount: 0, expenseCount: 0, count: 0,
    firstDate: '', lastDate: '', months: [], accounts: []
  };
  const { results } = await env.DB.prepare(
    'SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM class_fund GROUP BY kind'
  ).all();
  for (const r of results || []) {
    if (r.kind === 'income') { out.incomeCents = Number(r.total) || 0; out.incomeCount = Number(r.n) || 0; }
    else if (r.kind === 'expense') { out.expenseCents = Number(r.total) || 0; out.expenseCount = Number(r.n) || 0; }
  }
  out.balanceCents = out.incomeCents - out.expenseCents; /* 余额永远现算，不存在和明细打架的第三个数 */
  out.count = out.incomeCount + out.expenseCount;

  const { results: months } = await env.DB.prepare(
    `SELECT substr(occurred_on, 1, 7) AS month, kind, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
     FROM class_fund GROUP BY month, kind ORDER BY month DESC`
  ).all();
  const mMap = new Map();
  for (const r of months || []) {
    if (!r.month) continue;
    if (!mMap.has(r.month)) mMap.set(r.month, { month: r.month, incomeCents: 0, expenseCents: 0, count: 0 });
    const m = mMap.get(r.month);
    if (r.kind === 'income') m.incomeCents = Number(r.total) || 0;
    else if (r.kind === 'expense') m.expenseCents = Number(r.total) || 0;
    m.count += Number(r.n) || 0;
  }
  out.months = [...mMap.values()];

  const { results: accts } = await env.DB.prepare(
    'SELECT DISTINCT account FROM class_fund ORDER BY account'
  ).all();
  out.accounts = (accts || []).map(a => a.account).filter(Boolean);

  const { results: range } = await env.DB.prepare(
    'SELECT MIN(occurred_on) AS first, MAX(occurred_on) AS last FROM class_fund'
  ).all();
  if (range && range[0]) { out.firstDate = range[0].first || ''; out.lastDate = range[0].last || ''; }

  for (const k of ['income', 'expense', 'balance']) out[k + 'Yuan'] = fundYuan(out[k + 'Cents']);
  return out;
}

/* 列表查询参数：公开页与后台共用，保证两边筛选/排序语义一致 */
function fundListQuery(url) {
  const kindRaw = url.searchParams.get('kind') || 'all';
  const kind = (kindRaw === 'income' || kindRaw === 'expense') ? kindRaw : 'all';
  const monthRaw = (url.searchParams.get('month') || '').trim();
  const month = /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : '';
  const accountRaw = (url.searchParams.get('account') || '').trim();
  const account = accountRaw ? String(wallClean(accountRaw, FUND_LIMITS.account).value) : '';
  const statusRaw = url.searchParams.get('status') || '';
  const verified = statusRaw === 'verified' ? 1 : statusRaw === 'pending' ? 0 : null;
  const q = String(wallClean(url.searchParams.get('q') || '', 40).value);
  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), FUND_LIMITS.pageMax);
  return { kind, month, account, verified, q, order, page, limit };
}

function fundWhere(q) {
  const where = [];
  const binds = [];
  if (q.kind !== 'all') { where.push('kind = ?'); binds.push(q.kind); }
  if (q.month) { where.push("substr(occurred_on, 1, 7) = ?"); binds.push(q.month); }
  if (q.account) { where.push('account = ?'); binds.push(q.account); }
  if (q.verified !== null) { where.push('verified = ?'); binds.push(q.verified); }
  if (q.q) { where.push('(note LIKE ? OR account LIKE ? OR occurred_on LIKE ?)'); const like = '%' + q.q + '%'; binds.push(like, like, like); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', binds };
}

async function fundList(env, q) {
  const w = fundWhere(q);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, occurred_on, account, amount_cents, verified, note, evidence_key, created_by, created_at, updated_at
     FROM class_fund ${w.sql}
     ORDER BY occurred_on ${q.order === 'asc' ? 'ASC' : 'DESC'}, id ${q.order === 'asc' ? 'ASC' : 'DESC'}
     LIMIT ? OFFSET ?`
  ).bind(...w.binds, q.limit, (q.page - 1) * q.limit).all();
  const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM class_fund ${w.sql}`).bind(...w.binds).first();
  const total = Number(cnt?.n) || 0;
  /* rows 给后台用（里面带凭证 key），items 是公开结构，不带 key */
  return { items: (results || []).map(fundRowOut), rows: results || [], total, page: q.page, limit: q.limit, hasMore: q.page * q.limit < total };
}

/* 公开：账单 + 汇总。不设缓存头 —— 管理员改完立刻能看到新余额（指导2 §42） */
async function handleFundLedger(request, env) {
  const url = new URL(request.url);
  const q = fundListQuery(url);
  const read = async () => {
    const [summary, list, cfg] = [await fundSummary(env), await fundList(env, q), await fundConfig(env)];
    const { rows, ...rest } = list;   /* 凭证 key 属于后台，公开页只看到 hasEvidence */
    return { success: true, ...cfg, summary, ...rest, filter: { kind: q.kind, month: q.month, account: q.account, order: q.order } };
  };
  try {
    return jsonResp(await read());
  } catch (e) {
    /* 表还没建（比如迁移还没跑就先有人打开页面）：自愈一次再读，仍失败才算真错 */
    try {
      await ensureFundTables(env);
      return jsonResp(await read());
    } catch (e2) {
      console.error('[Fund] 读取账目失败:', e2?.stack || e2);
      return jsonResp({ success: false, error: '账目暂时读不出来，稍后再试' }, 500);
    }
  }
}

async function handleFundRecord(env, url) {
  const id = parseInt(String(url.pathname).split('/').pop(), 10);
  if (!Number.isInteger(id) || id <= 0) return jsonResp({ success: false, error: '账目不存在' }, 404);
  try {
    const row = await env.DB.prepare(
      'SELECT id, kind, occurred_on, account, amount_cents, verified, note, created_by, created_at, updated_at FROM class_fund WHERE id = ?'
    ).bind(id).first();
    if (!row) return jsonResp({ success: false, error: '账目不存在' }, 404);
    return jsonResp({ success: true, item: fundRowOut(row) });
  } catch (e) {
    return jsonResp({ success: false, error: '账目暂时读不出来' }, 500);
  }
}

/* 最小化修改记录（指导2 §29）：记不下完整历史，只留「谁 / 何时 / 改成什么」。
 * actor 默认 admin；AI 自动入账时传 'ai'，审计里区分得开人和机器 */
async function fundAudit(env, fundId, action, before, after, actor = 'admin') {
  try {
    await env.DB.prepare(
      'INSERT INTO class_fund_audit (fund_id, action, before_json, after_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(fundId, action, before ? JSON.stringify(before) : '', after ? JSON.stringify(after) : '', actor || 'admin', Date.now()).run();
  } catch (e) { /* 审计写失败不阻断主操作，记日志 */ console.error('[Fund] 审计写入失败:', e?.message || e); }
}

/* 后台：一条账目的字段校验，创建与编辑共用 */
function fundValidate(body) {
  const kind = body.kind === 'income' ? 'income' : body.kind === 'expense' ? 'expense' : '';
  if (!kind) return { error: '类型只能是收入或支出' };
  const amount = fundParseAmount(body.amount);
  if (amount.error) return { error: amount.error };
  const date = fundParseDate(body.date || body.occurredOn);
  if (date.error) return { error: date.error };
  const account = wallClean(body.account || '微信', FUND_LIMITS.account);
  if (!account.value) return { error: '请填写账户' };
  if (!account.ok) return { error: `账户最多 ${FUND_LIMITS.account} 个字` };
  const note = wallClean(body.note, FUND_LIMITS.note);
  if (!note.ok) return { error: `备注最多 ${FUND_LIMITS.note} 个字` };
  return {
    value: {
      kind,
      amount_cents: amount.cents,
      occurred_on: date.value,
      account: account.value,
      note: note.value,
      verified: body.verified ? 1 : 0
    }
  };
}

/* 落一条账目 + 写审计。人工新增（/record）和 AI 自动入账（/parse?autoSave）共用一份。
 * 调用方负责先跑 fundValidate —— 脏数据不许走到这里。
 * opts.source='ai'：一律记成「待核对」，原始那句话进审计的 before_json。 */
async function fundCreate(env, v, opts = {}) {
  const isAi = opts.source === 'ai';
  const value = isAi ? { ...v, verified: 0 } : v;
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO class_fund (class_label, kind, occurred_on, account, amount_cents, verified, note, evidence_key, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(FUND_DEFAULTS.class_label, value.kind, value.occurred_on, value.account, value.amount_cents, value.verified, value.note, value.evidence_key || '', isAi ? 'ai' : 'admin', now, now).run();
  const id = Number(r?.meta?.last_row_id) || 0;
  await fundAudit(env, id, 'create', isAi ? { source: 'ai', text: wallClean(opts.text, FUND_AI.maxText).value } : null, value, isAi ? 'ai' : 'admin');
  return { id, value, isAi, now };
}

/* 后台接口集合。路由层已用 isAdmin 挡住未授权请求（指导2 §30：不靠前端藏按钮） */
/* ================= 自然语言记账（Workers AI）=================
 * 一句话（「昨天买扫把挂钩花了6.7」）-> 一条账目草稿。
 * 只做「填表」不做「入账」：结果一律回给前端填进表单，由人核对后再点保存 ——
 * 记账是钱的事，AI 不能自己落库。金额/日期/账户全部再过一遍本地校验，
 * AI 输出什么都要能兜住，坏数据不许进表单。 */
const FUND_AI = {
  model: '@cf/zai-org/glm-4.7-flash', /* 可用 AI_FUND_MODEL 覆盖 */
  maxText: 120
};

/* 东八区「今天」：AI 要把「昨天」「上周五」换算成日期，得先告诉它今天是几号 */
function fundAiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function fundAiParse(env, text) {
  if (!env.AI) return { error: '这个环境没接 Workers AI，请手动填写' };
  const today = fundAiToday();
  const model = env.AI_FUND_MODEL || FUND_AI.model;
  const prompt = `你是班费记账助手。把下面这句话记成一条账目，严格输出 JSON，不要解释、不要 markdown。

今天是 ${today}。

字段：
- kind: "income"（收钱/进账）或 "expense"（花钱/买东西）
- amount: 金额，字符串，单位元，最多两位小数，不带¥、不带正负号
- date: 发生日期 YYYY-MM-DD。说"今天"就是 ${today}，"昨天""上周五"按今天换算；没说日期就用 ${today}
- account: 只能是 微信 / 支付宝 / 现金 / 银行卡 之一；没说就用 微信
- note: 用途或来源，简短中文，最多 60 字，例：教师节老师礼物16盆植物

示例：
输入：昨天买扫把挂钩花了6.7
输出：{"kind":"expense","amount":"6.7","date":"比今天早一天的日期","account":"微信","note":"扫把挂钩"}
输入：收班费440
输出：{"kind":"income","amount":"440","date":"${today}","account":"微信","note":""}

输入：${text}
输出：`;

  let out = '';
  try {
    const res = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '你只输出 JSON 对象，不要任何多余文字。' },
        { role: 'user', content: prompt }
      ]
    });
    out = (res && (
      (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ||
      res.response || res.result
    )) || '';
  } catch (e) {
    console.error('[Fund] AI 识别失败:', e?.message || e);
    return { error: 'AI 暂时没响应，请手动填写' };
  }

  let obj = null;
  try {
    const s = String(out);
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) obj = JSON.parse(s.slice(a, b + 1));
  } catch (e) { obj = null; }
  if (!obj || typeof obj !== 'object') return { error: 'AI 没看懂这句话，换个说法或手动填写' };

  /* 类型：认 income/expense，也认中文「收入/支出/花/收」 */
  const rawKind = String(obj.kind || '').toLowerCase().trim();
  let kind = '';
  if (rawKind === 'income' || /收|进账/.test(rawKind)) kind = 'income';
  else if (rawKind === 'expense' || /支|花|买|付/.test(rawKind)) kind = 'expense';
  if (!kind) return { error: 'AI 没判断出是收入还是支出，换个说法试试' };

  const amount = fundParseAmount(obj.amount);
  if (amount.error) return { error: 'AI 给出的金额不对（' + amount.error + '），请手动填写' };

  const d = fundParseDate(obj.date);
  const account = FUND_ACCOUNTS.includes(String(obj.account || '').trim()) ? String(obj.account).trim() : '微信';
  const note = wallClean(obj.note, FUND_LIMITS.note).value;

  return {
    draft: {
      kind,
      amount: fundYuan(amount.cents),
      amountCents: amount.cents,
      date: d.error ? today : d.value,   /* 日期没解析出来就落到今天，前端会显示出来给人核对 */
      dateGuessed: !!d.error,
      account,
      note
    }
  };
}

async function handleAdminFund(request, env, url) {
  const path = url.pathname.replace('/api/admin/fund', '');
  const method = request.method;
  await ensureFundTables(env);

  if (path === '/init' && method === 'POST') {
    const r = await fundSeed(env);
    return jsonResp({ success: true, ...r, count: (await fundSummary(env)).count });
  }

  /* 自然语言记账：识别 + （可选）入账。
   * 不带 autoSave 就只回草稿不落库；带 autoSave=true 时识别和落库在同一个请求里做完 ——
   * 请求已经发到服务端，人关页面/断网都不影响这一步，账照样记上。
   * 识别不出来或落库失败就整条不记，把草稿回给页面由人手动核对。 */
  if (path === '/parse' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { return jsonResp({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const text = wallClean(body.text, FUND_AI.maxText).value;
    if (!text) return jsonResp({ success: false, error: '先说一句要记的账，例如「昨天买扫把挂钩花了 6.7」' }, 400);
    const r = await fundAiParse(env, text);
    if (r.error) return jsonResp({ success: false, error: r.error }, 422);
    if (body.autoSave !== true) return jsonResp({ success: true, draft: r.draft, text });

    /* 草稿再过一遍本地校验：AI 的产出不因为「要自动入账」就免检 */
    const v = fundValidate({
      kind: r.draft.kind, amount: r.draft.amount, date: r.draft.date,
      account: r.draft.account, note: r.draft.note, verified: 0
    });
    if (v.error) return jsonResp({ success: false, error: '没入账：' + v.error, draft: r.draft, text }, 422);
    try {
      const c = await fundCreate(env, v.value, { source: 'ai', text });
      return jsonResp({ success: true, saved: true, id: c.id, draft: r.draft, text });
    } catch (e) {
      return jsonResp({ success: false, error: '没入账：' + (e?.message || e), draft: r.draft, text }, 500);
    }
  }

  /* 凭证：上传 / 查看 / 删除。都挂在 /api/admin/fund/ 下，路由层已经用 isAdmin 挡过 */
  if (path === '/evidence' && method === 'POST') return handleFundEvidenceUpload(request, env);
  if (path === '/evidence/delete' && method === 'POST') return handleFundEvidenceDelete(request, env);
  if (path.startsWith('/evidence/') && method === 'GET') {
    return handleFundEvidenceGet(decodeURIComponent(path.slice('/evidence/'.length)), env);
  }

  if (path === '/records' && method === 'GET') {
    const q = fundListQuery(url);
    try {
      const [summary, list, cfg] = [await fundSummary(env), await fundList(env, q), await fundConfig(env)];
      /* 凭证 key 只回给后台。公开账本那边不带 rows，只留「有没有凭证」 */
      const { rows, ...rest } = list;
      const items = list.items.map((it, i) => ({ ...it, evidenceKey: (rows[i] && rows[i].evidence_key) || '' }));
      return jsonResp({ success: true, ...cfg, summary, ...rest, items, filter: { kind: q.kind, month: q.month, account: q.account, verified: q.verified, q: q.q, order: q.order } });
    } catch (e) {
      console.error('[Fund] 后台读取失败:', e?.stack || e);
      return jsonResp({ success: false, error: '读取失败：' + (e?.message || e) }, 500);
    }
  }

  if (path === '/record' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { return jsonResp({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const v = fundValidate(body);
    if (v.error) return jsonResp({ success: false, error: v.error }, 400);
    /* 凭证是可选附件：给了 key 就得真在 KV 里，别让账目挂一张打不开的图 */
    const ev = fundEvidenceValid(body.evidence);
    if (body.evidence && !ev) return jsonResp({ success: false, error: '凭证参数不对，请重新上传' }, 400);
    if (ev && !(await fundEvidenceExists(env, ev))) return jsonResp({ success: false, error: '凭证没存上，请重新上传' }, 400);
    v.value.evidence_key = ev;
    try {
      /* source='ai' 的写入一律待核对，见 fundCreate */
      const c = await fundCreate(env, v.value, { source: body.source === 'ai' ? 'ai' : 'admin', text: body.sourceText });
      return jsonResp({ success: true, id: c.id, ai: c.isAi, item: { id: c.id, ...fundRowOut({ ...c.value, id: c.id, created_by: c.isAi ? 'ai' : 'admin', created_at: c.now, updated_at: c.now }) } });
    } catch (e) {
      return jsonResp({ success: false, error: '新增失败：' + (e?.message || e) }, 500);
    }
  }

  if (path === '/record/update' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { return jsonResp({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id <= 0) return jsonResp({ success: false, error: '账目不存在' }, 404);
    const v = fundValidate(body);
    if (v.error) return jsonResp({ success: false, error: v.error }, 400);
    const ev = fundEvidenceValid(body.evidence);
    if (body.evidence && !ev) return jsonResp({ success: false, error: '凭证参数不对，请重新上传' }, 400);
    if (ev && !(await fundEvidenceExists(env, ev))) return jsonResp({ success: false, error: '凭证没存上，请重新上传' }, 400);
    try {
      const before = await env.DB.prepare('SELECT * FROM class_fund WHERE id = ?').bind(id).first();
      if (!before) return jsonResp({ success: false, error: '账目不存在，可能已被删除' }, 404);
      await env.DB.prepare(
        `UPDATE class_fund SET kind = ?, occurred_on = ?, account = ?, amount_cents = ?, verified = ?, note = ?, evidence_key = ?, updated_at = ? WHERE id = ?`
      ).bind(v.value.kind, v.value.occurred_on, v.value.account, v.value.amount_cents, v.value.verified, v.value.note, ev, Date.now(), id).run();
      /* 换了凭证（或去掉凭证）就把旧的从 KV 删掉，别在库里留一堆没人认领的截图 */
      if (before.evidence_key && before.evidence_key !== ev) await fundEvidenceDrop(env, before.evidence_key);
      await fundAudit(env, id, 'update', fundRowOut(before), { ...v.value, evidence_key: ev });
      return jsonResp({ success: true, id });
    } catch (e) {
      return jsonResp({ success: false, error: '保存失败：' + (e?.message || e) }, 500);
    }
  }

  if (path === '/record/verify' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { return jsonResp({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id <= 0) return jsonResp({ success: false, error: '账目不存在' }, 404);
    try {
      const before = await env.DB.prepare('SELECT * FROM class_fund WHERE id = ?').bind(id).first();
      if (!before) return jsonResp({ success: false, error: '账目不存在，可能已被删除' }, 404);
      const verified = body.verified ? 1 : 0;
      await env.DB.prepare('UPDATE class_fund SET verified = ?, updated_at = ? WHERE id = ?').bind(verified, Date.now(), id).run();
      await fundAudit(env, id, 'verify', { verified: !!before.verified }, { verified: !!verified });
      return jsonResp({ success: true, id, verified: !!verified });
    } catch (e) {
      return jsonResp({ success: false, error: '保存失败：' + (e?.message || e) }, 500);
    }
  }

  if (path === '/record/delete' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { return jsonResp({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id <= 0) return jsonResp({ success: false, error: '账目不存在' }, 404);
    try {
      const before = await env.DB.prepare('SELECT * FROM class_fund WHERE id = ?').bind(id).first();
      if (!before) return jsonResp({ success: false, error: '账目不存在，可能已被删除' }, 404);
      await env.DB.prepare('DELETE FROM class_fund WHERE id = ?').bind(id).run();
      await fundEvidenceDrop(env, before.evidence_key);   /* 账目没了，凭证也没必要留 */
      await fundAudit(env, id, 'delete', fundRowOut(before), null);
      return jsonResp({ success: true, id });
    } catch (e) {
      return jsonResp({ success: false, error: '删除失败：' + (e?.message || e) }, 500);
    }
  }

  if (path === '/audit' && method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 100);
    try {
      const { results } = await env.DB.prepare(
        'SELECT id, fund_id, action, before_json, after_json, actor, created_at FROM class_fund_audit ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all();
      return jsonResp({ success: true, items: results || [] });
    } catch (e) {
      return jsonResp({ success: false, error: '读取失败：' + (e?.message || e) }, 500);
    }
  }

  /* 导出账单：管理员专属（指导2 §44）。加 BOM，Excel 打开不乱码 */
  if (path === '/export' && method === 'GET') {
    const q = fundListQuery(url);
    q.page = 1; q.limit = FUND_LIMITS.pageMax;
    try {
      const all = [];
      for (let page = 1; page <= 200; page++) {
        q.page = page;
        const batch = await fundList(env, q);
        all.push(...batch.items);
        if (!batch.hasMore) break;
      }
      const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [['日期', '类型', '账户', '金额(元)', '核对', '备注'].map(cell).join(',')];
      for (const it of all) {
        lines.push([it.date, it.kind === 'income' ? '收入' : '支出', it.account, it.amount, it.verified ? '已核对' : '待核对', it.note].map(cell).join(','));
      }
      const csv = '﻿' + lines.join('\r\n') + '\r\n';
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv;charset=UTF-8',
          'Content-Disposition': 'attachment; filename="class-fund.csv"',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      });
    } catch (e) {
      return jsonResp({ success: false, error: '导出失败：' + (e?.message || e) }, 500);
    }
  }

  return jsonResp({ success: false, error: '未知接口' }, 404);
}

/* =====================================================================
 *                              页面 HTML
 * ===================================================================== */

function getMainHTML(isChina) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>清流中学非官方站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:2rem;overflow-x:hidden}
.container{text-align:center;max-width:800px;width:100%}
.gradient-bg{position:fixed;inset:0;background:linear-gradient(135deg,#667eea,#764ba2);z-index:-2}
.gradient-bg::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 30% 50%,rgba(255,255,255,.1),transparent 50%),radial-gradient(circle at 70% 80%,rgba(255,255,255,.1),transparent 50%);animation:float 15s ease-in-out infinite}
@keyframes float{0%,100%{transform:translate(0,0)}50%{transform:translate(20px,20px)}}
.announcement-banner{position:fixed;top:50px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,.15);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.3);border-radius:50px;padding:12px 24px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.1);z-index:100;animation:slideDown .6s ease-out}
@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.announcement-icon{font-size:20px;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
.announcement-text{color:#fff;font-size:14px;font-weight:500}
.github-link{color:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:4px 12px;background:rgba(255,255,255,.2);border-radius:20px;transition:.3s}
.github-link:hover{background:rgba(255,255,255,.3);transform:translateY(-2px)}
h1{font-size:4rem;font-weight:700;color:#fff;text-shadow:2px 2px 4px rgba(0,0,0,.2);margin-bottom:1rem;display:inline-block}
.subtitle{font-size:1.1rem;color:rgba(255,255,255,.95);margin-bottom:3rem;text-shadow:1px 1px 2px rgba(0,0,0,.1)}
.cursor{display:inline-block;width:3px;height:1em;background:#fff;margin-left:.1rem;animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.button-container{margin-top:3rem;display:flex;gap:1.5rem;justify-content:center;flex-wrap:wrap}
.action-btn,.menu-trigger{display:inline-flex;align-items:center;gap:8px;padding:1rem 2rem;background:rgba(255,255,255,.2);color:#fff;text-decoration:none;border-radius:50px;font-weight:600;font-size:1rem;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.3);transition:.3s cubic-bezier(.4,0,.2,1);box-shadow:0 4px 15px rgba(0,0,0,.1)}
.action-btn:hover,.menu-trigger:hover{background:rgba(255,255,255,.3);transform:translateY(-5px);box-shadow:0 8px 25px rgba(0,0,0,.15)}
.menu-group{position:relative;display:inline-block}
.menu-trigger{cursor:pointer;user-select:none}
.menu-arrow{display:inline-block;transition:transform .3s cubic-bezier(.4,0,.2,1);font-size:.8rem}
.menu-group.open .menu-arrow{transform:rotate(180deg)}
.submenu{position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%);background:rgba(255,255,255,.25);backdrop-filter:blur(15px);border:1px solid rgba(255,255,255,.4);border-radius:20px;min-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.2);overflow:hidden;max-height:0;opacity:0;transition:.4s cubic-bezier(.4,0,.2,1);pointer-events:none}
.menu-group.open .submenu{max-height:300px;opacity:1;pointer-events:all}
.submenu-item{display:block;padding:.9rem 1.5rem;color:#fff;text-decoration:none;font-weight:500;font-size:.95rem;transition:.2s;border-bottom:1px solid rgba(255,255,255,.1)}
.submenu-item:last-child{border-bottom:none}
.submenu-item:hover{background:rgba(255,255,255,.2);padding-left:2rem}
@media (max-width:768px){h1{font-size:2.5rem}.subtitle{font-size:1rem}.button-container{flex-direction:column;align-items:center}.action-btn,.menu-trigger{width:100%;max-width:300px}.announcement-banner{top:10px;padding:10px 20px;max-width:90%}.announcement-text{font-size:12px}}
</style>
</head>
<body>
<div class="gradient-bg"></div>
<div class="announcement-banner">
  <span class="announcement-icon">⭐</span>
  <span class="announcement-text">本项目已在 GitHub 开源：
    <a href="https://github.com/xingnengmao666/qlzx-website" class="github-link" target="_blank" rel="noopener noreferrer">
      <span>🔗</span><span>qlzx-website</span>
    </a>
  </span>
</div>
<div class="container">
  <h1 id="text"><span class="cursor">|</span></h1>
  <div class="subtitle">听说平台统一密码为 sh13579@，查询界面位于学生服务下</div>
  <div class="button-container">
    <a href="https://mirror.qlzx.lol" class="action-btn">📥 下载镜像中转</a>
    <a href="https://wl.qlzx.qzz.io" class="action-btn">🧪 物理实验操作方法</a>
    <a href="https://time.qlzx.lol" class="action-btn">🕐 北京时间</a>
    
    <div class="menu-group">
      <div class="menu-trigger" onclick="toggleMenu(event)">📚 学生服务<span class="menu-arrow">▼</span></div>
      <div class="submenu">
        <a href="https://zp.shec.edu.cn/" class="submenu-item" target="_blank" rel="noopener noreferrer">📋 综合素质评价</a>
        <a href="https://jkpt.koukao.cn" class="submenu-item" target="_blank" rel="noopener noreferrer">🎧 听说教考平台</a>
      </div>
    </div>
    <a href="/news.html" class="action-btn">📰 热点新闻</a>
    <a href="/countdown.html" class="action-btn">⏰ 倒计时</a>
    <a href="/drive" class="action-btn">📁 临时云盘</a>
  </div>
</div>
<script>
const t='清流中学非官方站';let i=0,d=false,e=document.getElementById('text');
(function f(){if(!d){if(i<t.length){e.innerHTML=t.slice(0,++i)+'<span class="cursor">|</span>';setTimeout(f,150)}else setTimeout(()=>{document.querySelector('.cursor').style.display='none';d=true;f()},2000)}else{if(i>0){e.innerHTML=t.slice(0,--i)+'<span class="cursor">|</span>';setTimeout(f,100)}else{d=false;setTimeout(f,500)}}})();
function toggleMenu(event){event.stopPropagation();const g=event.currentTarget.parentElement;document.querySelectorAll('.menu-group.open').forEach(o=>{if(o!==g)o.classList.remove('open')});g.classList.toggle('open')}
document.addEventListener('click',e=>{if(!e.target.closest('.menu-group'))document.querySelectorAll('.menu-group.open').forEach(g=>g.classList.remove('open'))});
</script>
</body>
</html>`;
}

function getLandingHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f2f2f5">
<title>建平世纪中学</title>
<script>
/* 主题先行，避免闪烁 */
try{var t=localStorage.getItem('np-theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}
</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
:root{
 --bg:#f2f2f5;--fg:#15151a;--dim:#6c6c76;--line:rgba(0,0,0,.08);
 --glass:rgba(255,255,255,.55);--glass2:rgba(255,255,255,.34);--edge:rgba(255,255,255,.75);
 --sh:0 1px 1px rgba(0,0,0,.04),0 6px 16px rgba(0,0,0,.06),0 24px 60px rgba(0,0,0,.07);
 --shH:0 1px 1px rgba(0,0,0,.05),0 12px 26px rgba(0,0,0,.09),0 36px 90px rgba(0,0,0,.11);
 --a:#667eea;--b:#764ba2;--c:#3b82f6;--d:#ec4899;
 font:100%/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
}
html[data-theme="dark"]{
 --bg:#08080b;--fg:#f2f2f7;--dim:#9a9aa4;--line:rgba(255,255,255,.1);
 --glass:rgba(32,32,38,.5);--glass2:rgba(28,28,34,.34);--edge:rgba(255,255,255,.14);
 --sh:0 1px 1px rgba(0,0,0,.5),0 8px 22px rgba(0,0,0,.45),0 28px 70px rgba(0,0,0,.5);
 --shH:0 1px 1px rgba(0,0,0,.55),0 14px 34px rgba(0,0,0,.55),0 44px 110px rgba(0,0,0,.6);
 --a:#3d5ea8;--b:#5d2f56;--c:#1e4a7a;--d:#7a2d5a;
}
body{background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;min-height:100vh;min-height:100dvh;transition:background-color .6s linear,color .6s linear;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;overflow-x:hidden}
.bgfx{position:fixed;inset:-20vmax;z-index:-3;filter:blur(80px) saturate(140%);opacity:.85;pointer-events:none}
html[data-theme="dark"] .bgfx{opacity:.6;filter:blur(96px) saturate(120%)}
.blob{position:absolute;border-radius:50%;opacity:.55;will-change:transform}
.b1{width:52vmax;height:52vmax;background:radial-gradient(circle at 30% 30%,var(--a),transparent 68%);top:-8%;left:-6%;animation:d1 46s ease-in-out infinite alternate}
.b2{width:46vmax;height:46vmax;background:radial-gradient(circle at 60% 40%,var(--b),transparent 68%);top:22%;right:-10%;animation:d2 58s ease-in-out infinite alternate}
.b3{width:50vmax;height:50vmax;background:radial-gradient(circle at 40% 60%,var(--c),transparent 68%);bottom:-14%;left:14%;animation:d3 52s ease-in-out infinite alternate}
.b4{width:34vmax;height:34vmax;background:radial-gradient(circle at 50% 50%,var(--d),transparent 68%);top:56%;left:52%;animation:d4 64s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate3d(12vmax,8vmax,0) scale(1.15)}}
@keyframes d2{to{transform:translate3d(-14vmax,10vmax,0) scale(1.1)}}
@keyframes d3{to{transform:translate3d(10vmax,-12vmax,0) scale(1.18)}}
@keyframes d4{to{transform:translate3d(-9vmax,-7vmax,0) scale(.9)}}
.grain{position:fixed;inset:0;z-index:-2;pointer-events:none;opacity:.035;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence baseFrequency='.85' numOctaves='3'/></filter><rect width='140' height='140' filter='url(%23n)'/></svg>")}
.orb{position:fixed;top:1.1rem;right:1.1rem;width:2.4rem;height:2.4rem;border-radius:50%;cursor:pointer;z-index:20;background:radial-gradient(circle at 35% 32%,#ffd88a,#ff9d4d);box-shadow:0 0 14px rgba(255,170,80,.55);border:none;transition:background .6s linear,box-shadow .6s linear,transform .3s cubic-bezier(.34,1.56,.64,1)}
.orb:active{transform:scale(.9)}
html[data-theme="dark"] .orb{background:radial-gradient(circle at 62% 38%,#e9edf7,#a9b3c9);box-shadow:0 0 14px rgba(190,205,255,.4)}
.hero{text-align:center;margin-bottom:3.2rem;opacity:0;transform:translateY(22px)}
.hero.in{opacity:1;transform:none;transition:opacity .7s linear,transform .7s cubic-bezier(.34,1.56,.64,1)}
.hero .school{font-size:clamp(1.6rem,4.5vw,2.6rem);font-weight:700;letter-spacing:.02em}
.hero .sub{margin-top:.55rem;font-size:.95rem;color:var(--dim);letter-spacing:.04em}
.cards{display:flex;gap:1.2rem;flex-wrap:wrap;justify-content:center;max-width:1000px}
.card{position:relative;flex:1 1 260px;max-width:300px;min-height:210px;border-radius:1.6rem;padding:1.8rem 1.6rem;cursor:pointer;text-decoration:none;color:var(--fg);background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;opacity:0;transform:translateY(28px) scale(.92);transition:transform .6s cubic-bezier(.34,1.56,.64,1),box-shadow .45s linear,opacity .6s linear}
.card.in{opacity:1;transform:none}
.card:hover{transform:translateY(-4px) scale(1.02);box-shadow:var(--shH),inset 0 1px 0 var(--edge)}
.card:active{transform:scale(.97);transition:transform 120ms ease-out}
.card .glare{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .5s linear;background:radial-gradient(16rem 16rem at var(--mx,50%) var(--my,50%),rgba(255,255,255,.32),transparent 60%)}
html[data-theme="dark"] .card .glare{background:radial-gradient(16rem 16rem at var(--mx,50%) var(--my,50%),rgba(255,255,255,.08),transparent 60%)}
.card:hover .glare{opacity:1}
.card .ico{font-size:2.6rem;line-height:1;margin-bottom:1rem}
.card .name{font-size:1.3rem;font-weight:700;letter-spacing:-.01em}
.card .desc{margin-top:.4rem;font-size:.86rem;color:var(--dim);line-height:1.55}
.card .go{margin-top:1.2rem;font-size:.82rem;font-weight:600;color:var(--dim);display:flex;align-items:center;gap:.35rem}
.card .go b{color:#0071e3}
.foot{margin-top:2.8rem;font-size:.78rem;color:var(--dim);letter-spacing:.06em;opacity:0}
.foot.in{opacity:1;transition:opacity .8s linear .4s}
@media(max-width:560px){.cards{flex-direction:column}.card{max-width:none;min-height:auto}}
@media (prefers-reduced-motion: reduce){.card,.hero{transition:none}.hero,.card{transform:none;opacity:1}}
</style>
</head>
<body>
<div class="bgfx"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i><i class="blob b4"></i></div>
<div class="grain"></div>
<button class="orb" id="themeBtn" aria-label="切换昼夜" title="切换昼夜"></button>
<div class="hero" id="hero">
  <div class="school">上海市建平世纪中学</div>
  <div class="sub">选择要前往的页面</div>
</div>
<div class="cards" id="cards">
  <a class="card" href="/news" id="cNews">
    <div class="glare"></div>
    <div>
      <div class="ico">📰</div>
      <div class="name">热点新闻</div>
      <div class="desc">多来源聚合资讯，瀑布流浏览，AI 抽检标注</div>
    </div>
    <div class="go">进入 <b>→</b></div>
  </a>
  <a class="card" href="/exam" id="cExam">
    <div class="glare"></div>
    <div>
      <div class="ico">⏰</div>
      <div class="name">考试模式</div>
      <div class="desc">考试倒计时显示，剩余时间进度，全屏大字时钟</div>
    </div>
    <div class="go">进入 <b>→</b></div>
  </a>
  <a class="card" href="/wall" id="cWall">
    <div class="glare"></div>
    <div>
      <div class="ico">🎓</div>
      <div class="name">毕业留言墙</div>
      <div class="desc">写一张便签投进留言箱，留在属于我们的那面墙上</div>
    </div>
    <div class="go">进入 <b>→</b></div>
  </a>
  <a class="card" href="/fund" id="cFund">
    <div class="glare"></div>
    <div>
      <div class="ico">💰</div>
      <div class="name">班费收支</div>
      <div class="desc">高一（7）班的公开账本，收了多少钱、花了多少钱、还剩多少</div>
    </div>
    <div class="go">进入 <b>→</b></div>
  </a>
</div>
<div class="foot" id="foot">建平世纪中学 · 非官方站点</div>
<script>
(function(){
  var tb=document.getElementById('themeBtn');
  tb.addEventListener('click',function(){
    var h=document.documentElement;
    var dark=h.getAttribute('data-theme')==='dark';
    h.setAttribute('data-theme',dark?'light':'dark');
    try{localStorage.setItem('np-theme',dark?'light':'dark')}catch(e){}
  });
  /* Q弹入场：hero 先弹，两张卡依次错开，spring 曲线回弹 */
  var t1=setTimeout(function(){document.getElementById('hero').classList.add('in')},80);
  var t2=setTimeout(function(){document.getElementById('cNews').classList.add('in')},180);
  var t3=setTimeout(function(){document.getElementById('cExam').classList.add('in')},300);
  var t3b=setTimeout(function(){document.getElementById('cWall').classList.add('in')},380);
  var t3c=setTimeout(function(){document.getElementById('cFund').classList.add('in')},450);
  var t4=setTimeout(function(){document.getElementById('foot').classList.add('in')},520);
  /* 卡片光泽跟随鼠标 */
  document.getElementById('cards').addEventListener('mousemove',function(e){
    var c=e.target.closest('.card');if(!c)return;
    var b=c.getBoundingClientRect();
    c.style.setProperty('--mx',(e.clientX-b.left)+'px');
    c.style.setProperty('--my',(e.clientY-b.top)+'px');
  });
})();
</script>
</body>
</html>`;
}

function getExamHTML() {
  return `<!DOCTYPE html>
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
}

/* ================= 毕业留言墙页面 ================= */
function getWallHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#f6f2e9">
<title>毕业留言墙</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Noto+Serif+SC:wght@400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  /* 莫奈：奶油白 / 雾蓝 / 鼠尾草绿 / 雾粉 / 淡紫 / 浅鹅黄 / 米色 / 浅青 */
  --cream:#f7f3ea; --ink:#4a453e; --ink2:#837b6f; --line:rgba(74,69,62,.14);
  --sage:#b9c9b3; --mist:#bccfdf; --blush:#e9cfc9; --butter:#f4e6be; --lilac:#d2c9df; --mint:#c6dcd6;
  --paper-cream:#fbf8f1; --paper-butter:#f8efd3; --paper-mist:#e6eef5; --paper-sage:#e8f0e6;
  --paper-blush:#f8e8e5; --paper-lilac:#eee9f6;
  --sh-note:0 1px 1px rgba(74,64,50,.05),0 6px 14px rgba(74,64,50,.07);
  --sh-box:0 2px 6px rgba(74,64,50,.12),0 14px 30px rgba(74,64,50,.14);
}
html,body{min-height:100%}
body{
  background:var(--cream);color:var(--ink);
  font-family:"Noto Serif SC",-apple-system,"PingFang SC","Microsoft YaHei",serif;
  font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased;
  overflow-x:hidden;padding-bottom:9rem;
}
.bg{position:fixed;inset:0;z-index:-2;pointer-events:none;background:
  radial-gradient(60rem 40rem at 8% -6%,rgba(188,207,223,.55),transparent 62%),
  radial-gradient(48rem 34rem at 96% 4%,rgba(233,207,201,.5),transparent 60%),
  radial-gradient(52rem 38rem at 50% 112%,rgba(185,201,179,.45),transparent 62%),
  linear-gradient(180deg,#f9f6ef,#f4efe4)}
.grain{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='.8' numOctaves='2'/></filter><rect width='160' height='160' filter='url(%23n)' opacity='.05'/></svg>")}
a{color:inherit}
::selection{background:var(--butter)}
.wrap{max-width:1180px;margin:0 auto;padding:0 1.15rem}

/* ---- 顶部：沿用站点的极简返回 ---- */
header.top{position:sticky;top:0;z-index:40;background:rgba(247,243,234,.82);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:.9rem;height:3.1rem}
.top .back{font-size:.86rem;color:var(--ink2);text-decoration:none;padding:.3rem .1rem;transition:color .25s}
.top .back:hover{color:var(--ink)}
.top .name{font-size:.9rem;letter-spacing:.06em;color:var(--ink2);margin-left:auto}
.top .cnt{font-size:.82rem;color:var(--ink2);background:rgba(255,255,255,.6);border:1px solid var(--line);border-radius:999px;padding:.12rem .6rem}

/* ---- 头图 ---- */
.hero{text-align:center;padding:3.4rem 0 1.6rem}
.hero h1{font-size:clamp(1.6rem,5.2vw,2.7rem);font-weight:600;letter-spacing:.04em;line-height:1.4}
.hero .year{display:inline-block;font-family:"Cormorant Garamond",serif;font-size:.95em;color:var(--ink2);letter-spacing:.1em;margin-right:.35rem}
.hero .slogan{margin-top:.85rem;color:var(--ink2);font-size:.95rem;letter-spacing:.02em}
.hero .cta{margin-top:1.7rem;display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap}
.btn{font:inherit;font-size:.92rem;padding:.62rem 1.4rem;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.72);color:var(--ink);cursor:pointer;transition:transform .3s cubic-bezier(.34,1.4,.64,1),box-shadow .3s,background .3s;box-shadow:0 1px 2px rgba(74,64,50,.05)}
.btn:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(74,64,50,.1)}
.btn:active{transform:translateY(0) scale(.98)}
.btn.pri{background:linear-gradient(180deg,#f3e3bb,#eeda9f);border-color:rgba(74,64,50,.16);font-weight:600}
.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn.ghost{background:transparent}
.closed-note{margin-top:1rem;color:var(--ink2);font-size:.92rem}

/* ---- 班级筛选 ---- */
.filters{display:flex;gap:.45rem;overflow-x:auto;padding:.4rem .15rem 1.4rem;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.filters::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;font:inherit;font-size:.82rem;color:var(--ink2);background:rgba(255,255,255,.6);border:1px solid var(--line);border-radius:999px;padding:.3rem .85rem;cursor:pointer;transition:background .25s,color .25s}
.chip.on{background:var(--sage);color:#3c413a;border-color:transparent;font-weight:600}

/* ---- 墙 ---- */
.wall{columns:1;column-gap:1.1rem}
@media(min-width:620px){.wall{columns:2}}
@media(min-width:940px){.wall{columns:3}}
@media(min-width:1240px){.wall{columns:4}}
.note{position:relative;break-inside:avoid;-webkit-column-break-inside:avoid;page-break-inside:avoid;margin:0 0 1.1rem;
  padding:1.15rem 1.15rem 1rem;background:var(--paper-cream);border-radius:2px;
  box-shadow:var(--sh-note);transform:rotate(var(--rot,0deg));
  transition:transform .4s cubic-bezier(.34,1.4,.64,1),box-shadow .4s}
.note::after{content:"";position:absolute;inset:0;border-radius:2px;pointer-events:none;
  background-image:repeating-linear-gradient(0deg,rgba(74,64,50,.02) 0 1px,transparent 1px 4px),
    radial-gradient(120% 90% at 8% 0%,rgba(255,255,255,.55),transparent 62%)}
.note.c-cream{background:var(--paper-cream)}.note.c-butter{background:var(--paper-butter)}
.note.c-mist{background:var(--paper-mist)}.note.c-sage{background:var(--paper-sage)}
.note.c-blush{background:var(--paper-blush)}.note.c-lilac{background:var(--paper-lilac)}
.note.clk{cursor:pointer}
.note.clk:hover{transform:rotate(0deg) translateY(-3px);box-shadow:0 2px 3px rgba(74,64,50,.06),0 14px 28px rgba(74,64,50,.13)}
.note .txt{position:relative;z-index:1;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:.98rem;line-height:1.85;color:#3f3a34}
.note .to{position:relative;z-index:1;font-size:.78rem;color:var(--ink2);margin-bottom:.35rem}
.note .meta{position:relative;z-index:1;margin-top:.85rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-size:.76rem;color:var(--ink2)}
.note .sig{font-weight:600;color:#5b544b}
.tag{font-size:.72rem;background:rgba(255,255,255,.66);border:1px solid var(--line);border-radius:999px;padding:.05rem .5rem}
.note.pop{animation:pop .55s cubic-bezier(.34,1.5,.64,1)}
@keyframes pop{from{opacity:0;transform:rotate(var(--rot,0deg)) scale(.9) translateY(-8px)}to{opacity:1}}
.sentinel{height:1px}
.loading{text-align:center;color:var(--ink2);font-size:.85rem;padding:1.4rem 0}
.state{text-align:center;padding:3.2rem 1rem;color:var(--ink2)}
.state .big{font-size:1.15rem;color:var(--ink);margin-bottom:.5rem;letter-spacing:.04em}
.state .btn{margin-top:1.2rem}

/* ---- 留言箱 ---- */
.box{position:fixed;right:1.2rem;bottom:1.2rem;z-index:30;width:7.6rem;height:5.4rem;cursor:pointer;user-select:none}
.box .face{position:absolute;inset:0;border-radius:.35rem;box-shadow:var(--sh-box);
  background:linear-gradient(180deg,#efe4cd,#ddceb0);border:1px solid rgba(74,64,50,.16);transform:rotate(-1.2deg)}
.box .slot{position:absolute;left:12%;right:12%;top:26%;height:.62rem;border-radius:2px;
  background:linear-gradient(180deg,#6c6153,#8d8172);box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.box .lbl{position:absolute;left:0;right:0;bottom:.55rem;text-align:center;font-size:.76rem;letter-spacing:.22em;color:#6a6053}
.box:active .face{transform:rotate(-1.2deg) scale(.96)}
@media(max-width:560px){.box{right:.7rem;bottom:.7rem;width:5.6rem;height:4.2rem}.box .lbl{font-size:.68rem;letter-spacing:.14em;bottom:.35rem}.box .slot{top:22%;height:.5rem}}

/* ---- 浮层 ---- */
.scrim{position:fixed;inset:0;z-index:60;background:rgba(58,52,44,.34);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:1rem;overflow-y:auto}
.scrim.on{display:flex}
.sheet{width:100%;max-width:34rem;margin:auto;background:linear-gradient(180deg,#fdfbf6,#f8f3e8);border:1px solid var(--line);border-radius:.6rem;box-shadow:0 20px 50px rgba(60,52,42,.24);padding:1.4rem 1.35rem 1.25rem;animation:sheet .45s cubic-bezier(.34,1.4,.64,1)}
@keyframes sheet{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
.sheet h2{font-size:1.02rem;font-weight:600;letter-spacing:.04em;margin-bottom:1rem}
.sheet label{display:block;font-size:.78rem;color:var(--ink2);margin:.85rem 0 .3rem;letter-spacing:.04em}
.sheet input[type=text],.sheet textarea,.sheet select{font:inherit;font-size:.92rem;width:100%;padding:.55rem .7rem;background:rgba(255,255,255,.72);border:1px solid var(--line);border-radius:.35rem;color:var(--ink);outline:none;transition:border-color .25s}
.sheet input[type=text]:focus,.sheet textarea:focus,.sheet select:focus{border-color:rgba(140,150,130,.7)}
.sheet textarea{min-height:8.5rem;resize:vertical;line-height:1.8}
.count{font-size:.74rem;color:var(--ink2);text-align:right;margin-top:.3rem}
.count.warn{color:#b0824a}
.sheet .row2{display:flex;gap:.8rem}
.sheet .row2>div{flex:1}
.anon{display:flex;align-items:center;gap:.45rem;margin-top:.7rem;font-size:.82rem;color:var(--ink2);cursor:pointer}
.anon input{accent-color:#9fb096;width:1rem;height:1rem}
.acts{display:flex;gap:.7rem;justify-content:flex-end;margin-top:1.35rem;flex-wrap:wrap}
.note.big{font-size:1.05rem;transform:none;box-shadow:0 10px 30px rgba(74,64,50,.14);margin:0}
.note.big .txt{font-size:1.06rem}
.hint{font-size:.78rem;color:var(--ink2);text-align:center;margin-top:.9rem}
.radios{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.3rem}
.radios label{display:inline-flex;align-items:center;gap:.35rem;font-size:.84rem;color:var(--ink);background:rgba(255,255,255,.6);border:1px solid var(--line);border-radius:999px;padding:.25rem .7rem;cursor:pointer;margin:0}
.radios input{accent-color:#9fb096}
/* 飞行中的便签：脱离编辑器飞向留言箱 */
.fly{position:fixed;z-index:70;margin:0;pointer-events:none;will-change:transform,opacity}
.toast{position:fixed;left:50%;bottom:1.6rem;transform:translateX(-50%) translateY(1rem);z-index:80;
  background:rgba(74,64,50,.92);color:#fbf7ef;font-size:.86rem;padding:.55rem 1.1rem;border-radius:999px;
  opacity:0;pointer-events:none;transition:opacity .35s,transform .45s cubic-bezier(.34,1.4,.64,1);max-width:88vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
.ok-note{position:fixed;left:0;right:0;top:34%;text-align:center;z-index:75;pointer-events:none;opacity:0;transition:opacity .5s}
.ok-note.on{opacity:1}
.ok-note b{font-size:1.3rem;letter-spacing:.16em;color:#5b544b;background:rgba(253,251,246,.86);border-radius:.5rem;padding:.7rem 1.3rem;box-shadow:0 10px 26px rgba(74,64,50,.14);display:inline-block}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media (prefers-reduced-motion: reduce){
  .note,.btn,.sheet,.toast{transition:none;animation:none}
  .note{transform:none}
}
</style>
</head>
<body>
<div class="bg"></div>
<div class="grain"></div>

<header class="top"><div class="wrap">
  <a class="back" href="/">← 返回</a>
  <span class="name" id="topName">毕业留言墙</span>
  <span class="cnt" id="topCnt">…</span>
</div></header>

<div class="wrap">
  <div class="hero">
    <h1><span class="year" id="hYear">2026</span><span id="hTitle">届毕业留言墙</span></h1>
    <div class="slogan" id="hSlogan">把想说的话，留在这一年的墙上。</div>
    <div class="cta">
      <button class="btn pri" id="writeBtn">✎ 写下一张</button>
      <button class="btn ghost" id="lookBtn">看看大家说了什么</button>
    </div>
    <div class="closed-note" id="closedNote" style="display:none"></div>
  </div>

  <div class="filters" id="filters"></div>
  <div class="wall" id="wall"></div>
  <div id="state" class="state" style="display:none"></div>
  <div class="sentinel" id="sentinel"></div>
  <div class="loading" id="loading" style="display:none">正在翻找墙上的纸条…</div>
</div>

<div class="box" id="msgBox" title="留言箱">
  <div class="face"></div>
  <div class="slot"></div>
  <div class="lbl">留言箱</div>
</div>

<div class="scrim" id="editScrim">
  <div class="sheet" role="dialog" aria-modal="true" aria-label="写一张留言">
    <h2>写一张纸条</h2>
    <label for="fTarget">写给谁（可以留空）</label>
    <input type="text" id="fTarget" maxlength="30" placeholder="写给某个人，或者某段日子">
    <div class="row2">
      <div>
        <label for="fClass">班级</label>
        <select id="fClass"></select>
      </div>
      <div>
        <label for="fSign">署名</label>
        <input type="text" id="fSign" maxlength="20" placeholder="写下你的名字">
      </div>
    </div>
    <label class="anon"><input type="checkbox" id="fAnon">匿名留下</label>
    <label for="fBody">想说的话</label>
    <textarea id="fBody" maxlength="200" placeholder="写点什么吧，写到这儿的话，会一直留在这面墙上。"></textarea>
    <div class="count" id="fCount">0 / 200</div>
    <div class="acts">
      <button class="btn ghost" id="cancelBtn">先不写了</button>
      <button class="btn pri" id="previewBtn">预览一下</button>
    </div>
  </div>
</div>

<div class="scrim" id="pvScrim">
  <div class="sheet" role="dialog" aria-modal="true" aria-label="预览纸条">
    <h2>就要投进去了</h2>
    <div id="pvNoteWrap"></div>
    <div class="acts">
      <button class="btn ghost" id="paperBtn">换张纸</button>
      <button class="btn ghost" id="backBtn">再改改</button>
      <button class="btn pri" id="dropBtn">投入留言箱</button>
    </div>
    <div class="hint" id="pvHint">看看是不是你想说的样子。</div>
  </div>
</div>

<div class="scrim" id="dtScrim">
  <div class="sheet" role="dialog" aria-modal="true" aria-label="纸条">
    <div id="dtNoteWrap"></div>
    <div class="acts">
      <button class="btn ghost" id="dtReport">举报这张纸条</button>
      <button class="btn" id="dtClose">收起</button>
    </div>
  </div>
</div>

<div class="scrim" id="rpScrim">
  <div class="sheet" role="dialog" aria-modal="true" aria-label="举报">
    <h2>举报这张纸条</h2>
    <div class="radios" id="rpReasons"></div>
    <label for="rpDetail">补充说明（可选）</label>
    <textarea id="rpDetail" maxlength="100" style="min-height:4.5rem"></textarea>
    <div class="acts">
      <button class="btn ghost" id="rpCancel">算了</button>
      <button class="btn pri" id="rpSubmit">提交</button>
    </div>
  </div>
</div>

<div class="ok-note" id="okNote"><b>留好了。</b></div>
<div class="toast" id="toast"></div>

<script>
(function(){
  'use strict';
  var PAPERS=['cream','butter','mist','sage','blush','lilac'];
  var REASONS=['不当内容','人身攻击','广告','隐私泄露','其他'];
  var BODY_MAX=200, MAX_NOTES=360, PAGE=24;
  var RM=false;
  try{RM=window.matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){}

  var S={cfg:null,items:[],cursor:null,hasMore:true,loading:false,filter:'',
         mode:'idle',draft:null,token:'',submitting:false,shown:0,firstDone:false};

  function $(id){return document.getElementById(id)}
  function mk(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  function rot(id){return (((id*37)%5)-2)*0.6}
  function uuid(){
    try{if(window.crypto&&crypto.randomUUID)return crypto.randomUUID()}catch(e){}
    return 'w'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  }
  var toastT=null;
  function toast(msg){
    var t=$('toast');t.textContent=msg;t.classList.add('on');
    if(toastT)clearTimeout(toastT);
    toastT=setTimeout(function(){t.classList.remove('on')},3200);
  }
  function fmt(ts){
    if(!ts)return '';
    var d=new Date(ts),diff=Date.now()-ts,m=Math.floor(diff/60000);
    if(m<1)return '刚刚';
    if(m<60)return m+' 分钟前';
    var h=Math.floor(m/60);
    if(h<24)return h+' 小时前';
    var day=Math.floor(h/24);
    if(day<30)return day+' 天前';
    return d.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'});
  }
  function api(path,opt){
    var o=opt||{};
    var ctl=null, timer=null;
    try{ctl=new AbortController();o.signal=ctl.signal;timer=setTimeout(function(){ctl.abort()},15000)}catch(e){}
    var p=fetch(path,o).then(function(r){
      return r.text().then(function(t){
        var j=null;try{j=JSON.parse(t)}catch(e){}
        if(!j)throw new Error('服务没有正确回应');
        return {status:r.status,body:j};
      });
    });
    if(timer)p.then(function(){clearTimeout(timer)},function(){clearTimeout(timer)});
    return p;
  }

  /* ---------- 便签渲染 ---------- */
  function noteEl(item,big,clickable){
    var n=mk('div','note c-'+item.paper+(big?' big':'')+(clickable?' clk':''));
    n.style.setProperty('--rot',(big?'0':rot(item.id))+'deg');
    if(item.target){
      var to=mk('div','to');to.textContent='写给 '+item.target;n.appendChild(to);
    }
    var t=mk('div','txt');t.textContent=item.body;n.appendChild(t);
    var meta=mk('div','meta');
    var sig=mk('span','sig',item.anonymous?'匿名同学':(item.signature||'一位同学'));
    meta.appendChild(sig);
    if(item.classLabel)meta.appendChild(mk('span','tag',item.classLabel));
    meta.appendChild(mk('span',null,fmt(item.createdAt)));
    n.appendChild(meta);
    if(clickable&&item.id){
      n.setAttribute('role','button');
      n.setAttribute('tabindex','0');
      n.setAttribute('aria-label','查看这张纸条');
      n.addEventListener('click',function(){openDetail(item.id)});
      n.addEventListener('keydown',function(e){
        if(e.key==='Enter'||e.key===' '){e.preventDefault();openDetail(item.id)}
      });
    }
    return n;
  }

  function totalText(n){return '已留下 '+n+' 张纸条'}

  /* ---------- 列表 ---------- */
  function setState(html){
    var box=$('state');
    if(!html){box.style.display='none';box.innerHTML='';return}
    box.innerHTML=html;box.style.display='';
  }
  function emptyState(){
    var d=mk('div');
    d.appendChild(mk('div','big','这里还很安静。'));
    d.appendChild(mk('div',null,'要不要成为第一个留下话的人？'));
    var b=mk('button','btn pri','✎ 写下一张');
    b.addEventListener('click',openEditor);
    d.appendChild(b);
    $('state').innerHTML='';
    $('state').appendChild(d);
    $('state').style.display='';
  }
  function errorState(msg){
    var d=mk('div');
    d.appendChild(mk('div','big','墙上暂时看不清。'));
    d.appendChild(mk('div',null,msg||'网络好像不太顺，再试一次吧。'));
    var b=mk('button','btn','重新加载');
    b.addEventListener('click',function(){load(true)});
    d.appendChild(b);
    $('state').innerHTML='';$('state').appendChild(d);$('state').style.display='';
  }

  function appendItems(items,push){
    var wall=$('wall');
    var frag=document.createDocumentFragment();
    items.forEach(function(it){
      var n=noteEl(it,false,true);
      if(push)n.classList.add('pop');
      frag.appendChild(n);
      S.items.push(it);
    });
    if(push)wall.insertBefore(frag,wall.firstChild);else wall.appendChild(frag);
    /* DOM 上限：超出后移除最早的节点（在顶部，往下翻不受影响） */
    while(wall.children.length>MAX_NOTES){wall.removeChild(wall.firstChild)}
  }

  function load(reset){
    if(S.loading)return;
    if(!reset&&!S.hasMore)return;
    S.loading=true;
    if(reset){S.cursor=null;S.hasMore=true;S.items=[];S.shown=0;$('wall').innerHTML='';setState('')}
    $('loading').style.display='';
    var q='/api/wall/messages?limit='+PAGE+(S.filter?'&class='+encodeURIComponent(S.filter):'')+(S.cursor?'&cursor='+S.cursor:'');
    api(q).then(function(r){
      S.loading=false;$('loading').style.display='none';
      if(!r.body.success){errorState(r.body.error);return}
      appendItems(r.body.items||[],false);
      S.hasMore=!!r.body.hasMore;
      S.cursor=r.body.nextCursor;
      S.firstDone=true;
      if(typeof r.body.total==='number')setTopCount(r.body.total);
      if(!S.items.length&&S.filter){setState('<div class="big">这个班级还没有人留下话。</div><div>要不，你先来一句？</div>')}
      else if(!S.items.length){emptyState()}
      else setState('');
    },function(){
      S.loading=false;$('loading').style.display='none';
      if(!S.firstDone)errorState();else toast('后面的纸条没加载出来，稍后再试');
    });
  }

  function applyFilter(cls,chip){
    if(S.filter===cls)return;
    S.filter=cls;
    var chips=document.querySelectorAll('.chip');
    for(var i=0;i<chips.length;i++)chips[i].classList.toggle('on',chips[i]===chip);
    load(true);
    try{$('wall').scrollIntoView({behavior:RM?'auto':'smooth',block:'start'})}catch(e){}
  }

  function buildFilters(classes){
    var box=$('filters');box.innerHTML='';
    var all=mk('button','chip on','全部');
    all.addEventListener('click',function(){applyFilter('',all)});
    box.appendChild(all);
    classes.forEach(function(c){
      var b=mk('button','chip',c);
      b.addEventListener('click',function(){applyFilter(c,b)});
      box.appendChild(b);
    });
    box.style.display=classes.length?'':'none';
  }

  function setTopCount(n){
    $('topCnt').textContent=n==null?'…':totalText(n);
    if(S.cfg)S.cfg.total=n;
  }

  /* ---------- 编辑 ---------- */
  function openEditor(){
    if(!S.cfg||!S.cfg.open)return;
    if(S.submitting)return;
    var classes=(S.cfg.classes||[]).slice();
    if(!classes.length)classes=['其他'];
    S.draft={target:'',classLabel:classes[0],body:'',signature:'',anonymous:false,
             paper:PAPERS[Math.floor(Math.random()*PAPERS.length)]};
    S.token=uuid();
    S.mode='edit';
    var sel=$('fClass');sel.innerHTML='';
    classes.forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=c;sel.appendChild(o)});
    $('fTarget').value='';$('fSign').value='';$('fAnon').checked=false;$('fBody').value='';
    syncAnon();count();
    $('editScrim').classList.add('on');
    setTimeout(function(){try{$('fBody').focus()}catch(e){}},80);
  }
  function closeEditor(){
    $('editScrim').classList.remove('on');
    if(S.mode!=='flying')S.mode='idle';
  }
  function syncAnon(){
    var on=$('fAnon').checked;
    $('fSign').disabled=on;
    $('fSign').placeholder=on?'匿名同学':'写下你的名字';
  }
  function count(){
    var n=Array.from($('fBody').value.trim()).length;
    var c=$('fCount');
    c.textContent=n+' / '+BODY_MAX;
    c.className='count'+(n>BODY_MAX-20?' warn':'');
  }
  function newToken(){S.token=uuid()}
  function readDraft(){
    S.draft.target=$('fTarget').value.trim();
    S.draft.classLabel=$('fClass').value;
    S.draft.body=$('fBody').value.trim();
    S.draft.signature=$('fSign').value.trim();
    S.draft.anonymous=$('fAnon').checked;
    return S.draft;
  }
  function draftItem(){
    var d=S.draft;
    return {id:0,body:d.body||'（还没写内容）',anonymous:d.anonymous,signature:d.signature,
            target:d.target,classLabel:d.classLabel,paper:d.paper,createdAt:Date.now()};
  }
  function preview(){
    readDraft();
    if(!S.draft.body){toast('还没写内容呢');try{$('fBody').focus()}catch(e){}return}
    if(Array.from(S.draft.body).length>BODY_MAX){toast('写得有点长，最多 '+BODY_MAX+' 字');return}
    var wrapTxt=Array.from(S.draft.body).slice(0,BODY_MAX).join('');
    S.draft.body=wrapTxt;
    S.mode='preview';
    var box=$('pvNoteWrap');box.innerHTML='';
    box.appendChild(noteEl(draftItem(),true,false));
    $('pvHint').textContent='看看是不是你想说的样子。';
    $('editScrim').classList.remove('on');
    $('pvScrim').classList.add('on');
  }
  function backToEdit(){
    $('pvScrim').classList.remove('on');
    $('editScrim').classList.add('on');
    S.mode='edit';
  }
  function cyclePaper(){
    readDraft();
    var i=PAPERS.indexOf(S.draft.paper);
    S.draft.paper=PAPERS[(i+1)%PAPERS.length];
    var box=$('pvNoteWrap');box.innerHTML='';
    box.appendChild(noteEl(draftItem(),true,false));
  }

  /* ---------- 投箱 ---------- */
  function fly(fromEl,toEl){
    if(RM||!fromEl||!toEl)return Promise.resolve(null);
    var a=fromEl.getBoundingClientRect(),b=toEl.getBoundingClientRect();
    var clone=fromEl.cloneNode(true);
    clone.classList.add('fly');
    clone.style.left=a.left+'px';clone.style.top=a.top+'px';
    clone.style.width=a.width+'px';
    document.body.appendChild(clone);
    fromEl.style.visibility='hidden';
    var dx=(b.left+b.width/2)-(a.left+a.width/2);
    var dy=(b.top+b.height/2)-(a.top+a.height/2);
    var anim;
    try{
      anim=clone.animate([
        {transform:'translate(0,0) rotate(0deg) scale(1)',opacity:1},
        {offset:.28,transform:'translate('+(dx*0.3)+'px,'+(dy*0.3-30)+'px) rotate(-5deg) scale(1.02)',opacity:1},
        {offset:.7,transform:'translate('+(dx*0.78)+'px,'+(dy*0.8-10)+'px) rotate(7deg) scale(.7)',opacity:1},
        {transform:'translate('+dx+'px,'+dy+'px) rotate(12deg) scale(.16)',opacity:.15}
      ],{duration:1000,easing:'cubic-bezier(.45,.05,.5,1)',fill:'forwards'});
    }catch(e){clone.remove();fromEl.style.visibility='';return Promise.resolve(null)}
    return anim.finished.then(function(){return clone},function(){return clone});
  }
  function flyBack(clone,fromEl){
    if(!clone){if(fromEl)fromEl.style.visibility='';return Promise.resolve()}
    var p;
    try{
      p=clone.animate([{transform:clone.style.transform||'none',opacity:.15},{transform:'translate(0,0) rotate(0deg) scale(1)',opacity:1}],
        {duration:420,easing:'cubic-bezier(.34,1.3,.64,1)',fill:'forwards'}).finished;
    }catch(e){p=Promise.resolve()}
    return p.then(function(){clone.remove();if(fromEl)fromEl.style.visibility=''},function(){clone.remove();if(fromEl)fromEl.style.visibility=''});
  }
  function shakeBox(){
    if(RM)return;
    var f=$('msgBox').querySelector('.face');
    try{f.animate([{transform:'rotate(-1.2deg)'},{transform:'rotate(-3deg) translateY(-3px)'},{transform:'rotate(1.6deg)'},{transform:'rotate(-1.2deg)'}],
      {duration:460,easing:'ease-out'})}catch(e){}
  }
  function okNote(){
    var n=$('okNote');
    n.classList.add('on');
    setTimeout(function(){n.classList.remove('on')},RM?700:1500);
  }
  function onSaved(item){
    S.submitting=false;S.mode='idle';S.draft=null;S.token='';
    var btn=$('dropBtn');btn.disabled=false;btn.textContent='投入留言箱';
    $('pvScrim').classList.remove('on');$('editScrim').classList.remove('on');
    shakeBox();okNote();
    if(item){
      /* 当前筛选下看不到这张（比如选了别的班），只提示不硬插 */
      if(!S.filter||item.classLabel===S.filter){appendItems([item],true);setState('')}
      else toast('留好了，它在「全部」里等你。');
    }
    try{$('wall').scrollIntoView({behavior:RM?'auto':'smooth',block:'start'})}catch(e){}
  }
  function failText(r){
    if(!r)return '纸条没投进去，再试一次？';
    if(r.code==='rate_limited')return r.error||'投得有点急，歇一会儿再来。';
    if(r.code==='closed')return r.error||'这一年的留言已经收好了。';
    return r.error||'纸条没投进去，再试一次？';
  }
  function submit(){
    if(S.submitting)return;
    readDraft();
    if(!S.draft.body){toast('还没写内容呢');$('pvScrim').classList.remove('on');$('editScrim').classList.add('on');S.mode='edit';return}
    S.submitting=true;S.mode='flying';
    var btn=$('dropBtn');btn.disabled=true;btn.textContent='投递中…';
    $('pvHint').textContent='正在把它放进留言箱…';
    var payload={body:S.draft.body,signature:S.draft.anonymous?'':S.draft.signature,target:S.draft.target,
                 classLabel:S.draft.classLabel,anonymous:!!S.draft.anonymous,paper:S.draft.paper,clientToken:S.token};
    var req=api('/api/wall/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    var fromEl=$('pvNoteWrap').firstChild;
    var flying=fly(fromEl,$('msgBox'));
    Promise.all([flying,req]).then(function(res){
      var clone=res[0],r=res[1];
      if(r.body.success){
        if(clone)clone.remove();
        if(fromEl)fromEl.style.visibility='';
        var n=(S.cfg&&typeof S.cfg.total==='number')?S.cfg.total:0;
        setTopCount(r.body.total!=null?r.body.total:(r.body.dedup?n:n+1));
        onSaved(r.body.item||null);
      }else{
        return flyBack(clone,fromEl).then(function(){
          S.submitting=false;S.mode='preview';
          btn.disabled=false;btn.textContent='投入留言箱';
          $('pvHint').textContent='纸条还在手上。';
          toast(failText(r.body));
        });
      }
    },function(){
      var el=$('pvNoteWrap').firstChild;
      var clones=document.querySelectorAll('.fly');
      for(var i=0;i<clones.length;i++)clones[i].remove();
      flyBack(null,el).then(function(){
        S.submitting=false;S.mode='preview';
        var b=$('dropBtn');b.disabled=false;b.textContent='投入留言箱';
        $('pvHint').textContent='纸条还在手上。';
        toast('网络好像不太顺，再投一次？');
      });
    });
  }

  /* ---------- 详情 / 举报 ---------- */
  var dtId=null;
  function openDetail(id){
    api('/api/wall/message/'+id).then(function(r){
      if(!r.body.success){
        /* 被隐藏/删除：本次不硬删 DOM，下次刷新自然消失 */
        toast(r.body.error||'这张纸条已经不在墙上了。');
        return;
      }
      var it=r.body.item;dtId=it.id;
      var box=$('dtNoteWrap');box.innerHTML='';
      box.appendChild(noteEl(it,true,false));
      var extra=mk('div','hint');
      extra.textContent=(it.anonymous?'匿名同学':(it.signature||'一位同学'))+' · 写于 '+new Date(it.createdAt).toLocaleString('zh-CN');
      box.appendChild(extra);
      $('dtScrim').classList.add('on');
    },function(){toast('网络好像不太顺，稍后再试')});
  }
  function closeDetail(){$('dtScrim').classList.remove('on');dtId=null}
  function openReport(){
    if(!dtId)return;
    var box=$('rpReasons');box.innerHTML='';
    REASONS.forEach(function(r0,i){
      var l=mk('label');
      var c=document.createElement('input');c.type='radio';c.name='rp';c.value=r0;
      if(i===0)c.checked=true;
      l.appendChild(c);l.appendChild(document.createTextNode(r0));
      box.appendChild(l);
    });
    $('rpDetail').value='';
    $('rpScrim').classList.add('on');
  }
  function submitReport(){
    var sel=document.querySelector('#rpReasons input:checked');
    if(!sel){toast('选一个举报原因');return}
    var btn=$('rpSubmit');btn.disabled=true;
    api('/api/wall/report',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messageId:dtId,reason:sel.value,detail:$('rpDetail').value.trim()})})
    .then(function(r){
      btn.disabled=false;
      if(r.body.success){$('rpScrim').classList.remove('on');toast(r.body.message||'已经收到，谢谢你。')}
      else toast(r.body.error||'举报没提交上，稍后再试');
    },function(){btn.disabled=false;toast('网络好像不太顺，稍后再试')});
  }

  /* ---------- 绑定 ---------- */
  $('writeBtn').addEventListener('click',openEditor);
  $('lookBtn').addEventListener('click',function(){
    try{$('filters').scrollIntoView({behavior:RM?'auto':'smooth',block:'start'})}catch(e){}
  });
  $('msgBox').addEventListener('click',function(){
    try{$('wall').scrollIntoView({behavior:RM?'auto':'smooth',block:'start'})}catch(e){}
  });
  $('cancelBtn').addEventListener('click',function(){if(!S.submitting)closeEditor()});
  $('previewBtn').addEventListener('click',preview);
  $('backBtn').addEventListener('click',function(){if(!S.submitting)backToEdit()});
  $('paperBtn').addEventListener('click',function(){if(!S.submitting)cyclePaper()});
  $('dropBtn').addEventListener('click',submit);
  $('dtClose').addEventListener('click',closeDetail);
  $('dtReport').addEventListener('click',openReport);
  $('rpCancel').addEventListener('click',function(){$('rpScrim').classList.remove('on')});
  $('rpSubmit').addEventListener('click',submitReport);
  $('fBody').addEventListener('input',function(){count();newToken()});
  $('fTarget').addEventListener('input',newToken);
  $('fSign').addEventListener('input',newToken);
  $('fClass').addEventListener('change',newToken);
  $('fAnon').addEventListener('change',function(){syncAnon();newToken()});
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape')return;
    if($('rpScrim').classList.contains('on')){$('rpScrim').classList.remove('on');return}
    if($('dtScrim').classList.contains('on')){closeDetail();return}
    if($('pvScrim').classList.contains('on')){if(!S.submitting)backToEdit();return}
    if($('editScrim').classList.contains('on')){if(!S.submitting)closeEditor()}
  });
  /* 提交前离开页面：草稿还在，防误触 */
  window.addEventListener('beforeunload',function(e){
    if(S.mode==='edit'||S.mode==='preview'){e.preventDefault();e.returnValue=''}
  });
  /* 无限滚动：哨兵进入视口就取下一页 */
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){
      es.forEach(function(en){if(en.isIntersecting)load(false)});
    },{rootMargin:'700px 0px'});
    io.observe($('sentinel'));
  }else{
    window.addEventListener('scroll',function(){
      if(window.innerHeight+window.scrollY>document.body.offsetHeight-800)load(false);
    });
  }

  /* ---------- 启动 ---------- */
  api('/api/wall/config').then(function(r){
    if(!r.body.success){errorState();return}
    var c=r.body;S.cfg=c;
    document.title=c.title||'毕业留言墙';
    $('topName').textContent=c.title||'毕业留言墙';
    $('hTitle').textContent=(c.year?'届毕业留言墙':'')||'毕业留言墙';
    $('hYear').textContent=c.year||'';
    $('hYear').style.display=c.year?'':'none';
    $('hSlogan').textContent=c.slogan||'';
    setTopCount(typeof c.total==='number'?c.total:null);
    buildFilters(c.classes||[]);
    if(!c.open){
      $('writeBtn').style.display='none';
      $('msgBox').style.display='none';
      var cn=$('closedNote');cn.textContent=c.closedNote||'这一年的留言已经收好了。';cn.style.display='';
    }
    load(true);
  },function(){
    errorState();
    setTopCount(null);
  });
})();
</script>
</body>
</html>`;
}

function getNewsHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f2f2f5">
<title>热点新闻 · 建平世纪中学</title>
<script>
/* 主题先行，避免闪烁 */
try{var t=localStorage.getItem('np-theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}
</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
:root{
 --bg:#f2f2f5;--fg:#15151a;--dim:#6c6c76;--line:rgba(0,0,0,.08);
 --glass:rgba(255,255,255,.55);--glass2:rgba(255,255,255,.34);--edge:rgba(255,255,255,.75);
 --sh:0 1px 1px rgba(0,0,0,.04),0 6px 16px rgba(0,0,0,.06),0 24px 60px rgba(0,0,0,.07);
 --shH:0 1px 1px rgba(0,0,0,.05),0 12px 26px rgba(0,0,0,.09),0 36px 90px rgba(0,0,0,.11);
 --a:#667eea;--b:#764ba2;--c:#3b82f6;--d:#ec4899;
 font:100%/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
}
html[data-theme="dark"]{
 --bg:#08080b;--fg:#f2f2f7;--dim:#9a9aa4;--line:rgba(255,255,255,.1);
 --glass:rgba(32,32,38,.5);--glass2:rgba(28,28,34,.34);--edge:rgba(255,255,255,.14);
 --sh:0 1px 1px rgba(0,0,0,.5),0 8px 22px rgba(0,0,0,.45),0 28px 70px rgba(0,0,0,.5);
 --shH:0 1px 1px rgba(0,0,0,.55),0 14px 34px rgba(0,0,0,.55),0 44px 110px rgba(0,0,0,.6);
 --a:#3d5ea8;--b:#5d2f56;--c:#1e4a7a;--d:#7a2d5a;
}
body{background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;overflow:hidden;height:100vh;height:100dvh;transition:background-color .6s linear,color .6s linear}
.bgfx{position:fixed;inset:-20vmax;z-index:-3;filter:blur(80px) saturate(140%);opacity:.85;pointer-events:none}
html[data-theme="dark"] .bgfx{opacity:.6;filter:blur(96px) saturate(120%)}
.blob{position:absolute;border-radius:50%;opacity:.55;will-change:transform}
.b1{width:52vmax;height:52vmax;background:radial-gradient(circle at 30% 30%,var(--a),transparent 68%);top:-8%;left:-6%;animation:d1 46s ease-in-out infinite alternate}
.b2{width:46vmax;height:46vmax;background:radial-gradient(circle at 60% 40%,var(--b),transparent 68%);top:22%;right:-10%;animation:d2 58s ease-in-out infinite alternate}
.b3{width:50vmax;height:50vmax;background:radial-gradient(circle at 40% 60%,var(--c),transparent 68%);bottom:-14%;left:14%;animation:d3 52s ease-in-out infinite alternate}
.b4{width:34vmax;height:34vmax;background:radial-gradient(circle at 50% 50%,var(--d),transparent 68%);top:56%;left:52%;animation:d4 64s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate3d(12vmax,8vmax,0) scale(1.15)}}
@keyframes d2{to{transform:translate3d(-14vmax,10vmax,0) scale(1.1)}}
@keyframes d3{to{transform:translate3d(10vmax,-12vmax,0) scale(1.18)}}
@keyframes d4{to{transform:translate3d(-9vmax,-7vmax,0) scale(.9)}}
.grain{position:fixed;inset:0;z-index:-2;pointer-events:none;opacity:.035;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence baseFrequency='.85' numOctaves='3'/></filter><rect width='140' height='140' filter='url(%23n)'/></svg>")}
.glass{background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%)}
header{position:fixed;inset:.7rem .8rem auto .8rem;z-index:20;display:flex;align-items:center;gap:.6rem;justify-content:space-between;padding:.5rem .55rem .5rem .95rem;border-radius:999px;background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(26px) saturate(180%);-webkit-backdrop-filter:blur(26px) saturate(180%);overflow:hidden}
.hdr-title{font-weight:640;letter-spacing:-.01em;font-size:.95rem;white-space:nowrap}
.hud{display:flex;align-items:center;gap:.5rem;font-size:.78rem;color:var(--dim);font-variant-numeric:tabular-nums}
.orb{width:1.15rem;height:1.15rem;border-radius:50%;position:relative;overflow:hidden;flex:none;cursor:pointer;background:radial-gradient(circle at 35% 32%,#ffd88a,#ff9d4d);box-shadow:0 0 12px rgba(255,170,80,.55);transition:background .6s linear,box-shadow .6s linear}
html[data-theme="dark"] .orb{background:radial-gradient(circle at 62% 38%,#e9edf7,#a9b3c9);box-shadow:0 0 12px rgba(190,205,255,.4)}
.orb::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--bg);transform:translate(120%,-40%);transition:transform .6s linear}
html[data-theme="dark"] .orb::after{transform:translate(38%,-26%)}
.btn{font:inherit;font-size:.8rem;font-weight:550;padding:.34rem .8rem;border-radius:999px;cursor:pointer;color:var(--fg);background:var(--glass2);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);will-change:transform;transition:transform 260ms linear,box-shadow 260ms linear}
.btn:active{transform:scale(.96)}
.btn.p{background:#0071e3;border-color:transparent;color:#fff;box-shadow:0 8px 24px rgba(0,113,227,.35)}
.wrap{height:100vh;height:100dvh;display:flex;flex-direction:column;padding:4.6rem 1.5rem 1rem;overflow:hidden}
#secs{flex:1;min-height:0;display:flex}
.toolbar{flex:none;display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem;flex-wrap:wrap}
/* 分类下拉多选：苹果风玻璃胶囊按钮 + 弹簧弹出的复选面板 */
.catwrap{position:relative;flex:none;min-width:0}
.catsel{display:flex;align-items:center;gap:.35rem;font:inherit;font-size:.78rem;font-weight:550;padding:.34rem .8rem;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--fg);cursor:pointer;box-shadow:var(--sh),inset 0 1px 0 var(--edge);transition:transform 260ms linear,box-shadow 260ms linear;white-space:nowrap;max-width:10.5rem;overflow:hidden}
.catsel:active{transform:scale(.96)}
.catsel .caret{font-size:.7rem;transition:transform .25s linear}
.catwrap.open .caret{transform:rotate(180deg)}
.catdrop{position:absolute;top:calc(100% + .45rem);left:0;z-index:55;min-width:10.5rem;max-height:min(58vh,20rem);overflow-y:auto;scrollbar-width:none;background:var(--bg);border:1px solid var(--line);border-radius:.9rem;box-shadow:0 14px 36px rgba(0,0,0,.2);padding:.35rem;display:none}
.catdrop::-webkit-scrollbar{display:none}
.catwrap.open .catdrop{display:block;animation:catIn .28s cubic-bezier(.34,1.56,.64,1)}
@keyframes catIn{from{opacity:0;transform:translateY(-6px) scale(.97)}to{opacity:1;transform:none}}
.catopt{display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;border-radius:.6rem;font-size:.78rem;color:var(--fg);cursor:pointer;white-space:nowrap}
.catopt:hover{background:var(--glass2)}
.catopt input{accent-color:#0071e3;width:.95rem;height:.95rem;flex:none;margin:0}
.catopt.on{background:var(--glass2);font-weight:600}
.catdiv{height:1px;background:var(--line);margin:.3rem .35rem}
.colsel{flex:none;display:flex;gap:.15rem;background:var(--glass2);border:1px solid var(--line);border-radius:999px;padding:.14rem}
.cbtn{width:1.75rem;height:1.45rem;font:inherit;font-size:.74rem;line-height:1;border:none;border-radius:999px;background:transparent;color:var(--dim);cursor:pointer;transition:.2s}
.cbtn.on{background:var(--fg);color:var(--bg);font-weight:700}
.speedsel{flex:none;display:flex;align-items:center;gap:.4rem;background:var(--glass2);border:1px solid var(--line);border-radius:999px;padding:.18rem .6rem}
.sp-icon{font-size:.8rem;line-height:1}
.sp-range{-webkit-appearance:none;appearance:none;width:5.5rem;height:4px;border-radius:2px;background:var(--line);outline:none;cursor:pointer}
.sp-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#0071e3;border:none;box-shadow:0 2px 6px rgba(0,113,227,.4)}
.sp-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#0071e3;border:none;cursor:pointer}
.sp-val{font-size:.72rem;color:var(--dim);font-weight:600;min-width:2.5rem;text-align:center}
/* 搜索框 + 建议下拉 */
.searchwrap{position:relative;flex:1 1 9rem;min-width:6.5rem;display:flex}
.sbox{flex:1;width:100%;font:inherit;font-size:.78rem;background:var(--glass2);border:1px solid var(--line);border-radius:999px;padding:.34rem .8rem;color:var(--fg);outline:none;transition:.2s}
.sbox:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.18)}
.sbox::-webkit-search-cancel-button{-webkit-appearance:none}
.suggest{position:absolute;top:calc(100% + .4rem);left:0;right:0;z-index:50;background:var(--bg);border:1px solid var(--line);border-radius:.9rem;box-shadow:0 12px 34px rgba(0,0,0,.18);overflow:hidden;display:none}
.suggest.open{display:block}
.suggest .si{display:block;width:100%;text-align:left;font:inherit;font-size:.78rem;padding:.5rem .8rem;border:none;background:transparent;color:var(--fg);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.suggest .si:hover{background:var(--glass2)}
.suggest .sc{font-size:.7rem;color:var(--dim);padding:.4rem .8rem;background:var(--glass)}
/* 搜索状态条 */
.sres{display:flex;align-items:center;gap:.6rem;padding:.3rem .5rem;font-size:.78rem;color:var(--dim)}
.sres[hidden]{display:none}
.sres .x{font:inherit;font-size:.72rem;border:none;background:var(--glass2);border:1px solid var(--line);border-radius:999px;padding:.18rem .6rem;color:var(--fg);cursor:pointer}
/* 触屏端走原生滚动，速率滑块无意义，隐藏 */
@media (hover:none){.speedsel{display:none}}
/* 瀑布流：固定视口，多列循环滚动（相邻列方向不同） */
.masonry{flex:1;min-height:0;display:flex;gap:.75rem;align-items:stretch}
.masonry-col{flex:1 1 0;min-width:0;position:relative;overflow:hidden;border-radius:1.15rem;border:1px solid var(--line);background:var(--glass);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%)}
.col-scroller{position:absolute;inset:0;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none;display:flex;flex-direction:column;gap:.75rem;padding:.65rem;scroll-behavior:auto}
.col-scroller::-webkit-scrollbar{display:none}
.card{position:relative;display:block;flex:none;padding:1.05rem 1.15rem;border-radius:1.15rem;overflow:hidden;background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);will-change:transform;transition:box-shadow .45s linear}
.card:hover{box-shadow:var(--shH),inset 0 1px 0 var(--edge)}
.card .glare{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .5s linear;background:radial-gradient(18rem 18rem at var(--mx,50%) var(--my,50%),rgba(255,255,255,.35),transparent 60%)}
html[data-theme="dark"] .card .glare{background:radial-gradient(18rem 18rem at var(--mx,50%) var(--my,50%),rgba(255,255,255,.09),transparent 60%)}
.card:hover .glare{opacity:1}
.card h3{font-size:1rem;font-weight:600;letter-spacing:-.012em;line-height:1.45}
.card h3 a{color:inherit;text-decoration:none}
.card h3 a:hover{text-decoration:underline}
.card p{color:var(--dim);font-size:.86rem;margin-top:.3rem;line-height:1.55}
.card .thumb{width:100%;aspect-ratio:16/10;border-radius:.8rem;display:block;margin-bottom:.5rem;object-fit:cover}
/* 竖版海报卡(豆瓣电影)：小封面在标题左侧，尊重 2:3 原比例不裁切不拉伸 */
.card.poster .poster-row{display:flex;gap:.75rem;align-items:flex-start}
.card .poster{width:3.6rem;flex:none;aspect-ratio:2/3;object-fit:cover;border-radius:.6rem;box-shadow:var(--sh);background:var(--glass2)}
.card .poster-body{min-width:0;flex:1}
.card .poster-body h3{font-size:.92rem}
.card .poster-body .meta{margin-top:.45rem}
.card .meta{display:flex;align-items:center;flex-wrap:wrap;gap:.45rem;margin-top:.55rem;font-size:.72rem;color:var(--dim)}
.badge{display:inline-flex;align-items:center;gap:.25rem;padding:.1rem .55rem;border-radius:999px;background:var(--glass2);border:1px solid var(--line);font-size:.68rem;font-weight:600}
.badge.warn{background:rgba(255,149,0,.16);border-color:rgba(255,149,0,.4);color:#e8830c}
.reveal{opacity:0;transform:translateY(14px)}
.reveal.in{opacity:1;transform:none;transition:opacity .7s linear,transform .7s cubic-bezier(.22,.61,.36,1)}
.state{text-align:center;padding:70px 20px;color:var(--dim)}
.spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--fg);animation:spin 1s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
.err{color:#d70015}
/* 两列切换提示：苹果风顶部横幅，弹簧滑入 */
.prompt{position:fixed;top:4.4rem;left:50%;transform:translateX(-50%) translateY(-150%);opacity:0;z-index:60;width:min(92vw,26rem);pointer-events:none;transition:transform .65s cubic-bezier(.34,1.56,.64,1),opacity .45s linear}
.prompt.show{transform:translateX(-50%) translateY(0);opacity:1;pointer-events:auto}
.prompt-body{background:rgba(255,255,255,.84);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);border:1px solid var(--line);border-radius:1.25rem;box-shadow:0 24px 70px rgba(0,0,0,.18);padding:1.1rem 1.3rem;color:var(--fg)}
html[data-theme="dark"] .prompt-body{background:rgba(30,30,36,.86)}
.prompt-t{font-size:1.05rem;font-weight:700;letter-spacing:-.01em;margin-bottom:.2rem}
.prompt-s{font-size:.83rem;color:var(--dim);line-height:1.5;margin-bottom:.85rem}
.prompt-btns{display:flex;gap:.5rem;justify-content:flex-end}
.pbtn{font:inherit;font-size:.85rem;font-weight:600;padding:.42rem .95rem;border-radius:999px;border:1px solid var(--line);cursor:pointer;background:var(--glass2);color:var(--fg);transition:transform .2s}
.pbtn:active{transform:scale(.96)}
.pbtn.pri{background:#0071e3;border-color:transparent;color:#fff;box-shadow:0 6px 18px rgba(0,113,227,.32)}
.pbtn.pri:hover{background:#0a6ed0}
/* 周杰伦每日推荐浮窗：玻璃拟态材质，与页面按钮/卡片同源 */
.jay-fab{position:fixed;left:1.1rem;bottom:1.1rem;z-index:40;width:3rem;height:3rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;cursor:pointer;background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);color:var(--fg);transition:transform .5s cubic-bezier(.34,1.56,.64,1),box-shadow 260ms linear,opacity .3s linear;user-select:none;-webkit-tap-highlight-color:transparent}
.jay-fab:active{transform:scale(.96);transition:transform 100ms ease-out,opacity 100ms linear}
.jay-fab.off{color:var(--dim);opacity:.62}
.jay-fab.hide{transform:translateY(calc(100% + 1.5rem));opacity:0;pointer-events:none}
.jay-panel{position:fixed;left:1.1rem;bottom:4.6rem;z-index:40;width:min(19.5rem,calc(100vw - 2.2rem));border-radius:1.25rem;padding:1rem 1.1rem 1.05rem;transform:translateY(22px) scale(.94);opacity:0;pointer-events:none;transition:transform .6s cubic-bezier(.34,1.56,.64,1),opacity .3s linear}
.jay-panel.open{transform:none;opacity:1;pointer-events:auto}
.jay-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem}
.jay-date{font-size:.72rem;font-weight:700;color:var(--dim);letter-spacing:.02em}
.jay-sw{display:flex;align-items:center;gap:.35rem;font-size:.7rem;color:var(--dim)}
.jay-switch{position:relative;width:2.1rem;height:1.25rem;border-radius:999px;background:var(--line);border:none;cursor:pointer;transition:background .25s;flex:none;padding:0}
.jay-switch::after{content:"";position:absolute;top:.14rem;left:.16rem;width:.97rem;height:.97rem;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .25s}
.jay-switch.on{background:#0071e3}
.jay-switch.on::after{transform:translateX(.85rem)}
.jay-card{display:flex;gap:.8rem;align-items:center}
.jay-cover{width:5.2rem;height:5.2rem;border-radius:.9rem;object-fit:cover;flex:none;background:var(--glass2);box-shadow:var(--sh)}
.jay-cov-fb{width:5.2rem;height:5.2rem;border-radius:.9rem;flex:none;display:none;align-items:center;justify-content:center;font-size:1.7rem;background:var(--glass2);border:1px solid var(--line);color:var(--dim)}
.jay-info{min-width:0;flex:1}
.jay-title{font-size:.95rem;font-weight:700;letter-spacing:-.01em;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jay-album{font-size:.72rem;color:var(--dim);margin-top:.25rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jay-album b{color:var(--fg);font-weight:600}
.jay-storybtn{margin-top:.55rem;font:inherit;font-size:.7rem;font-weight:600;color:var(--a);background:none;border:none;cursor:pointer;padding:0}
.jay-story{margin-top:.8rem;font-size:.76rem;line-height:1.6;color:var(--dim);background:var(--glass2);border:1px solid var(--line);border-radius:.8rem;padding:.6rem .7rem;display:none}
.jay-story.open{display:block}
.jay-story b{color:var(--fg);display:block;margin-bottom:.15rem;font-size:.72rem}
@media(max-width:640px){.hud .time{display:none}.wrap{padding-top:4.8rem}.prompt{top:4.4rem}
/* 手机端工具栏重排：分类下拉独占一行（按钮拉满宽度），列数+搜索+速度依次下排，互不挤压 */
.toolbar{row-gap:.5rem}
.catwrap{order:1;flex:1 1 100%;width:100%}
.catsel{max-width:none;width:100%;justify-content:space-between}
.catdrop{left:0;right:auto}
.colsel{order:2}
.searchwrap{order:3;flex:1 1 auto;min-width:0}
.speedsel{order:4}}
@media (prefers-reduced-motion: reduce){.prompt{transition:opacity .25s linear}.reveal.in{transition:none}.jay-panel{transition:opacity .25s linear}.jay-fab{transition:opacity .25s linear}}
</style>
</head>
<body>
<div class="bgfx"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i><i class="blob b4"></i></div>
<div class="grain"></div>
<header>
  <div class="hdr-title">📰 热点新闻</div>
  <div class="hud">
    <span class="time" id="updTime">-</span>
    <button class="btn" onclick="location.href='/admin'" title="新闻管理后台">⚙️ 管理</button>
    <button class="btn" onclick="location.reload()">刷新</button>
    <i class="orb" id="themeBtn" title="切换昼夜"></i>
  </div>
</header>
<div class="wrap">
  <div class="toolbar">
    <div class="catwrap" id="catWrap">
      <button type="button" class="catsel" id="catselBtn" title="分类筛选">全部分类<span class="caret">▾</span></button>
      <div class="catdrop" id="catDrop" role="menu"></div>
    </div>
    <div class="colsel" id="colsel" title="列数"></div>
    <div class="searchwrap">
      <input type="search" class="sbox" id="searchQ" placeholder="🔍 搜索新闻…" autocomplete="off">
      <div class="suggest" id="suggest"></div>
    </div>
    <div class="speedsel" title="滚动速度">
      <span class="sp-icon">⏩</span>
      <input type="range" class="sp-range" id="speedRange" min="25" max="200" step="5" value="100">
      <span class="sp-val" id="speedVal">1.0x</span>
    </div>
  </div>
  <div class="sres" id="sres" hidden></div>
  <div id="state"><div class="spinner"></div>正在加载新闻…</div>
  <div id="secs"></div>
</div>
<button type="button" class="jay-fab" id="jayFab" aria-label="周杰伦每日推荐">🎵</button>
<div class="jay-panel glass" id="jayPanel" role="dialog" aria-hidden="true">
  <div class="jay-head">
    <div class="jay-date" id="jayDate">今日推荐</div>
    <div class="jay-sw">每日推荐<button type="button" class="jay-switch on" id="jaySwitch" role="switch" aria-checked="true" title="开启/关闭每日推荐"></button></div>
  </div>
  <div class="jay-card">
    <img class="jay-cover" id="jayCover" alt="专辑封面" referrerpolicy="no-referrer">
    <div class="jay-cov-fb" id="jayCovFb">🎵</div>
    <div class="jay-info">
      <div class="jay-title" id="jayTitle"></div>
      <div class="jay-album">专辑 · <b id="jayAlbum"></b></div>
      <button type="button" class="jay-storybtn" id="jayStoryBtn">🎬 幕后小故事</button>
    </div>
  </div>
  <div class="jay-story" id="jayStory"><b>幕后小故事</b><span id="jayStoryTxt"></span></div>
</div>
<div id="prompt" class="prompt" role="dialog" aria-hidden="true">
  <div class="prompt-body">
    <div class="prompt-t">切换为两列浏览？</div>
    <div class="prompt-s">当前多列较拥挤，两列更易阅读。你也可以随时在右上角调整列数。</div>
    <div class="prompt-btns">
      <button type="button" class="pbtn" data-act="no">暂不</button>
      <button type="button" class="pbtn pri" data-act="yes">切换为两列</button>
    </div>
  </div>
</div>
<script>
var SRC_EMOJI={'Hacker News':'🧵','GitHub Trending':'⭐','V2EX热门':'💬','微博热搜':'🔥','少数派':'✍️','IT之家':'🖥','百度热搜':'🔍','BBC中文':'📰','纽约时报中文':'🗽','爱范儿':'📱','中新网':'🏛','ESPN体育':'🏀','华尔街见闻':'💰','财联社':'📈','豆瓣电影':'🎬','今日头条热榜':'📋','网易体育':'⚽','NewsAPI体育':'🏅'};
/* 来源→大类映射：新增源在此登记，CAT_ORDER 控制下拉顺序 */
var CAT_MAP={'V2EX热门':'科技','微博热搜':'娱乐','Hacker News':'国际','GitHub Trending':'科技','少数派':'科技','IT之家':'科技','百度热搜':'社会','BBC中文':'国际','纽约时报中文':'国际','爱范儿':'科技','中新网':'国内','ESPN体育':'体育','华尔街见闻':'财经','财联社':'财经','豆瓣电影':'娱乐','今日头条热榜':'社会','网易体育':'体育','NewsAPI体育':'体育'};
var CAT_ORDER=['科技','国际','国内','财经','社会','娱乐','体育'];
var CAT_FALLBACK='其他';
var NEWS_FLAGS_MAP={'political':'疑似夹带第三国政治立场','biased':'探究方向不客观','subjective':'个人主观判断','clickbait':'标题党·夸大','unverified':'事实存疑','ad':'软广·推广'};
var $=function(id){return document.getElementById(id)};

/* 昼夜切换 */
$('themeBtn').addEventListener('click',function(){
  var d=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',d);
  try{localStorage.setItem('np-theme',d)}catch(e){}
});
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML.replace(/"/g,'&quot;')}
function fmt(ts){if(!ts)return'刚刚';var n=Date.now(),diff=n-ts,m=Math.floor(diff/6e4),h=Math.floor(diff/36e5),d=Math.floor(diff/864e5);if(m<1)return'刚刚';if(m<60)return m+'分钟前';if(h<24)return h+'小时前';if(d<7)return d+'天前';return new Date(ts).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}

/* ---- 列数：响应式，localStorage 覆盖（列数按钮） ---- */
function baseCols(){
  var w=window.innerWidth;
  if(w>=1600) return 4;
  if(w>=1100) return 3;
  if(w>=700)  return 2;
  return 1;
}
function savedCols(){
  try{var v=parseInt(localStorage.getItem('jpc_news_cols'),10);if(v>=1&&v<=4)return v}catch(e){}
  return 0;
}
function colCount(){var s=savedCols();return s?s:baseCols()}

/* ---- 滚动引擎：方向交替+随机起点（相邻不同向、上下均衡），scrollTop 无缝循环 ---- */
var _cols=[],_dirs=[],_pos=[],_heights=[],_lastTs=[],_raf=[],_hover=[];
var _animating=false,_pausedAll=false,_speed=40,_speedMult=1,_gen=0;
function mod(a,b){return ((a%b)+b)%b}
function isTouch(){try{return window.matchMedia('(hover:none)').matches}catch(e){return false}}
function reduced(){try{return window.matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){return false}}
function assignDirs(n){
  _dirs=[];var up=Math.random()<.5;
  for(var i=0;i<n;i++){_dirs.push(up?'up':'down');up=!up}
}

/* 单卡片构建：来源降级为 badge，RSS 带图则渲染缩略图；data-ori 标记原始卡，供循环复制用 */
function buildCard(it){
  var c=document.createElement('div');c.className='card reveal';c.setAttribute('data-ori','1');
  var title=it.link?'<a href="'+esc(it.link)+'" target="_blank" rel="noopener">'+esc(it.title)+'</a>':esc(it.title);
  var desc=it.description?'<p>'+esc(it.description)+'</p>':'';
  var src='<span class="badge src">'+(SRC_EMOJI[it.source]||'📌')+' '+esc(it.source)+'</span>';
  var time=it.pubDate?'<span class="badge">⏰ '+fmt(it.pubDate)+'</span>':'';
  var warns=(it.flags||[]).map(function(f){return '<span class="badge warn">⚠️ '+esc(NEWS_FLAGS_MAP[f]||f)+'</span>'}).join('');
  var meta='<div class="meta">'+src+time+warns+'</div>';
  /* 竖版海报源(豆瓣电影)：小封面放标题左侧，尊重 2:3 原比例，不裁切不拉伸；其余源保持全宽横版缩略图 */
  if(it.source==='豆瓣电影'&&it.image){
    c.classList.add('poster');
    var pimg='<img class="poster" src="'+esc(it.image)+'" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">';
    c.innerHTML='<div class="glare"></div><div class="poster-row">'+pimg+'<div class="poster-body"><h3>'+title+'</h3>'+desc+meta+'</div></div>';
  }else{
    var img=it.image?'<img class="thumb" src="'+esc(it.image)+'" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">':'';
    c.innerHTML='<div class="glare"></div>'+img+'<h3>'+title+'</h3>'+desc+meta;
  }
  return c;
}

function catOf(src){return CAT_MAP[src]||CAT_FALLBACK}
var _cats=[]; /* 多选分类，空=全部 */

/* 顶部大类筛选：下拉多选。空=全部；勾选分类多选过滤；勾"全部"清空 */
function buildChips(){
  var btn=$('catselBtn'),drop=$('catDrop');if(!btn||!drop)return;
  var used={};(_lastItems||[]).forEach(function(it){used[catOf(it.source)]=1});
  var list=[];
  CAT_ORDER.forEach(function(c){if(used[c])list.push(c)});
  if(used[CAT_FALLBACK])list.push(CAT_FALLBACK);
  /* 记忆的筛选若已不存在则剔除 */
  _cats=_cats.filter(function(c){return list.indexOf(c)>=0});
  var html='<label class="catopt" data-cat="all"><input type="checkbox"'+( _cats.length?'':' checked')+'><span>全部</span></label>';
  if(list.length)html+='<div class="catdiv"></div>';
  list.forEach(function(c){
    var on=_cats.indexOf(c)>=0;
    html+='<label class="catopt'+(on?' on':'')+'" data-cat="'+c+'"><input type="checkbox"'+(on?' checked':'')+'><span>'+c+'</span></label>';
  });
  drop.innerHTML=html;
  btn.innerHTML=( _cats.length?'已选 '+_cats.length+' 项':'全部分类')+'<span class="caret">▾</span>';
}
(function(){
  var wrap=$('catWrap'),btn=$('catselBtn'),drop=$('catDrop');if(!wrap||!btn||!drop)return;
  btn.addEventListener('click',function(e){e.stopPropagation();wrap.classList.toggle('open')});
  drop.addEventListener('click',function(e){
    e.stopPropagation(); /* 阻止冒泡到 document 关闭面板，保持打开可连续多选 */
    var opt=e.target.closest('.catopt');if(!opt)return;
    var c=opt.getAttribute('data-cat');
    if(c==='all'){_cats=[]}
    else{
      var i=_cats.indexOf(c);
      if(i>=0)_cats.splice(i,1);else _cats.push(c);
    }
    try{localStorage.setItem('jpc_news_cat',JSON.stringify(_cats))}catch(_){}
    buildChips();
    if(window._lastItems)renderMasonry(window._lastItems);
  });
  /* 点面板外部任意处收起下拉 */
  document.addEventListener('click',function(){wrap.classList.remove('open')});
})();

/* 列数选择按钮 1/2/3/4 */
function buildColSel(){
  var sel=$('colsel');if(!sel)return;
  var active=savedCols()||baseCols();
  sel.innerHTML='';
  for(var i=1;i<=4;i++){
    var b=document.createElement('button');b.type='button';b.className='cbtn'+(i===active?' on':'');b.textContent=i;b.setAttribute('data-cols',i);
    sel.appendChild(b);
  }
}
$('colsel').addEventListener('click',function(e){
  var b=e.target.closest('.cbtn');if(!b)return;
  var v=parseInt(b.getAttribute('data-cols'),10);
  try{localStorage.setItem('jpc_news_cols',String(v))}catch(_){}
  if(window._lastItems)renderMasonry(window._lastItems);
});

/* 滚动速度滑块：倍率 0.25x-2x 实时生效，localStorage 记忆；基速 40px/s */
(function(){
  var r=$('speedRange'),v=$('speedVal');if(!r||!v)return;
  var saved=parseFloat(localStorage.getItem('jpc_news_speed')||'1');
  if(isNaN(saved)||saved<.25||saved>2)saved=1;
  _speedMult=saved;_speed=40*saved;
  r.value=Math.round(saved*100);v.textContent=saved.toFixed(1)+'x';
  r.addEventListener('input',function(){
    var m=Math.max(.25,Math.min(2,r.value/100));
    _speedMult=m;_speed=40*m;
    v.textContent=m.toFixed(1)+'x';
    try{localStorage.setItem('jpc_news_speed',String(m))}catch(e){}
  });
})();

/* 搜索：库里建议下拉 + 过滤信息流（推荐现有库中已有新闻） */
var _allItems=null,_searchQ='',_sugT=null;
var sbox=$('searchQ'),sug=$('suggest'),sres=$('sres');
function hideSug(){if(sug){sug.classList.remove('open');sug.innerHTML=''}}
/* 候选渲染：sbox 内容已变则丢弃（不再依赖焦点，避免点击别处就不弹） */
function renderSug(q,list){
  if(!sug||!sbox||sbox.value!==q)return;
  if(!list.length){hideSug();return}
  sug.innerHTML='<div class="sc">库里已有 '+list.length+' 条相关</div>'+list.slice(0,8).map(function(it){
    return '<button type="button" class="si" data-title="'+esc(it.title)+'">'+esc(it.source)+' · '+esc(it.title)+'</button>';
  }).join('');
  sug.classList.add('open');
}
function doSuggest(q){
  if(!q){hideSug();return}
  /* 本地已加载的新闻立即过滤先弹（零等待），后台再全库补全合并去重 */
  var local=[];
  (_lastItems||[]).forEach(function(it){
    if((it.title||'').indexOf(q)>=0||(it.source||'').indexOf(q)>=0)local.push(it);
  });
  renderSug(q,local);
  fetch('/api/news/suggest?q='+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(j){
    if(!j.success)return;
    var seen={};local.forEach(function(it){seen[it.title]=1});
    var merged=local.slice();
    (j.data||[]).forEach(function(it){if(!seen[it.title])merged.push(it)});
    renderSug(q,merged);
  }).catch(function(){});
}
function applySearch(q){
  _searchQ=q;hideSug();
  if(!q){renderMasonry(_allItems, false);if(sres){sres.hidden=true;sres.innerHTML=''}return}
  fetch('/api/news?q='+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(j){
    if(!j.success)return;
    if(sres){
      sres.hidden=false;
      sres.innerHTML='搜索 “'+esc(q)+'” · '+j.data.length+' 条 <button type="button" class="x">✕ 清除</button>';
    }
    renderMasonry(j.data, true); /* 搜索结果静态展示，不循环复制 */
  }).catch(function(){});
}
if(sbox){
  sbox.addEventListener('input',function(){
    var q=sbox.value.trim();clearTimeout(_sugT);
    if(q){_sugT=setTimeout(function(){doSuggest(q)},250)}else hideSug();
  });
  sbox.addEventListener('keydown',function(e){if(e.key==='Enter')applySearch(sbox.value.trim())});
  sbox.addEventListener('focus',function(){var q=sbox.value.trim();if(q)doSuggest(q)});
  document.addEventListener('click',function(e){if(!e.target.closest('.searchwrap'))hideSug()});
}
if(sug){sug.addEventListener('click',function(e){
  var b=e.target.closest('.si');if(!b)return;
  var t=b.getAttribute('data-title');hideSug();sbox.value=t;applySearch(t);
})}
if(sres){sres.addEventListener('click',function(e){
  if(e.target.closest('.x')){sbox.value='';applySearch('')}
})}

/* 列滚动容器：动画时复制内容铺满视口实现无缝循环；触摸/reduced-motion 单份+原生滚动 */
function setupScroll(n){
  _heights=[];
  for(var i=0;i<n;i++){
    var sc=_cols[i],c=sc.querySelector('.col-scroller');
    /* 克隆带 data-clone 标记，重建前只清克隆；原始卡 data-ori（cloneNode 会带过去，克隆时剥掉防误认） */
    var clones=c.querySelectorAll('.card[data-clone]');
    for(var k=0;k<clones.length;k++)clones[k].parentNode.removeChild(clones[k]);
    var cards=c.querySelectorAll('.card');
    /* 循环周期 = 单份内容高度 = 卡片高之和 + L 个间距（含末卡到克隆首卡的边界间距），不含 padding，保证回绕无缝 */
    var H=0;for(k=0;k<cards.length;k++)H+=cards[k].offsetHeight;
    if(cards.length)H+=cards.length*12; /* gap .75rem */
    H=Math.max(H,1);_heights.push(H);
    if(_animating){
      var need=Math.ceil(sc.clientHeight/H)+1;if(need<2)need=2;
      for(var rep=1;rep<need;rep++){for(k=0;k<cards.length;k++){var cl=cards[k].cloneNode(true);cl.setAttribute('data-clone','1');cl.removeAttribute('data-ori');c.appendChild(cl)}}
    }
    c.scrollTop=0;_pos[i]=0;
    (function(idx,col){
      col.onmouseenter=function(){_hover[idx]=true};
      col.onmouseleave=function(){_hover[idx]=false;var cc=col.querySelector('.col-scroller');if(_animating&&cc)_pos[idx]=cc.scrollTop};
    })(i,sc);
  }
}
function startScroll(n,gen){
  for(var i=0;i<_raf.length;i++)cancelAnimationFrame(_raf[i]||0);
  _raf=[];
  for(var i=0;i<n;i++){
    (function(idx,g){
      _lastTs[idx]=performance.now();
      _raf[idx]=requestAnimationFrame(function(t){stepScroll(idx,t,g)});
    })(i,gen);
  }
}
function stepScroll(i,ts,g){
  if(g!==_gen)return; /* 旧世代残留帧，丢弃 */
  var sc=_cols[i];
  if(sc&&_animating&&!_hover[i]&&!_pausedAll&&!document.hidden){
    var c=sc.querySelector('.col-scroller'),H=_heights[i];
    if(c&&H){
      var dt=Math.min(ts-_lastTs[i],100);_lastTs[i]=ts;
      _pos[i]+=(_dirs[i]==='up'?1:-1)*_speed*dt/1000;
      c.scrollTop=mod(_pos[i],H);
    }
  }
  if(g===_gen)_raf[i]=requestAnimationFrame(function(t){stepScroll(i,t,g)});
}

/* 瀑布流渲染：贪心插入最矮列；过滤/列数变化时整树重建。
 * isSearch=搜索结果：静态展示、每条只出现一次(不循环复制)、忽略分类过滤(全局搜索) */
var _isSearch=false; /* 搜索态持久：搜索后列数切换/resize/分类点击重渲染时保持静态，不循环复制 */
function renderMasonry(items, isSearch){
  if(typeof isSearch!=='undefined')_isSearch=!!isSearch; else isSearch=_isSearch;
  var secs=$('secs');secs.innerHTML='';
  var n=colCount();
  if(!items||!items.length){window._lastItems=items||[];window._lastCols=n;if(!isSearch)buildChips();buildColSel();secs.innerHTML=isSearch?'<div class="state">未找到相关新闻</div>':'<div class="state">暂无新闻数据</div>';return}
  var list=isSearch?items:(_cats.length?items.filter(function(it){return _cats.indexOf(catOf(it.source))>=0}):items);
  if(!list.length){window._lastItems=items;window._lastCols=n;buildChips();buildColSel();secs.innerHTML='<div class="state">该分类暂无内容</div>';return}
  var m=document.createElement('div');m.className='masonry';
  _cols=[];var heights=[];
  for(var i=0;i<n;i++){
    var col=document.createElement('div');col.className='masonry-col';
    var scroller=document.createElement('div');scroller.className='col-scroller';
    col.appendChild(scroller);_cols.push(col);heights.push(0);m.appendChild(col);
  }
  /* 必须先挂进文档再读高度：离树节点无布局，offsetHeight 恒为 0，全部卡片会挤进第一列 */
  secs.appendChild(m);
  var GAP=12; /* 列间距 .75rem */
  list.forEach(function(it){
    var card=buildCard(it);
    var min=0;
    for(var k=1;k<_cols.length;k++){if(heights[k]<heights[min])min=k}
    _cols[min].querySelector('.col-scroller').appendChild(card);
    heights[min]+=card.offsetHeight+GAP; /* 每卡只读一次高度，避免 n 列全读的布局抖动 */
  });
  window._lastItems=items;window._lastCols=n;
  _animating=!isSearch&&!isTouch()&&!reduced();
  if(_dirs.length!==n){assignDirs(n)}
  _gen++;
  setupScroll(n);
  if(_animating)startScroll(n,_gen);
  if(!isSearch)buildChips(); /* 搜索不重建分类下拉，保留用户已选分类状态 */
  buildColSel();
  requestAnimationFrame(function(){secs.querySelectorAll('.reveal').forEach(function(el){el.classList.add('in')})});
}

/* 窗口缩放：跨列档位重排；同档位仅重配滚动（复制份数随视口高变化） */
var _rt;
window.addEventListener('resize',function(){
  clearTimeout(_rt);
  _rt=setTimeout(function(){
    if(!window._lastItems)return;
    if(window._lastCols!==colCount()){renderMasonry(window._lastItems)}
    else{_animating=!_isSearch&&!isTouch()&&!reduced();_gen++;setupScroll(window._lastCols);if(_animating)startScroll(window._lastCols,_gen)}
  },200);
});

/* 卡片光泽：委托到容器，复制出的卡片同样生效 */
$('secs').addEventListener('mousemove',function(e){
  var card=e.target.closest('.card');if(!card)return;
  var b=card.getBoundingClientRect();
  card.style.setProperty('--mx',(e.clientX-b.left)+'px');
  card.style.setProperty('--my',(e.clientY-b.top)+'px');
});

/* ---- 两列切换弹窗：顶部横幅，弹簧滑入 ---- */
function setPausedAll(p){_pausedAll=p}
function showPrompt(){
  var p=$('prompt');if(!p)return;
  if(window._jayClose)window._jayClose(); /* 列数提示弹出前先收起每日推荐，避免撞车 */
  setPausedAll(true);
  p.setAttribute('aria-hidden','false');
  void p.offsetWidth; /* 强制回流让过渡生效 */
  p.classList.add('show');
}
function hidePrompt(){
  var p=$('prompt');if(!p)return;
  p.classList.remove('show');p.setAttribute('aria-hidden','true');
  setPausedAll(false);
}
$('prompt').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  if(b.getAttribute('data-act')==='yes'){
    try{localStorage.setItem('jpc_news_cols','2')}catch(_){}
    hidePrompt();
    if(window._lastItems)renderMasonry(window._lastItems);
  }else{hidePrompt()}
});
var _asked=false;
function maybeAsk(){
  if(_asked)return;_asked=true;
  setTimeout(function(){
    if(colCount()>2)showPrompt();
  },5000);
}

async function load(){
  var st=$('state');
  try{
    var r=await fetch('/api/news'),j=await r.json();
    if(!j.success||!j.data||!j.data.length){st.innerHTML='<div class="state">暂无新闻数据</div>';return}
    st.style.display='none';
    $('updTime').textContent='更新于 '+j.updateTime;
    try{
      var raw=localStorage.getItem('jpc_news_cat');
      if(raw&&raw!=='all'){var a=JSON.parse(raw);_cats=Array.isArray(a)?a:[]}else _cats=[];
    }catch(e){_cats=[]}
    _allItems=j.data;
    renderMasonry(j.data);
    maybeAsk();
  }catch(e){
    st.innerHTML='<div class="state err">⚠️ 加载失败：'+esc(e.message)+'</div>';
  }
}
/* ---- 周杰伦每日推荐浮窗：标题/封面/专辑/幕后小故事；开关 localStorage 永久记忆 ---- */
var JAY_SONGS=[
 {t:'晴天',a:'叶惠美',m:'000MkMni19ClKG',s:'词曲编全由周杰伦一人包办，MV在淡水拍，讲学生时代初恋。录音时钢琴旋律现场即兴，副歌和声一个人完成。'},
 {t:'七里香',a:'七里香',m:'003DFRzD192KKD',s:'歌名取自席慕蓉诗集《七里香》，方文山以"写诗"的心情填词，木吉他一扫而过，成了夏天最常被想起的歌。'},
 {t:'稻香',a:'魔杰座',m:'002Neh8l0uciQZ',s:'2008年金融海啸后创作，周杰伦把童年乡下的生活写进歌里，想告诉大家"累了就回家"，找回最初的快乐。'},
 {t:'夜曲',a:'十一月的萧邦',m:'0024bjiL2aocxT',s:'灵感来自肖邦的钢琴夜曲，周杰伦在飞机上随手弹的旋律，回国后录成了整首歌，MV远赴纽约拍摄。'},
 {t:'青花瓷',a:'我很忙',m:'002eFUFm2XYZ7z',s:'方文山逛台北故宫看到宋瓷展，写下"天青色等烟雨"——那是汝窑瓷器在雨过天晴时才烧成的天青色传说。'},
 {t:'告白气球',a:'周杰伦的床边故事',m:'003RMaRI1iFoYd',s:'整张专辑里最甜的一首，MV在巴黎塞纳河畔拍摄，从咖啡馆一路逛到埃菲尔铁塔，弹着吉他唱给喜欢的人。'},
 {t:'简单爱',a:'范特西',m:'000I5jJB3blWeN',s:'周杰伦学生时代练琴时弹出来的即兴旋律，简单到只有爱情最初的样子，也成了华语乐坛最经典的纯爱启蒙。'},
 {t:'安静',a:'范特西',m:'000I5jJB3blWeN',s:'周杰伦自己作词，写的是一个人孤独坐在角落的心情。全曲以钢琴独奏为主，是他极少见的"自己写自己"的歌。'},
 {t:'双截棍',a:'范特西',m:'000I5jJB3blWeN',s:'2001年引爆"中国风说唱"，把功夫电影元素写进歌里，让全世界知道了什么叫"哼哼哈兮"。'},
 {t:'听妈妈的话',a:'依然范特西',m:'002jLGWe16Tf1H',s:'写给母亲叶惠美的歌，用Rap讲小时候妈妈教他弹琴的故事，后来被收入台湾教科书。'},
 {t:'最伟大的作品',a:'最伟大的作品',m:'0042cH172YJ0mz',s:'2022年专辑同名主打，MV里周杰伦穿越回1920年代的巴黎，与马格利特、达利、莫奈等艺术家们斗琴共舞。'},
 {t:'等你下课',a:'等你下课',m:'003bSL0v4bpKAx',s:'2018年1月18日生日当天发布，写的是毕业十年后还在等初恋下课的故事，与杨瑞代合唱。'},
 {t:'一路向北',a:'十一月的萧邦',m:'0024bjiL2aocxT',s:'电影《头文字D》插曲，周杰伦在片里开着AE86演藤原拓海，歌里全是失恋后一路向北的孤独。'},
 {t:'以父之名',a:'叶惠美',m:'000MkMni19ClKG',s:'灵感来自电影《教父》，2003年发行当天全亚洲50多家电台同步首播，创下8亿人收听的纪录。'},
 {t:'说好不哭',a:'说好不哭',m:'002gBTVk4JEE2T',s:'2019年深夜发布，与五月天阿信合唱，MV在东京取景，上线当晚把QQ音乐服务器都挤崩了。'},
 {t:'搁浅',a:'七里香',m:'003DFRzD192KKD',s:'七里香专辑里的催泪抒情歌，副歌高音出了名的难唱，却是KTV点了十年的常青树。'}
];
(function(){
  var fab=$('jayFab'),panel=$('jayPanel'),sw=$('jaySwitch');
  if(!fab||!panel||!sw)return;
  var on=localStorage.getItem('np-jay-on');if(on===null)on='1';else on=(on==='1'?'1':'0');
  var idx=Math.floor(Date.now()/864e5)%JAY_SONGS.length;
  var open=false,autoT1=null,autoT2=null;
  var touch=isTouch(),hidOnce=false,hideT=null;
  function render(){
    var s=JAY_SONGS[idx];
    $('jayTitle').textContent=s.t;
    $('jayAlbum').textContent=s.a;
    $('jayStoryTxt').textContent=s.s;
    $('jayDate').textContent='今日推荐 · '+(new Date()).toLocaleDateString('zh-CN',{month:'long',day:'numeric'});
    var img=$('jayCover');
    img.onload=function(){$('jayCovFb').style.display='none';img.style.display='block'};
    img.onerror=function(){img.style.display='none';$('jayCovFb').style.display='flex'};
    img.src='https://y.gtimg.cn/music/photo_new/T002R300x300M000'+s.m+'.jpg';
  }
  function openPanel(){
    open=true;
    panel.classList.add('open');panel.setAttribute('aria-hidden','false');
  }
  function closePanel(){
    open=false;
    panel.classList.remove('open');panel.setAttribute('aria-hidden','true');
    /* 初次弹出并收起后，桌面端平滑隐藏按钮，鼠标靠近左下角再唤出 */
    if(!hidOnce&&!touch){hidOnce=true;hideFab()}
  }
  function hideFab(){fab.classList.add('hide')}
  function showFab(){fab.classList.remove('hide')}
  function cancelAuto(){clearTimeout(autoT1);clearTimeout(autoT2)}
  window._jayClose=closePanel; /* 供列数提示 showPrompt 撞车时收起 */
  function sync(){
    if(on==='1'){
      fab.classList.remove('off');fab.textContent='🎵';fab.title='周杰伦每日推荐';
      sw.classList.add('on');sw.setAttribute('aria-checked','true');
    }else{
      fab.classList.add('off');fab.textContent='🎵';fab.title='开启每日推荐';
      sw.classList.remove('on');sw.setAttribute('aria-checked','false');
      cancelAuto();closePanel();
    }
  }
  fab.addEventListener('click',function(){
    cancelAuto();
    if(on!=='1'){on='1';try{localStorage.setItem('np-jay-on','1')}catch(e){}sync();}
    if(open)closePanel();else openPanel();
  });
  sw.addEventListener('click',function(){
    cancelAuto();
    on=(on==='1'?'0':'1');
    try{localStorage.setItem('np-jay-on',on)}catch(e){}
    sync();
  });
  $('jayStoryBtn').addEventListener('click',function(){$('jayStory').classList.toggle('open')});
  /* 点击页面任意处收起面板（面板/按钮自身除外） */
  document.addEventListener('pointerdown',function(e){
    if(!open)return;
    if(e.target.closest('#jayPanel')||e.target.closest('#jayFab'))return;
    cancelAuto();closePanel();
  });
  /* 桌面端：鼠标进入左下角区域唤出按钮，离开且面板关闭后延时收起 */
  if(!touch){
    document.addEventListener('mousemove',function(e){
      if(e.clientX<=130&&e.clientY>=window.innerHeight-150){
        showFab();clearTimeout(hideT);
      }else if(hidOnce&&!open){
        clearTimeout(hideT);
        hideT=setTimeout(hideFab,500);
      }
    });
  }
  render();sync();
  /* 每日自动弹出一次：进页面1.2s后从左下角Q弹展示，3.4s后自动收起(5s列数提示前结束) */
  if(on==='1'){
    var today=new Date().toDateString(),seen=null;
    try{seen=localStorage.getItem('np-jay-seen')}catch(e){}
    if(seen!==today){
      autoT1=setTimeout(function(){
        try{localStorage.setItem('np-jay-seen',today)}catch(e){}
        openPanel();
        autoT2=setTimeout(closePanel,3400);
      },1200);
    }
  }
})();
load();
</script>
</body>
</html>`;
}

/* ================= 班费收支页面（公开账本） ================= */

/* 莫奈色沿用留言墙那套 token（奶油白/雾蓝/鼠尾草绿/雾粉/淡紫/浅鹅黄/米色），
 * 收支配色刻意压低饱和度，不做股票那种红绿（指导2 §4）。
 * 所有金额都由 /api/fund/ledger 给的分值现算，页面里没有任何写死的数字（§53）。 */
function getFundHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>班费收支 · 高一（7）班</title>
<meta name="theme-color" content="#f7f3ea">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&family=Cormorant+Garamond:wght@500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --cream:#f7f3ea; --ink:#4a453e; --ink2:#837b6f; --line:rgba(74,69,62,.14);
  --sage:#b9c9b3; --mist:#bccfdf; --blush:#e9cfc9; --butter:#f4e6be; --lilac:#d2c9df; --mint:#c6dcd6;
  --paper:#fbf8f1; --paper-mist:#e6eef5; --paper-sage:#e8f0e6;
  --in:#5c7a60; --out:#9a6b63;
  --sh-note:0 1px 1px rgba(74,64,50,.05),0 6px 14px rgba(74,64,50,.07);
  --sh-box:0 2px 6px rgba(74,64,50,.10),0 16px 34px rgba(74,64,50,.12);
}
html{-webkit-text-size-adjust:100%}
body{
  font-family:'Noto Serif SC','Songti SC','PingFang SC','Microsoft YaHei',serif;
  color:var(--ink);background:var(--cream);line-height:1.6;min-height:100vh;
  background-image:radial-gradient(circle at 12% 8%,rgba(188,207,223,.35),transparent 42%),radial-gradient(circle at 88% 4%,rgba(233,207,201,.32),transparent 38%),radial-gradient(circle at 50% 100%,rgba(185,201,179,.28),transparent 46%);
  font-variant-numeric:tabular-nums;
}
a{color:inherit;text-decoration:none}
.wrap{max-width:1040px;margin:0 auto;padding:26px 18px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}
.back{font-size:13px;color:var(--ink2);border:1px solid var(--line);border-radius:999px;padding:6px 14px;background:rgba(255,255,255,.5)}
.back:hover{color:var(--ink)}
.hd{text-align:center;margin-bottom:24px}
.cls{font-size:13px;letter-spacing:.18em;color:var(--ink2)}
.hd h1{font-family:'Cormorant Garamond','Noto Serif SC',serif;font-size:30px;font-weight:600;letter-spacing:.04em;margin:6px 0 8px}
.slogan{font-size:13px;color:var(--ink2)}
.grid{display:block}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh-note);padding:20px;margin-bottom:18px}
/* 顶部余额卡：当前余额是视觉中心，收支是它两侧的注脚（指导2 §6） */
.hero{background:linear-gradient(150deg,#fbf8f1 0%,#f2f5ef 62%,#eef2f7 100%);box-shadow:var(--sh-box)}
.hero .lbl{font-size:13px;color:var(--ink2);letter-spacing:.08em}
.bal{font-family:'Cormorant Garamond','Noto Serif SC',serif;font-size:52px;font-weight:600;line-height:1.15;letter-spacing:.01em}
.bal .cur{font-size:26px;vertical-align:.16em;margin-right:2px;color:var(--ink2)}
.bal-sub{font-size:12px;color:var(--ink2);margin-top:2px}
.flow{display:flex;align-items:center;gap:8px;margin-top:18px;flex-wrap:wrap}
.flow .node{flex:1 1 0;min-width:96px;background:rgba(255,255,255,.66);border:1px solid var(--line);border-radius:11px;padding:10px 12px}
.flow .node .k{font-size:12px;color:var(--ink2)}
.flow .node .v{font-size:19px;font-weight:600;margin-top:2px}
.flow .node.in .v{color:var(--in)}
.flow .node.out .v{color:var(--out)}
.flow .arw{color:var(--ink2);font-size:15px;flex:0 0 auto}
.ratio{margin-top:18px}
.ratio-bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--paper-mist)}
.ratio-bar i{display:block;height:100%}
.ratio-bar .i{background:linear-gradient(90deg,#b9c9b3,#8fae93)}
.ratio-bar .o{background:linear-gradient(90deg,#e9cfc9,#c79a92)}
.ratio-lg{display:flex;justify-content:space-between;font-size:12px;color:var(--ink2);margin-top:8px;gap:10px}
.chip{display:inline-flex;align-items:center;gap:5px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot.i{background:#8fae93}.dot.o{background:#c79a92}
/* 月度小结：数据只有一个月时整块不显示，不为图表而图表（指导2 §36） */
.mrow{display:flex;align-items:center;gap:10px;font-size:13px;padding:7px 0;border-bottom:1px dashed var(--line)}
.mrow:last-child{border-bottom:0}
.mrow .m{flex:0 0 64px;color:var(--ink2)}
.mrow .bar{flex:1 1 auto;height:8px;border-radius:999px;background:var(--paper-sage);overflow:hidden}
.mrow .bar i{display:block;height:100%;background:linear-gradient(90deg,#e9cfc9,#c79a92)}
.mrow .amt{flex:0 0 auto;font-size:13px;color:var(--out)}
/* 筛选 */
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg{display:inline-flex;background:rgba(255,255,255,.6);border:1px solid var(--line);border-radius:999px;padding:3px}
.seg button{border:0;background:transparent;font:inherit;font-size:13px;color:var(--ink2);padding:6px 14px;border-radius:999px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--paper);color:var(--ink);box-shadow:0 1px 3px rgba(74,64,50,.14)}
select,input[type=text]{font:inherit;font-size:13px;color:var(--ink);background:rgba(255,255,255,.7);border:1px solid var(--line);border-radius:999px;padding:7px 12px;max-width:100%}
.fhint{font-size:12px;color:var(--ink2);margin-left:auto}
/* 时间线（移动端主体） */
.tl{list-style:none}
.rec{display:flex;gap:12px;padding:14px 0;border-bottom:1px dashed var(--line);cursor:pointer}
.rec:last-child{border-bottom:0}
.rec .when{flex:0 0 68px;font-size:13px;color:var(--ink2);padding-top:2px}
.rec .mid{flex:1 1 auto;min-width:0}
.rec .what{font-size:15px;word-break:break-word}
.rec .what .none{color:var(--ink2);font-size:13px}
.rec .meta{font-size:12px;color:var(--ink2);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap}
.rec .amt{flex:0 0 auto;font-size:16px;font-weight:600;white-space:nowrap}
.rec.in .amt{color:var(--in)}
.rec.out .amt{color:var(--out)}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--ink2);background:rgba(255,255,255,.6)}
.tag.ok{color:#5c7a60;border-color:rgba(143,174,147,.5);background:var(--paper-sage)}
.tag.wait{color:#8a7a4e;border-color:rgba(214,196,140,.55);background:#faf5e4}
.k-ind{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--paper-mist);color:#5d7285}
.k-ind.ex{background:#f8e8e5;color:#8a5f58}
/* 表格（PC） */
.tblwrap{display:none}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;font-size:12px;color:var(--ink2);letter-spacing:.06em;background:rgba(255,255,255,.4)}
td.num{text-align:right;white-space:nowrap;font-weight:600}
td.num.in{color:var(--in)}
td.num.out{color:var(--out)}
tbody tr{cursor:pointer}
tbody tr:hover{background:rgba(255,255,255,.55)}
/* 分页 */
.pager{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:16px;font-size:13px;color:var(--ink2)}
.pager button{font:inherit;font-size:13px;background:rgba(255,255,255,.7);border:1px solid var(--line);border-radius:999px;padding:7px 16px;color:var(--ink);cursor:pointer}
.pager button:disabled{opacity:.45;cursor:not-allowed}
.empty{text-align:center;padding:38px 16px;color:var(--ink2);font-size:14px}
.empty .big{font-size:26px;display:block;margin-bottom:8px;opacity:.7}
.foot{text-align:center;font-size:12px;color:var(--ink2);margin-top:22px;line-height:1.9}
/* 详情弹窗 */
.modal{position:fixed;inset:0;background:rgba(74,64,50,.34);display:none;align-items:center;justify-content:center;padding:18px;z-index:20;backdrop-filter:blur(2px)}
.modal.on{display:flex}
.sheet{background:var(--paper);border-radius:16px;box-shadow:var(--sh-box);max-width:420px;width:100%;padding:22px;max-height:86vh;overflow:auto}
.sheet h2{font-size:17px;font-weight:600;margin-bottom:14px}
.kv{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px dashed var(--line);font-size:14px}
.kv:last-of-type{border-bottom:0}
.kv .k{color:var(--ink2);flex:0 0 auto;font-size:13px}
.kv .v{text-align:right;word-break:break-word}
.sheet .close{margin-top:16px;width:100%;font:inherit;font-size:14px;padding:10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.7);cursor:pointer}
.offline{background:#faf5e4;border-color:rgba(214,196,140,.6)}
@media(min-width:720px){
  .hd h1{font-size:34px}
  .bal{font-size:58px}
}
@media(min-width:940px){
  .grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;align-items:start}
  .grid .card{margin-bottom:18px}
  .tl{display:none}
  .tblwrap{display:block}
  .rec .when{flex-basis:80px}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <a class="back" href="/">← 返回首页</a>
    <span style="display:inline-flex;align-items:center;gap:8px">
      <span class="cls" id="clsTop"></span>
      <a class="back" id="adminLink" href="/fund-admin">🔒 后台管理</a>
    </span>
  </div>

  <header class="hd">
    <div class="cls" id="cls"></div>
    <h1 id="ttl">班费收支</h1>
    <p class="slogan" id="slogan">每一笔班费，都清清楚楚地记录在这里。</p>
  </header>

  <div class="grid">
    <section class="card hero" aria-live="polite">
      <div class="lbl">当前余额</div>
      <div class="bal"><span class="cur">¥</span><span id="bal">--</span></div>
      <div class="bal-sub" id="balSub">累计收入 − 累计支出</div>
      <div class="flow">
        <div class="node in"><div class="k">累计收入</div><div class="v" id="sumIn">¥--</div></div>
        <div class="arw">→</div>
        <div class="node out"><div class="k">累计支出</div><div class="v" id="sumOut">¥--</div></div>
        <div class="arw">→</div>
        <div class="node"><div class="k">当前余额</div><div class="v" id="sumBal">¥--</div></div>
      </div>
      <div class="ratio" id="ratioBox">
        <div class="ratio-bar"><i class="i" id="rIn" style="width:50%"></i><i class="o" id="rOut" style="width:50%"></i></div>
        <div class="ratio-lg">
          <span class="chip"><span class="dot i"></span>收入 <b id="lgIn">--</b></span>
          <span class="chip"><span class="dot o"></span>支出 <b id="lgOut">--</b></span>
        </div>
      </div>
    </section>

    <aside class="card" id="monCard" style="display:none">
      <div class="lbl" style="font-size:13px;color:var(--ink2);margin-bottom:8px">各月支出</div>
      <div id="monList"></div>
    </aside>
  </div>

  <section class="card">
    <div class="filters">
      <div class="seg" role="group" aria-label="收支筛选">
        <button type="button" data-kind="all" aria-pressed="true">全部</button>
        <button type="button" data-kind="income" aria-pressed="false">收入</button>
        <button type="button" data-kind="expense" aria-pressed="false">支出</button>
      </div>
      <select id="fMonth" aria-label="按月份筛选"><option value="">全部月份</option></select>
      <select id="fAccount" aria-label="按账户筛选" style="display:none"><option value="">全部账户</option></select>
      <select id="fOrder" aria-label="排序"><option value="desc">最新在前</option><option value="asc">最早在前</option></select>
      <span class="fhint" id="fhint"></span>
    </div>
  </section>

  <section class="card">
    <div id="listBox"><div class="empty"><span class="big">🧾</span>正在翻账本…</div></div>
    <div class="tblwrap" id="tblWrap">
      <table>
        <thead><tr><th>日期</th><th>类型</th><th>账户</th><th style="text-align:right">金额</th><th>核对</th><th>备注</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div class="pager" id="pager" style="display:none">
      <button type="button" id="prevBtn">← 上一页</button>
      <span id="pageHint"></span>
      <button type="button" id="nextBtn">下一页 →</button>
    </div>
  </section>

  <div class="foot">
    余额由服务端按「累计收入 − 累计支出」实时计算，页面数字均来自数据库。<br>
    每一笔账都可以点开看明细；账目有疑问可在班级群里提出。
  </div>
</div>

<div class="modal" id="modal">
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mTitle">
    <h2 id="mTitle">账目明细</h2>
    <div id="mBody"></div>
    <button class="close" type="button" id="mClose">关闭</button>
  </div>
</div>

<script>
var state={kind:'all',month:'',account:'',order:'desc',page:1,limit:12,total:0,summary:null};
var $=function(id){return document.getElementById(id)};
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function yuan(c){return (Number(c||0)/100).toFixed(2)}
function money(c){return '¥'+yuan(c)}
function dLabel(d){var p=String(d||'').split('-');return p.length===3?(p[1]+'月'+p[2]+'日'):(d||'')}
function api(path){
  return fetch(path,{headers:{'Accept':'application/json'}}).then(function(r){return r.json().then(function(j){return {status:r.status,body:j}})});
}
function setChips(){
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'),function(b){
    b.setAttribute('aria-pressed',b.getAttribute('data-kind')===state.kind?'true':'false');
  });
}
function renderSummary(s){
  state.summary=s;
  $('bal').textContent=yuan(s.balanceCents);
  $('sumIn').textContent=money(s.incomeCents);
  $('sumOut').textContent=money(s.expenseCents);
  $('sumBal').textContent=money(s.balanceCents);
  $('balSub').textContent='累计收入 '+money(s.incomeCents)+' − 累计支出 '+money(s.expenseCents);
  $('lgIn').textContent=money(s.incomeCents);
  $('lgOut').textContent=money(s.expenseCents);
  var sum=s.incomeCents+s.expenseCents;
  var pi=sum>0?Math.round(s.incomeCents/sum*100):50;
  $('rIn').style.width=pi+'%';
  $('rOut').style.width=(100-pi)+'%';
  /* 月份下拉：只列账本里真实出现过的月份 */
  var fm=$('fMonth'),keep=state.month;
  fm.innerHTML='<option value="">全部月份</option>'+ (s.months||[]).map(function(m){
    return '<option value="'+esc(m.month)+'">'+esc(m.month.replace('-','年'))+'月</option>';
  }).join('');
  fm.value=keep;
  var fa=$('fAccount');
  if((s.accounts||[]).length>1){
    fa.style.display='';
    fa.innerHTML='<option value="">全部账户</option>'+(s.accounts||[]).map(function(a){return '<option value="'+esc(a)+'">'+esc(a)+'</option>'}).join('');
    fa.value=state.account;
  }else{fa.style.display='none'}
  /* 只有一个月的数据时不摆月度统计 */
  var withData=(s.months||[]).filter(function(m){return m.expenseCents>0});
  if(withData.length>1){
    var max=Math.max.apply(null,withData.map(function(m){return m.expenseCents}));
    $('monList').innerHTML=withData.map(function(m){
      var w=max>0?Math.max(Math.round(m.expenseCents/max*100),4):0;
      return '<div class="mrow"><span class="m">'+esc(m.month.slice(2))+'</span><span class="bar"><i style="width:'+w+'%"></i></span><span class="amt">'+money(m.expenseCents)+'</span></div>';
    }).join('');
    $('monCard').style.display='';
  }else{$('monCard').style.display='none'}
}
function recRow(it){
  var kindCls=it.kind==='income'?'in':'out';
  var kindTxt=it.kind==='income'?'收入':'支出';
  var sign=it.kind==='income'?'+':'−';
  var note=it.note?'<div class="what">'+esc(it.note)+'</div>':'<div class="what"><span class="none">'+(it.kind==='income'?'未填写来源备注':'未填写用途备注')+'</span></div>';
  return '<li class="rec '+kindCls+'" data-id="'+it.id+'" tabindex="0">'+
    '<span class="when">'+esc(dLabel(it.date))+'</span>'+
    '<span class="mid">'+note+'<span class="meta"><span class="k-ind'+(it.kind==='income'?'':' ex')+'">'+kindTxt+'</span><span>'+esc(it.account)+'</span><span class="tag '+(it.verified?'ok':'wait')+'">'+(it.verified?'已核对':'待核对')+'</span></span></span>'+
    '<span class="amt">'+sign+money(it.amountCents).slice(1)+'</span></li>';
}
function tblRow(it){
  var kindCls=it.kind==='income'?'in':'out';
  var sign=it.kind==='income'?'+':'−';
  return '<tr data-id="'+it.id+'"><td>'+esc(it.date)+'</td>'+
    '<td><span class="k-ind'+(it.kind==='income'?'':' ex')+'">'+(it.kind==='income'?'收入':'支出')+'</span></td>'+
    '<td>'+esc(it.account)+'</td>'+
    '<td class="num '+kindCls+'">'+sign+money(it.amountCents).slice(1)+'</td>'+
    '<td><span class="tag '+(it.verified?'ok':'wait')+'">'+(it.verified?'已核对':'待核对')+'</span></td>'+
    '<td>'+esc(it.note||'—')+'</td></tr>';
}
function emptyText(){
  var s=state.summary||{};
  if(state.month||state.account||state.kind!=='all')return '这个筛选条件下还没有记录，换个条件看看。';
  if(!s.count)return '账本还是空的，第一笔记录很快就会记上来。';
  if(!s.expenseCount)return '还没有支出记录。';
  if(!s.incomeCount)return '还没有收入记录。';
  return '还没有记录。';
}
function renderList(j){
  state.total=j.total;state.page=j.page;
  var items=j.items||[];
  $('fhint').textContent='共 '+j.total+' 笔记录';
  if(!items.length){
    $('listBox').innerHTML='<div class="empty"><span class="big">📖</span>'+esc(emptyText())+'</div>';
    $('tbody').innerHTML='';
  }else{
    $('listBox').innerHTML='<ul class="tl">'+items.map(recRow).join('')+'</ul>';
    $('tbody').innerHTML=items.map(tblRow).join('');
  }
  var pages=Math.max(Math.ceil(j.total/j.limit),1);
  $('pager').style.display=j.total>j.limit?'flex':'none';
  $('pageHint').textContent='第 '+j.page+' / '+pages+' 页';
  $('prevBtn').disabled=j.page<=1;
  $('nextBtn').disabled=!j.hasMore;
}
function fail(msg){
  $('listBox').innerHTML='<div class="empty offline"><span class="big">🌧️</span>'+esc(msg||'账目暂时读不出来，稍后再试。')+'</div>';
  $('tbody').innerHTML='';
}
function qs(){
  var p=['kind='+encodeURIComponent(state.kind),'order='+state.order,'page='+state.page,'limit='+state.limit];
  if(state.month)p.push('month='+encodeURIComponent(state.month));
  if(state.account)p.push('account='+encodeURIComponent(state.account));
  return p.join('&');
}
function load(){
  $('fhint').textContent='读取中…';
  return api('/api/fund/ledger?'+qs()).then(function(res){
    if(!res.body||!res.body.success){fail(res.body&&res.body.error);return}
    $('cls').textContent=res.body.class_label||'';
    $('clsTop').textContent=res.body.class_label||'';
    $('ttl').textContent=res.body.title||'班费收支';
    $('slogan').textContent=res.body.slogan||$('slogan').textContent;
    document.title=(res.body.title||'班费收支')+' · '+(res.body.class_label||'');
    renderSummary(res.body.summary);
    renderList(res.body);
  }).catch(function(){fail('网络不顺畅，账目没读出来。')});
}
function detail(id){
  api('/api/fund/record/'+id).then(function(res){
    if(!res.body||!res.body.success){fail(res.body&&res.body.error);return}
    var it=res.body.item;
    var rows=[
      ['日期',it.date],
      ['类型',it.kind==='income'?'收入':'支出'],
      ['账户',it.account],
      ['金额','¥'+yuan(it.amountCents)],
      [it.kind==='income'?'来源备注':'支出去向',it.note||'未填写'],
      ['核对状态',it.verified?'已核对':'待核对'],
      ['最后更新',it.updatedAt?new Date(it.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—']
    ];
    $('mBody').innerHTML=rows.map(function(r){return '<div class="kv"><span class="k">'+esc(r[0])+'</span><span class="v">'+esc(r[1])+'</span></div>'}).join('');
    $('modal').classList.add('on');
  }).catch(function(){fail('这条账目没读出来，稍后再试。')});
}
function bindList(){
  document.addEventListener('click',function(e){
    var b=e.target.closest('button[data-kind]');
    if(b){state.kind=b.getAttribute('data-kind');state.page=1;setChips();load();return}
    var row=e.target.closest('[data-id]');
    if(row){detail(row.getAttribute('data-id'));return}
    if(e.target.id==='modal'){$('modal').classList.remove('on')}
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){$('modal').classList.remove('on');return}
    /* 时间线条目可以键盘打开（可访问性） */
    if(e.key==='Enter'){
      var row=document.activeElement;
      if(row&&row.getAttribute&&row.getAttribute('data-id'))detail(row.getAttribute('data-id'));
    }
  });
  $('fMonth').addEventListener('change',function(){state.month=this.value;state.page=1;load()});
  $('fAccount').addEventListener('change',function(){state.account=this.value;state.page=1;load()});
  $('fOrder').addEventListener('change',function(){state.order=this.value;state.page=1;load()});
  $('prevBtn').addEventListener('click',function(){if(state.page>1){state.page--;load();window.scrollTo({top:0,behavior:'smooth'})}});
  $('nextBtn').addEventListener('click',function(){state.page++;load()});
  $('mClose').addEventListener('click',function(){$('modal').classList.remove('on')});
}
bindList();setChips();load();
</script>
</body>
</html>`;
}

/* ================= 管理后台页面：新闻标注 + AI 抽检 ================= */
/* 班费独立后台 /fund-admin：不占主后台的 ADMIN_TOKEN，
 * 用单独的 FUND_ADMIN_TOKEN（见 isFundAdmin），方便把班费交给生活委员维护。
 * 面板与脚本直接复用 fundAdminPanel() / fundAdminJS()，和 /admin 里的折叠卡是同一份。 */
function getFundAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>班费账本 · 后台</title>
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#f7f3ea">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&family=Cormorant+Garamond:wght@500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --cream:#f7f3ea; --ink:#4a453e; --ink2:#837b6f; --line:rgba(74,69,62,.14);
  --sage:#b9c9b3; --mist:#bccfdf; --blush:#e9cfc9; --mint:#c6dcd6;
  --paper:#fbf8f1;
  --sh-note:0 1px 1px rgba(74,64,50,.05),0 6px 14px rgba(74,64,50,.07);
  --sh-box:0 2px 6px rgba(74,64,50,.10),0 16px 34px rgba(74,64,50,.12);
  --in:#5c7a60; --out:#9a6b63;
}
body{
  font-family:'Noto Serif SC','Songti SC','PingFang SC','Microsoft YaHei',serif;
  color:var(--ink);background:var(--cream);line-height:1.6;min-height:100vh;font-size:15px;
  background-image:radial-gradient(circle at 10% 6%,rgba(188,207,223,.32),transparent 40%),radial-gradient(circle at 92% 2%,rgba(233,207,201,.3),transparent 36%);
  font-variant-numeric:tabular-nums;
}
a{color:inherit;text-decoration:none}
.wrap{max-width:1000px;margin:0 auto;padding:22px 16px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.ttl{font-family:'Cormorant Garamond','Noto Serif SC',serif;font-size:22px;font-weight:600;letter-spacing:.03em}
.sub{font-size:12px;color:var(--ink2);letter-spacing:.12em}
.mini{font-size:13px;color:var(--ink2);border:1px solid var(--line);border-radius:999px;padding:5px 12px;background:rgba(255,255,255,.55)}
.mini:hover{color:var(--ink)}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh-note);padding:18px;margin-bottom:16px}
.gate{max-width:400px;margin:9vh auto;box-shadow:var(--sh-box);text-align:center}
.gate h2{font-size:18px;font-weight:600;margin-bottom:6px}
.gate p{font-size:13px;color:var(--ink2);margin-bottom:16px}
.gate .fld{display:flex;gap:8px}
.gate input{flex:1;text-align:center;letter-spacing:.14em}
input,select,button{font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 11px;font-size:14px}
input:focus,select:focus{outline:none;border-color:var(--sage);box-shadow:0 0 0 3px rgba(185,201,179,.3)}
button{cursor:pointer;background:rgba(255,255,255,.72)}
button:hover{border-color:var(--ink2)}
button:disabled{opacity:.45;cursor:not-allowed}
button.pri{background:var(--sage);border-color:transparent;color:#3a4a3c;font-weight:600}
button.pri:hover{background:#aec0a8}
button.del{color:var(--out);border-color:rgba(154,107,99,.35)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.hint{font-size:13px;color:var(--ink2)}
.hint b{color:var(--ink)}
.err{color:var(--out)}
.ok{color:var(--in)}
.dim{color:var(--ink2)}
.res{margin:6px 0 12px}
.item{border-top:1px dashed var(--line);padding:10px 0}
.item .t{font-size:14px}
.item .m{font-size:13px;color:var(--ink2);margin-top:3px}
.badge{display:inline-block;font-size:12px;border-radius:999px;padding:1px 8px;background:rgba(185,201,179,.35);color:#4c5c4e}
.badge.warn{background:rgba(233,207,201,.45);color:#8a5f56}
.badge.clean{background:rgba(198,220,214,.5);color:#3f5f58}
.foot{text-align:center;font-size:12px;color:var(--ink2);margin-top:22px;line-height:1.9}
@media (max-width:520px){
  .wrap{padding:16px 12px 48px}
  .card{padding:14px}
  input,select,button{font-size:16px}
  .row>input,.row>select{flex:1 1 140px;max-width:none !important}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <div class="ttl">班费账本 · 后台</div>
      <div class="sub">高一（7）班</div>
    </div>
    <div>
      <a class="mini" href="/fund">公开账本 ↗</a>
      <a class="mini" href="/">首页</a>
      <button class="mini" id="logoutBtn" type="button" style="display:none">退出</button>
    </div>
  </div>

  <div class="card gate" id="gate">
    <h2>请输入班费后台口令</h2>
    <p>口令存在本机浏览器，换设备要重新输入。</p>
    <div class="fld">
      <input type="password" id="fpw" placeholder="口令" autocomplete="current-password">
      <button class="pri" id="floginBtn" type="button">进入</button>
    </div>
    <div class="hint" id="fHint" style="margin-top:12px"></div>
  </div>

  <div class="card" id="panel" style="display:none">
${fundAdminPanel()}
  </div>

  <div class="foot">
    每笔改动都会留记录 · 删除不可撤销<br>
    也可以在 /admin 的「班费收支」里维护
  </div>
</div>
<script>
${fundAdminJS()}
var TOKEN_KEY='jpc_fund_token';
function tok(){return localStorage.getItem(TOKEN_KEY)||''}
function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML}
function api(path,opt){
  var o=opt||{};o.headers=o.headers||{};
  o.headers['Authorization']='Bearer '+tok();
  if(o.body)o.headers['Content-Type']='application/json';
  return fetch(path,o).then(function(r){
    if(r.status===401){lock('登录已失效，请重新输入口令');throw new Error('401')}
    if(r.status===429){return r.json().then(function(j){lock(j.error||'尝试次数过多');throw new Error('429')})}
    return r.json();
  });
}
function unlock(){
  document.getElementById('gate').style.display='none';
  document.getElementById('panel').style.display='';
  document.getElementById('logoutBtn').style.display='';
  document.getElementById('fHint').innerHTML='<span class="ok">✓ 已进入</span>';
  fundLoad(1);fundAuditLoad();
}
function lock(msg){
  localStorage.removeItem(TOKEN_KEY);
  document.getElementById('panel').style.display='none';
  document.getElementById('logoutBtn').style.display='none';
  document.getElementById('gate').style.display='';
  document.getElementById('fpw').value='';
  document.getElementById('fHint').innerHTML=msg?('<span class="err">'+esc(msg)+'</span>'):'';
}
function fundLogin(){
  var t=document.getElementById('fpw').value.trim();if(!t)return;
  var box=document.getElementById('fHint');box.innerHTML='<span class="dim">验证中…</span>';
  fetch('/api/fund-admin/verify',{method:'POST',headers:{'Authorization':'Bearer '+t}}).then(function(r){
    if(r.status===401){box.innerHTML='<span class="err">口令不对</span>';return}
    if(r.status===429||r.status===503){
      return r.json().then(function(j){box.innerHTML='<span class="err">'+esc(j.error||('服务异常 '+r.status))+'</span>'})
        .catch(function(){box.innerHTML='<span class="err">服务异常 ('+r.status+')</span>'});
    }
    if(!r.ok){box.innerHTML='<span class="err">服务异常 ('+r.status+')</span>';return}
    localStorage.setItem(TOKEN_KEY,t);
    unlock();
  }).catch(function(){box.innerHTML='<span class="err">网络错误</span>'});
}
document.getElementById('floginBtn').onclick=fundLogin;
document.getElementById('fpw').addEventListener('keydown',function(e){if(e.key==='Enter')fundLogin()});
document.getElementById('logoutBtn').onclick=function(){lock('已退出')};
/* 本机存过口令：静默验一次，有效就直接进，失效就留在门口 */
if(tok()){
  fetch('/api/fund-admin/verify',{method:'POST',headers:{'Authorization':'Bearer '+tok()}}).then(function(r){
    if(r.ok)unlock();else lock('口令已失效，请重新输入');
  }).catch(function(){});
}
</script>
</body>
</html>`;
}

/* 班费后台面板与脚本：主后台 /admin 的折叠卡和独立后台 /fund-admin 共用同一份，
 * 只在外壳（登录方式、样式）上不同，改一次两边都生效 */
function fundAdminPanel() {
  return `
      <div class="row" style="padding-top:4px">
        <span class="hint" id="fundSum">解锁后加载…</span>
        <span style="flex:1"></span>
        <button id="fundInitBtn" type="button">导入初始数据</button>
        <button id="fundExportBtn" type="button">导出 CSV</button>
      </div>
      <div class="row" style="display:block">
        <div class="hint" style="margin-bottom:6px">一句话记账，例如「昨天买扫把挂钩花了 6.7」。默认只填表，核对后手动保存。</div>
        <div class="row">
          <input type="text" id="fundAiText" placeholder="例如：教师节买16盆植物花了160" maxlength="120" style="flex:1;min-width:220px">
          <button class="pri" id="fundAiBtn" type="button">AI 识别</button>
          <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer" title="勾上后 AI 识别成功即自动入账，一律记为「待核对」">
            <input type="checkbox" id="fundAiAuto" style="accent-color:#0071e3">识别后自动入账
          </label>
        </div>
        <div class="hint" id="fundAiHint" style="margin-bottom:6px"></div>
      </div>
      <div class="row" style="display:block">
        <div class="hint" id="fundFormTitle" style="margin-bottom:6px">新增账目</div>
        <div class="row">
          <select id="fKind" style="max-width:120px">
            <option value="expense">支出</option>
            <option value="income">收入</option>
          </select>
          <input type="date" id="fDate" style="max-width:160px">
          <input type="text" id="fAmount" placeholder="金额，如 20.80" style="max-width:150px" inputmode="decimal">
          <input type="text" id="fAccount" list="fundAccounts" placeholder="账户" style="max-width:130px">
          <datalist id="fundAccounts">
            <option value="微信"></option><option value="支付宝"></option>
            <option value="现金"></option><option value="银行卡"></option>
          </datalist>
          <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="fVerified" style="accent-color:#0071e3">已核对
          </label>
        </div>
        <div class="row">
          <input type="text" id="fNote" placeholder="备注：收入来源 / 支出去向" maxlength="60" style="flex:1">
        </div>
        <div class="row">
          <label class="hint" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            凭证截图
            <input type="file" id="fEvidence" accept="image/jpeg,image/png,image/webp,image/gif" style="max-width:230px">
          </label>
          <span class="hint" id="fEvidenceHint"></span>
        </div>
        <div class="row">
          <button class="pri" id="fundSaveBtn" type="button">保存账目</button>
          <button id="fundCancelBtn" type="button" style="display:none">取消编辑</button>
          <span class="hint" id="fundSaveHint"></span>
        </div>
      </div>
      <div class="row">
        <select id="fltKind" style="max-width:110px">
          <option value="all">全部</option><option value="income">收入</option><option value="expense">支出</option>
        </select>
        <select id="fltStatus" style="max-width:120px">
          <option value="">全部核对状态</option><option value="verified">已核对</option><option value="pending">待核对</option>
        </select>
        <select id="fltOrder" style="max-width:130px">
          <option value="desc">最新在前</option><option value="asc">最早在前</option>
        </select>
        <input type="text" id="fltQ" placeholder="搜备注 / 账户 / 日期" style="flex:1;min-width:150px" maxlength="40">
        <button id="fundQueryBtn" type="button">查询</button>
      </div>
      <div class="res" id="fundList"><div class="hint">解锁后加载…</div></div>
      <div class="row" id="fundPager" style="display:none;justify-content:center">
        <button id="fundPrevBtn" type="button">← 上一页</button>
        <span class="hint" id="fundPageHint"></span>
        <button id="fundNextBtn" type="button">下一页 →</button>
      </div>
      <div class="row" style="display:block">
        <div class="hint" style="margin:6px 0">最近修改记录</div>
        <div class="res" id="fundAudit"><div class="hint">加载中…</div></div>
      </div>
    </div>
  </d
`;
}

function fundAdminJS() {
  return `
/* ===== 班费收支：后台模块（新增 / 编辑 / 删除 / 核对 / 筛选 / 排序 / 导出）===== */
var fundState={page:1,limit:20,total:0,editId:0,items:{},evidenceKey:'',evUrl:'',evBlob:''};
function fundYuanAdj(c){return (Number(c||0)/100).toFixed(2)}
/* ---- 凭证截图：上传走 /api/admin/fund/evidence（KV，与云盘文件分开存）---- */
function apiForm(path,fd){
  return fetch(path,{method:'POST',headers:{'Authorization':'Bearer '+tok()},body:fd}).then(function(r){return r.json()});
}
/* 看凭证要带令牌，<img src> 带不了，所以取回来转成 blob 地址再显示 */
function fundEvidenceFetch(key){
  if(fundState.evBlob===key&&fundState.evUrl)return Promise.resolve(fundState.evUrl);
  return fetch('/api/admin/fund/evidence/'+encodeURIComponent(key),{headers:{'Authorization':'Bearer '+tok()}})
    .then(function(r){if(!r.ok)throw new Error('凭证打不开');return r.blob()})
    .then(function(b){
      if(fundState.evUrl)URL.revokeObjectURL(fundState.evUrl);
      fundState.evBlob=key;fundState.evUrl=URL.createObjectURL(b);
      return fundState.evUrl;
    });
}
function fundEvidenceHint(){
  var box=document.getElementById('fEvidenceHint'),key=fundState.evidenceKey;
  if(!key){box.textContent='未上传（可选）';return}
  box.textContent='读取中…';
  fundEvidenceFetch(key).then(function(u){
    if(fundState.evidenceKey!==key)return;
    box.innerHTML='<a href="'+u+'" target="_blank" rel="noopener">已上传，点开看</a> '+
      '<img src="'+u+'" alt="凭证" style="height:34px;vertical-align:middle;border-radius:4px;margin:0 6px"> '+
      '<button type="button" onclick="fundEvidenceClear()">移除</button>';
  }).catch(function(e){box.innerHTML='<span class="err">'+esc(e.message||'凭证打不开')+'</span>'});
}
/* 列表里点「凭证」：另开一个标签页看原图 */
function fundEvidenceOpen(key){
  if(!key)return;
  fundEvidenceFetch(key).then(function(u){
    var a=document.createElement('a');a.href=u;a.target='_blank';a.rel='noopener';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
  }).catch(function(e){alert('凭证打不开：'+((e&&e.message)||''))});
}
/* 移除：只改本表单，保存时才真的从 KV 删掉 */
function fundEvidenceClear(){
  fundState.evidenceKey='';
  var f=document.getElementById('fEvidence');if(f)f.value='';
  document.getElementById('fEvidenceHint').textContent='保存后移除该凭证';
}
function fundQs(){
  var p=['page='+fundState.page,'limit='+fundState.limit,
    'kind='+encodeURIComponent(document.getElementById('fltKind').value),
    'order='+encodeURIComponent(document.getElementById('fltOrder').value)];
  var st=document.getElementById('fltStatus').value,q=document.getElementById('fltQ').value.trim();
  if(st)p.push('status='+st);
  if(q)p.push('q='+encodeURIComponent(q));
  return p.join('&');
}
function fundFillForm(it){
  fundState.editId=it?it.id:0;
  document.getElementById('fKind').value=it?it.kind:'expense';
  document.getElementById('fDate').value=it?it.date:'';
  document.getElementById('fAmount').value=it?fundYuanAdj(it.amountCents):'';
  document.getElementById('fAccount').value=it?it.account:'微信';
  document.getElementById('fVerified').checked=it?!!it.verified:false;
  document.getElementById('fNote').value=it?it.note:'';
  document.getElementById('fundFormTitle').textContent=it?('编辑 #'+it.id):'新增账目';
  document.getElementById('fundCancelBtn').style.display=it?'':'none';
  document.getElementById('fundSaveHint').textContent='';
  fundState.evidenceKey=it?(it.evidenceKey||''):'';
  var evInput=document.getElementById('fEvidence');if(evInput)evInput.value='';
  fundEvidenceHint();
  if(it)fundDraftSave();else fundDraftClear(); /* 表单清空 = 没有草稿要留 */
}
/* ---- 草稿本地暂存：只存这台浏览器，不上传。关页面/手滑刷新不丢填了一半的内容 ---- */
var FUND_DRAFT_KEY='jpc_fund_draft';
function fundDraftSave(){
  try{
    localStorage.setItem(FUND_DRAFT_KEY,JSON.stringify({
      ai:document.getElementById('fundAiText').value,
      kind:document.getElementById('fKind').value,
      date:document.getElementById('fDate').value,
      amount:document.getElementById('fAmount').value,
      account:document.getElementById('fAccount').value,
      note:document.getElementById('fNote').value
    }));
  }catch(e){}
}
function fundDraftClear(){try{localStorage.removeItem(FUND_DRAFT_KEY)}catch(e){}}
function fundDropDraft(){
  fundDraftClear();fundFillForm(null);
  document.getElementById('fundAiText').value='';
  document.getElementById('fundAiHint').textContent='草稿已清空。';
}
function fundDraftRestore(){
  var d=null;
  try{d=JSON.parse(localStorage.getItem(FUND_DRAFT_KEY)||'null')}catch(e){d=null}
  if(!d||typeof d!=='object')return false;
  if(d.kind)document.getElementById('fKind').value=d.kind==='income'?'income':'expense';
  if(d.date)document.getElementById('fDate').value=d.date;
  if(d.amount)document.getElementById('fAmount').value=d.amount;
  if(d.account)document.getElementById('fAccount').value=d.account;
  if(d.note)document.getElementById('fNote').value=d.note;
  if(d.ai)document.getElementById('fundAiText').value=d.ai;
  if(!(d.ai||d.amount||d.date||d.note))return false;
  document.getElementById('fundAiHint').innerHTML='已恢复上次没保存的内容。 '+
    '<button type="button" onclick="fundDropDraft()">清空草稿</button>';
  return true;
}
function fundLoad(page){
  if(page)fundState.page=page;
  document.getElementById('fundList').innerHTML='<div class="hint">读取中…</div>';
  api('/api/admin/fund/records?'+fundQs()).then(function(j){
    if(!j.success){document.getElementById('fundList').innerHTML='<div class="hint">读取失败：'+esc(j.error||'')+'</div>';return}
    fundState.total=j.total;fundState.items={};
    var s=j.summary||{};
    document.getElementById('fundSum').innerHTML='累计收入 <b>¥'+fundYuanAdj(s.incomeCents)+'</b> · 累计支出 <b>¥'+fundYuanAdj(s.expenseCents)+'</b> · 当前余额 <b>¥'+fundYuanAdj(s.balanceCents)+'</b> · 共 '+s.count+' 笔';
    var items=j.items||[];
    items.forEach(function(it){fundState.items[it.id]=it});
    if(!items.length){document.getElementById('fundList').innerHTML='<div class="hint">没有符合条件的账目。</div>'}
    else{
      document.getElementById('fundList').innerHTML=items.map(function(it){
        var sign=it.kind==='income'?'+':'−';
        return '<div class="item"><div class="t">'+
          '<span class="badge '+(it.kind==='income'?'clean':'warn')+'">'+(it.kind==='income'?'收入':'支出')+'</span> '+
          esc(it.date)+' · '+esc(it.account)+' · <b>'+sign+'¥'+fundYuanAdj(it.amountCents)+'</b> · '+
          '<span class="badge '+(it.verified?'clean':'warn')+'">'+(it.verified?'已核对':'待核对')+'</span>'+
          (it.createdBy==='ai'?' <span class="badge">AI 记账</span>':'')+'</div>'+
          '<div class="m">'+esc(it.note||'（无备注）')+'</div>'+
          '<div class="m">'+
            (it.hasEvidence?('<button onclick="fundEvidenceOpen(\\''+esc(it.evidenceKey)+'\\')">凭证</button> '):'')+
            '<button onclick="fundEdit('+it.id+')">编辑</button> '+
            '<button onclick="fundVerify('+it.id+','+(it.verified?'false':'true')+')">'+(it.verified?'取消核对':'标记已核对')+'</button> '+
            '<button class="del" onclick="fundDelete('+it.id+')">删除</button>'+
          '</div></div>';
      }).join('');
    }
    var pages=Math.max(Math.ceil(j.total/j.limit),1);
    document.getElementById('fundPager').style.display=j.total>j.limit?'':'none';
    document.getElementById('fundPageHint').textContent='第 '+j.page+' / '+pages+' 页 · 共 '+j.total+' 笔';
    document.getElementById('fundPrevBtn').disabled=j.page<=1;
    document.getElementById('fundNextBtn').disabled=!j.hasMore;
  }).catch(function(e){document.getElementById('fundList').innerHTML='<div class="hint">读取失败：'+esc(e.message||'')+'</div>'});
}
function fundAuditLoad(){
  api('/api/admin/fund/audit?limit=8').then(function(j){
    if(!j.success){document.getElementById('fundAudit').innerHTML='<div class="hint">审计读取失败</div>';return}
    var names={create:'新增',update:'修改',verify:'改核对状态',delete:'删除'};
    var items=j.items||[];
    document.getElementById('fundAudit').innerHTML=items.length?items.map(function(a){
      var t=new Date(a.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
      return '<div class="item"><div class="m">'+esc(t)+' · '+(names[a.action]||a.action)+' · 账目 #'+a.fund_id
        +(a.actor==='ai'?' · <span class="badge">AI 记账</span>':'')+'</div></div>';
    }).join(''):'<div class="hint">还没有修改记录。</div>';
  }).catch(function(){document.getElementById('fundAudit').innerHTML='<div class="hint">审计读取失败</div>'});
}
function fundEdit(id){var it=fundState.items[id];if(it)fundFillForm(it)}
function fundVerify(id,v){
  api('/api/admin/fund/record/verify',{method:'POST',body:JSON.stringify({id:id,verified:v})}).then(function(j){
    if(!j.success)return alert('操作失败：'+(j.error||''));
    fundLoad();fundAuditLoad();
  }).catch(function(e){alert('操作失败：'+(e.message||''))});
}
function fundDelete(id){
  var it=fundState.items[id]||{};
  /* 删除是不可逆的财务数据操作，必须二次确认（指导2 §39） */
  if(!confirm('确定删除这笔 '+it.date+' 的'+(it.kind==='income'?'收入':'支出')+' ¥'+fundYuanAdj(it.amountCents)+' 吗？删除后余额会跟着变，且无法撤销。'))return;
  api('/api/admin/fund/record/delete',{method:'POST',body:JSON.stringify({id:id})}).then(function(j){
    if(!j.success)return alert('删除失败：'+(j.error||''));
    if(fundState.editId===id)fundFillForm(null);
    fundLoad();fundAuditLoad();
  }).catch(function(e){alert('删除失败：'+(e.message||''))});
}
function fundExport(){
  fetch('/api/admin/fund/export',{headers:{'Authorization':'Bearer '+tok()}}).then(function(r){
    if(r.status===401)return alert('令牌无效，请重新登录');
    if(!r.ok)return alert('导出失败 ('+r.status+')');
    return r.blob().then(function(b){
      var a=document.createElement('a');
      a.href=URL.createObjectURL(b);a.download='class-fund.csv';
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(a.href)},2000);
    });
  }).catch(function(e){alert('导出失败：'+(e.message||''))});
}
/* 表单 -> 提交体。新增/编辑/AI 自动入账共用一份，字段名只有这里说了算 */
function fundPayload(){
  return {
    kind:document.getElementById('fKind').value,
    date:document.getElementById('fDate').value,
    amount:document.getElementById('fAmount').value.trim(),
    account:document.getElementById('fAccount').value.trim(),
    verified:document.getElementById('fVerified').checked,
    note:document.getElementById('fNote').value.trim(),
    evidence:fundState.evidenceKey||''
  };
}
/* 选了新图就先传上去，拿到 key 再记账。上传失败 = 这笔不记，别记一条没有凭证的账 */
function fundEvidenceUpload(){
  var inp=document.getElementById('fEvidence');
  var f=inp&&inp.files&&inp.files[0];
  if(!f)return Promise.resolve({ok:true});
  if(f.size>8*1024*1024)return Promise.resolve({ok:false,error:'截图超过 8MB'});
  var fd=new FormData();fd.append('file',f);
  return apiForm('/api/admin/fund/evidence',fd).then(function(j){
    if(!j.success)return {ok:false,error:j.error||'凭证上传失败'};
    return {ok:true,key:j.key,fresh:true};
  }).catch(function(e){return {ok:false,error:'凭证上传失败：'+((e&&e.message)||'')}});
}
/* 记账没成功 -> 刚传上去的图没人认领，顺手删掉，别在 KV 里留垃圾 */
function fundEvidenceDiscard(key){
  if(!key)return;
  api('/api/admin/fund/evidence/delete',{method:'POST',body:JSON.stringify({key:key})}).catch(function(){});
}
/* 保存成功后的收尾：清表单 + 清草稿 + 刷新列表和审计 */
function fundAfterSave(){fundFillForm(null);fundLoad(1);fundAuditLoad()}
/* 保存账目（新增或编辑）。返回 {ok,error,editing} 给调用方写提示 */
function fundSave(){
  var btn=document.getElementById('fundSaveBtn'),hint=document.getElementById('fundSaveHint');
  var editing=!!fundState.editId;
  btn.disabled=true;
  hint.textContent='保存中…';
  return fundEvidenceUpload().then(function(up){
    if(!up.ok){btn.disabled=false;hint.textContent='保存失败：'+up.error;return {ok:false,error:up.error,editing:editing}}
    var payload=fundPayload();
    if(up.key)payload.evidence=up.key;   /* 新图刚传完，用新 key 覆盖表单里那张 */
    if(editing)payload.id=fundState.editId;
    return api(editing?'/api/admin/fund/record/update':'/api/admin/fund/record',{method:'POST',body:JSON.stringify(payload)}).then(function(j){
      btn.disabled=false;
      var ok=!!j.success;
      if(ok)fundAfterSave();
      else if(up.fresh)fundEvidenceDiscard(up.key);
      hint.textContent=ok?(editing?'✓ 已保存修改':'✓ 已新增'):('保存失败：'+(j.error||''));
      return {ok:ok,error:j.error||'',editing:editing};
    });
  }).catch(function(e){
    btn.disabled=false;
    var msg=(e&&e.message)||'网络错误';
    hint.textContent='保存失败：'+msg;
    return {ok:false,error:msg,editing:editing};
  });
}
/* 把 AI 草稿填进表单：金额、日期、收/支都摆在明面上，人一眼能看出 AI 有没有听错 */
function fundFillDraft(d){
  d=d||{};
  fundState.editId=0;
  document.getElementById('fKind').value=d.kind==='income'?'income':'expense';
  document.getElementById('fDate').value=d.date||'';
  document.getElementById('fAmount').value=d.amount||'';
  document.getElementById('fAccount').value=d.account||'微信';
  document.getElementById('fNote').value=d.note||'';
  document.getElementById('fVerified').checked=false;
  document.getElementById('fundFormTitle').textContent='新增一笔账目（编辑时这里会变成「保存修改」）';
  document.getElementById('fundCancelBtn').style.display='none';
  document.getElementById('fundSaveHint').textContent='';
  fundDraftSave();
}
/* 一句话记账。勾了「识别后自动入账」就带 autoSave 一起发：识别和落库在服务端同一个
 * 请求里做完，所以请求发出去以后页面关掉、断网都不影响，账照样记上。
 * 识别不出来或入账失败就整条不记，草稿照样填进表单等人手动核对 */
document.getElementById('fundAiBtn').onclick=function(){
  var b=this,box=document.getElementById('fundAiHint');
  var text=document.getElementById('fundAiText').value.trim();
  if(!text){box.innerHTML='先写一句话，例如「昨天买扫把挂钩花了 6.7」';return}
  var auto=document.getElementById('fundAiAuto').checked;
  b.disabled=true;box.innerHTML=auto?'识别并入账中…':'识别中…';
  api('/api/admin/fund/parse',{method:'POST',body:JSON.stringify({text:text,autoSave:auto})}).then(function(j){
    b.disabled=false;
    var d=j.draft||null;
    if(!d){box.innerHTML='<span class="dim">'+esc(j.error||'没识别出来')+'</span>';return}
    fundFillDraft(d);
    var sum='<b>'+(d.kind==='income'?'收入':'支出')+' ¥'+esc(d.amount)+' '+esc(d.date)+'</b>'
      +(d.dateGuessed?'（原话里没看出日期，按今天算）':'')+' · '+esc(d.note||'无备注');
    if(!j.success){
      box.innerHTML='已填成：'+sum+' · <b class="err">未入账</b>：'+esc(j.error||'')+'（可手动保存）';
      return;
    }
    if(j.saved){
      fundAfterSave();
      document.getElementById('fundAiText').value='';
      box.innerHTML='<b class="ok">已入账</b>：'+sum+'（待核对）';
      return;
    }
    box.innerHTML='已填成：'+sum+'（核对后点保存）';
  }).catch(function(e){b.disabled=false;box.innerHTML='<span class="dim">'+esc('识别失败：'+(e.message||''))+'</span>'});
};
document.getElementById('fundAiText').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('fundAiBtn').click()});
/* 自动入账开关：存在本机，下次打开还是上次的选择。开启时确认一次，
 * 免得手滑勾上以后每说一句话就直接进账本 */
(function(){
  var box=document.getElementById('fundAiAuto'),KEY='jpc_fund_ai_auto';
  try{box.checked=localStorage.getItem(KEY)==='1'}catch(e){}
  box.addEventListener('change',function(){
    if(box.checked&&!confirm('开启后识别成功就直接记账（记为待核对，可改可删）。确定？')){
      box.checked=false;return;
    }
    try{localStorage.setItem(KEY,box.checked?'1':'0')}catch(e){}
    document.getElementById('fundAiHint').innerHTML=box.checked
      ?'<span class="ok">已开启</span>：识别成功即记账。'
      :'已关闭：识别后只填表。';
  });
})();
/* 输入就存草稿：关页面/刷新回来内容还在（只存本机） */
['fundAiText','fKind','fDate','fAmount','fAccount','fNote'].forEach(function(id){
  var el=document.getElementById(id);
  if(!el)return;
  el.addEventListener('input',fundDraftSave);
  el.addEventListener('change',fundDraftSave);
});
fundDraftRestore();
document.getElementById('fundSaveBtn').onclick=function(){fundSave()};
document.getElementById('fundCancelBtn').onclick=function(){fundFillForm(null)};
document.getElementById('fundInitBtn').onclick=function(){
  if(!confirm('导入《高一（7）班班费收支明细表》初始数据？已经导入过就不会重复插。'))return;
  api('/api/admin/fund/init',{method:'POST'}).then(function(j){
    alert(j.success?(j.seeded?('已导入 '+j.inserted+' 笔初始账目'):('未重复导入：'+(j.reason||''))):('失败：'+(j.error||'')));
    fundLoad(1);fundAuditLoad();
  }).catch(function(e){alert('失败：'+(e.message||''))});
};
document.getElementById('fundExportBtn').onclick=fundExport;
document.getElementById('fundQueryBtn').onclick=function(){fundLoad(1)};
document.getElementById('fltQ').addEventListener('keydown',function(e){if(e.key==='Enter')fundLoad(1)});
document.getElementById('fundPrevBtn').onclick=function(){if(fundState.page>1)fundLoad(fundState.page-1)};
document.getElementById('fundNextBtn').onclick=function(){fundLoad(fundState.page+1)};
`;
}

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理后台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f4f4f7;color:#222;padding:22px}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px}
.sub{font-size:12px;color:#888;margin-bottom:18px}
.card{background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.07);padding:16px 18px;margin-bottom:16px}
.card h2{font-size:14px;margin-bottom:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
input[type=text],input[type=password],input[type=number],textarea{font:inherit;font-size:13px;padding:7px 10px;border:1px solid #ddd;border-radius:8px;outline:none}
input:focus,textarea:focus{border-color:#0071e3}
input[type=text]{flex:1;min-width:160px}
input[type=password]{flex:1;min-width:200px}
textarea{width:100%;min-height:56px;resize:vertical}
button{font:inherit;font-size:13px;font-weight:600;padding:7px 14px;border:none;border-radius:8px;cursor:pointer;background:#e9e9ef;color:#333;transition:.15s}
button:hover{filter:brightness(.96)}
button.pri{background:#0071e3;color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;outline:none}
.hint{font-size:12px;color:#999}
.quota{font-size:12px;color:#666}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;margin:2px 3px 2px 0;background:#eef;color:#335;font-weight:600}
.badge.warn{background:#fff1e0;color:#c26a0a}
.badge.clean{background:#e8f5e9;color:#2e7d32}
.item{padding:9px 4px;border-bottom:1px solid #f0f0f2;font-size:13px}
.item:last-child{border-bottom:none}
.item .t{font-weight:600}
.item .m{font-size:12px;color:#888;margin-top:2px}
.del{background:none;color:#d33;font-size:12px;padding:2px 6px}
.res{margin-top:10px}
#sugWrap{position:relative}
#sug{position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:50;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);display:none;max-height:260px;overflow:auto}
#sug .si{display:block;width:100%;text-align:left;font-size:12px;padding:8px 12px;border:none;background:none;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sug .si:hover{background:#f0f4ff}
.ok{color:#2e7d32}
.err{color:#d33}
.dim{color:#999}
/* 锁定态管理模块：小条堆叠 + 内容模糊；解锁后 max-height 线性展开 */
.acard{background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.07);margin-bottom:16px;overflow:hidden;max-height:54px;transition:max-height .65s cubic-bezier(.22,.7,.35,1)}
.acard.open{max-height:20000px}
.acard .abrief{display:flex;align-items:center;gap:10px;padding:14px 18px;font-weight:700;font-size:14px;user-select:none}
.acard .abrief .alock{margin-left:auto;font-size:11px;color:#999;background:#f1f1f5;border:1px solid #e5e5ea;border-radius:999px;padding:2px 10px}
.acard .abody{padding:0 18px 16px;filter:blur(7px);opacity:.45;pointer-events:none;user-select:none;transition:filter .5s ease .2s,opacity .5s ease .2s}
.acard.open .abody{filter:none;opacity:1;pointer-events:auto}
</style>
</head>
<body>
<div class="wrap">
  <h1>🗞 管理后台</h1>
  <div class="sub">新闻标注 · AI 随机抽检 · 搜索推荐 · 毕业留言墙</div>

  <div class="card">
    <div class="row">
      <input type="password" id="tok" placeholder="管理员令牌 (ADMIN_TOKEN)" value="">
      <button id="loginBtn" class="pri">解锁</button>
    </div>
    <div class="hint" id="loginHint">输入管理员令牌解锁下方模块</div>
  </div>

  <div class="acard" id="card-review">
    <div class="abrief"><span>🤖</span> AI 随机抽检（外媒/评论源）<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
      <div class="row" style="padding-top:4px">
        <span class="quota" id="quotaTxt">今日额度 --/--</span>
        <input type="number" id="rcnt" value="5" min="1" max="30" style="width:70px" title="本次抽检条数">
        <button id="runBtn" class="pri">▶ 开始抽检</button>
      </div>
      <div class="res" id="reviewRes"></div>
    </div>
  </div>

  <div class="acard" id="card-annotate">
    <div class="abrief"><span>✍️</span> 手动标注<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
      <div id="sugWrap" style="padding-top:12px">
        <input type="text" id="ssearch" placeholder="搜索新闻选择要标注的条目…" autocomplete="off">
        <div id="sug"></div>
      </div>
      <div class="row" id="flagBox" style="margin-top:10px"></div>
      <textarea id="noteBox" placeholder="备注（可选）"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="saveBtn" class="pri">保存标注</button>
        <span class="hint" id="selInfo">未选择新闻</span>
      </div>
    </div>
  </div>

  <div class="acard" id="card-list">
    <div class="abrief"><span>📋</span> 已标注列表<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
      <div class="row" style="padding-top:4px">
        <select id="flagDays" title="时间范围">
          <option value="1">今天</option>
          <option value="7" selected>近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
          <option value="0">全部时间</option>
        </select>
        <label class="hint" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="flagOnly" style="accent-color:#0071e3">只看有问题的
        </label>
        <span style="flex:1"></span>
        <span class="hint" id="flagSum"></span>
      </div>
      <div id="flagList"><div class="hint">解锁后加载…</div></div>
      <div class="row" id="flagMoreRow" style="display:none;justify-content:center">
        <button id="flagMoreBtn" type="button">加载更早的</button>
      </div>
    </div>
  </div>

  <div class="acard" id="card-wall-msg">
    <div class="abrief"><span>🎓</span> 毕业留言墙 · 留言管理<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
      <div class="row" style="padding-top:4px">
        <input type="text" id="wq" placeholder="搜索留言内容 / 署名 / 写给谁…">
        <input type="text" id="wcls" placeholder="班级（留空=全部）" style="max-width:170px">
        <select id="wst" title="状态">
          <option value="visible">正常</option>
          <option value="hidden">已隐藏</option>
          <option value="deleted">已删除</option>
          <option value="all">全部</option>
        </select>
        <button class="pri" id="wsearchBtn">查询</button>
        <button id="winitBtn" title="首次上线时建表 + 写入默认配置">初始化表</button>
      </div>
      <div class="res" id="wlist"><div class="hint">解锁后加载…</div></div>
      <div class="row">
        <button id="wprev">← 上一页</button>
        <button id="wnext">下一页 →</button>
        <span class="hint" id="wpage"></span>
      </div>
    </div>
  </div>

  <div class="acard" id="card-wall-report">
    <div class="abrief"><span>🚩</span> 毕业留言墙 · 举报管理<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
      <div class="row" style="padding-top:4px">
        <select id="rst" title="处理状态">
          <option value="pending">待处理</option>
          <option value="resolved">已处理</option>
          <option value="dismissed">已忽略</option>
          <option value="all">全部</option>
        </select>
        <button class="pri" id="rsearchBtn">查询</button>
        <span class="hint" id="rpage"></span>
      </div>
      <div class="res" id="rlist"><div class="hint">解锁后加载…</div></div>
    </div>
  </div>

  <div class="acard" id="card-wall-config">
    <div class="abrief"><span>⚙️</span> 毕业留言墙 · 配置<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
      <div class="row" style="padding-top:4px">
        <input type="text" id="cTitle" placeholder="留言墙名称">
        <input type="text" id="cYear" placeholder="毕业年份" style="max-width:120px">
      </div>
      <div class="row">
        <input type="text" id="cSlogan" placeholder="首页一句话">
      </div>
      <div class="row">
        <input type="text" id="cClosed" placeholder="关闭时的提示语">
      </div>
      <div class="row">
        <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="cOpen" style="accent-color:#0071e3">开放留言（取消勾选即关闭投递）
        </label>
      </div>
      <div class="row" style="display:block">
        <div class="hint" style="margin-bottom:6px">班级选项（每行一个，留言时供选择，也用于筛选）</div>
        <textarea id="cClasses" style="min-height:110px"></textarea>
      </div>
      <div class="row">
        <button class="pri" id="cfgSaveBtn">保存配置</button>
        <span class="hint" id="cfgHint"></span>
      </div>
    </div>
  </div>

  <div class="acard" id="card-fund">
    <div class="abrief"><span>💰</span> 班费收支 · 账目管理<span class="alock">🔒 待解锁</span></div>
    <div class="abody">
${fundAdminPanel()}
    </div>
  </div>
</div>
<script>
var FLAGS=[['political','疑似夹带第三国政治立场'],['biased','探究方向不客观'],['subjective','个人主观判断'],['clickbait','标题党·夸大'],['unverified','事实存疑'],['ad','软广·推广']];
var sel=null;
function tok(){return localStorage.getItem('jpc_admin_token')||''}
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function api(path,opt){
  var o=opt||{};o.headers=o.headers||{};
  o.headers['Authorization']='Bearer '+tok();
  if(o.body)o.headers['Content-Type']='application/json';
  return fetch(path,o).then(function(r){
    if(r.status===401){document.getElementById('loginHint').innerHTML='<span class="err">令牌无效，请重新登录</span>';throw new Error('401')}
    return r.json();
  });
}
/* 解锁：先服务端验证令牌，通过后三个模块卡依次线性展开 */
function login(){
  var t=document.getElementById('tok').value.trim();if(!t)return;
  var box=document.getElementById('loginHint');box.innerHTML='<span class="dim">验证中…</span>';
  fetch('/api/admin/verify',{method:'POST',headers:{'Authorization':'Bearer '+t}}).then(function(r){
    if(r.status===401){box.innerHTML='<span class="err">令牌无效，请检查 ADMIN_TOKEN</span>';return}
    if(!r.ok){box.innerHTML='<span class="err">服务异常 ('+r.status+')</span>';return}
    localStorage.setItem('jpc_admin_token',t);
    box.innerHTML='<span class="ok">✓ 已解锁</span>';
    unlockAll();
  }).catch(function(){box.innerHTML='<span class="err">网络错误</span>'});
}
function unlockAll(){
  var ids=['card-review','card-annotate','card-list','card-wall-msg','card-wall-report','card-wall-config','card-fund'];
  ids.forEach(function(id,i){
    setTimeout(function(){
      var el=document.getElementById(id);if(!el)return;
      el.classList.add('open');
      el.querySelectorAll('.alock').forEach(function(s){s.textContent='🔓 已解锁'});
    },i*240);
  });
  loadQuota();loadList();
  wallLoad(1);wallReportLoad();wallCfgLoad();
  fundLoad(1);fundAuditLoad();
}
document.getElementById('loginBtn').onclick=login;
document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')login()});
var stored=tok();if(stored){
  document.getElementById('tok').value=stored;
  /* 已存令牌：静默验证，有效则直接解锁；失效则清掉 */
  fetch('/api/admin/verify',{method:'POST',headers:{'Authorization':'Bearer '+stored}}).then(function(r){
    if(r.status===401){localStorage.removeItem('jpc_admin_token');document.getElementById('loginHint').innerHTML='<span class="err">令牌已失效，请重新输入</span>'}
    else if(r.ok){document.getElementById('loginHint').innerHTML='<span class="ok">✓ 已解锁</span>';unlockAll()}
  }).catch(function(){});
}

function loadQuota(){
  api('/api/admin/review/quota').then(function(j){
    if(j.success)document.getElementById('quotaTxt').textContent='今日额度 '+j.used+'/'+j.quota;
  }).catch(function(){});
}
/* 已标注列表：默认最近 7 天，一次 50 条，想看更早的点「加载更早的」往后接。
 * 不把立项至今全倒出来 —— 那是几千条，翻不到头也看不出最近出了什么事 */
var flagState={offset:0,limit:50,total:0,loading:false};
function flagDays(){return document.getElementById('flagDays').value}
function flagOnly(){return document.getElementById('flagOnly').checked?'flagged':'all'}
function flagItemHtml(it){
  var badges=(it.flags||[]).map(function(f){return '<span class="badge warn">'+esc(f)+'</span>'}).join('')||'<span class="badge clean">✓ 无问题</span>';
  var who=it.method==='ai'?'AI 抽检':'手动标注';
  return '<span class="t">'+esc(it.title)+'</span> <span class="badge">'+esc(it.source||'')+'</span> '+badges+
    '<div class="m">'+who+' · '+(it.note?esc(it.note):'')+' · '+new Date(it.reviewed_at).toLocaleString('zh-CN')+
    ' <button class="del" data-link="'+esc(it.link)+'">删除</button></div>';
}
function loadList(append){
  if(flagState.loading)return;
  var box=document.getElementById('flagList');
  if(!append){flagState.offset=0;box.innerHTML='<div class="hint">读取中…</div>'}
  flagState.loading=true;
  api('/api/admin/flags?days='+flagDays()+'&only='+flagOnly()+'&limit='+flagState.limit+'&offset='+flagState.offset).then(function(j){
    flagState.loading=false;
    if(!j.success){box.innerHTML='<div class="hint">读取失败：'+esc(j.error||'')+'</div>';return}
    var items=j.data||[],c=j.counts||{};
    flagState.total=j.total||0;
    document.getElementById('flagSum').textContent=(j.days?('近 '+j.days+' 天'):'全部时间')+
      '：共 '+c.total+' 条标注，其中 '+c.flagged+' 条有问题';
    if(!append)box.innerHTML='';
    if(!items.length&&!append){
      box.innerHTML='<div class="hint">这个时间段还没有标注。</div>';
    }else{
      var frag=document.createElement('div');
      items.forEach(function(it){
        var d=document.createElement('div');d.className='item';d.innerHTML=flagItemHtml(it);
        frag.appendChild(d);
      });
      while(frag.firstChild)box.appendChild(frag.firstChild);
    }
    flagState.offset+=items.length;
    document.getElementById('flagMoreRow').style.display=j.hasMore?'':'none';
  }).catch(function(e){flagState.loading=false;box.innerHTML='<div class="hint">读取失败：'+esc(e.message||'')+'</div>'});
}
document.getElementById('flagDays').onchange=function(){loadList(false)};
document.getElementById('flagOnly').onchange=function(){loadList(false)};
document.getElementById('flagMoreBtn').onclick=function(){loadList(true)};
document.getElementById('flagList').addEventListener('click',function(e){
  var b=e.target.closest('.del');if(!b)return;
  if(!confirm('删除该标注？'))return;
  api('/api/admin/flags',{method:'DELETE',body:JSON.stringify({link:b.getAttribute('data-link')})}).then(function(j){
    if(j.success)loadList();
  }).catch(function(){});
});

/* AI 抽检 */
document.getElementById('runBtn').onclick=function(){
  var btn=this;btn.disabled=true;btn.textContent='⏳ 抽检中…';
  var box=document.getElementById('reviewRes');box.innerHTML='<div class="hint">抽检中，最多需 1 分钟…</div>';
  api('/api/admin/review',{method:'POST',body:JSON.stringify({count:parseInt(document.getElementById('rcnt').value,10)||5})}).then(function(j){
    if(!j.success){box.innerHTML='<span class="err">'+esc(j.error||'抽检失败')+'</span>';return}
    if(j.reason){box.innerHTML='<div class="hint">'+esc(j.reason)+'</div>';return}
    var h='<div class="quota">本次审查 '+j.reviewed.length+' 条，跳过 '+(j.skipped||0)+'，失败 '+(j.failed?j.failed.length:0)+'；今日额度 '+j.quota.used+'/'+j.quota.quota+'</div>';
    (j.reviewed||[]).forEach(function(r){
      var f=(r.flags||[]).length?r.flags.map(function(x){return '<span class="badge warn">'+esc(x)+'</span>'}).join(''):'<span class="badge clean">✓ 无问题</span>';
      h+='<div class="item"><span class="t">'+esc(r.title)+'</span> <span class="badge">'+esc(r.source)+'</span> '+f+
         '<div class="m">'+(r.note?esc(r.note):'')+'</div></div>';
    });
    box.innerHTML=h;
    loadQuota();loadList();
  }).catch(function(e){box.innerHTML='<span class="err">'+esc(e.message)+'</span>'}).finally(function(){btn.disabled=false;btn.textContent='▶ 开始抽检'});
};

/* 手动标注：搜索选新闻 + 勾旗 + 保存 */
var sugBox=document.getElementById('sug'),ssearch=document.getElementById('ssearch');
function hideSug(){sugBox.style.display='none';sugBox.innerHTML=''}
ssearch.addEventListener('input',function(){
  var q=ssearch.value.trim();if(!q){hideSug();return}
  clearTimeout(ssearch._t);
  ssearch._t=setTimeout(function(){
    fetch('/api/news/suggest?q='+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(j){
      if(!j.success||!j.data||!j.data.length){hideSug();return}
      sugBox.innerHTML='';
      j.data.forEach(function(it){
        var b=document.createElement('button');b.type='button';b.className='si';
        b.textContent=it.source+' · '+it.title;b.dataset.link=it.link;b.dataset.title=it.title;b.dataset.source=it.source;
        b.onclick=function(){sel={link:b.dataset.link,title:b.dataset.title,source:b.dataset.source};ssearch.value=b.textContent;hideSug();renderFlagBox()};
        sugBox.appendChild(b);
      });
      sugBox.style.display='block';
    }).catch(function(){});
  },250);
});
document.addEventListener('click',function(e){if(!e.target.closest('#sugWrap'))hideSug()});
function renderFlagBox(){
  var box=document.getElementById('flagBox');box.innerHTML='';
  FLAGS.forEach(function(f){
    var l=document.createElement('label');
    l.style.cssText='font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-right:10px;cursor:pointer';
    var c=document.createElement('input');c.type='checkbox';c.value=f[0];c.style.cssText='accent-color:#0071e3';
    l.appendChild(c);l.appendChild(document.createTextNode(f[1]));box.appendChild(l);
  });
  document.getElementById('selInfo').textContent='已选：'+sel.title;
}
document.getElementById('saveBtn').onclick=function(){
  if(!sel){alert('先搜索选择一条新闻');return}
  var flags=[];document.querySelectorAll('#flagBox input:checked').forEach(function(c){flags.push(c.value)});
  api('/api/admin/flags',{method:'POST',body:JSON.stringify({link:sel.link,title:sel.title,source:sel.source,flags:flags,note:document.getElementById('noteBox').value.trim()})}).then(function(j){
    if(j.success){document.getElementById('noteBox').value='';alert('✓ 已保存标注');loadList()}
    else alert('保存失败：'+j.error);
  }).catch(function(){});
};

/* ===== 毕业留言墙：后台模块（留言管理 / 举报管理 / 配置）===== */
var WALL_PAGE=1,WALL_LIMIT=20,WALL_TOTAL=0;
function wallQ(){
  return {
    q:document.getElementById('wq').value.trim(),
    cls:document.getElementById('wcls').value.trim(),
    st:document.getElementById('wst').value
  };
}
function wallBtn(label,act,id,pri){
  return '<button class="'+(pri?'pri':'')+'" data-act="'+act+'" data-id="'+id+'">'+label+'</button>';
}
function wallLoad(page){
  WALL_PAGE=page||1;
  var f=wallQ();
  var url='/api/admin/wall/messages?page='+WALL_PAGE+'&limit='+WALL_LIMIT+
    '&status='+encodeURIComponent(f.st)+'&q='+encodeURIComponent(f.q)+'&class='+encodeURIComponent(f.cls);
  var box=document.getElementById('wlist');
  box.innerHTML='<div class="hint">加载中…</div>';
  api(url).then(function(j){
    if(!j.success){box.innerHTML='<span class="err">'+esc(j.error||'加载失败')+'</span>';return}
    WALL_TOTAL=j.total;
    document.getElementById('wpage').textContent='共 '+j.total+' 条 · 第 '+j.page+' 页';
    if(!j.items.length){box.innerHTML='<div class="hint">没有符合条件的留言</div>';return}
    box.innerHTML='';
    j.items.forEach(function(it){
      var stTag=it.status==='visible'?'<span class="badge clean">正常</span>'
        :(it.status==='hidden'?'<span class="badge warn">已隐藏</span>'
        :'<span class="badge" style="background:#fdecec;color:#a33">已删除</span>');
      var rp=it.reportCount?'<span class="badge warn">被举报 '+it.reportCount+'</span>':'';
      var who=it.anonymous?'匿名同学':(it.signature||'一位同学');
      var acts='';
      if(it.status!=='visible')acts+=wallBtn('恢复','restore',it.id);
      if(it.status==='visible')acts+=wallBtn('隐藏','hide',it.id);
      if(it.status!=='deleted')acts+=wallBtn('删除','delete',it.id);
      acts+=wallBtn('彻底删除','purge',it.id);
      var d=document.createElement('div');
      d.className='item';
      d.innerHTML='<div class="t">'+esc(it.body)+'</div>'+
        '<div class="m">'+stTag+rp+'<span class="badge">'+esc(it.classLabel||'未填班级')+'</span> '+
        esc(who)+(it.target?' → 写给 '+esc(it.target):'')+' · '+new Date(it.createdAt).toLocaleString('zh-CN')+
        ' · IP '+esc(it.ip||'-')+'</div>'+
        '<div class="row" style="margin:6px 0 0">'+acts+'</div>';
      box.appendChild(d);
    });
  }).catch(function(e){box.innerHTML='<span class="err">'+esc(e.message||'加载失败')+'</span>'});
}
document.getElementById('wlist').addEventListener('click',function(e){
  var b=e.target.closest('button[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=parseInt(b.getAttribute('data-id'),10);
  var label={hide:'隐藏',restore:'恢复',delete:'删除',purge:'彻底删除'}[act]||act;
  if(act==='purge'&&!confirm('彻底删除这条留言？举报记录也会一并删掉，无法恢复。'))return;
  if(act==='delete'&&!confirm('删除这条留言？（前台不再显示，可恢复）'))return;
  b.disabled=true;
  api('/api/admin/wall/message',{method:'POST',body:JSON.stringify({id:id,action:act})}).then(function(j){
    b.disabled=false;
    if(!j.success)return alert('操作失败：'+(j.error||''));
    wallLoad(WALL_PAGE);
  }).catch(function(e){b.disabled=false;alert('操作失败：'+(e.message||''))});
});
document.getElementById('wsearchBtn').onclick=function(){wallLoad(1)};
document.getElementById('wq').addEventListener('keydown',function(e){if(e.key==='Enter')wallLoad(1)});
document.getElementById('wcls').addEventListener('keydown',function(e){if(e.key==='Enter')wallLoad(1)});
document.getElementById('wst').addEventListener('change',function(){wallLoad(1)});
document.getElementById('wprev').onclick=function(){if(WALL_PAGE>1)wallLoad(WALL_PAGE-1)};
document.getElementById('wnext').onclick=function(){
  if(WALL_PAGE*WALL_LIMIT<WALL_TOTAL)wallLoad(WALL_PAGE+1);
};
document.getElementById('winitBtn').onclick=function(){
  var b=this;b.disabled=true;
  api('/api/admin/wall/init',{method:'POST'}).then(function(j){
    b.disabled=false;
    alert(j.success?'✓ 表结构与默认配置已就绪':'初始化失败：'+(j.error||''));
    if(j.success){wallLoad(1);wallReportLoad();wallCfgLoad()}
  }).catch(function(e){b.disabled=false;alert('初始化失败：'+(e.message||''))});
};

/* ---- 举报管理 ---- */
function wallReportLoad(){
  var st=document.getElementById('rst').value;
  var box=document.getElementById('rlist');
  box.innerHTML='<div class="hint">加载中…</div>';
  api('/api/admin/wall/reports?status='+encodeURIComponent(st)+'&limit=30').then(function(j){
    if(!j.success){box.innerHTML='<span class="err">'+esc(j.error||'加载失败')+'</span>';return}
    document.getElementById('rpage').textContent='共 '+j.total+' 条';
    if(!j.items.length){box.innerHTML='<div class="hint">没有举报记录</div>';return}
    box.innerHTML='';
    j.items.forEach(function(it){
      var stTag=it.status==='pending'?'<span class="badge warn">待处理</span>'
        :(it.status==='resolved'?'<span class="badge clean">已处理</span>':'<span class="badge">已忽略</span>');
      var msgTag=it.msgStatus==='visible'?'<span class="badge clean">留言在墙上</span>'
        :(it.msgStatus==='hidden'?'<span class="badge warn">留言已隐藏</span>'
        :(it.msgStatus==='deleted'?'<span class="badge" style="background:#fdecec;color:#a33">留言已删除</span>'
        :'<span class="badge">留言已不存在</span>'));
      var acts='<button data-ract="resolve" data-id="'+it.id+'" data-mid="'+it.messageId+'" class="pri">处理并隐藏留言</button>'+
        '<button data-ract="resolve" data-id="'+it.id+'" data-mid="'+it.messageId+'" data-nohide="1">仅标记已处理</button>'+
        '<button data-ract="dismiss" data-id="'+it.id+'">忽略</button>'+
        '<button data-ract="pending" data-id="'+it.id+'">重新待处理</button>';
      var d=document.createElement('div');
      d.className='item';
      d.innerHTML='<div class="t">['+esc(it.reason)+'] '+esc(it.body==null?'（留言已不存在）':it.body)+'</div>'+
        '<div class="m">'+stTag+msgTag+'<span class="badge">'+esc(it.classLabel||'未填班级')+'</span> '+
        esc(it.anonymous?'匿名同学':(it.signature||'一位同学'))+' · 举报于 '+new Date(it.createdAt).toLocaleString('zh-CN')+
        ' · IP '+esc(it.ip||'-')+(it.detail?' · 说明：'+esc(it.detail):'')+'</div>'+
        '<div class="row" style="margin:6px 0 0">'+acts+'</div>';
      box.appendChild(d);
    });
  }).catch(function(e){box.innerHTML='<span class="err">'+esc(e.message||'加载失败')+'</span>'});
}
document.getElementById('rlist').addEventListener('click',function(e){
  var b=e.target.closest('button[data-ract]');if(!b)return;
  var act=b.getAttribute('data-ract');
  var body={id:parseInt(b.getAttribute('data-id'),10),action:act};
  if(act==='resolve'&&!b.getAttribute('data-nohide')){
    body.hideMessage=true;body.messageId=parseInt(b.getAttribute('data-mid'),10);
  }
  b.disabled=true;
  api('/api/admin/wall/report',{method:'POST',body:JSON.stringify(body)}).then(function(j){
    b.disabled=false;
    if(!j.success)return alert('操作失败：'+(j.error||''));
    wallReportLoad();wallLoad(WALL_PAGE);
  }).catch(function(e){b.disabled=false;alert('操作失败：'+(e.message||''))});
});
document.getElementById('rsearchBtn').onclick=wallReportLoad;
document.getElementById('rst').addEventListener('change',wallReportLoad);

/* ---- 留言墙配置 ---- */
function wallCfgLoad(){
  api('/api/admin/wall/config').then(function(j){
    if(!j.success)return;
    document.getElementById('cTitle').value=j.title||'';
    document.getElementById('cYear').value=j.year||'';
    document.getElementById('cSlogan').value=j.slogan||'';
    document.getElementById('cClosed').value=j.closedNote||'';
    document.getElementById('cOpen').checked=!!j.open;
    document.getElementById('cClasses').value=(j.classes||[]).join('\\n');
    document.getElementById('cfgHint').textContent='当前共 '+j.total+' 张纸条';
  }).catch(function(){});
}
document.getElementById('cfgSaveBtn').onclick=function(){
  var b=this;b.disabled=true;
  var classes=document.getElementById('cClasses').value.split('\\n').map(function(s){return s.trim()}).filter(function(s){return s});
  api('/api/admin/wall/config',{method:'POST',body:JSON.stringify({
    title:document.getElementById('cTitle').value.trim(),
    year:document.getElementById('cYear').value.trim(),
    slogan:document.getElementById('cSlogan').value.trim(),
    closedNote:document.getElementById('cClosed').value.trim(),
    open:document.getElementById('cOpen').checked,
    classes:classes
  })}).then(function(j){
    b.disabled=false;
    document.getElementById('cfgHint').textContent=j.success?'✓ 已保存':'保存失败：'+(j.error||'');
    if(j.success)wallCfgLoad();
  }).catch(function(e){b.disabled=false;document.getElementById('cfgHint').textContent='保存失败：'+(e.message||'')});
};

${fundAdminJS()}

loadQuota();loadList();
</script>
</body>
</html>`;
}


function get404HTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>404 - 页面未找到</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow:hidden;position:relative}
.container{text-align:center;z-index:1;max-width:600px;background:rgba(255,255,255,.95);border-radius:20px;padding:60px 40px;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:slideUp .6s}
@keyframes slideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
.error-code{font-size:120px;font-weight:900;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:20px;line-height:1}
.error-title{font-size:32px;font-weight:700;color:#323130;margin-bottom:16px}
.error-message{font-size:16px;color:#605e5c;line-height:1.6;margin-bottom:40px}
.btn-group{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.btn{padding:12px 32px;font-size:16px;font-weight:600;border:none;border-radius:8px;cursor:pointer;text-decoration:none;transition:.3s;display:inline-block}
.btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;box-shadow:0 4px 15px rgba(102,126,234,.4)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(102,126,234,.6)}
.btn-secondary{background:#fff;color:#667eea;border:2px solid #667eea}
.btn-secondary:hover{background:#667eea;color:#fff}
.icon{font-size:80px;margin-bottom:20px;animation:bounce 2s infinite}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
@media (max-width:640px){.container{padding:40px 24px}.error-code{font-size:80px}.error-title{font-size:24px}.btn-group{flex-direction:column}.btn{width:100%}}
</style>
</head>
<body>
<div class="container">
  <div class="icon">🔍</div>
  <div class="error-code">404</div>
  <h1 class="error-title">页面未找到</h1>
  <p class="error-message">抱歉，您访问的页面不存在或已被移除。</p>
  <div class="btn-group">
    <a href="/" class="btn btn-primary">🏠 返回首页</a>
    <a href="/news.html" class="btn btn-secondary">📰 查看新闻</a>
  </div>
</div>
</body>
</html>`;
}

function getCountdownHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>倒计时 - 清流中学非官方站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f3f2f1;min-height:100vh;padding:20px}
.container{max-width:1200px;margin:0 auto}
.header{text-align:center;margin-bottom:40px;padding-top:20px}
.header h1{font-size:42px;font-weight:600;color:#201f1e;margin-bottom:8px}
.header p{font-size:16px;color:#605e5c}
.back-link{display:inline-block;margin-bottom:20px;color:#0078d4;text-decoration:none;font-size:14px;font-weight:600}
.countdown-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:24px;margin-bottom:40px}
.countdown-card{background:#fff;border-radius:8px;padding:32px;box-shadow:0 1.6px 3.6px rgba(0,0,0,.132);transition:.2s;position:relative;border:1px solid #edebe9}
.countdown-card:hover{box-shadow:0 6.4px 14.4px rgba(0,0,0,.132);transform:translateY(-2px)}
.countdown-title{font-size:24px;font-weight:600;color:#323130;margin-bottom:24px;text-align:center}
.flip-clock{display:flex;justify-content:center;gap:20px;margin:24px 0}
.flip-unit{display:flex;flex-direction:column;align-items:center;gap:8px}
.flip-label{font-size:11px;color:#605e5c;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.flip-card-container{display:flex;gap:3px}
.flip-card{position:relative;width:48px;height:64px;perspective:200px}
.flip-card-top,.flip-card-top-flip{position:absolute;width:100%;height:50%;top:0;left:0;background:#0078d4;border-radius:4px 4px 0 0;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.14)}
.flip-card-top::after,.flip-card-top-flip::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:rgba(0,0,0,.2)}
.flip-card-bottom,.flip-card-bottom-flip{position:absolute;width:100%;height:50%;bottom:0;left:0;background:#0078d4;border-radius:0 0 4px 4px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.14)}
.flip-card-top-flip{transform-origin:bottom;transform:rotateX(0);z-index:2}
.flip-card-bottom-flip{transform-origin:top;transform:rotateX(0);z-index:1}
.flip-card.flipping .flip-card-top-flip{animation:flipTop .6s cubic-bezier(.4,0,.2,1) forwards}
.flip-card.flipping .flip-card-bottom-flip{animation:flipBottom .6s cubic-bezier(.4,0,.2,1) forwards}
@keyframes flipTop{0%{transform:rotateX(0)}100%{transform:rotateX(-90deg)}}
@keyframes flipBottom{0%{transform:rotateX(90deg)}100%{transform:rotateX(0)}}
.flip-number{position:absolute;width:100%;height:200%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:600;color:#fff}
.flip-card-top .flip-number,.flip-card-top-flip .flip-number{top:0}
.flip-card-bottom .flip-number,.flip-card-bottom-flip .flip-number{bottom:0}
.countdown-complete{text-align:center;padding:48px 24px;background:#f3f2f1;border-radius:8px;border:2px solid #107c10}
.countdown-complete h3{font-size:28px;font-weight:600;color:#107c10;margin-bottom:8px}
.delete-btn{position:absolute;top:12px;right:12px;background:#f3f2f1;color:#605e5c;border:none;width:32px;height:32px;border-radius:4px;cursor:pointer;font-size:16px;opacity:0;z-index:10;transition:.1s}
.delete-btn:hover{background:#e1dfdd;color:#a4262c}
.countdown-card:hover .delete-btn{opacity:1}
.admin-section{text-align:center;margin-top:40px}
.admin-btn{background:#0078d4;color:#fff;border:none;padding:12px 32px;border-radius:4px;font-size:15px;font-weight:600;cursor:pointer}
.admin-btn:hover{background:#106ebe}
.admin-panel{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;justify-content:center;align-items:center;z-index:1000}
.admin-panel.active{display:flex}
.admin-content{background:#fff;border-radius:8px;padding:32px;width:90%;max-width:500px;position:relative}
.close-btn{position:absolute;top:12px;right:12px;background:none;border:none;font-size:20px;color:#605e5c;cursor:pointer;width:32px;height:32px;border-radius:4px}
.form-group{margin-bottom:20px}
.form-label{display:block;font-size:14px;font-weight:600;color:#323130;margin-bottom:8px}
.form-input{width:100%;padding:8px 12px;font-size:14px;border:1px solid #8a8886;border-radius:2px}
.form-input:focus{outline:none;border-color:#0078d4;box-shadow:0 0 0 1px #0078d4}
.submit-btn{width:100%;background:#0078d4;color:#fff;border:none;padding:10px;border-radius:2px;font-size:15px;font-weight:600;cursor:pointer}
.empty-state{text-align:center;padding:80px 40px;background:#fff;border-radius:8px;border:2px dashed #d2d0ce}
.empty-state-icon{font-size:64px;margin-bottom:16px;opacity:.6}
.message{padding:12px 16px;border-radius:4px;margin-bottom:20px;font-size:14px;display:none;border-left:4px solid}
.message.success{background:#dff6dd;border-color:#107c10;color:#0b5a08}
.message.error{background:#fde7e9;border-color:#a80000;color:#a80000}
.message.show{display:block}
@media (max-width:768px){.header h1{font-size:32px}.countdown-grid{grid-template-columns:1fr;gap:16px}.countdown-card{padding:24px}.flip-card{width:40px;height:56px}.flip-number{font-size:30px}}
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 返回首页</a>
  <div class="header"><h1>⏰ 倒计时</h1><p>重要时刻，倒数计时</p></div>
  <div id="countdownGrid" class="countdown-grid"></div>
  <div class="admin-section"><button class="admin-btn" onclick="openAdminPanel()">➕ 管理倒计时</button></div>
</div>
<div id="adminPanel" class="admin-panel">
  <div class="admin-content">
    <button class="close-btn" onclick="closeAdminPanel()">×</button>
    <h2 style="margin-bottom:24px;color:#323130;font-size:20px;font-weight:600">管理倒计时</h2>
    <div id="message" class="message"></div>
    <div class="form-group"><label class="form-label">管理员密钥</label><input type="password" id="adminToken" class="form-input" placeholder="ADMIN_TOKEN"></div>
    <div class="form-group"><label class="form-label">倒计时标题</label><input type="text" id="countdownTitle" class="form-input"></div>
    <div class="form-group"><label class="form-label">目标日期时间</label><input type="datetime-local" id="targetTime" class="form-input"></div>
    <button class="submit-btn" onclick="addCountdown()">添加倒计时</button>
  </div>
</div>
<script>
let countdowns=[],intervalIds=[];
async function loadCountdowns(){
  try{const r=await fetch('/api/countdowns'),d=await r.json();
    if(d.success){countdowns=d.data;render();}
  }catch(e){console.error(e)}
}
function clearAll(){intervalIds.forEach(i=>clearInterval(i));intervalIds=[]}
function render(){
  clearAll();const g=document.getElementById('countdownGrid');
  if(!countdowns.length){g.innerHTML='<div class="empty-state"><div class="empty-state-icon">⏰</div><h2>还没有倒计时</h2><p>点击下方按钮添加吧</p></div>';return}
  g.innerHTML='';
  countdowns.forEach(c=>{
    const now=Date.now();
    const card=document.createElement('div');card.className='countdown-card';
    if(c.target_time<=now){
      card.innerHTML='<button class="delete-btn" onclick="del('+c.id+')">×</button><div class="countdown-complete"><h3>🎉 '+esc(c.title)+'</h3><p>时间已到！</p></div>';
      g.appendChild(card);
    }else{
      card.innerHTML='<button class="delete-btn" onclick="del('+c.id+')">×</button><div class="countdown-title">'+esc(c.title)+'</div><div id="cd-'+c.id+'" class="flip-clock"></div>';
      g.appendChild(card);startCountdown(c.id,c.target_time);
    }
  });
}
function startCountdown(id,target){
  const c=document.getElementById('cd-'+id);
  const units=[{label:'Days',ids:['d1','d2','d3']},{label:'Hours',ids:['h1','h2']},{label:'Minutes',ids:['m1','m2']},{label:'Seconds',ids:['s1','s2']}];
  let html='';
  units.forEach(u=>{
    html+='<div class="flip-unit"><div class="flip-label">'+u.label+'</div><div class="flip-card-container">';
    u.ids.forEach(d=>{
      const k=d+'-'+id;
      html+='<div class="flip-card" id="'+k+'"><div class="flip-card-top"><div class="flip-number" id="'+k+'-ct">0</div></div><div class="flip-card-bottom"><div class="flip-number" id="'+k+'-cb">0</div></div><div class="flip-card-top-flip" id="'+k+'-tf" style="display:none"><div class="flip-number" id="'+k+'-nt">0</div></div><div class="flip-card-bottom-flip" id="'+k+'-bf" style="display:none"><div class="flip-number" id="'+k+'-nb">0</div></div></div>';
    });
    html+='</div></div>';
  });
  c.innerHTML=html;
  function tick(){
    const diff=target-Date.now();
    if(diff<=0){loadCountdowns();return}
    const dd=Math.floor(diff/864e5),hh=Math.floor(diff%864e5/36e5),mm=Math.floor(diff%36e5/6e4),ss=Math.floor(diff%6e4/1e3);
    set('d1-'+id,Math.floor(dd/100));set('d2-'+id,Math.floor(dd%100/10));set('d3-'+id,dd%10);
    set('h1-'+id,Math.floor(hh/10));set('h2-'+id,hh%10);
    set('m1-'+id,Math.floor(mm/10));set('m2-'+id,mm%10);
    set('s1-'+id,Math.floor(ss/10));set('s2-'+id,ss%10);
  }
  tick();intervalIds.push(setInterval(tick,1000));
}
function set(k,v){
  const ct=document.getElementById(k+'-ct'),cb=document.getElementById(k+'-cb');
  if(!ct||!cb)return;
  const cur=parseInt(ct.textContent)||0;
  if(cur===v)return;
  const card=document.getElementById(k),
        tf=document.getElementById(k+'-tf'),bf=document.getElementById(k+'-bf'),
        nt=document.getElementById(k+'-nt'),nb=document.getElementById(k+'-nb');
  if(card.classList.contains('flipping'))return;

  // 翻动层:上半显示 OLD(要翻走的),下半显示 NEW(要翻进来的)
  nt.textContent=cur;
  nb.textContent=v;
  // 静态层:上半立刻切到 NEW(此刻被 top-flip 盖住,看不见);下半保持 OLD,动画末再切
  ct.textContent=v;

  tf.style.display='block';bf.style.display='block';
  card.classList.add('flipping');
  setTimeout(()=>{
    cb.textContent=v;          // 此时 bottom-flip 已落到 0° 盖住它,切换不可见
    tf.style.display='none';
    bf.style.display='none';
    card.classList.remove('flipping');
  },600);
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function openAdminPanel(){document.getElementById('adminPanel').classList.add('active');const t=localStorage.getItem('admin_token');if(t)document.getElementById('adminToken').value=t}
function closeAdminPanel(){document.getElementById('adminPanel').classList.remove('active');hideMsg()}
async function addCountdown(){
  const t=document.getElementById('adminToken').value.trim(),title=document.getElementById('countdownTitle').value.trim(),tt=document.getElementById('targetTime').value;
  if(!t)return showMsg('请输入管理员密钥','error');
  if(!title)return showMsg('请输入标题','error');
  if(!tt)return showMsg('请选择目标时间','error');
  try{
    const r=await fetch('/api/countdown/add',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({title,target_time:new Date(tt).toISOString()})});
    const d=await r.json();
    if(d.success){localStorage.setItem('admin_token',t);showMsg('添加成功！','success');document.getElementById('countdownTitle').value='';document.getElementById('targetTime').value='';setTimeout(()=>{closeAdminPanel();loadCountdowns()},1500)}
    else showMsg(d.error||'添加失败','error');
  }catch(e){showMsg('网络错误：'+e.message,'error')}
}
async function del(id){
  if(!confirm('确定删除？'))return;
  const t=localStorage.getItem('admin_token');
  if(!t)return alert('请先在管理面板中输入密钥');
  try{
    const r=await fetch('/api/countdown/delete',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({id})});
    const d=await r.json();
    if(d.success)loadCountdowns();else alert(d.error||'删除失败');
  }catch(e){alert('网络错误：'+e.message)}
}
function showMsg(t,type){const m=document.getElementById('message');m.textContent=t;m.className='message '+type+' show';setTimeout(hideMsg,5000)}
function hideMsg(){document.getElementById('message').classList.remove('show')}
loadCountdowns();setInterval(loadCountdowns,30000);
</script>
</body>
</html>`;
}

function getDriveHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>临时云盘 - 清流中学非官方站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f3f2f1;min-height:100vh;padding:20px}
.container{max-width:900px;margin:0 auto}
.back-link{display:inline-block;margin-bottom:20px;color:#0078d4;text-decoration:none;font-size:14px;font-weight:600}
.back-link:hover{text-decoration:underline}
.header{text-align:center;margin-bottom:32px}
.header h1{font-size:32px;color:#201f1e;margin-bottom:8px;font-weight:600}
.header p{font-size:14px;color:#605e5c}
.card{background:#fff;border-radius:8px;padding:24px;box-shadow:0 1.6px 3.6px rgba(0,0,0,.132);margin-bottom:24px}
.drop-zone{border:2px dashed #8a8886;border-radius:8px;padding:40px 20px;text-align:center;transition:.2s;cursor:pointer;background:#faf9f8}
.drop-zone.drag{border-color:#0078d4;background:#deecf9}
.drop-zone-icon{font-size:48px;margin-bottom:12px}
.drop-zone-text{color:#323130;font-size:16px;margin-bottom:4px}
.drop-zone-hint{color:#605e5c;font-size:12px}
#fileInput{display:none}
.form-group{margin-top:16px}
.form-label{display:block;font-size:13px;font-weight:600;color:#323130;margin-bottom:6px}
.form-input{width:100%;padding:8px 12px;font-size:14px;border:1px solid #8a8886;border-radius:2px}
.form-input:focus{outline:none;border-color:#0078d4;box-shadow:0 0 0 1px #0078d4}
.form-hint{font-size:12px;color:#605e5c;margin-top:4px}
.btn{padding:8px 20px;font-size:14px;font-weight:600;border:none;border-radius:2px;cursor:pointer}
.btn-primary{background:#0078d4;color:#fff}
.btn-primary:hover:not(:disabled){background:#106ebe}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-small{padding:4px 10px;font-size:12px}
.btn-danger{background:#fff;color:#a4262c;border:1px solid #a4262c}
.btn-danger:hover{background:#a4262c;color:#fff}
.progress{width:100%;height:6px;background:#edebe9;border-radius:3px;overflow:hidden;margin-top:12px;display:none}
.progress-bar{height:100%;background:#0078d4;width:0;transition:.2s}
.message{padding:10px 14px;border-radius:4px;margin-top:12px;font-size:14px;display:none;border-left:4px solid}
.message.success{background:#dff6dd;border-color:#107c10;color:#0b5a08}
.message.error{background:#fde7e9;border-color:#a80000;color:#a80000}
.message.show{display:block}
.file-list{list-style:none}
.file-item{display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid #edebe9}
.file-item:last-child{border-bottom:none}
.file-icon{font-size:28px}
.file-info{flex:1;min-width:0}
.file-name{font-size:14px;color:#323130;font-weight:600;word-break:break-all}
.file-meta{font-size:12px;color:#605e5c;margin-top:2px}
.badge{display:inline-block;padding:1px 6px;border-radius:2px;font-size:11px;font-weight:600;margin-right:6px}
.badge.permanent{background:#107c10;color:#fff}
.badge.temp{background:#ff8c00;color:#fff}
.file-actions{display:flex;gap:6px;flex-shrink:0}
.file-actions a,.file-actions button{text-decoration:none}
.empty{text-align:center;padding:40px 20px;color:#605e5c}
@media (max-width:640px){.file-item{flex-wrap:wrap}.file-actions{width:100%}}
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 返回首页</a>
  <div class="header"><h1>📁 临时云盘</h1><p>默认保存 12 小时 · 临时口令存 14 天并可自定义短链 · 管理员密钥永久存储 · 单文件上限 500MB</p></div>
  <div class="card">
    <div id="usageBox" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600;color:#323130">云盘空间</span>
        <span style="font-size:12px;color:#605e5c" id="usageText">—</span>
      </div>
      <div style="width:100%;height:8px;background:#edebe9;border-radius:4px;overflow:hidden">
        <div id="usageBar" style="height:100%;width:0;background:#0078d4;transition:.3s"></div>
      </div>
      <div class="form-hint">整个 KV 命名空间免费额度 1GB，两个站点共用。</div>
    </div>
    <div id="dropZone" class="drop-zone" onclick="document.getElementById('fileInput').click()">
      <div class="drop-zone-icon">☁️</div>
      <div class="drop-zone-text" id="dropText">点击或拖拽文件到此处上传</div>
      <div class="drop-zone-hint">最大 500MB</div>
    </div>
    <input type="file" id="fileInput">
    <div class="form-group">
      <label class="form-label">口令（可选）</label>
      <input type="password" id="adminToken" class="form-input" placeholder="留空 = 12 小时后删除；临时口令 = 存 14 天；管理员密钥 = 永久">
      <div class="form-hint">口令只在浏览器内使用。在不是自己的设备（同学手机、机房电脑）上只填「临时口令」：它只能上传，看不到也删不掉已有文件。</div>
    </div>
    <div class="form-group">
      <label class="form-label">自定义短链（可选）</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:13px;color:#605e5c" id="shortBase">/s/</span>
        <input type="text" id="alias" class="form-input" placeholder="例如 banhui-ppt" maxlength="32" style="flex:1;min-width:150px">
        <select id="shortDays" class="form-input" style="max-width:160px">
          <option value="7">短链存 7 天</option>
          <option value="14" selected>短链存 14 天（默认）</option>
          <option value="30">短链存 30 天</option>
          <option value="90">短链存 90 天</option>
        </select>
      </div>
      <div class="form-hint">留空就不建短链。别名 3-32 位字母数字下划线短横线；短链不能比文件活得久，否则是死链。</div>
    </div>
    <div class="form-group" style="display:flex;gap:8px">
      <button class="btn btn-primary" id="uploadBtn" onclick="upload()">⬆ 上传</button>
      <button class="btn btn-primary" style="background:#fff;color:#0078d4;border:1px solid #0078d4" onclick="loadList()">🔄 刷新列表</button>
    </div>
    <div class="progress" id="progress"><div class="progress-bar" id="progressBar"></div></div>
    <div id="msg" class="message"></div>
    <div id="shortBox" class="message success" style="display:none"></div>
  </div>
  <div class="card">
    <h2 style="font-size:18px;margin-bottom:16px;color:#323130">文件列表</h2>
    <ul id="fileList" class="file-list"></ul>
  </div>
</div>
<script>
const $=id=>document.getElementById(id),dropZone=$('dropZone'),fileInput=$('fileInput');
let pending=null,uploading=false,currentUploadId=null;
/* 分片参数要和后端 old-news-api.js 里的 DRIVE_CHUNK_BYTES / DRIVE_MAX_FILE_BYTES 保持一致 */
const CHUNK_BYTES=24*1024*1024,MAX_FILE_BYTES=500*1024*1024,UPLOAD_CONCURRENCY=3;
['dragenter','dragover'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.add('drag')}));
['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.remove('drag')}));
dropZone.addEventListener('drop',e=>{if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0])});
fileInput.addEventListener('change',e=>{if(e.target.files[0])setFile(e.target.files[0])});
function setFile(f){pending=f;$('dropText').textContent='已选择：'+f.name+' ('+fmtSize(f.size)+')'}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(2)+' MB'}
function fmtTime(ts){if(!ts)return'-';return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
function showMsg(t,type='success'){const m=$('msg');m.textContent=t;m.className='message '+type+' show';setTimeout(()=>m.classList.remove('show'),5000)}
/* 大文件在浏览器里切开再传：Worker 请求体上限 100MB、内存 128MB，整份丢过去必炸。
   init 拿会话 -> 3 路并发传片 -> complete 收尾；任何一步失败就 abort 把已传的片清掉。 */
async function upload(){
  if(!pending)return showMsg('请先选择文件','error');
  if(!pending.size)return showMsg('文件是空的','error');
  if(pending.size>MAX_FILE_BYTES)return showMsg('文件超过 '+fmtSize(MAX_FILE_BYTES),'error');
  const btn=$('uploadBtn'),shortBox=$('shortBox');
  uploading=true;btn.disabled=true;btn.textContent='准备中...';
  $('progress').style.display='block';$('progressBar').style.width='0%';
  shortBox.style.display='none';shortBox.innerHTML='';
  let id=null;
  try{
    const alias=$('alias').value.trim();
    const init=await fetch('/api/drive/upload/init',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:pending.name,size:pending.size,type:pending.type||'application/octet-stream',
        admin_token:$('adminToken').value,alias:alias,days:alias?$('shortDays').value:''})});
    const d=await init.json();
    if(!d.success)return showMsg('✗ '+(d.error||'初始化失败'),'error');
    id=d.id;currentUploadId=id;
    const chunkSize=d.chunkSize,count=d.chunkCount;
    let cursor=0,done=0;
    const nextIndex=()=>cursor<count?cursor++:-1;
    async function sendChunk(i){
      let lastErr=null;
      for(let attempt=1;attempt<=3;attempt++){
        try{
          const blob=pending.slice(i*chunkSize,Math.min((i+1)*chunkSize,pending.size));
          const r=await fetch('/api/drive/upload/chunk?id='+encodeURIComponent(id)+'&i='+i,
            {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:blob});
          if(r.ok)return;
          const e=await r.json().catch(()=>({}));
          lastErr=new Error(e.error||('HTTP '+r.status));
          if(r.status<500)throw lastErr;   /* 4xx 是参数/会话问题，重试没意义 */
        }catch(err){lastErr=err}
        if(attempt<3)await new Promise(res=>setTimeout(res,600*attempt));
      }
      throw lastErr||new Error('分片上传失败');
    }
    async function worker(){
      for(let i=nextIndex();i>=0;i=nextIndex()){
        await sendChunk(i);
        done++;$('progressBar').style.width=Math.round(done/count*100)+'%';btn.textContent='上传中 '+done+'/'+count;
      }
    }
    btn.textContent='上传中 0/'+count;
    await Promise.all(Array.from({length:Math.min(UPLOAD_CONCURRENCY,count)},worker));

    btn.textContent='收尾中...';
    const comp=await fetch('/api/drive/upload/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const cb=await comp.json();
    if(!cb.success){await abortUpload(id);return showMsg('✗ '+(cb.error||'上传收尾失败'),'error')}
    const keep=cb.permanent?'永久保存':(cb.guest?'保存 14 天':'12 小时后过期');
    showMsg('✓ 上传成功！('+keep+')','success');
    if(cb.short)showShortBox(cb);else if(cb.shortError)showMsg('✗ '+cb.shortError,'error');
    pending=null;fileInput.value='';$('alias').value='';
    $('dropText').textContent='点击或拖拽文件到此处上传';
    renderUsage(cb.usage);loadList();
  }catch(e){
    if(id)await abortUpload(id);
    showMsg('✗ '+e.message,'error');
  }finally{
    uploading=false;currentUploadId=null;btn.disabled=false;btn.textContent='⬆ 上传';
    setTimeout(()=>{$('progress').style.display='none';$('progressBar').style.width='0'},800);
  }
}
async function abortUpload(id){
  try{await fetch('/api/drive/upload/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id}),keepalive:true})}catch(e){}
}
/* 中途离开页面会让已传的片变成孤儿（永久上传没有 TTL 兜底），拦一下并顺手清掉 */
window.addEventListener('beforeunload',e=>{if(uploading){e.preventDefault();e.returnValue=''}});
window.addEventListener('pagehide',()=>{if(uploading&&currentUploadId)abortUpload(currentUploadId)});
async function loadUsage(){
  try{
    const r=await fetch('/api/drive/usage'),d=await r.json();
    if(d.success)renderUsage(d);
  }catch(e){}
}
function renderUsage(u){
  if(!u)return;
  const cap=u.softLimitBytes||u.limitBytes;
  const pct=Math.min(100,Math.round(u.bytes/cap*100));
  $('usageBox').style.display='block';
  $('usageBar').style.width=pct+'%';
  $('usageBar').style.background=pct>=90?'#a80000':(pct>=70?'#ff8c00':'#0078d4');
  $('usageText').textContent=fmtSize(u.bytes)+' / '+fmtSize(u.limitBytes)+'（'+pct+'%）· '+u.files+' 个文件';
}
loadUsage();
async function loadList(){
  try{
    const t=$('adminToken').value.trim();
    const r=await fetch('/api/drive/list',{headers:t?{'Authorization':'Bearer '+t}:{}}),ul=$('fileList');
    if(r.status===401){ul.innerHTML='<div class="empty">输入管理员密钥后查看文件列表</div>';return}
    const d=await r.json();
    if(!d.success||!d.data||!d.data.length){ul.innerHTML='<div class="empty">暂无文件</div>';return}
    ul.innerHTML=d.data.map(f=>{
      const icon=f.type&&f.type.startsWith('image/')?'🖼️':f.type&&f.type.startsWith('video/')?'🎬':f.type&&f.type.startsWith('audio/')?'🎵':f.type==='application/pdf'?'📄':f.type&&f.type.startsWith('text/')?'📝':'📦';
      const badge=f.permanent?'<span class="badge permanent">永久</span>':'<span class="badge temp">临时</span>';
      const expire=f.permanent?'不过期':('过期：'+fmtTime(f.expiration));
      const link='/api/drive/file/'+f.id;
      const shorts=(f.shorts||[]).map(s=>'<div class="file-meta">🔗 <a href="/s/'+encodeURIComponent(s.alias)+'" target="_blank">'+escHtml(location.host+'/s/'+s.alias)+'</a>　'+(s.expiration?('到期 '+fmtTime(s.expiration)):'永不过期')+'　<button class="btn btn-danger btn-small" data-short-del="'+escHtml(s.alias)+'">删短链</button></div>').join('');
      return '<li class="file-item"><div class="file-icon">'+icon+'</div><div class="file-info"><div class="file-name">'+badge+escHtml(f.name||'(未命名)')+'</div><div class="file-meta">'+fmtSize(f.size||0)+' · 上传：'+fmtTime(f.uploadedAt)+' · '+expire+'</div>'+shorts+'</div><div class="file-actions"><a class="btn btn-primary btn-small" href="'+link+'" target="_blank">查看</a><a class="btn btn-primary btn-small" href="'+link+'" download="'+escHtml(f.name||'file')+'">下载</a><button class="btn btn-danger btn-small" data-short-add="'+escHtml(f.id)+'">建短链</button><button class="btn btn-danger btn-small" onclick="copyLink(\\''+link+'\\')">复制链接</button><button class="btn btn-danger btn-small" onclick="del(\\''+f.id+'\\')">删除</button></div></li>';
    }).join('');
    ul.querySelectorAll('button[data-short-add]').forEach(b=>b.onclick=()=>addShort(b.getAttribute('data-short-add')));
    ul.querySelectorAll('button[data-short-del]').forEach(b=>b.onclick=()=>delShort(b.getAttribute('data-short-del')));
  }catch(e){$('fileList').innerHTML='<div class="empty">加载失败：'+e.message+'</div>'}
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function copyLink(p){const f=location.origin+p;navigator.clipboard.writeText(f).then(()=>showMsg('已复制：'+f,'success'),()=>showMsg('复制失败','error'))}
function showShortBox(b){
  const box=$('shortBox'),url=location.origin+b.short.url;
  const when=b.short.expiresAt?('有效期到 '+fmtTime(b.short.expiresAt)):'永不过期';
  box.style.display='block';
  box.innerHTML='🔗 短链：<a href="'+b.short.url+'" target="_blank">'+escHtml(url)+'</a><br><span style="font-size:12px">'+when+'</span> <button class="btn btn-primary btn-small" id="copyShortBtn" type="button">复制短链</button>';
  $('copyShortBtn').onclick=()=>copyLink(b.short.url);
}
async function addShort(id){
  const alias=prompt('给这个文件起个短链名字（3-32 位字母、数字、下划线、短横线）：');
  if(!alias)return;
  const t=$('adminToken').value.trim();
  try{
    const r=await fetch('/api/drive/short',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({id,alias:alias.trim(),days:$('shortDays').value})});
    if(r.status===401)return showMsg('建短链需要管理员密钥','error');
    const d=await r.json();
    if(d.success){showMsg('✓ 短链已建：'+location.origin+d.short.url,'success');loadList()}
    else showMsg('✗ '+(d.error||'建短链失败'),'error');
  }catch(e){showMsg('请求失败：'+e.message,'error')}
}
async function delShort(alias){
  const t=$('adminToken').value.trim();
  if(!confirm('删除短链 /s/'+alias+' ？文件本身不受影响。'))return;
  try{
    const r=await fetch('/api/drive/short/delete',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({alias})});
    if(r.status===401)return showMsg('删短链需要管理员密钥','error');
    const d=await r.json();
    if(d.success){showMsg('短链已删除','success');loadList()}
    else showMsg('删除失败：'+(d.error||''),'error');
  }catch(e){showMsg('请求失败：'+e.message,'error')}
}
async function del(id){
  const t=$('adminToken').value||prompt('删除需要管理员密钥：');
  if(!t)return;
  if(!confirm('确定删除？'))return;
  try{
    const r=await fetch('/api/drive/delete',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({id})});
    if(r.status===401)return showMsg('密钥错误','error');
    const d=await r.json();
    if(d.success){showMsg('已删除','success');loadList()}
    else showMsg('删除失败：'+(d.error||''),'error');
  }catch(e){showMsg('请求失败：'+e.message,'error')}
}
$('shortBase').textContent=location.host+'/s/';
loadList();
</script>
</body>
</html>`;
}
