/* =====================================================================
 * 清流中学非官方站 · Cloudflare Worker 主文件
 * 模块: 维护模式 / 新闻聚合(含HN翻译) / TG推送 / 邮箱申请 /
 *       倒计时 / 临时云盘 / 上传风控
 * Bindings 需要: DB(D1) FILES_KV(KV) AI(Workers AI)
 * ===================================================================== */

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, ctx));
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
      return new Response(get404HTML(), {
        status: 404,
        headers: { 'content-type': 'text/html;charset=UTF-8' }
      });
    }
  }

  /* ---- 邮箱申请 ---- */
  if (url.pathname === '/submit-application' && request.method === 'POST') {
    return handleFormSubmit(request, env);
  }
  if (url.pathname === '/email-apply.html' || url.pathname === '/email-apply') {
    return new Response(getEmailApplyHTML(), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }

  /* ---- 新闻 ---- */
  if (url.pathname === '/news.html' || url.pathname === '/news') {
    return new Response(getNewsHTML(), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }
  if (url.pathname === '/api/news') return handleNewsAPI(env);

  /* ---- 倒计时 ---- */
  if (url.pathname === '/countdown.html' || url.pathname === '/countdown') {
    return new Response(getCountdownHTML(), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
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

  /* ---- 强制更新新闻 + TG推送（带详细返回）---- */
  if (url.pathname === '/api/update-news' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    const result = { newsOk: false, tgOk: false, count: 0, errors: [] };
    try {
      const newsData = await fetchAllNews(env);
      result.count = newsData.length;
      try {
        await pushNewsToTelegram(env, newsData);
        result.tgOk = true;
      } catch (e) { result.errors.push('TG: ' + (e.message || e)); }
      try {
        await clearOldNews(env);
        await saveNewsToD1(env, newsData);
        result.newsOk = true;
      } catch (e) { result.errors.push('D1: ' + (e.message || e)); }
    } catch (e) {
      result.errors.push('FETCH: ' + (e.message || e));
    }
    return jsonResp({ success: result.newsOk || result.tgOk, ...result });
  }

  /* ---- 临时云盘 ---- */
  if (url.pathname === '/drive' || url.pathname === '/drive.html') {
    return new Response(getDriveHTML(), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }
  if (url.pathname === '/api/drive/upload' && request.method === 'POST') {
    return handleDriveUpload(request, env, ctx);
  }
  if (url.pathname === '/api/drive/list') return handleDriveList(env);
  if (url.pathname.startsWith('/api/drive/file/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/drive/file/', ''));
    return handleDriveDownload(id, env);
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
  /* ---- 物理小测验 ---- */
  if (url.pathname === '/phy-test' || url.pathname === '/phy-test.html') {
    return new Response(getPhyTestHTML(), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }
  if (url.pathname === '/api/phy-test/questions') return handlePhyQuestions(env);
  if (url.pathname === '/api/phy-test/submit' && request.method === 'POST') {
    return handlePhySubmit(request, env);
  }
  if (url.pathname === '/api/phy-test/seed' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handlePhySeed(env);
  }
  /* ---- 404 / 主页 ---- */
  if (url.pathname === '/404' || url.pathname === '/404.html') {
    return new Response(get404HTML(), { status: 404, headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }
  if (url.pathname === '/') {
    return new Response(getMainHTML(isChina), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }

  return new Response(get404HTML(), { status: 404, headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

/* ================= 通用工具 ================= */

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...extraHeaders }
  });
}

function isAdmin(request, env) {
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/* ================= /phy-test 物理小测验 ================= */

const PHY_TEST_COUNT = 20;

const PHY_QUESTIONS_SEED = [
  // ---- 力学 ----
  { type:'choice', topic:'mechanics', question:'关于机械运动，下列说法正确的是：',
    options:['运动是绝对的，静止是相对的','运动是相对的，静止是绝对的','运动和静止都是绝对的','只有相对地面运动的物体才在运动'],
    answer:'运动是绝对的，静止是相对的' },
  { type:'fill', topic:'mechanics', question:'一辆汽车以 20 m/s 的速度匀速行驶 5 分钟，通过的路程是 ___ m。', answer:'6000' },
  { type:'choice', topic:'mechanics', question:'关于力，下列说法正确的是：',
    options:['力是物体对物体的作用','单独一个物体也能产生力','力可以脱离物体而存在','两个不接触的物体之间一定没有力的作用'],
    answer:'力是物体对物体的作用' },
  { type:'fill', topic:'mechanics', question:'质量为 5 kg 的物体所受重力为 ___ N。(g 取 10 N/kg)', answer:'50' },
  { type:'choice', topic:'mechanics', question:'下列关于惯性的说法正确的是：',
    options:['静止的物体没有惯性','物体运动得越快，惯性越大','一切物体都具有惯性','受力大的物体惯性大'],
    answer:'一切物体都具有惯性' },
  { type:'fill', topic:'mechanics', question:'物体在水平地面上受 20 N 水平拉力做匀速直线运动，地面对物体的摩擦力大小为 ___ N。', answer:'20' },
  { type:'choice', topic:'mechanics', question:'物体浸没在液体中所受浮力的大小取决于：',
    options:['物体的密度','物体的重力','物体排开液体的体积和液体的密度','物体的形状'],
    answer:'物体排开液体的体积和液体的密度' },
  { type:'fill', topic:'mechanics', question:'体积为 100 cm³ 的物体完全浸没在水中，受到的浮力是 ___ N。(ρ水=1.0×10³ kg/m³, g 取 10 N/kg)', answer:'1' },
  { type:'choice', topic:'mechanics', question:'关于大气压，下列说法正确的是：',
    options:['随高度升高而增大','随高度升高而减小','与高度无关','与温度无关'],
    answer:'随高度升高而减小' },
  { type:'fill', topic:'mechanics', question:'标准大气压约相当于 ___ cm 高的水银柱。', answer:'76' },

  // ---- 简单机械 / 功 / 功率 ----
  { type:'choice', topic:'machines', question:'关于杠杆，下列说法错误的是：',
    options:['杠杆一定是直的','杠杆可以省力','杠杆可以省距离但费力','等臂杠杆既不省力也不费力'],
    answer:'杠杆一定是直的' },
  { type:'fill', topic:'machines', question:'用不计自重和摩擦的动滑轮提起 100 N 的重物，所需拉力为 ___ N。', answer:'50' },
  { type:'choice', topic:'work', question:'下列关于做功的说法正确的是：',
    options:['只要有力，就一定做功','物体移动了距离就一定做了功','力和距离都不为零就一定做了功','力作用在物体上，且物体在力的方向上通过了距离，才做了功'],
    answer:'力作用在物体上，且物体在力的方向上通过了距离，才做了功' },
  { type:'fill', topic:'work', question:'用 50 N 的水平拉力使物体沿力的方向移动 4 m，拉力做的功是 ___ J。', answer:'200' },
  { type:'choice', topic:'work', question:'功率是表示：',
    options:['做功多少的物理量','做功快慢的物理量','物体运动快慢的物理量','物体受力大小的物理量'],
    answer:'做功快慢的物理量' },
  { type:'fill', topic:'work', question:'某同学 10 s 内做了 500 J 的功，他的功率是 ___ W。', answer:'50' },

  // ---- 热学 ----
  { type:'choice', topic:'thermal', question:'下列现象中属于熔化的是：',
    options:['冰雪消融','露水形成','霜的形成','水沸腾'], answer:'冰雪消融' },
  { type:'choice', topic:'thermal', question:'关于温度计的使用，下列说法正确的是：',
    options:['玻璃泡要接触容器壁或容器底','读数时视线要与液柱上表面相平','读数时要把温度计从液体中取出','测沸水的温度可以使用酒精温度计'],
    answer:'读数时视线要与液柱上表面相平' },
  { type:'fill', topic:'thermal', question:'1 标准大气压下，水的沸点是 ___ ℃。', answer:'100' },
  { type:'choice', topic:'thermal', question:'下列说法正确的是：',
    options:['蒸发只在高温下发生','蒸发只能在液体表面进行','沸腾过程中温度不断升高','升华是物质由固态直接变为液态的过程'],
    answer:'蒸发只能在液体表面进行' },
  { type:'fill', topic:'thermal', question:'把 2 kg 的水从 20 ℃ 加热到 70 ℃，水吸收的热量是 ___ J。(c水=4.2×10³ J/(kg·℃))', answer:'420000' },

  // ---- 声 ----
  { type:'choice', topic:'sound', question:'声音不能在下列哪种介质中传播？',
    options:['空气','水','钢铁','真空'], answer:'真空' },
  { type:'choice', topic:'sound', question:'声音的三个基本特性是：',
    options:['响度、音调、音色','响度、频率、振幅','振幅、频率、波长','振幅、波长、音色'],
    answer:'响度、音调、音色' },
  { type:'fill', topic:'sound', question:'声音在 15 ℃ 空气中的传播速度约为 ___ m/s。', answer:'340' },

  // ---- 光学 ----
  { type:'choice', topic:'optics', question:'关于光的反射，下列说法错误的是：',
    options:['反射光线、入射光线和法线在同一平面内','反射光线和入射光线分居法线两侧','反射角等于入射角','反射角总是大于入射角'],
    answer:'反射角总是大于入射角' },
  { type:'choice', topic:'optics', question:'平面镜成像的特点是：',
    options:['倒立、等大的实像','正立、等大的虚像','正立、放大的虚像','正立、缩小的虚像'],
    answer:'正立、等大的虚像' },
  { type:'choice', topic:'optics', question:'当物体位于凸透镜两倍焦距以外时，所成的像是：',
    options:['倒立、缩小的实像','倒立、放大的实像','倒立、等大的实像','正立、放大的虚像'],
    answer:'倒立、缩小的实像' },
  { type:'fill', topic:'optics', question:'入射光线与镜面的夹角为 30°，反射角为 ___ 度。', answer:'60' },
  { type:'choice', topic:'optics', question:'下列现象由光的折射形成的是：',
    options:['平面镜中看到自己的像','小孔成像','看到水中的筷子向上弯折','看到水中倒影'],
    answer:'看到水中的筷子向上弯折' },
  { type:'fill', topic:'optics', question:'光在水中传播的速度比在真空中 ___ (填"大"或"小")。', answer:'小' },

  // ---- 电学 ----
  { type:'choice', topic:'electricity', question:'关于电路，下列说法正确的是：',
    options:['串联电路中各处电流相等','并联电路中各支路两端电压不相等','串联电路总电压等于各部分电压之差','并联电路总电流等于各支路电流之差'],
    answer:'串联电路中各处电流相等' },
  { type:'fill', topic:'electricity', question:'一段导体两端电压为 6 V，通过它的电流为 0.2 A，该导体的电阻是 ___ Ω。', answer:'30' },
  { type:'choice', topic:'electricity', question:'欧姆定律的内容是：',
    options:['导体两端电压与通过它的电流成反比','通过导体的电流跟它两端的电压成正比，跟它的电阻成反比','导体的电阻与电流成正比，与电压成反比','通过导体的电流与电阻成正比'],
    answer:'通过导体的电流跟它两端的电压成正比，跟它的电阻成反比' },
  { type:'fill', topic:'electricity', question:'标有 "6 V 3 W" 的灯泡，正常工作时通过它的电流是 ___ A。', answer:'0.5' },
  { type:'choice', topic:'electricity', question:'下列家用电器中，主要利用电流热效应工作的是：',
    options:['电风扇','电视机','电饭锅','洗衣机'], answer:'电饭锅' },
  { type:'fill', topic:'electricity', question:'通过某导体的电流为 2 A，10 s 内通过其横截面的电量是 ___ C。', answer:'20' },
  { type:'choice', topic:'electricity', question:'关于电功率，下列说法正确的是：',
    options:['电功率大的用电器消耗电能一定多','电功率是表示电流做功快慢的物理量','电功就是电功率','用电器两端电压越大，电功率一定越大'],
    answer:'电功率是表示电流做功快慢的物理量' },
  { type:'choice', topic:'electricity', question:'关于磁场和磁感线，下列说法正确的是：',
    options:['磁场是由磁感线组成的','磁体外部，磁感线从北极出发回到南极','同名磁极相互吸引','地球周围不存在磁场'],
    answer:'磁体外部，磁感线从北极出发回到南极' },
  { type:'fill', topic:'electricity', question:'标有 "220 V 60 W" 的电灯正常工作 5 h 消耗电能 ___ kW·h。', answer:'0.3' },
  { type:'choice', topic:'electricity', question:'家庭电路中，如果开关接在零线上：',
    options:['用电器能正常工作，且符合安全要求','用电器无法工作','用电器能工作，但不符合安全要求','用电器一定会烧毁'],
    answer:'用电器能工作，但不符合安全要求' },
];

async function handlePhySeed(env) {
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS c FROM phy_questions').all();
    const existing = results[0]?.c || 0;
    if (existing > 0) {
      return jsonResp({ success: true, message: `已存在 ${existing} 道题，未重复写入`, count: existing });
    }
    const stmt = env.DB.prepare(
      'INSERT INTO phy_questions (type, topic, question, options, answer, alt_answers) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const batch = PHY_QUESTIONS_SEED.map(q => stmt.bind(
      q.type, q.topic || null, q.question,
      q.options ? JSON.stringify(q.options) : null,
      q.answer,
      q.alt_answers ? JSON.stringify(q.alt_answers) : null
    ));
    await env.DB.batch(batch);
    return jsonResp({ success: true, message: `已写入 ${batch.length} 道题`, count: batch.length });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

function shufflePhy(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function handlePhyQuestions(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, type, topic, question, options FROM phy_questions ORDER BY RANDOM() LIMIT ?'
    ).bind(PHY_TEST_COUNT).all();
    if (!results || !results.length) {
      return jsonResp({ success: false, error: '题库为空，请管理员调用 /api/phy-test/seed 初始化' }, 404);
    }
    const data = results.map(r => {
      let opts = null;
      if (r.options) { try { opts = JSON.parse(r.options); } catch { opts = null; } }
      if (opts) opts = shufflePhy(opts);    // 选项也打乱顺序
      return { id: r.id, type: r.type, topic: r.topic, question: r.question, options: opts };
    });
    return jsonResp({ success: true, data, count: data.length });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

function normalizePhyAns(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：？！,.;:?!"'"'"]/g, '');
}

function isPhyAnswerCorrect(userAns, correctAns, altAnswers) {
  const u = normalizePhyAns(userAns);
  if (!u) return false;
  if (u === normalizePhyAns(correctAns)) return true;
  if (Array.isArray(altAnswers)) {
    for (const a of altAnswers) if (u === normalizePhyAns(a)) return true;
  }
  // 数值容差比较（处理 0.5 / .5 / 0.50 这类）
  const nu = parseFloat(u);
  const nc = parseFloat(normalizePhyAns(correctAns));
  if (!isNaN(nu) && !isNaN(nc) && Math.abs(nu - nc) < 1e-9) return true;
  return false;
}

async function handlePhySubmit(request, env) {
  try {
    const body = await request.json();
    const userAnswers = body?.answers || {};
    const ids = Object.keys(userAnswers).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    if (!ids.length) return jsonResp({ success: false, error: '未提交答案' }, 400);

    const placeholders = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, type, question, answer, alt_answers FROM phy_questions WHERE id IN (${placeholders})`
    ).bind(...ids).all();

    let correct = 0;
    const details = results.map(r => {
      const userAns = String(userAnswers[r.id] ?? '');
      let alt = null;
      try { alt = r.alt_answers ? JSON.parse(r.alt_answers) : null; } catch {}
      const ok = isPhyAnswerCorrect(userAns, r.answer, alt);
      if (ok) correct++;
      return { id: r.id, type: r.type, question: r.question, userAnswer: userAns, correctAnswer: r.answer, correct: ok };
    });

    const total = results.length;
    const score = total ? Math.round((correct / total) * 100) : 0;
    // 按 id 顺序还原成提交时的顺序（前端会再按自己的顺序对照）
    const detailMap = Object.fromEntries(details.map(d => [d.id, d]));
    const orderedDetails = ids.map(id => detailMap[id]).filter(Boolean);

    return jsonResp({ success: true, total, correct, wrong: total - correct, score, details: orderedDetails });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
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

async function handleScheduled(env, ctx) {
  const t0 = Date.now();
  console.log('[Cron] 开始:', new Date().toISOString());

  let newsData = [];
  try {
    newsData = await fetchAllNews(env);
    console.log(`[Cron] 抓到 ${newsData.length} 条`);
  } catch (e) { console.error('[Cron] 抓取失败:', e?.stack || e); }

  if (newsData.length) {
    try {
      await pushNewsToTelegram(env, newsData);
      console.log('[Cron] TG 推送完成');
    } catch (e) { console.error('[Cron] TG 推送失败:', e?.stack || e); }
  }

  try {
    await clearOldNews(env);
    await saveNewsToD1(env, newsData);
    console.log('[Cron] D1 写入完成');
  } catch (e) { console.error('[Cron] D1 写入失败:', e?.stack || e); }

  console.log(`[Cron] 全部结束,用时 ${Date.now() - t0}ms`);
}

/* ================= 新闻抓取 ================= */

async function fetchAllNews(env) {
  const newsSources = [
    { name: 'V2EX热门',        fetch: () => fetchV2EXHot() },
    { name: '微博热搜',        fetch: () => fetchWeiboHotNew() },
    { name: 'Hacker News',    fetch: () => fetchHackerNews(env) },
    { name: 'GitHub Trending', fetch: () => fetchGitHubTrending() },
    { name: '少数派',          fetch: () => fetchSsPaiNews() }
  ];

  const results = await Promise.allSettled(newsSources.map(async src => {
    try {
      const list = await src.fetch();
      return list.map(it => ({ ...it, source: src.name }));
    } catch (err) {
      console.error(`${src.name} 获取失败:`, err);
      return [];
    }
  }));

  let all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });
  return all;
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

    const items = await Promise.all(ids.slice(0, 10).map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) })
        .then(x => x.json()).catch(() => null)
    ));

    const out = await Promise.all(items.filter(Boolean).map(async it => {
      const zh = await translateToZh(env, it.title);
      const finalTitle = zh && zh !== it.title ? `${zh}（${it.title}）` : it.title;
      return {
        title: finalTitle,
        link: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
        description: `${it.score || 0} points | ${it.descendants || 0} comments`,
        pubDate: it.time ? it.time * 1000 : Date.now()
      };
    }));
    return out;
  } catch (e) {
    console.error('Hacker News 获取失败:', e);
    return [];
  }
}

async function translateToZh(env, text) {
  if (!text || !env.AI) return text;
  try {
    const res = await env.AI.run('@cf/meta/m2m100-1.2b', {
      text, source_lang: 'english', target_lang: 'chinese'
    });
    return (res && res.translated_text) ? res.translated_text.trim() : text;
  } catch (e) {
    console.error('翻译失败:', e);
    return text;
  }
}

async function fetchGitHubTrending() {
  const r = await fetch('https://api.gitterapp.com/repositories', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.slice(0, 10).map(it => ({
    title: `${it.name} - ${it.description || '无描述'}`,
    link: it.url || `https://github.com/${it.fullName}`,
    description: `⭐ ${it.stars || 0} | ${it.language || 'Unknown'}`,
    pubDate: Date.now()
  }));
}

async function fetchSsPaiNews() {
  const r = await fetch('https://sspai.com/feed', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  return parseRSS(await r.text()).slice(0, 10);
}

async function fetchWeiboHotNew() {
  const r = await fetch('https://orz.ai/api/v1/dailynews/?platform=weibo', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return [];
  const data = await r.json();
  const list = (data && Array.isArray(data.data)) ? data.data
              : (Array.isArray(data) ? data : []);
  return list.slice(0, 15).map(it => {
    const title = it.title || it.query || '';
    return {
      title,
      link: it.url || it.link || `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`,
      description: it.desc || it.hot || it.word || '',
      pubDate: it.timestamp ? it.timestamp * 1000 : Date.now()
    };
  });
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const c = m[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(c) || /<title>(.*?)<\/title>/.exec(c) || [])[1];
    const link  = (/<link>(.*?)<\/link>/.exec(c) || [])[1];
    const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(c) || /<description>(.*?)<\/description>/.exec(c) || [])[1];
    const date  = (/<pubDate>(.*?)<\/pubDate>/.exec(c) || [])[1];
    if (title) items.push({
      title: title.trim(),
      link: link ? link.trim() : '',
      description: desc ? stripHtml(desc.trim()).slice(0, 100) : '',
      pubDate: date ? new Date(date).getTime() : Date.now()
    });
  }
  return items;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/* ================= 新闻 D1 / API ================= */

async function clearOldNews(env) {
  try { await env.DB.prepare('DELETE FROM news').run(); }
  catch (e) { console.error('清空数据失败:', e); }
}

async function saveNewsToD1(env, arr) {
  if (!arr || !arr.length) return;
  const stmt = env.DB.prepare(
    'INSERT INTO news (title, link, description, source, pub_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const batch = arr.map(it => stmt.bind(it.title, it.link, it.description || '', it.source, it.pubDate, Date.now()));
  await env.DB.batch(batch);
}

async function handleNewsAPI(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT title, link, description, source, pub_date, created_at FROM news ORDER BY created_at DESC LIMIT 50'
    ).all();
    const data = results.map(r => ({
      title: r.title, link: r.link, description: r.description, source: r.source, pubDate: r.pub_date
    }));
    const { results: u } = await env.DB.prepare('SELECT MAX(created_at) as last_update FROM news').all();
    const lastUpdate = u[0]?.last_update || Date.now();
    return jsonResp({
      success: true, data, count: data.length,
      updateTime: new Date(lastUpdate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* ================= Telegram 推送 ================= */

async function pushNewsToTelegram(env, newsData) {
  const token  = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !newsData?.length) {
    console.log('[TG] 跳过推送（未配置或无数据）');
    return;
  }

  const grouped = {};
  for (const it of newsData) {
    const s = it.source || '其他';
    (grouped[s] ||= []).push(it);
  }

  const lines = [
    `🗞 <b>新闻更新</b> · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `共 ${newsData.length} 条`,
    ''
  ];
  for (const [src, items] of Object.entries(grouped)) {
    lines.push(`<b>📰 ${escTg(src)}</b>`);
    items.forEach((it, i) => {
      const t = escTg(it.title || '');
      lines.push(it.link ? `${i + 1}. <a href="${escTg(it.link)}">${t}</a>` : `${i + 1}. ${t}`);
      if (it.description) lines.push(`   <i>${escTg(it.description)}</i>`);
    });
    lines.push('');
  }

  const chunks = chunkText(lines.join('\n'), 3800);
  console.log(`[TG] 准备发送 ${chunks.length} 条消息`);
  for (let i = 0; i < chunks.length; i++) {
    const ok = await sendTG(token, chatId, chunks[i]);
    console.log(`[TG] chunk ${i + 1}/${chunks.length} ${ok ? 'OK' : 'FAIL'}`);
    if (i < chunks.length - 1) await sleep(400);
  }
}

async function sendTG(token, chatId, text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
      });
      if (res.ok) return true;
      const errBody = await res.text();
      console.error(`[TG] 第${attempt}次失败 ${res.status}: ${errBody.slice(0, 200)}`);
      if (res.status === 429) {
        try { const j = JSON.parse(errBody); await sleep((j.parameters?.retry_after || 1) * 1000); }
        catch { await sleep(2000); }
      } else if (res.status >= 400 && res.status < 500) return false;
    } catch (e) {
      console.error(`[TG] 第${attempt}次异常:`, e);
      await sleep(800);
    }
  }
  return false;
}

function escTg(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chunkText(text, max) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur ? cur.length + 1 : 0) + line.length > max) {
      if (cur) out.push(cur);
      cur = line.length > max ? line.slice(0, max) : line;
    } else {
      cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ================= 邮箱申请 / Turnstile ================= */

async function handleFormSubmit(request, env) {
  try {
    const formData = await request.formData();
    const turnstileToken = formData.get('cf-turnstile-response');
    if (!turnstileToken) return jsonResp({ success: false, error: '请完成人机验证' }, 400);

    const tr = await verifyTurnstile(turnstileToken, env);
    if (!tr.success) return jsonResp({ success: false, error: '人机验证失败，请重试' }, 400);

    const data = {
      username: formData.get('username'),
      realName: formData.get('realName'),
      studentId: formData.get('studentId') || '未提供',
      contactEmail: formData.get('contactEmail'),
      purpose: formData.get('purpose'),
      reason: formData.get('reason'),
      timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };

    if (!env.GITHUB_REPO_OWNER || !env.GITHUB_REPO_NAME || !env.GITHUB_PAT)
      throw new Error('GitHub 环境变量未正确配置');

    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'cloudflare-worker'
        },
        body: JSON.stringify({ event_type: 'send-email', client_payload: data })
      }
    );

    if (res.status === 204) return jsonResp({ success: true, message: '申请已提交，我们将尽快处理！' });
    console.error('GitHub API Error:', res.status, await res.text());
    return jsonResp({ success: false, error: 'GitHub 接口返回错误' }, 500);
  } catch (e) {
    return jsonResp({ success: false, error: e.message || '提交失败' }, 500);
  }
}

async function verifyTurnstile(token, env) {
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token })
    });
    return await r.json();
  } catch (e) {
    console.error('Turnstile 验证失败:', e);
    return { success: false };
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
    if (!title || !target_time) return jsonResp({ success: false, error: '标题和目标时间不能为空' }, 400);
    const ts = new Date(target_time).getTime();
    if (isNaN(ts)) return jsonResp({ success: false, error: '无效的时间格式' }, 400);
    await env.DB.prepare('INSERT INTO countdowns (title, target_time, created_at) VALUES (?, ?, ?)')
      .bind(title, ts, Date.now()).run();
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
const DRIVE_TTL_SECONDS = 12 * 60 * 60;
const DRIVE_MAX_BYTES = 25 * 1024 * 1024;

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

async function handleDriveUpload(request, env, ctx) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    const pwd  = (form.get('admin_token') || '').toString();
    if (!file || typeof file === 'string') return jsonResp({ success: false, error: '请选择文件' }, 400);
    if (file.size > DRIVE_MAX_BYTES) return jsonResp({
      success: false, error: `文件 ${(file.size / 1024 / 1024).toFixed(2)}MB 超过 KV 25MB 上限`
    }, 400);

    const isAdminUpload = pwd && pwd === env.ADMIN_TOKEN;

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
    const metadata = {
      name: file.name || 'unnamed', size: file.size,
      type: file.type || 'application/octet-stream',
      uploadedAt: Date.now(), permanent: !!isAdminUpload
    };
    const opts = { metadata };
    if (!isAdminUpload) opts.expirationTtl = DRIVE_TTL_SECONDS;
    await env.FILES_KV.put(DRIVE_PREFIX + id, buffer, opts);

    if (!isAdminUpload && rl) recordUpload(env, ctx, rl.ip, file.size, rl.cfg);

    return jsonResp({
      success: true, id, url: `/api/drive/file/${id}`,
      permanent: !!isAdminUpload,
      expiresAt: isAdminUpload ? null : Date.now() + DRIVE_TTL_SECONDS * 1000,
      ...metadata
    });
  } catch (e) {
    console.error('上传失败:', e);
    return jsonResp({ success: false, error: e.message || '上传失败' }, 500);
  }
}

async function handleDriveList(env) {
  try {
    const out = [];
    let cursor;
    do {
      const page = await env.FILES_KV.list({ prefix: DRIVE_PREFIX, cursor });
      page.keys.forEach(k => out.push({
        id: k.name.slice(DRIVE_PREFIX.length),
        ...(k.metadata || {}),
        expiration: k.expiration ? k.expiration * 1000 : null
      }));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    return jsonResp({ success: true, data: out });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleDriveDownload(id, env) {
  try {
    const { value, metadata } = await env.FILES_KV.getWithMetadata(DRIVE_PREFIX + id, { type: 'arrayBuffer' });
    if (!value) return new Response('File not found or expired', { status: 404 });
    const meta = metadata || {};
    const safe = encodeURIComponent(meta.name || 'file');
    return new Response(value, {
      headers: {
        'Content-Type': meta.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${safe}`,
        'Cache-Control': 'private, max-age=300'
      }
    });
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}

async function handleDriveDelete(request, env) {
  try {
    const { id } = await request.json();
    if (!id) return jsonResp({ success: false, error: 'ID 不能为空' }, 400);
    await env.FILES_KV.delete(DRIVE_PREFIX + id);
    return jsonResp({ success: true });
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
    <a href="/phy-test" class="action-btn">🔬 物理小测验</a>
    <a href="/email-apply.html" class="action-btn">📧 邮箱申请</a>
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

function getNewsHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>热点新闻 - 清流中学非官方站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f3f2f1;min-height:100vh;padding:20px}
.container{max-width:900px;margin:40px auto}
.header{text-align:center;margin-bottom:32px}
.header h1{font-size:28px;font-weight:600;color:#201f1e;margin-bottom:8px}
.header p{font-size:14px;color:#605e5c}
.back-link{display:inline-block;margin-bottom:20px;color:#0078d4;text-decoration:none;font-size:14px;font-weight:600}
.back-link:hover{text-decoration:underline}
.loading{text-align:center;padding:60px 20px}
.loading-spinner{border:3px solid #f3f2f1;border-top:3px solid #0078d4;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.update-info{text-align:center;color:#605e5c;font-size:13px;margin-bottom:24px}
.refresh-btn{background:#0078d4;color:#fff;border:none;padding:6px 16px;border-radius:2px;cursor:pointer;font-size:13px;margin-left:8px}
.refresh-btn:hover{background:#106ebe}
.timeline{position:relative;padding-left:40px}
.timeline::before{content:'';position:absolute;left:15px;top:0;bottom:0;width:2px;background:#d2d0ce}
.news-item{position:relative;margin-bottom:32px;background:#fff;border-radius:8px;padding:20px 24px;box-shadow:0 1.6px 3.6px rgba(0,0,0,.132);transition:.2s;animation:fadeIn .5s}
.news-item:hover{transform:translateX(4px);box-shadow:0 3.2px 7.2px rgba(0,0,0,.132)}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.news-item::before{content:'';position:absolute;left:-31px;top:24px;width:12px;height:12px;background:#0078d4;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 2px #0078d4}
.news-source{display:inline-block;background:#0078d4;color:#fff;padding:2px 8px;border-radius:2px;font-size:11px;font-weight:600;margin-bottom:8px}
.news-title{font-size:18px;font-weight:600;color:#201f1e;margin-bottom:8px;line-height:1.4}
.news-title a{color:inherit;text-decoration:none}
.news-title a:hover{color:#0078d4}
.news-description{font-size:14px;color:#605e5c;line-height:1.6;margin-bottom:8px}
.news-time{font-size:12px;color:#8a8886}
.error-message{background:#fde7e9;border-left:4px solid #a80000;color:#a80000;padding:16px;border-radius:4px;margin:20px 0}
.empty-state{text-align:center;padding:60px 20px;color:#605e5c}
@media (max-width:640px){.container{margin:20px auto}.timeline{padding-left:30px}.timeline::before{left:10px}.news-item::before{left:-26px}.news-item{padding:16px 20px}.news-title{font-size:16px}}
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 返回首页</a>
  <div class="header"><h1>📰 热点新闻</h1><p>实时聚合各大平台热门话题</p></div>
  <div id="updateInfo" class="update-info" style="display:none">最后更新：<span id="updateTime">-</span><button class="refresh-btn" onclick="location.reload()">🔄 刷新</button></div>
  <div id="loading" class="loading"><div class="loading-spinner"></div><div>正在加载新闻...</div></div>
  <div id="error" class="error-message" style="display:none"></div>
  <div id="timeline" class="timeline" style="display:none"></div>
</div>
<script>
async function loadNews(){
  const L=document.getElementById('loading'),E=document.getElementById('error'),T=document.getElementById('timeline'),U=document.getElementById('updateInfo');
  L.style.display='block';E.style.display='none';T.style.display='none';
  try{
    const r=await fetch('/api/news'),d=await r.json();
    if(d.success&&d.data&&d.data.length){
      display(d.data);
      document.getElementById('updateTime').textContent=d.updateTime;
      U.style.display='block';T.style.display='block';
    }else showEmpty();
  }catch(e){E.textContent='⚠️ 加载失败：'+e.message;E.style.display='block';}
  finally{L.style.display='none';}
}
function display(arr){
  const T=document.getElementById('timeline');T.innerHTML='';
  arr.forEach((it,idx)=>{
    const d=document.createElement('div');d.className='news-item';d.style.animationDelay=(idx*.05)+'s';
    const time=it.pubDate?fmt(it.pubDate):'刚刚';
    const desc=it.description?'<div class="news-description">'+esc(it.description)+'</div>':'';
    const t=it.link?'<a href="'+esc(it.link)+'" target="_blank" rel="noopener">'+esc(it.title)+'</a>':esc(it.title);
    d.innerHTML='<div class="news-source">'+esc(it.source||'未知来源')+'</div><div class="news-title">'+t+'</div>'+desc+'<div class="news-time">⏰ '+time+'</div>';
    T.appendChild(d);
  });
}
function fmt(ts){const n=Date.now(),diff=n-ts,m=Math.floor(diff/6e4),h=Math.floor(diff/36e5),d=Math.floor(diff/864e5);if(m<1)return'刚刚';if(m<60)return m+'分钟前';if(h<24)return h+'小时前';if(d<7)return d+'天前';return new Date(ts).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function showEmpty(){document.getElementById('timeline').innerHTML='<div class="empty-state">暂无新闻数据</div>';document.getElementById('timeline').style.display='block'}
loadNews();
</script>
</body>
</html>`;
}

function getEmailApplyHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>邮箱申请 - 清流中学非官方站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f3f2f1;min-height:100vh;padding:20px}
.container{max-width:600px;margin:40px auto}
.header{text-align:center;margin-bottom:32px}
.header h1{font-size:28px;font-weight:600;color:#201f1e;margin-bottom:8px}
.header p{font-size:14px;color:#605e5c}
.card{background:#fff;border-radius:8px;box-shadow:0 1.6px 3.6px rgba(0,0,0,.132);padding:32px}
.form-group{margin-bottom:24px}
.form-label{display:block;font-size:14px;font-weight:600;color:#323130;margin-bottom:8px}
.required{color:#a4262c;margin-left:4px}
.form-input,.form-textarea,.form-select{width:100%;padding:8px 12px;font-size:14px;font-family:inherit;border:1px solid #8a8886;border-radius:2px;background:#fff;transition:.1s}
.form-input:focus,.form-textarea:focus,.form-select:focus{outline:none;border-color:#0078d4;box-shadow:0 0 0 1px #0078d4}
.form-textarea{min-height:100px;resize:vertical}
.form-hint{font-size:12px;color:#605e5c;margin-top:4px}
.checkbox-group{display:flex;align-items:flex-start;margin-bottom:24px}
.checkbox-input{margin-right:8px;margin-top:2px;cursor:pointer}
.checkbox-label{font-size:14px;color:#323130;cursor:pointer;user-select:none}
.button-group{display:flex;gap:12px;margin-top:32px}
.btn{padding:8px 20px;font-size:14px;font-weight:600;border:none;border-radius:2px;cursor:pointer;font-family:inherit}
.btn-primary{background:#0078d4;color:#fff}
.btn-primary:hover:not(:disabled){background:#106ebe}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-default{background:#fff;color:#323130;border:1px solid #8a8886}
.btn-default:hover{background:#f3f2f1}
.message{padding:12px 16px;border-radius:2px;margin-bottom:24px;font-size:14px;display:none}
.message.success{background:#dff6dd;border-left:4px solid #107c10;color:#0b5a08}
.message.error{background:#fde7e9;border-left:4px solid #a80000;color:#a80000}
.message.show{display:block}
.back-link{display:inline-block;margin-bottom:20px;color:#0078d4;text-decoration:none;font-size:14px;font-weight:600}
@media (max-width:640px){.container{margin:20px auto}.card{padding:24px}.button-group{flex-direction:column}.btn{width:100%}}
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 返回首页</a>
  <div class="header"><h1>📧 邮箱申请</h1><p>申请 @mail.qlzx.lol 专属邮箱</p></div>
  <div id="successMessage" class="message success">✓ 申请已提交成功！我们将在 1-3 个工作日内审核并通过邮件通知您。</div>
  <div id="errorMessage" class="message error"></div>
  <div class="card">
    <form id="emailForm">
      <div class="form-group">
        <label class="form-label">期望的邮箱地址<span class="required">*</span></label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="text" class="form-input" id="username" name="username" placeholder="yourusername" required pattern="[a-z0-9._-]+" style="flex:1">
          <span style="color:#605e5c">@mail.qlzx.lol</span>
        </div>
        <div class="form-hint">只能包含小写字母、数字、点、下划线和连字符</div>
      </div>
      <div class="form-group"><label class="form-label" for="realName">真实姓名<span class="required">*</span></label><input type="text" class="form-input" id="realName" name="realName" required></div>
      <div class="form-group"><label class="form-label" for="studentId">学号（如适用）</label><input type="text" class="form-input" id="studentId" name="studentId"></div>
      <div class="form-group"><label class="form-label" for="contactEmail">备用联系邮箱<span class="required">*</span></label><input type="email" class="form-input" id="contactEmail" name="contactEmail" required></div>
      <div class="form-group">
        <label class="form-label" for="purpose">申请用途<span class="required">*</span></label>
        <select class="form-select" id="purpose" name="purpose" required>
          <option value="">请选择</option>
          <option value="student">学生使用</option>
          <option value="alumni">校友使用</option>
          <option value="teacher">教师使用</option>
          <option value="other">其他</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label" for="reason">申请理由<span class="required">*</span></label><textarea class="form-textarea" id="reason" name="reason" required></textarea></div>
      <div class="checkbox-group"><input type="checkbox" class="checkbox-input" id="agree" required><label class="checkbox-label" for="agree">我已阅读并同意遵守邮箱使用规范，承诺不使用邮箱进行违法违规活动</label></div>
      <div class="form-group">
        <label class="form-label">人机验证<span class="required">*</span></label>
        <div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY" data-theme="light"></div>
      </div>
      <div class="button-group">
        <button type="submit" class="btn btn-primary" id="submitBtn">提交申请</button>
        <button type="reset" class="btn btn-default">重置表单</button>
      </div>
    </form>
  </div>
</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
const form=document.getElementById('emailForm'),submitBtn=document.getElementById('submitBtn'),sm=document.getElementById('successMessage'),em=document.getElementById('errorMessage'),u=document.getElementById('username');
u.addEventListener('input',function(){this.value=this.value.toLowerCase().replace(/[^a-z0-9._-]/g,'')});
form.addEventListener('submit',async e=>{
  e.preventDefault();
  submitBtn.disabled=true;submitBtn.textContent='提交中...';
  sm.classList.remove('show');em.classList.remove('show');
  try{
    const r=await fetch('/submit-application',{method:'POST',body:new FormData(form)});
    const d=await r.json();
    if(d.success){sm.textContent='✓ '+(d.message||'申请已提交成功！');sm.classList.add('show');form.reset();}
    else{em.textContent='✗ '+(d.error||'提交失败');em.classList.add('show');}
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(err){em.textContent='✗ 网络错误，请稍后重试';em.classList.add('show');}
  finally{submitBtn.disabled=false;submitBtn.textContent='提交申请';}
});
form.addEventListener('reset',()=>{sm.classList.remove('show');em.classList.remove('show')});
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
  <div class="header"><h1>📁 临时云盘</h1><p>默认保存 12 小时 · 输入管理员密钥可永久存储 · 单文件上限 25MB</p></div>
  <div class="card">
    <div id="dropZone" class="drop-zone" onclick="document.getElementById('fileInput').click()">
      <div class="drop-zone-icon">☁️</div>
      <div class="drop-zone-text" id="dropText">点击或拖拽文件到此处上传</div>
      <div class="drop-zone-hint">最大 25MB</div>
    </div>
    <input type="file" id="fileInput">
    <div class="form-group">
      <label class="form-label">管理员密钥（可选）</label>
      <input type="password" id="adminToken" class="form-input" placeholder="留空 = 12小时后自动删除；正确密钥 = 永久保存">
      <div class="form-hint">密钥仅在浏览器内使用</div>
    </div>
    <div class="form-group" style="display:flex;gap:8px">
      <button class="btn btn-primary" id="uploadBtn" onclick="upload()">⬆ 上传</button>
      <button class="btn btn-primary" style="background:#fff;color:#0078d4;border:1px solid #0078d4" onclick="loadList()">🔄 刷新列表</button>
    </div>
    <div class="progress" id="progress"><div class="progress-bar" id="progressBar"></div></div>
    <div id="msg" class="message"></div>
  </div>
  <div class="card">
    <h2 style="font-size:18px;margin-bottom:16px;color:#323130">文件列表</h2>
    <ul id="fileList" class="file-list"></ul>
  </div>
</div>
<script>
const $=id=>document.getElementById(id),dropZone=$('dropZone'),fileInput=$('fileInput');
let pending=null;
['dragenter','dragover'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.add('drag')}));
['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.remove('drag')}));
dropZone.addEventListener('drop',e=>{if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0])});
fileInput.addEventListener('change',e=>{if(e.target.files[0])setFile(e.target.files[0])});
function setFile(f){pending=f;$('dropText').textContent='已选择：'+f.name+' ('+fmtSize(f.size)+')'}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(2)+' MB'}
function fmtTime(ts){if(!ts)return'-';return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
function showMsg(t,type='success'){const m=$('msg');m.textContent=t;m.className='message '+type+' show';setTimeout(()=>m.classList.remove('show'),5000)}
async function upload(){
  if(!pending)return showMsg('请先选择文件','error');
  if(pending.size>26214400)return showMsg('文件超过 25MB','error');
  const fd=new FormData();fd.append('file',pending);fd.append('admin_token',$('adminToken').value);
  const btn=$('uploadBtn');btn.disabled=true;btn.textContent='上传中...';$('progress').style.display='block';
  try{
    const result=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('POST','/api/drive/upload');
      xhr.upload.onprogress=e=>{if(e.lengthComputable)$('progressBar').style.width=(e.loaded/e.total*100)+'%'};
      xhr.onload=()=>{try{resolve({status:xhr.status,body:JSON.parse(xhr.responseText)})}catch(e){reject(new Error('响应解析失败'))}};
      xhr.onerror=()=>reject(new Error('网络错误'));xhr.send(fd);
    });
    if(result.status===429){showMsg('✗ '+(result.body.error||'已被风控限制'),'error');return}
    if(result.body.success){showMsg('✓ 上传成功！'+(result.body.permanent?' (永久)':' (12小时后过期)'),'success');pending=null;fileInput.value='';$('dropText').textContent='点击或拖拽文件到此处上传';loadList()}
    else showMsg('✗ '+(result.body.error||'上传失败'),'error');
  }catch(e){showMsg('✗ '+e.message,'error')}
  finally{btn.disabled=false;btn.textContent='⬆ 上传';setTimeout(()=>{$('progress').style.display='none';$('progressBar').style.width='0'},800)}
}
async function loadList(){
  try{
    const r=await fetch('/api/drive/list'),d=await r.json(),ul=$('fileList');
    if(!d.success||!d.data||!d.data.length){ul.innerHTML='<div class="empty">暂无文件</div>';return}
    ul.innerHTML=d.data.map(f=>{
      const icon=f.type&&f.type.startsWith('image/')?'🖼️':f.type&&f.type.startsWith('video/')?'🎬':f.type&&f.type.startsWith('audio/')?'🎵':f.type==='application/pdf'?'📄':f.type&&f.type.startsWith('text/')?'📝':'📦';
      const badge=f.permanent?'<span class="badge permanent">永久</span>':'<span class="badge temp">临时</span>';
      const expire=f.permanent?'不过期':('过期：'+fmtTime(f.expiration));
      const link='/api/drive/file/'+f.id;
      return '<li class="file-item"><div class="file-icon">'+icon+'</div><div class="file-info"><div class="file-name">'+badge+escHtml(f.name||'(未命名)')+'</div><div class="file-meta">'+fmtSize(f.size||0)+' · 上传：'+fmtTime(f.uploadedAt)+' · '+expire+'</div></div><div class="file-actions"><a class="btn btn-primary btn-small" href="'+link+'" target="_blank">查看</a><a class="btn btn-primary btn-small" href="'+link+'" download="'+escHtml(f.name||'file')+'">下载</a><button class="btn btn-danger btn-small" onclick="copyLink(\\''+link+'\\')">复制链接</button><button class="btn btn-danger btn-small" onclick="del(\\''+f.id+'\\')">删除</button></div></li>';
    }).join('');
  }catch(e){$('fileList').innerHTML='<div class="empty">加载失败：'+e.message+'</div>'}
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function copyLink(p){const f=location.origin+p;navigator.clipboard.writeText(f).then(()=>showMsg('已复制：'+f,'success'),()=>showMsg('复制失败','error'))}
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
loadList();
</script>
</body>
</html>`;
}
function getPhyTestHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>物理小测验 - 清流中学非官方站</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f3f2f1;min-height:100vh;padding:20px}
.container{max-width:780px;margin:0 auto}
.back-link{display:inline-block;margin-bottom:20px;color:#0078d4;text-decoration:none;font-size:14px;font-weight:600}
.back-link:hover{text-decoration:underline}
.header{text-align:center;margin-bottom:24px}
.header h1{font-size:28px;color:#201f1e;margin-bottom:8px;font-weight:600}
.header p{font-size:14px;color:#605e5c}
.card{background:#fff;border-radius:8px;padding:24px;box-shadow:0 1.6px 3.6px rgba(0,0,0,.132);margin-bottom:16px}
.intro-card{text-align:center;padding:48px 32px}
.intro-icon{font-size:64px;margin-bottom:16px}
.intro-card h2{font-size:22px;color:#323130;margin-bottom:12px;font-weight:600}
.intro-card p{color:#605e5c;font-size:14px;line-height:1.7;margin-bottom:6px}
.btn{padding:10px 28px;font-size:15px;font-weight:600;border:none;border-radius:2px;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:#0078d4;color:#fff}
.btn-primary:hover:not(:disabled){background:#106ebe}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-outline{background:#fff;color:#0078d4;border:1px solid #0078d4}
.btn-outline:hover{background:#deecf9}
.progress-bar{position:sticky;top:0;background:#f3f2f1;padding:12px 0;margin-bottom:16px;z-index:5;border-bottom:1px solid #edebe9}
.progress-text{font-size:13px;color:#605e5c;margin-bottom:6px;display:flex;justify-content:space-between}
.progress-track{height:6px;background:#edebe9;border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:#0078d4;transition:width .2s}
.question-card{padding:20px 24px}
.q-header{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.q-num{background:#0078d4;color:#fff;font-size:12px;font-weight:600;padding:2px 8px;border-radius:2px}
.q-type{background:#edebe9;color:#605e5c;font-size:11px;font-weight:600;padding:2px 8px;border-radius:2px}
.q-topic{background:#fff;color:#0078d4;font-size:11px;padding:1px 8px;border:1px solid #c7e0f4;border-radius:2px}
.q-text{font-size:15px;color:#201f1e;line-height:1.7;margin-bottom:16px;word-break:break-word}
.options{display:flex;flex-direction:column;gap:8px}
.option{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border:1px solid #d2d0ce;border-radius:4px;cursor:pointer;transition:.15s;background:#fff;font-size:14px;color:#323130}
.option:hover{background:#f3f2f1;border-color:#0078d4}
.option.selected{background:#deecf9;border-color:#0078d4}
.option input{margin-top:3px;cursor:pointer;flex-shrink:0}
.option-label{flex:1;line-height:1.5}
.fill-input{width:100%;padding:8px 12px;font-size:14px;border:1px solid #8a8886;border-radius:2px;font-family:inherit}
.fill-input:focus{outline:none;border-color:#0078d4;box-shadow:0 0 0 1px #0078d4}
.submit-area{text-align:center;margin:24px 0 40px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.message{padding:12px 16px;border-radius:4px;margin-bottom:16px;font-size:14px;border-left:4px solid;display:none}
.message.show{display:block}
.message.error{background:#fde7e9;border-color:#a80000;color:#a80000}
.loading{text-align:center;padding:60px 20px;color:#605e5c}
.loading-spinner{border:3px solid #edebe9;border-top:3px solid #0078d4;border-radius:50%;width:36px;height:36px;animation:spin 1s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
.result-card{text-align:center;padding:40px 24px}
.score-circle{width:140px;height:140px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;margin:0 auto 20px;color:#fff;font-weight:600}
.score-circle.pass{background:linear-gradient(135deg,#107c10,#0b5a08)}
.score-circle.fail{background:linear-gradient(135deg,#a80000,#6e0000)}
.score-num{font-size:42px;line-height:1}
.score-label{font-size:12px;margin-top:4px;letter-spacing:2px}
.result-stats{display:flex;justify-content:center;gap:32px;margin:20px 0;flex-wrap:wrap}
.stat{text-align:center}
.stat-num{font-size:26px;font-weight:600;color:#201f1e}
.stat-label{font-size:12px;color:#605e5c;margin-top:2px}
.review-card{padding:16px 20px;border-left:4px solid}
.review-card.right{border-color:#107c10;background:#f3faf3}
.review-card.wrong{border-color:#a80000;background:#fdf3f4}
.review-q{font-size:14px;color:#201f1e;margin-bottom:8px;line-height:1.6}
.review-row{font-size:13px;color:#605e5c;margin-top:4px;word-break:break-word}
.review-row.correct{color:#107c10}
.review-row.wrong{color:#a80000}
@media (max-width:640px){.card{padding:18px}.intro-card{padding:32px 20px}.result-stats{gap:20px}.q-text{font-size:14px}}
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 返回首页</a>
  <div class="header">
    <h1>🔬 物理小测验</h1>
    <p>上海初中物理基础题 · 每次随机抽取 20 题</p>
  </div>

  <div id="introScreen">
    <div class="card intro-card">
      <div class="intro-icon">⚛️</div>
      <h2>准备好开始测验了吗？</h2>
      <p>本测验涵盖力学、热学、声学、光学、电学等上海初中物理基础知识点。</p>
      <p>共 20 题，包含选择题与填空题，题目顺序与选项顺序均会随机打乱。</p>
      <p style="margin-top:18px;color:#a4262c">提交后将立即看到成绩与每题解析。</p>
      <div style="margin-top:24px">
        <button class="btn btn-primary" onclick="startTest()">▶ 开始测验</button>
      </div>
    </div>
  </div>

  <div id="loadingScreen" style="display:none">
    <div class="card"><div class="loading"><div class="loading-spinner"></div>正在抽取题目...</div></div>
  </div>

  <div id="testScreen" style="display:none">
    <div class="progress-bar">
      <div class="progress-text"><span id="progressText">进度 0 / 40</span><span id="progressPercent">0%</span></div>
      <div class="progress-track"><div id="progressFill" class="progress-fill" style="width:0%"></div></div>
    </div>
    <div id="msgBox" class="message error"></div>
    <div id="questionsContainer"></div>
    <div class="submit-area">
      <button class="btn btn-outline" onclick="if(confirm('确定要放弃当前作答?'))location.reload()">放弃重来</button>
      <button class="btn btn-primary" id="submitBtn" onclick="submitTest()">📤 提交测验</button>
    </div>
  </div>

  <div id="resultScreen" style="display:none">
    <div class="card result-card">
      <div id="scoreCircle" class="score-circle pass">
        <div id="scoreNum" class="score-num">0</div>
        <div class="score-label">SCORE</div>
      </div>
      <h2 id="resultTitle" style="font-size:22px;color:#323130;margin-bottom:8px">测验完成!</h2>
      <p id="resultSubtitle" style="color:#605e5c"></p>
      <div class="result-stats">
        <div class="stat"><div id="statCorrect" class="stat-num" style="color:#107c10">0</div><div class="stat-label">答对</div></div>
        <div class="stat"><div id="statWrong" class="stat-num" style="color:#a80000">0</div><div class="stat-label">答错</div></div>
        <div class="stat"><div id="statTotal" class="stat-num">0</div><div class="stat-label">总题数</div></div>
      </div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-primary" onclick="location.reload()">🔄 再来一次</button>
        <button class="btn btn-outline" onclick="document.getElementById('reviewArea').scrollIntoView({behavior:'smooth'})">📝 查看解析</button>
      </div>
    </div>
    <h3 id="reviewArea" style="font-size:18px;color:#323130;margin:24px 0 12px">📝 答题解析</h3>
    <div id="reviewContainer"></div>
    <div class="submit-area">
      <button class="btn btn-primary" onclick="location.reload()">🔄 重新测验</button>
      <a href="/" class="btn btn-outline">🏠 返回首页</a>
    </div>
  </div>
</div>
<script>
const TYPE_LABELS={choice:'选择题',fill:'填空题'};
const TOPIC_LABELS={mechanics:'力学',machines:'简单机械',work:'功与功率',thermal:'热学',sound:'声学',optics:'光学',electricity:'电学'};
let questions=[],userAnswers={};

function esc(s){const d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML}

async function startTest(){
  document.getElementById('introScreen').style.display='none';
  document.getElementById('loadingScreen').style.display='block';
  try{
    const r=await fetch('/api/phy-test/questions');
    const d=await r.json();
    if(!d.success||!d.data||!d.data.length){
      alert('加载失败：'+(d.error||'题库为空'));location.reload();return;
    }
    questions=d.data;
    renderQuestions();
    document.getElementById('loadingScreen').style.display='none';
    document.getElementById('testScreen').style.display='block';
    updateProgress();
  }catch(e){alert('网络错误：'+e.message);location.reload();}
}

function renderQuestions(){
  const c=document.getElementById('questionsContainer');
  c.innerHTML=questions.map((q,i)=>{
    const num=i+1;
    const typeLab=TYPE_LABELS[q.type]||q.type;
    const topicLab=TOPIC_LABELS[q.topic]||(q.topic||'');
    const topicHtml=topicLab?'<span class="q-topic">'+esc(topicLab)+'</span>':'';
    let body='';
    if(q.type==='choice'&&Array.isArray(q.options)){
      body='<div class="options">'+q.options.map(opt=>(
        '<label class="option"><input type="radio" name="q_'+q.id+'" value="'+esc(opt)+'" onchange="setAnswer('+q.id+',this.value,this)"><span class="option-label">'+esc(opt)+'</span></label>'
      )).join('')+'</div>';
    }else{
      body='<input type="text" class="fill-input" placeholder="请输入答案..." oninput="setAnswer('+q.id+',this.value)" autocomplete="off">';
    }
    return '<div class="card question-card"><div class="q-header"><span class="q-num">第 '+num+' 题</span><span class="q-type">'+typeLab+'</span>'+topicHtml+'</div><div class="q-text">'+esc(q.question)+'</div>'+body+'</div>';
  }).join('');
}

function setAnswer(qid,val,inputEl){
  userAnswers[qid]=val;
  if(inputEl){
    const label=inputEl.closest('.option');
    const container=label.parentElement;
    container.querySelectorAll('.option').forEach(o=>o.classList.remove('selected'));
    label.classList.add('selected');
  }
  updateProgress();
}

function updateProgress(){
  const done=Object.values(userAnswers).filter(v=>v&&String(v).trim()).length;
  const total=questions.length;
  const pct=total?Math.round(done/total*100):0;
  document.getElementById('progressText').textContent='进度 '+done+' / '+total;
  document.getElementById('progressPercent').textContent=pct+'%';
  document.getElementById('progressFill').style.width=pct+'%';
}

async function submitTest(){
  const done=Object.values(userAnswers).filter(v=>v&&String(v).trim()).length;
  if(done<questions.length){
    if(!confirm('还有 '+(questions.length-done)+' 题未作答，确定提交?'))return;
  }
  // 没作答的题也送 id 上去，方便服务端返回解析
  questions.forEach(q=>{if(!(q.id in userAnswers))userAnswers[q.id]='';});
  const btn=document.getElementById('submitBtn');
  btn.disabled=true;btn.textContent='提交中...';
  const msg=document.getElementById('msgBox');msg.classList.remove('show');
  try{
    const r=await fetch('/api/phy-test/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:userAnswers})});
    const d=await r.json();
    if(!d.success){
      msg.textContent='提交失败：'+(d.error||'未知错误');msg.classList.add('show');
      btn.disabled=false;btn.textContent='📤 提交测验';return;
    }
    showResult(d);
  }catch(e){
    msg.textContent='网络错误：'+e.message;msg.classList.add('show');
    btn.disabled=false;btn.textContent='📤 提交测验';
  }
}

function showResult(res){
  document.getElementById('testScreen').style.display='none';
  document.getElementById('resultScreen').style.display='block';
  document.getElementById('scoreNum').textContent=res.score;
  document.getElementById('statCorrect').textContent=res.correct;
  document.getElementById('statWrong').textContent=res.wrong;
  document.getElementById('statTotal').textContent=res.total;
  const pass=res.score>=60;
  document.getElementById('scoreCircle').className='score-circle '+(pass?'pass':'fail');
  document.getElementById('resultTitle').textContent=pass?'恭喜通过!':'继续加油!';
  document.getElementById('resultSubtitle').textContent=pass?'你已掌握初中物理基础知识':'再认真复习一下相关知识点吧';
  // 按当前题目展示顺序对齐解析
  const detailMap=Object.fromEntries(res.details.map(d=>[d.id,d]));
  const ordered=questions.map(q=>detailMap[q.id]).filter(Boolean);
  const rc=document.getElementById('reviewContainer');
  rc.innerHTML=ordered.map((d,i)=>{
    const cls=d.correct?'right':'wrong';
    const icon=d.correct?'✓':'✗';
    const ua=d.userAnswer?esc(d.userAnswer):'<i style="color:#a80000">(未作答)</i>';
    return '<div class="card review-card '+cls+'"><div class="review-q"><strong>'+icon+' 第 '+(i+1)+' 题：</strong>'+esc(d.question)+'</div><div class="review-row '+(d.correct?'correct':'wrong')+'">你的答案：'+ua+'</div>'+(d.correct?'':'<div class="review-row correct">正确答案：'+esc(d.correctAnswer)+'</div>')+'</div>';
  }).join('');
  window.scrollTo({top:0,behavior:'smooth'});
}
</script>
</body>
</html>`;
}
