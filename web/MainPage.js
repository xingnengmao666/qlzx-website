export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  
  // Cron 定时任务入口
  async scheduled(event, env, ctx) {
    await handleScheduled(env, ctx);
  }
};

/* ================= 主路由 ================= */

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const country = request.cf?.country || 'UNKNOWN';
  const isChina = country === 'CN';

  // 管理API：开启维护模式
  if (url.pathname === '/api/maintenance/enable' && request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader === `Bearer ${env.ADMIN_TOKEN}`) {
      await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('maintenance_mode', 'true').run();
      return new Response(JSON.stringify({ success: true, message: '维护模式已开启' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Unauthorized', { status: 401 });
  }

  // 管理API：关闭维护模式
  if (url.pathname === '/api/maintenance/disable' && request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader === `Bearer ${env.ADMIN_TOKEN}`) {
      await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('maintenance_mode', 'false').run();
      return new Response(JSON.stringify({ success: true, message: '维护模式已关闭' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Unauthorized', { status: 401 });
  }

  // 管理API：查询维护模式状态
  if (url.pathname === '/api/maintenance/status') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader === `Bearer ${env.ADMIN_TOKEN}`) {
      const isMaintenanceMode = await checkMaintenanceMode(env);
      return new Response(JSON.stringify({ 
        success: true, 
        maintenanceMode: isMaintenanceMode 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Unauthorized', { status: 401 });
  }

  // 检查维护模式（主页除外）
  if (url.pathname !== '/' && url.pathname !== '/404' && url.pathname !== '/404.html') {
    const isMaintenanceMode = await checkMaintenanceMode(env);
    if (isMaintenanceMode) {
      return new Response(get404HTML(), {
        status: 404,
        headers: { 'content-type': 'text/html;charset=UTF-8' }
      });
    }
  }

  // 表单提交
  if (url.pathname === '/submit-application' && request.method === 'POST') {
    return handleFormSubmit(request, env);
  }

  // 邮箱申请页
  if (url.pathname === '/email-apply.html' || url.pathname === '/email-apply') {
    return new Response(getEmailApplyHTML(), {
      headers: { 'content-type': 'text/html;charset=UTF-8' }
    });
  }

  // 新闻页面
  if (url.pathname === '/news.html' || url.pathname === '/news') {
    return new Response(getNewsHTML(), {
      headers: { 'content-type': 'text/html;charset=UTF-8' }
    });
  }

  // 新闻数据API - 从 D1 读取
  if (url.pathname === '/api/news') {
    return handleNewsAPI(env);
  }

  // 倒计时页面
  if (url.pathname === '/countdown.html' || url.pathname === '/countdown') {
    return new Response(getCountdownHTML(), {
      headers: { 'content-type': 'text/html;charset=UTF-8' }
    });
  }

  // 倒计时数据 API
  if (url.pathname === '/api/countdowns') {
    return handleCountdownsAPI(env);
  }

  // 添加倒计时 API
  if (url.pathname === '/api/countdown/add' && request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader === `Bearer ${env.ADMIN_TOKEN}`) {
      return handleAddCountdown(request, env);
    }
    return new Response('Unauthorized', { status: 401 });
  }

  // 删除倒计时 API
  if (url.pathname === '/api/countdown/delete' && request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader === `Bearer ${env.ADMIN_TOKEN}`) {
      return handleDeleteCountdown(request, env);
    }
    return new Response('Unauthorized', { status: 401 });
  }

  // 手动触发更新（可选，用于测试）
  if (url.pathname === '/api/update-news' && request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader === `Bearer ${env.ADMIN_TOKEN}`) {
      await updateNewsTask(env);
      return new Response(JSON.stringify({ success: true, message: '新闻更新完成' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Unauthorized', { status: 401 });
  }

  // 404 页面（直接访问）
  if (url.pathname === '/404' || url.pathname === '/404.html') {
    return new Response(get404HTML(), {
      status: 404,
      headers: { 'content-type': 'text/html;charset=UTF-8' }
    });
  }

  // 主页
  if (url.pathname === '/') {
    return new Response(getMainHTML(isChina), {
      headers: { 'content-type': 'text/html;charset=UTF-8' }
    });
  }

  // 其他未定义路径返回 404
  return new Response(get404HTML(), {
    status: 404,
    headers: { 'content-type': 'text/html;charset=UTF-8' }
  });
}

/* ================= 维护模式检查 ================= */

async function checkMaintenanceMode(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('maintenance_mode').all();
    
    if (results && results.length > 0) {
      return results[0].value === 'true';
    }
    return false;
  } catch (error) {
    // 如果表不存在或查询失败，返回 false（不启用维护模式）
    console.error('检查维护模式失败:', error);
    return false;
  }
}

/* ================= Cron 定时任务处理 ================= */

async function handleScheduled(env, ctx) {
  console.log('Cron 任务开始执行:', new Date().toISOString());
  
  try {
    await updateNewsTask(env);
    console.log('Cron 任务执行成功');
  } catch (error) {
    console.error('Cron 任务执行失败:', error);
  }
}

/* ================= 新闻更新任务 ================= */

async function updateNewsTask(env) {
  // 1. 清空旧数据
  await clearOldNews(env);
  
  // 2. 爬取新闻
  const newsData = await fetchAllNews();
  
  // 3. 存入 D1 数据库
  await saveNewsToD1(env, newsData);
  
  console.log(`已更新 ${newsData.length} 条新闻到数据库`);
}

// 清空旧新闻（只保留最近的数据）
async function clearOldNews(env) {
  try {
    // 删除所有旧数据
    await env.DB.prepare('DELETE FROM news').run();
    console.log('已清空旧新闻数据');
  } catch (error) {
    console.error('清空数据失败:', error);
  }
}

// 保存新闻到 D1
async function saveNewsToD1(env, newsArray) {
  if (!newsArray || newsArray.length === 0) {
    console.log('没有新闻需要保存');
    return;
  }

  try {
    // 批量插入
    const stmt = env.DB.prepare(`
      INSERT INTO news (title, link, description, source, pub_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const batch = newsArray.map(item => 
      stmt.bind(
        item.title,
        item.link,
        item.description || '',
        item.source,
        item.pubDate,
        Date.now()
      )
    );

    await env.DB.batch(batch);
    console.log(`成功保存 ${newsArray.length} 条新闻`);
  } catch (error) {
    console.error('保存新闻失败:', error);
    throw error;
  }
}

/* ================= 新闻 API - 从 D1 读取 ================= */

async function handleNewsAPI(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT title, link, description, source, pub_date, created_at
      FROM news
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

    // 转换为前端需要的格式
    const newsData = results.map(row => ({
      title: row.title,
      link: row.link,
      description: row.description,
      source: row.source,
      pubDate: row.pub_date
    }));

    // 获取最后更新时间
    const { results: updateInfo } = await env.DB.prepare(`
      SELECT MAX(created_at) as last_update FROM news
    `).all();

    const lastUpdate = updateInfo[0]?.last_update || Date.now();
    const updateTime = new Date(lastUpdate).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai'
    });

    return new Response(JSON.stringify({
      success: true,
      data: newsData,
      updateTime: updateTime,
      count: newsData.length
    }), {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'public, max-age=60' // 缓存1分钟
      }
    });
  } catch (error) {
    console.error('读取新闻失败:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
}

/* ================= 新闻爬取逻辑（稳定版 - 使用可靠API） ================= */

async function fetchAllNews() {
  const newsSources = [
    { name: 'V2EX热门', fetch: fetchV2EXHot },
    { name: '微博热搜', fetch: fetchWeiboHotNew },
    { name: 'Hacker News', fetch: fetchHackerNews },
    { name: 'GitHub Trending', fetch: fetchGitHubTrending },
    { name: '少数派', fetch: fetchSsPaiNews }
  ];

  const results = await Promise.allSettled(
    newsSources.map(async source => {
      try {
        const news = await source.fetch();
        return news.map(item => ({ ...item, source: source.name }));
      } catch (err) {
        console.error(`${source.name} 获取失败:`, err);
        return [];
      }
    })
  );

  let allNews = [];
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      allNews = allNews.concat(result.value);
    }
  });

  return allNews;
}

// V2EX 热门话题（官方API，极其稳定）
async function fetchV2EXHot() {
  try {
    const response = await fetch('https://www.v2ex.com/api/topics/hot.json', {
      signal: AbortSignal.timeout(8000)
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    
    return data.slice(0, 15).map(item => ({
      title: item.title,
      link: `https://www.v2ex.com/t/${item.id}`,
      description: item.content ? item.content.slice(0, 100) : '',
      pubDate: item.created ? item.created * 1000 : Date.now()
    }));
  } catch (error) {
    console.error('V2EX 获取失败:', error);
    return [];
  }
}

// Hacker News Top Stories（官方API，极其稳定）
async function fetchHackerNews() {
  try {
    // 获取热门故事ID列表
    const response = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
      signal: AbortSignal.timeout(8000)
    });
    
    if (!response.ok) return [];
    
    const ids = await response.json();
    if (!Array.isArray(ids)) return [];
    
    // 获取前10条详情
    const topIds = ids.slice(0, 10);
    const items = await Promise.all(
      topIds.map(id => 
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          signal: AbortSignal.timeout(5000)
        })
          .then(r => r.json())
          .catch(() => null)
      )
    );
    
    return items.filter(Boolean).map(item => ({
      title: item.title,
      link: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      description: `${item.score || 0} points | ${item.descendants || 0} comments`,
      pubDate: item.time ? item.time * 1000 : Date.now()
    }));
  } catch (error) {
    console.error('Hacker News 获取失败:', error);
    return [];
  }
}

// GitHub Trending（非官方API，较稳定）
async function fetchGitHubTrending() {
  try {
    const response = await fetch('https://api.gitterapp.com/repositories', {
      signal: AbortSignal.timeout(8000)
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    
    return data.slice(0, 10).map(item => ({
      title: `${item.name} - ${item.description || '无描述'}`,
      link: item.url || `https://github.com/${item.fullName}`,
      description: `⭐ ${item.stars || 0} | ${item.language || 'Unknown'}`,
      pubDate: Date.now()
    }));
  } catch (error) {
    console.error('GitHub Trending 获取失败:', error);
    return [];
  }
}

// 少数派最新文章（RSS，稳定）
async function fetchSsPaiNews() {
  try {
    const response = await fetch('https://sspai.com/feed', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    
    if (!response.ok) return [];
    
    const text = await response.text();
    return parseRSS(text).slice(0, 10);
  } catch (error) {
    console.error('少数派获取失败:', error);
    return [];
  }
}

// 微博热搜（orz.ai API，稳定）
async function fetchWeiboHotNew() {
  try {
    const response = await fetch('https://orz.ai/api/v1/dailynews/?platform=weibo', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    
    // 根据API响应结构解析数据
    if (data && data.data && Array.isArray(data.data)) {
      return data.data.slice(0, 15).map(item => ({
        title: item.title || item.query || '',
        link: item.url || item.link || `https://s.weibo.com/weibo?q=${encodeURIComponent(item.title || item.query || '')}`,
        description: item.desc || item.hot || item.word || '',
        pubDate: item.timestamp ? item.timestamp * 1000 : Date.now()
      }));
    }
    
    // 如果数据结构不同，尝试其他可能的格式
    if (Array.isArray(data)) {
      return data.slice(0, 15).map(item => ({
        title: item.title || item.query || '',
        link: item.url || item.link || `https://s.weibo.com/weibo?q=${encodeURIComponent(item.title || item.query || '')}`,
        description: item.desc || item.hot || item.word || '',
        pubDate: item.timestamp ? item.timestamp * 1000 : Date.now()
      }));
    }
    
    return [];
  } catch (error) {
    console.error('微博热搜获取失败:', error);
    return [];
  }
}



// RSS 解析器
function parseRSS(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemContent = match[1];
    const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(itemContent) ||
                      /<title>(.*?)<\/title>/.exec(itemContent);
    const linkMatch = /<link>(.*?)<\/link>/.exec(itemContent);
    const descMatch = /<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(itemContent) ||
                     /<description>(.*?)<\/description>/.exec(itemContent);
    const dateMatch = /<pubDate>(.*?)<\/pubDate>/.exec(itemContent);
    
    if (titleMatch) {
      items.push({
        title: titleMatch[1].trim(),
        link: linkMatch ? linkMatch[1].trim() : '',
        description: descMatch ? stripHtml(descMatch[1].trim()).slice(0, 100) : '',
        pubDate: dateMatch ? new Date(dateMatch[1]).getTime() : Date.now()
      });
    }
  }
  
  return items;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/* ================= 表单处理（保持不变） ================= */

async function handleFormSubmit(request, env) {
  try {
    const formData = await request.formData();

    // 验证 Turnstile token
    const turnstileToken = formData.get('cf-turnstile-response');
    
    if (!turnstileToken) {
      return new Response(JSON.stringify({
        success: false,
        error: '请完成人机验证'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证 Turnstile token
    const turnstileResult = await verifyTurnstile(turnstileToken, env);
    
    if (!turnstileResult.success) {
      return new Response(JSON.stringify({
        success: false,
        error: '人机验证失败，请重试'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const applicationData = {
      username: formData.get('username'),
      realName: formData.get('realName'),
      studentId: formData.get('studentId') || '未提供',
      contactEmail: formData.get('contactEmail'),
      purpose: formData.get('purpose'),
      reason: formData.get('reason'),
      timestamp: new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai'
      })
    };

    const repoOwner = env.GITHUB_REPO_OWNER;
    const repoName  = env.GITHUB_REPO_NAME;
    const githubPat = env.GITHUB_PAT;

    if (!repoOwner || !repoName || !githubPat) {
      throw new Error('GitHub 环境变量未正确配置');
    }

    const res = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubPat}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'cloudflare-worker'
        },
        body: JSON.stringify({
          event_type: 'send-email',
          client_payload: applicationData
        })
      }
    );

    if (res.status === 204) {
      return new Response(JSON.stringify({
        success: true,
        message: '申请已提交，我们将尽快处理！'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const errText = await res.text();
    console.error('GitHub API Error:', res.status, errText);

    return new Response(JSON.stringify({
      success: false,
      error: 'GitHub 接口返回错误'
    }), { status: 500 });

  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message || '提交失败'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* ================= Turnstile 验证 ================= */

async function verifyTurnstile(token, env) {
  try {
    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
        }),
      }
    );

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Turnstile 验证失败:', error);
    return { success: false };
  }
}

/* ================= 倒计时功能 ================= */

// 获取所有倒计时
async function handleCountdownsAPI(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, title, target_time, created_at
      FROM countdowns
      ORDER BY target_time ASC
    `).all();

    return new Response(JSON.stringify({
      success: true,
      data: results
    }), {
      headers: { 
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'public, max-age=30'
      }
    });
  } catch (error) {
    console.error('获取倒计时失败:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
}

// 添加倒计时
async function handleAddCountdown(request, env) {
  try {
    const body = await request.json();
    const { title, target_time } = body;

    if (!title || !target_time) {
      return new Response(JSON.stringify({
        success: false,
        error: '标题和目标时间不能为空'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证时间格式
    const targetTimestamp = new Date(target_time).getTime();
    if (isNaN(targetTimestamp)) {
      return new Response(JSON.stringify({
        success: false,
        error: '无效的时间格式'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await env.DB.prepare(`
      INSERT INTO countdowns (title, target_time, created_at)
      VALUES (?, ?, ?)
    `).bind(title, targetTimestamp, Date.now()).run();

    return new Response(JSON.stringify({
      success: true,
      message: '倒计时添加成功'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('添加倒计时失败:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 删除倒计时
async function handleDeleteCountdown(request, env) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({
        success: false,
        error: 'ID 不能为空'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await env.DB.prepare(`
      DELETE FROM countdowns WHERE id = ?
    `).bind(id).run();

    return new Response(JSON.stringify({
      success: true,
      message: '倒计时删除成功'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('删除倒计时失败:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* ================= 主页 HTML ================= */

function getMainHTML(isChina) {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>清流中学非官方站</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: 'Microsoft YaHei', Arial, sans-serif; overflow: hidden; position: relative; }
    .gradient-bg { position: fixed; inset: 0; background: linear-gradient(-45deg, #667eea, #764ba2, #f093fb, #4facfe); background-size: 400% 400%; animation: gradientFlow 15s ease infinite; z-index: -1; }
    @keyframes gradientFlow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
    
    /* 开源公告横幅 */
    .announcement-banner {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      padding: 12px 24px;
      border-radius: 50px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 1000;
      animation: slideDown 0.6s ease-out;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    
    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translate(-50%, -20px);
      }
      to {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    }
    
    .announcement-banner:hover {
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.15);
      transform: translateX(-50%) translateY(-2px);
      transition: all 0.3s ease;
    }
    
    .announcement-icon {
      font-size: 20px;
      animation: pulse 2s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    
    .announcement-text {
      font-size: 14px;
      color: #333;
      font-weight: 500;
    }
    
    .github-link {
      color: #0078d4;
      text-decoration: none;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }
    
    .github-link:hover {
      color: #106ebe;
      transform: translateY(-1px);
    }
    
    .github-icon {
      font-size: 16px;
    }
    
    .container { text-align: center; padding: 20px; z-index: 1; }
    h1 { font-size: 4rem; color: #fff; margin-bottom: 2rem; min-height: 5rem; text-shadow: 2px 2px 4px rgba(0,0,0,.3); }
    .cursor { animation: blink 1s infinite; }
    @keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
    .subtitle { font-size: 1.5rem; color: rgba(255,255,255,.9); margin-top: 2rem; }
    .button-container { margin-top: 3rem; display: flex; gap: 1.5rem; justify-content: center; flex-wrap: wrap; }
    .action-btn { padding: 12px 30px; color:#fff; border-radius:50px; border:2px solid rgba(255,255,255,.4); text-decoration:none; backdrop-filter: blur(10px); transition:.3s; }
    .action-btn:hover { transform: translateY(-3px); background: rgba(255,255,255,.25); }
    
    /* 响应式设计 */
    @media (max-width: 640px) {
      .announcement-banner {
        top: 10px;
        padding: 10px 20px;
        max-width: 90%;
      }
      .announcement-text {
        font-size: 12px;
      }
      .announcement-icon {
        font-size: 16px;
      }
    }
  </style>
</head>
<body>
<div class="gradient-bg"></div>

<!-- 开源公告横幅 -->
<div class="announcement-banner">
  <span class="announcement-icon">⭐</span>
  <span class="announcement-text">
    本项目已在 GitHub 开源：
    <a href="https://github.com/xingnengmao666/qlzx-website" class="github-link" target="_blank" rel="noopener noreferrer">
      <span class="github-icon">🔗</span>
      <span>qlzx-website</span>
    </a>
  </span>
</div>

<div class="container">
  <h1 id="text"><span class="cursor">|</span></h1>
  <div class="subtitle">如遇问题请联系 support@mail.qlzx.lol</div>
  <div class="button-container">
    <a href="https://mirror.qlzx.lol" class="action-btn">📥 下载镜像中转</a>
    <a href="https://ping0.cc" class="action-btn">🌐 IP检测</a>
    <a href="https://time.qlzx.lol" class="action-btn">🕐 北京时间</a>
    <a href="https://dy.pdedu.sh.cn/phyEdu/student/#/home" class="action-btn">🏃 中考体育报名</a>
    <a href="/news.html" class="action-btn">📰 热点新闻</a>
    <a href="/email-apply.html" class="action-btn">📧 邮箱申请</a>
  </div>
</div>
<script>
  const t='清流中学非官方站';let i=0,d=false,e=document.getElementById('text');
  (function f(){if(!d){if(i<t.length){e.innerHTML=t.slice(0,++i)+'<span class="cursor">|</span>';setTimeout(f,150)}else setTimeout(()=>{d=true;f()},2000)}
  else{if(i>0){e.innerHTML=t.slice(0,--i)+'<span class="cursor">|</span>';setTimeout(f,100)}else{d=false;setTimeout(f,500)}}})();
</script>
</body>
</html>`;
}

/* ================= 新闻页面 HTML ================= */

function getNewsHTML() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>热点新闻 - 清流中学非官方站</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #f3f2f1; min-height: 100vh; padding: 20px; }
    .container { max-width: 900px; margin: 40px auto; }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-size: 28px; font-weight: 600; color: #201f1e; margin-bottom: 8px; }
    .header p { font-size: 14px; color: #605e5c; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #0078d4; text-decoration: none; font-size: 14px; font-weight: 600; }
    .back-link:hover { text-decoration: underline; }
    
    .loading { text-align: center; padding: 60px 20px; }
    .loading-spinner { border: 3px solid #f3f2f1; border-top: 3px solid #0078d4; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    
    .update-info { text-align: center; color: #605e5c; font-size: 13px; margin-bottom: 24px; }
    .refresh-btn { background: #0078d4; color: white; border: none; padding: 6px 16px; border-radius: 2px; cursor: pointer; font-size: 13px; margin-left: 8px; }
    .refresh-btn:hover { background: #106ebe; }
    
    .timeline { position: relative; padding-left: 40px; }
    .timeline::before { content: ''; position: absolute; left: 15px; top: 0; bottom: 0; width: 2px; background: #d2d0ce; }
    
    .news-item { position: relative; margin-bottom: 32px; background: white; border-radius: 8px; padding: 20px 24px; box-shadow: 0 1.6px 3.6px rgba(0,0,0,0.132), 0 0.3px 0.9px rgba(0,0,0,0.108); transition: all 0.2s; animation: fadeIn 0.5s ease; }
    .news-item:hover { transform: translateX(4px); box-shadow: 0 3.2px 7.2px rgba(0,0,0,0.132), 0 0.6px 1.8px rgba(0,0,0,0.108); }
    
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    
    .news-item::before { content: ''; position: absolute; left: -31px; top: 24px; width: 12px; height: 12px; background: #0078d4; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 0 2px #0078d4; }
    
    .news-source { display: inline-block; background: #0078d4; color: white; padding: 2px 8px; border-radius: 2px; font-size: 11px; font-weight: 600; margin-bottom: 8px; }
    
    .news-title { font-size: 18px; font-weight: 600; color: #201f1e; margin-bottom: 8px; line-height: 1.4; }
    .news-title a { color: inherit; text-decoration: none; }
    .news-title a:hover { color: #0078d4; }
    
    .news-description { font-size: 14px; color: #605e5c; line-height: 1.6; margin-bottom: 8px; }
    
    .news-time { font-size: 12px; color: #8a8886; }
    
    .error-message { background: #fde7e9; border-left: 4px solid #a80000; color: #a80000; padding: 16px; border-radius: 4px; margin: 20px 0; }
    
    .empty-state { text-align: center; padding: 60px 20px; color: #605e5c; }
    .empty-state svg { width: 64px; height: 64px; margin-bottom: 16px; opacity: 0.5; }
    
    @media (max-width: 640px) {
      .container { margin: 20px auto; }
      .timeline { padding-left: 30px; }
      .timeline::before { left: 10px; }
      .news-item::before { left: -26px; }
      .news-item { padding: 16px 20px; }
      .news-title { font-size: 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">← 返回首页</a>
    <div class="header">
      <h1>📰 热点新闻</h1>
      <p>实时聚合各大平台热门话题</p>
    </div>
    
    <div id="updateInfo" class="update-info" style="display:none;">
      最后更新：<span id="updateTime">-</span>
      <button class="refresh-btn" onclick="location.reload()">🔄 刷新</button>
    </div>
    
    <div id="loading" class="loading">
      <div class="loading-spinner"></div>
      <div>正在加载新闻...</div>
    </div>
    
    <div id="error" class="error-message" style="display:none;"></div>
    
    <div id="timeline" class="timeline" style="display:none;"></div>
  </div>

  <script>
    async function loadNews() {
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
      const timeline = document.getElementById('timeline');
      const updateInfo = document.getElementById('updateInfo');
      
      loading.style.display = 'block';
      error.style.display = 'none';
      timeline.style.display = 'none';
      
      try {
        const response = await fetch('/api/news');
        const result = await response.json();
        
        if (result.success && result.data && result.data.length > 0) {
          displayNews(result.data);
          document.getElementById('updateTime').textContent = result.updateTime;
          updateInfo.style.display = 'block';
          timeline.style.display = 'block';
        } else {
          showEmpty();
        }
      } catch (err) {
        error.textContent = '⚠️ 加载失败：' + err.message;
        error.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    }
    
    function displayNews(newsArray) {
      const timeline = document.getElementById('timeline');
      timeline.innerHTML = '';
      
      newsArray.forEach((item, index) => {
        const newsItem = document.createElement('div');
        newsItem.className = 'news-item';
        newsItem.style.animationDelay = (index * 0.05) + 's';
        
        const time = item.pubDate ? formatTime(item.pubDate) : '刚刚';
        const description = item.description ? \`<div class="news-description">\${escapeHtml(item.description)}</div>\` : '';
        
        newsItem.innerHTML = \`
          <div class="news-source">\${escapeHtml(item.source || '未知来源')}</div>
          <div class="news-title">
            \${item.link ? \`<a href="\${escapeHtml(item.link)}" target="_blank" rel="noopener">\${escapeHtml(item.title)}</a>\` : escapeHtml(item.title)}
          </div>
          \${description}
          <div class="news-time">⏰ \${time}</div>
        \`;
        
        timeline.appendChild(newsItem);
      });
    }
    
    function formatTime(timestamp) {
      const now = Date.now();
      const diff = now - timestamp;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return minutes + '分钟前';
      if (hours < 24) return hours + '小时前';
      if (days < 7) return days + '天前';
      
      const date = new Date(timestamp);
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function showEmpty() {
      const timeline = document.getElementById('timeline');
      timeline.innerHTML = \`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <div>暂无新闻数据</div>
        </div>
      \`;
      timeline.style.display = 'block';
    }
    
    loadNews();
  </script>
</body>
</html>
  `;
}

/* ================= 邮箱申请页 HTML（保持不变） ================= */

function getEmailApplyHTML() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>邮箱申请 - 清流中学非官方站</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #f3f2f1; min-height: 100vh; padding: 20px; }
    .container { max-width: 600px; margin: 40px auto; }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-size: 28px; font-weight: 600; color: #201f1e; margin-bottom: 8px; }
    .header p { font-size: 14px; color: #605e5c; }
    .card { background: white; border-radius: 8px; box-shadow: 0 1.6px 3.6px rgba(0,0,0,0.132), 0 0.3px 0.9px rgba(0,0,0,0.108); padding: 32px; }
    .form-group { margin-bottom: 24px; }
    .form-label { display: block; font-size: 14px; font-weight: 600; color: #323130; margin-bottom: 8px; }
    .required { color: #a4262c; margin-left: 4px; }
    .form-input, .form-textarea, .form-select { width: 100%; padding: 8px 12px; font-size: 14px; font-family: inherit; border: 1px solid #8a8886; border-radius: 2px; background: white; transition: all 0.1s ease; }
    .form-input:hover, .form-textarea:hover, .form-select:hover { border-color: #323130; }
    .form-input:focus, .form-textarea:focus, .form-select:focus { outline: none; border-color: #0078d4; box-shadow: 0 0 0 1px #0078d4; }
    .form-textarea { min-height: 100px; resize: vertical; }
    .form-hint { font-size: 12px; color: #605e5c; margin-top: 4px; }
    .checkbox-group { display: flex; align-items: flex-start; margin-bottom: 24px; }
    .checkbox-input { margin-right: 8px; margin-top: 2px; cursor: pointer; }
    .checkbox-label { font-size: 14px; color: #323130; cursor: pointer; user-select: none; }
    .button-group { display: flex; gap: 12px; margin-top: 32px; }
    .btn { padding: 8px 20px; font-size: 14px; font-weight: 600; border: none; border-radius: 2px; cursor: pointer; transition: all 0.1s ease; font-family: inherit; }
    .btn-primary { background: #0078d4; color: white; }
    .btn-primary:hover:not(:disabled) { background: #106ebe; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-default { background: white; color: #323130; border: 1px solid #8a8886; }
    .btn-default:hover { background: #f3f2f1; }
    .message { padding: 12px 16px; border-radius: 2px; margin-bottom: 24px; font-size: 14px; }
    .message.success { background: #dff6dd; border-left: 4px solid #107c10; color: #0b5a08; display: none; }
    .message.error { background: #fde7e9; border-left: 4px solid #a80000; color: #a80000; display: none; }
    .message.show { display: block; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #0078d4; text-decoration: none; font-size: 14px; font-weight: 600; }
    .back-link:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      .container { margin: 20px auto; }
      .card { padding: 24px; }
      .button-group { flex-direction: column; }
      .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">← 返回首页</a>
    <div class="header">
      <h1>📧 邮箱申请</h1>
      <p>申请 @mail.qlzx.lol 专属邮箱</p>
    </div>
    
    <div id="successMessage" class="message success">
      ✓ 申请已提交成功！我们将在 1-3 个工作日内审核并通过邮件通知您。
    </div>
    <div id="errorMessage" class="message error"></div>
    
    <div class="card">
      <form id="emailForm">
        <div class="form-group">
          <label class="form-label">期望的邮箱地址<span class="required">*</span></label>
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="text" class="form-input" id="username" name="username" placeholder="yourusername" required pattern="[a-z0-9._-]+" style="flex: 1;">
            <span style="color: #605e5c;">@mail.qlzx.lol</span>
          </div>
          <div class="form-hint">只能包含小写字母、数字、点、下划线和连字符</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="realName">真实姓名<span class="required">*</span></label>
          <input type="text" class="form-input" id="realName" name="realName" required placeholder="请输入您的真实姓名">
        </div>
        <div class="form-group">
          <label class="form-label" for="studentId">学号（如适用）</label>
          <input type="text" class="form-input" id="studentId" name="studentId" placeholder="如果您是学生，请填写学号">
        </div>
        <div class="form-group">
          <label class="form-label" for="contactEmail">备用联系邮箱<span class="required">*</span></label>
          <input type="email" class="form-input" id="contactEmail" name="contactEmail" required placeholder="用于接收审核结果">
          <div class="form-hint">我们将通过此邮箱通知您申请结果</div>
        </div>
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
        <div class="form-group">
          <label class="form-label" for="reason">申请理由<span class="required">*</span></label>
          <textarea class="form-textarea" id="reason" name="reason" required placeholder="请简要说明您申请此邮箱的原因"></textarea>
        </div>
        <div class="checkbox-group">
          <input type="checkbox" class="checkbox-input" id="agree" required>
          <label class="checkbox-label" for="agree">我已阅读并同意遵守邮箱使用规范，承诺不使用邮箱进行违法违规活动</label>
        </div>
        
        <!-- Cloudflare Turnstile 验证码 -->
        <div class="form-group">
          <label class="form-label">人机验证<span class="required">*</span></label>
          <div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY" data-theme="light"></div>
          <div class="form-hint">请完成人机验证以继续</div>
        </div>
        
        <div class="button-group">
          <button type="submit" class="btn btn-primary" id="submitBtn">提交申请</button>
          <button type="reset" class="btn btn-default">重置表单</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Turnstile Script -->
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

  <script>
    const form = document.getElementById('emailForm');
    const submitBtn = document.getElementById('submitBtn');
    const successMessage = document.getElementById('successMessage');
    const errorMessage = document.getElementById('errorMessage');
    const usernameInput = document.getElementById('username');
    
    usernameInput.addEventListener('input', function(e) {
      this.value = this.value.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    });
    
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';
      successMessage.classList.remove('show');
      errorMessage.classList.remove('show');
      
      const formData = new FormData(form);
      
      try {
        const response = await fetch('/submit-application', {
          method: 'POST',
          body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
          successMessage.textContent = '✓ ' + (result.message || '申请已提交成功！我们将在 1-3 个工作日内审核并通过邮件通知您。');
          successMessage.classList.add('show');
          form.reset();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          errorMessage.textContent = '✗ ' + (result.error || '提交失败，请重试');
          errorMessage.classList.add('show');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } catch (error) {
        errorMessage.textContent = '✗ 网络错误，请稍后重试';
        errorMessage.classList.add('show');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '提交申请';
      }
    });
    
    form.addEventListener('reset', function() {
      successMessage.classList.remove('show');
      errorMessage.classList.remove('show');
    });
  </script>
</body>
</html>
  `;
}

/* ================= 404 页面 HTML ================= */

function get404HTML() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - 页面未找到</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      overflow: hidden;
      position: relative;
    }
    
    .background {
      position: fixed;
      inset: 0;
      overflow: hidden;
      z-index: 0;
    }
    .circle {
      position: absolute;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      animation: float 20s infinite;
    }
    .circle:nth-child(1) { width: 80px; height: 80px; left: 10%; top: 20%; animation-delay: 0s; }
    .circle:nth-child(2) { width: 120px; height: 120px; right: 15%; top: 40%; animation-delay: 2s; }
    .circle:nth-child(3) { width: 60px; height: 60px; left: 20%; bottom: 30%; animation-delay: 4s; }
    .circle:nth-child(4) { width: 100px; height: 100px; right: 25%; bottom: 20%; animation-delay: 6s; }
    
    @keyframes float {
      0%, 100% { transform: translateY(0px) rotate(0deg); }
      50% { transform: translateY(-50px) rotate(180deg); }
    }
    
    .container {
      text-align: center;
      z-index: 1;
      max-width: 600px;
      background: rgba(255, 255, 255, 0.95);
      border-radius: 20px;
      padding: 60px 40px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.6s ease-out;
    }
    
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .error-code {
      font-size: 120px;
      font-weight: 900;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 20px;
      line-height: 1;
      animation: glitch 3s infinite;
    }
    
    @keyframes glitch {
      0%, 100% { transform: translate(0); }
      20% { transform: translate(-2px, 2px); }
      40% { transform: translate(-2px, -2px); }
      60% { transform: translate(2px, 2px); }
      80% { transform: translate(2px, -2px); }
    }
    
    .error-title {
      font-size: 32px;
      font-weight: 700;
      color: #323130;
      margin-bottom: 16px;
    }
    
    .error-message {
      font-size: 16px;
      color: #605e5c;
      line-height: 1.6;
      margin-bottom: 40px;
    }
    
    .error-reason {
      background: #fff4ce;
      border-left: 4px solid #ffd800;
      padding: 16px;
      margin-bottom: 40px;
      text-align: left;
      border-radius: 4px;
    }
    
    .error-reason strong {
      color: #323130;
      display: block;
      margin-bottom: 8px;
    }
    
    .error-reason ul {
      margin-left: 20px;
      color: #605e5c;
      font-size: 14px;
    }
    
    .error-reason li {
      margin: 4px 0;
    }
    
    .btn-group {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
    }
    
    .btn {
      padding: 12px 32px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.3s ease;
      display: inline-block;
    }
    
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
    }
    
    .btn-secondary {
      background: white;
      color: #667eea;
      border: 2px solid #667eea;
    }
    
    .btn-secondary:hover {
      background: #667eea;
      color: white;
    }
    
    .icon {
      font-size: 80px;
      margin-bottom: 20px;
      animation: bounce 2s infinite;
    }
    
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    
    @media (max-width: 640px) {
      .container {
        padding: 40px 24px;
      }
      .error-code {
        font-size: 80px;
      }
      .error-title {
        font-size: 24px;
      }
      .btn-group {
        flex-direction: column;
      }
      .btn {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="background">
    <div class="circle"></div>
    <div class="circle"></div>
    <div class="circle"></div>
    <div class="circle"></div>
  </div>
  
  <div class="container">
    <div class="icon">🔍</div>
    <div class="error-code">404</div>
    <h1 class="error-title">页面未找到</h1>
    <p class="error-message">
      抱歉，您访问的页面不存在或已被移除。
    </p>
    
    <div class="error-reason">
      <strong>⚠️ 可能的原因：</strong>
      <ul>
        <li>网址输入错误</li>
        <li>页面已被删除或移动</li>
        <li>网站正在维护中</li>
        <li>链接已过期</li>
      </ul>
    </div>
    
    <div class="btn-group">
      <a href="/" class="btn btn-primary">🏠 返回首页</a>
      <a href="/news.html" class="btn btn-secondary">📰 查看新闻</a>
    </div>
  </div>
</body>
</html>
  `;
}

/* ================= 倒计时页面 HTML ================= */


/* ================= 倒计时页面 HTML（纯CSS+JS实现） ================= */


/* ================= 倒计时页面 HTML（机场翻牌效果 + Fluent Design） ================= */


/* ================= 倒计时页面 HTML（机场翻牌 + Fluent UI） ================= */


/* ================= 倒计时页面 HTML（机场翻牌机效果，Fluent Design） ================= */

function getCountdownHTML() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>倒计时 - 清流中学非官方站</title>
  
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: #f3f2f1;
      min-height: 100vh;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .header {
      text-align: center;
      margin-bottom: 40px;
      padding-top: 20px;
    }
    
    .header h1 {
      font-size: 42px;
      font-weight: 600;
      color: #201f1e;
      margin-bottom: 8px;
    }
    
    .header p {
      font-size: 16px;
      color: #605e5c;
    }
    
    .back-link {
      display: inline-block;
      margin-bottom: 20px;
      color: #0078d4;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      transition: color 0.2s;
    }
    
    .back-link:hover {
      color: #106ebe;
      text-decoration: underline;
    }
    
    .countdown-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }
    
    .countdown-card {
      background: #ffffff;
      border-radius: 8px;
      padding: 32px;
      box-shadow: 0 1.6px 3.6px rgba(0,0,0,0.132), 0 0.3px 0.9px rgba(0,0,0,0.108);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      border: 1px solid #edebe9;
    }
    
    .countdown-card:hover {
      box-shadow: 0 6.4px 14.4px rgba(0,0,0,0.132), 0 1.2px 3.6px rgba(0,0,0,0.108);
      transform: translateY(-2px);
    }
    
    .countdown-title {
      font-size: 24px;
      font-weight: 600;
      color: #323130;
      margin-bottom: 24px;
      text-align: center;
    }
    
    .flip-clock {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin: 24px 0;
    }
    
    .flip-unit {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    
    .flip-label {
      font-size: 11px;
      color: #605e5c;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .flip-card-container {
      display: flex;
      gap: 3px;
    }
    
    /* 机场翻牌机核心样式 */
    .flip-card {
      position: relative;
      width: 48px;
      height: 64px;
      perspective: 200px;
    }
    
    /* 上半部分（固定） */
    .flip-card-top {
      position: absolute;
      width: 100%;
      height: 50%;
      top: 0;
      left: 0;
      background: #0078d4;
      border-radius: 4px 4px 0 0;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.14);
    }
    
    .flip-card-top::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: rgba(0, 0, 0, 0.2);
    }
    
    /* 下半部分（固定） */
    .flip-card-bottom {
      position: absolute;
      width: 100%;
      height: 50%;
      bottom: 0;
      left: 0;
      background: #0078d4;
      border-radius: 0 0 4px 4px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.14);
    }
    
    /* 翻牌的上半部分 */
    .flip-card-top-flip {
      position: absolute;
      width: 100%;
      height: 50%;
      top: 0;
      left: 0;
      background: #0078d4;
      border-radius: 4px 4px 0 0;
      overflow: hidden;
      transform-origin: bottom;
      transform: rotateX(0deg);
      z-index: 2;
      box-shadow: 0 2px 4px rgba(0,0,0,0.14);
    }
    
    .flip-card-top-flip::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: rgba(0, 0, 0, 0.2);
    }
    
    /* 翻牌的下半部分 */
    .flip-card-bottom-flip {
      position: absolute;
      width: 100%;
      height: 50%;
      bottom: 0;
      left: 0;
      background: #0078d4;
      border-radius: 0 0 4px 4px;
      overflow: hidden;
      transform-origin: top;
      transform: rotateX(0deg);
      z-index: 1;
      box-shadow: 0 2px 4px rgba(0,0,0,0.14);
    }
    
    /* 翻牌动画 */
    .flip-card.flipping .flip-card-top-flip {
      animation: flipTop 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .flip-card.flipping .flip-card-bottom-flip {
      animation: flipBottom 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    @keyframes flipTop {
      0% {
        transform: rotateX(0deg);
      }
      100% {
        transform: rotateX(-90deg);
      }
    }
    
    @keyframes flipBottom {
      0% {
        transform: rotateX(90deg);
      }
      100% {
        transform: rotateX(0deg);
      }
    }
    
    /* 数字显示 */
    .flip-number {
      position: absolute;
      width: 100%;
      height: 200%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      font-weight: 600;
      color: #ffffff;
    }
    
    /* 上半部分的数字 */
    .flip-card-top .flip-number,
    .flip-card-top-flip .flip-number {
      top: 0;
    }
    
    /* 下半部分的数字 */
    .flip-card-bottom .flip-number,
    .flip-card-bottom-flip .flip-number {
      bottom: 0;
    }
    
    .countdown-complete {
      text-align: center;
      padding: 48px 24px;
      background: #f3f2f1;
      border-radius: 8px;
      border: 2px solid #107c10;
    }
    
    .countdown-complete h3 {
      font-size: 28px;
      font-weight: 600;
      color: #107c10;
      margin-bottom: 8px;
    }
    
    .countdown-complete p {
      font-size: 16px;
      color: #323130;
    }
    
    .delete-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: #f3f2f1;
      color: #605e5c;
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
      transition: all 0.1s;
      opacity: 0;
      z-index: 10;
    }
    
    .delete-btn:hover {
      background: #e1dfdd;
      color: #a4262c;
    }
    
    .countdown-card:hover .delete-btn {
      opacity: 1;
    }
    
    .admin-section {
      text-align: center;
      margin-top: 40px;
    }
    
    .admin-btn {
      background: #0078d4;
      color: #ffffff;
      border: none;
      padding: 12px 32px;
      border-radius: 4px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(0,0,0,0.14);
      transition: all 0.1s;
    }
    
    .admin-btn:hover {
      background: #106ebe;
    }
    
    .admin-panel {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.4);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    
    .admin-panel.active {
      display: flex;
    }
    
    .admin-content {
      background: #ffffff;
      border-radius: 8px;
      padding: 32px;
      width: 90%;
      max-width: 500px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.24);
    }
    
    .close-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: none;
      border: none;
      font-size: 20px;
      color: #605e5c;
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 4px;
      transition: all 0.1s;
    }
    
    .close-btn:hover {
      background: #f3f2f1;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #323130;
      margin-bottom: 8px;
    }
    
    .form-input {
      width: 100%;
      padding: 8px 12px;
      font-size: 14px;
      border: 1px solid #8a8886;
      border-radius: 2px;
      transition: all 0.1s;
    }
    
    .form-input:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 1px #0078d4;
    }
    
    .submit-btn {
      width: 100%;
      background: #0078d4;
      color: #ffffff;
      border: none;
      padding: 10px;
      border-radius: 2px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    
    .submit-btn:hover {
      background: #106ebe;
    }
    
    .empty-state {
      text-align: center;
      padding: 80px 40px;
      background: #ffffff;
      border-radius: 8px;
      border: 2px dashed #d2d0ce;
    }
    
    .empty-state-icon {
      font-size: 64px;
      margin-bottom: 16px;
      opacity: 0.6;
    }
    
    .empty-state h2 {
      font-size: 24px;
      font-weight: 600;
      color: #323130;
      margin-bottom: 8px;
    }
    
    .empty-state p {
      font-size: 14px;
      color: #605e5c;
    }
    
    .message {
      padding: 12px 16px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
      border-left: 4px solid;
    }
    
    .message.success {
      background: #dff6dd;
      border-color: #107c10;
      color: #0b5a08;
    }
    
    .message.error {
      background: #fde7e9;
      border-color: #a80000;
      color: #a80000;
    }
    
    .message.show {
      display: block;
    }
    
    @media (max-width: 768px) {
      .header h1 { font-size: 32px; }
      .countdown-grid { grid-template-columns: 1fr; gap: 16px; }
      .countdown-card { padding: 24px; }
      .flip-card { width: 40px; height: 56px; }
      .flip-number { font-size: 30px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">← 返回首页</a>
    
    <div class="header">
      <h1>⏰ 倒计时</h1>
      <p>重要时刻，倒数计时</p>
    </div>
    
    <div id="countdownGrid" class="countdown-grid"></div>
    
    <div class="admin-section">
      <button class="admin-btn" onclick="openAdminPanel()">➕ 管理倒计时</button>
    </div>
  </div>
  
  <div id="adminPanel" class="admin-panel">
    <div class="admin-content">
      <button class="close-btn" onclick="closeAdminPanel()">×</button>
      <h2 style="margin-bottom: 24px; color: #323130; font-size: 20px; font-weight: 600;">管理倒计时</h2>
      
      <div id="message" class="message"></div>
      
      <div class="form-group">
        <label class="form-label">管理员密钥</label>
        <input type="password" id="adminToken" class="form-input" placeholder="请输入 ADMIN_TOKEN">
      </div>
      
      <div class="form-group">
        <label class="form-label">倒计时标题</label>
        <input type="text" id="countdownTitle" class="form-input" placeholder="例如：高考倒计时">
      </div>
      
      <div class="form-group">
        <label class="form-label">目标日期时间</label>
        <input type="datetime-local" id="targetTime" class="form-input">
      </div>
      
      <button class="submit-btn" onclick="addCountdown()">添加倒计时</button>
    </div>
  </div>
  
  <script>
    let countdowns = [];
    let intervalIds = [];
    
    async function loadCountdowns() {
      try {
        const response = await fetch('/api/countdowns');
        const data = await response.json();
        if (data.success) {
          countdowns = data.data;
          renderCountdowns();
        }
      } catch (error) {
        console.error('加载倒计时失败:', error);
      }
    }
    
    function clearAllIntervals() {
      intervalIds.forEach(id => clearInterval(id));
      intervalIds = [];
    }
    
    function renderCountdowns() {
      clearAllIntervals();
      const grid = document.getElementById('countdownGrid');
      
      if (countdowns.length === 0) {
        grid.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">⏰</div>
            <h2>还没有倒计时</h2>
            <p>点击下方按钮添加你的第一个倒计时吧</p>
          </div>
        \`;
        return;
      }
      
      grid.innerHTML = '';
      
      countdowns.forEach((countdown) => {
        const now = Date.now();
        const target = countdown.target_time;
        
        if (target <= now) {
          const card = document.createElement('div');
          card.className = 'countdown-card';
          card.innerHTML = \`
            <button class="delete-btn" onclick="deleteCountdown(\${countdown.id})">×</button>
            <div class="countdown-complete">
              <h3>🎉 \${countdown.title}</h3>
              <p>时间已到！</p>
            </div>
          \`;
          grid.appendChild(card);
        } else {
          const card = document.createElement('div');
          card.className = 'countdown-card';
          card.innerHTML = \`
            <button class="delete-btn" onclick="deleteCountdown(\${countdown.id})">×</button>
            <div class="countdown-title">\${countdown.title}</div>
            <div id="countdown-\${countdown.id}" class="flip-clock"></div>
          \`;
          grid.appendChild(card);
          startCountdown(countdown.id, target);
        }
      });
    }
    
    function startCountdown(id, targetTime) {
      const container = document.getElementById(\`countdown-\${id}\`);
      
      // 创建翻牌时钟结构
      const units = [
        { label: 'Days', ids: ['days1', 'days2', 'days3'] },
        { label: 'Hours', ids: ['hours1', 'hours2'] },
        { label: 'Minutes', ids: ['minutes1', 'minutes2'] },
        { label: 'Seconds', ids: ['seconds1', 'seconds2'] }
      ];
      
      let html = '';
      units.forEach(unit => {
        html += \`<div class="flip-unit"><div class="flip-label">\${unit.label}</div><div class="flip-card-container">\`;
        unit.ids.forEach(digitId => {
          html += \`
            <div class="flip-card" id="\${digitId}-\${id}">
              <div class="flip-card-top">
                <div class="flip-number" id="\${digitId}-current-top-\${id}">0</div>
              </div>
              <div class="flip-card-bottom">
                <div class="flip-number" id="\${digitId}-current-bottom-\${id}">0</div>
              </div>
              <div class="flip-card-top-flip" id="\${digitId}-top-flip-\${id}" style="display:none">
                <div class="flip-number" id="\${digitId}-next-top-\${id}">0</div>
              </div>
              <div class="flip-card-bottom-flip" id="\${digitId}-bottom-flip-\${id}" style="display:none">
                <div class="flip-number" id="\${digitId}-next-bottom-\${id}">0</div>
              </div>
            </div>
          \`;
        });
        html += \`</div></div>\`;
      });
      
      container.innerHTML = html;
      
      function update() {
        const now = Date.now();
        const diff = targetTime - now;
        
        if (diff <= 0) {
          loadCountdowns();
          return;
        }
        
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        updateDigit(\`days1-\${id}\`, Math.floor(days / 100));
        updateDigit(\`days2-\${id}\`, Math.floor((days % 100) / 10));
        updateDigit(\`days3-\${id}\`, days % 10);
        updateDigit(\`hours1-\${id}\`, Math.floor(hours / 10));
        updateDigit(\`hours2-\${id}\`, hours % 10);
        updateDigit(\`minutes1-\${id}\`, Math.floor(minutes / 10));
        updateDigit(\`minutes2-\${id}\`, minutes % 10);
        updateDigit(\`seconds1-\${id}\`, Math.floor(seconds / 10));
        updateDigit(\`seconds2-\${id}\`, seconds % 10);
      }
      
      update();
      const intervalId = setInterval(update, 1000);
      intervalIds.push(intervalId);
    }
    
    // 【机场翻牌机效果】更新单个数字
    function updateDigit(digitId, newValue) {
      const currentTop = document.getElementById(\`\${digitId}-current-top\`);
      const currentBottom = document.getElementById(\`\${digitId}-current-bottom\`);
      
      if (!currentTop || !currentBottom) return;
      
      const currentValue = parseInt(currentTop.textContent) || 0;
      
      if (currentValue !== newValue) {
        const card = document.getElementById(digitId);
        const topFlip = document.getElementById(\`\${digitId}-top-flip\`);
        const bottomFlip = document.getElementById(\`\${digitId}-bottom-flip\`);
        const nextTop = document.getElementById(\`\${digitId}-next-top\`);
        const nextBottom = document.getElementById(\`\${digitId}-next-bottom\`);
        
        if (!card || !topFlip || !bottomFlip || !nextTop || !nextBottom) return;
        
        // 防止重复动画
        if (card.classList.contains('flipping')) return;
        
        // 设置新数字
        nextTop.textContent = newValue;
        nextBottom.textContent = newValue;
        
        // 显示翻牌元素
        topFlip.style.display = 'block';
        bottomFlip.style.display = 'block';
        
        // 开始翻牌动画
        card.classList.add('flipping');
        
        // 动画结束后更新当前数字并隐藏翻牌元素
        setTimeout(() => {
          currentTop.textContent = newValue;
          currentBottom.textContent = newValue;
          topFlip.style.display = 'none';
          bottomFlip.style.display = 'none';
          card.classList.remove('flipping');
        }, 600);
      }
    }
    
    function openAdminPanel() {
      document.getElementById('adminPanel').classList.add('active');
      const savedToken = localStorage.getItem('admin_token');
      if (savedToken) {
        document.getElementById('adminToken').value = savedToken;
      }
    }
    
    function closeAdminPanel() {
      document.getElementById('adminPanel').classList.remove('active');
      hideMessage();
    }
    
    async function addCountdown() {
      const token = document.getElementById('adminToken').value.trim();
      const title = document.getElementById('countdownTitle').value.trim();
      const targetTime = document.getElementById('targetTime').value;
      
      if (!token) {
        showMessage('请输入管理员密钥', 'error');
        return;
      }
      
      if (!title) {
        showMessage('请输入倒计时标题', 'error');
        return;
      }
      
      if (!targetTime) {
        showMessage('请选择目标日期时间', 'error');
        return;
      }
      
      try {
        const response = await fetch('/api/countdown/add', {
          method: 'POST',
          headers: {
            'Authorization': \`Bearer \${token}\`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            title: title,
            target_time: new Date(targetTime).toISOString()
          })
        });
        
        const data = await response.json();
        
        if (data.success) {
          localStorage.setItem('admin_token', token);
          showMessage('倒计时添加成功！', 'success');
          document.getElementById('countdownTitle').value = '';
          document.getElementById('targetTime').value = '';
          
          setTimeout(() => {
            closeAdminPanel();
            loadCountdowns();
          }, 1500);
        } else {
          showMessage(data.error || '添加失败', 'error');
        }
      } catch (error) {
        showMessage('网络错误：' + error.message, 'error');
      }
    }
    
    async function deleteCountdown(id) {
      if (!confirm('确定要删除这个倒计时吗？')) {
        return;
      }
      
      const token = localStorage.getItem('admin_token');
      if (!token) {
        alert('请先在管理面板中输入管理员密钥');
        return;
      }
      
      try {
        const response = await fetch('/api/countdown/delete', {
          method: 'POST',
          headers: {
            'Authorization': \`Bearer \${token}\`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id })
        });
        
        const data = await response.json();
        
        if (data.success) {
          loadCountdowns();
        } else {
          alert(data.error || '删除失败');
        }
      } catch (error) {
        alert('网络错误：' + error.message);
      }
    }
    
    function showMessage(text, type) {
      const message = document.getElementById('message');
      message.textContent = text;
      message.className = \`message \${type} show\`;
      setTimeout(() => hideMessage(), 5000);
    }
    
    function hideMessage() {
      const message = document.getElementById('message');
      message.classList.remove('show');
    }
    
    loadCountdowns();
    setInterval(loadCountdowns, 30000);
  </script>
</body>
</html>
  `;
}
