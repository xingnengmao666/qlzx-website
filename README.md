# 维护模式 & 404 页面使用指南 🛠️

## 📋 功能说明

这个系统提供了一个**维护模式**功能，管理员可以通过密钥控制：

- ✅ **开启维护模式**：除主页外，所有子页面（/news.html, /email-apply.html 等）都显示 404
- ✅ **关闭维护模式**：网站恢复正常访问
- ✅ **主页不受影响**：无论维护模式开启或关闭，主页始终可访问

---

## 🎯 使用场景

### 何时需要开启维护模式？

1. **网站升级维护**
   - 正在修改代码
   - 更新数据库结构
   - 调试Bug

2. **紧急情况处理**
   - 发现安全漏洞需要临时关闭
   - 数据库出现问题
   - 服务器负载过高

3. **内容审核**
   - 临时关闭某些功能
   - 等待内容审核通过

---

## 🚀 部署步骤

### 1️⃣ 更新数据库结构

需要添加 `settings` 表来存储维护模式状态。

**使用新的 SQL 文件：**

```bash
# D1 Console 中执行 schema-v2.sql 的内容
```

或者手动添加表：

```sql
-- 创建设置表
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- 插入默认值
INSERT INTO settings (key, value) VALUES ('maintenance_mode', 'false');
```

### 2️⃣ 更新 Worker 代码

用新的 `worker-d1-cron.js` 完整替换现有代码。

**网页端：**
```
Worker → Edit code → 粘贴新代码 → Save and deploy
```

**命令行：**
```bash
wrangler deploy
```

### 3️⃣ 验证部署

访问一个不存在的页面测试 404：
```
https://your-worker.workers.dev/test-404
```

应该看到精美的 404 页面。

---

## 🎮 使用方法

### 方法 1：使用管理控制台（推荐）

我已经为你准备好了一个可视化的管理控制台！

#### 步骤：

1. **下载控制台文件**
   - 文件：`maintenance-console.html`
   - 这是一个单页面HTML文件

2. **本地打开**
   - 直接用浏览器打开这个 HTML 文件
   - 或者上传到任何静态托管服务

3. **登录验证**
   - 输入你的 `ADMIN_TOKEN`
   - 点击"验证登录"

4. **控制维护模式**
   - 查看当前状态
   - 一键开启/关闭维护模式
   - 实时查看效果

**界面预览：**
```
┌─────────────────────────────────┐
│  🛠️ 维护模式管理控制台          │
├─────────────────────────────────┤
│  📊 当前状态                     │
│  维护模式：✅ 已关闭             │
│  [🔄 刷新状态]                   │
├─────────────────────────────────┤
│  ⚙️ 操作控制                     │
│  [🚫 开启维护模式]              │
│  [✅ 关闭维护模式]              │
└─────────────────────────────────┘
```

---

### 方法 2：浏览器控制台（快速）

#### 开启维护模式：

```javascript
fetch('https://your-worker.workers.dev/api/maintenance/enable', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_ADMIN_TOKEN'
  }
})
.then(r => r.json())
.then(data => console.log(data));
```

#### 关闭维护模式：

```javascript
fetch('https://your-worker.workers.dev/api/maintenance/disable', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_ADMIN_TOKEN'
  }
})
.then(r => r.json())
.then(data => console.log(data));
```

#### 查询当前状态：

```javascript
fetch('https://your-worker.workers.dev/api/maintenance/status', {
  headers: {
    'Authorization': 'Bearer YOUR_ADMIN_TOKEN'
  }
})
.then(r => r.json())
.then(data => console.log(data));
```

---

### 方法 3：命令行（适合自动化）

```bash
# 开启维护模式
curl -X POST https://your-worker.workers.dev/api/maintenance/enable \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# 关闭维护模式
curl -X POST https://your-worker.workers.dev/api/maintenance/disable \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# 查询状态
curl https://your-worker.workers.dev/api/maintenance/status \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## 📊 API 接口文档

### 1. 开启维护模式

**接口：** `POST /api/maintenance/enable`

**请求头：**
```
Authorization: Bearer YOUR_ADMIN_TOKEN
```

**响应：**
```json
{
  "success": true,
  "message": "维护模式已开启"
}
```

---

### 2. 关闭维护模式

**接口：** `POST /api/maintenance/disable`

**请求头：**
```
Authorization: Bearer YOUR_ADMIN_TOKEN
```

**响应：**
```json
{
  "success": true,
  "message": "维护模式已关闭"
}
```

---

### 3. 查询维护模式状态

**接口：** `GET /api/maintenance/status`

**请求头：**
```
Authorization: Bearer YOUR_ADMIN_TOKEN
```

**响应：**
```json
{
  "success": true,
  "maintenanceMode": false
}
```

---

## 🔄 工作流程

### 开启维护模式后：

```
用户访问流程：

访问主页 (/)
  ↓
✅ 正常显示（不受影响）

访问新闻页 (/news.html)
  ↓
🚫 显示 404 页面

访问邮箱申请 (/email-apply.html)
  ↓
🚫 显示 404 页面

访问任何其他页面
  ↓
🚫 显示 404 页面
```

### 关闭维护模式后：

```
所有页面恢复正常访问 ✅
```

---

## 🎨 404 页面特点

### 设计亮点：

- ✅ **渐变背景** - 紫色系渐变
- ✅ **动画效果** - 浮动圆圈、数字抖动
- ✅ **响应式** - 完美适配手机端
- ✅ **Fluent Design** - 符合整站设计风格
- ✅ **友好提示** - 显示可能的原因和解决方案

### 显示内容：

```
🔍

404

页面未找到

抱歉，您访问的页面不存在或已被移除。

⚠️ 可能的原因：
• 网址输入错误
• 页面已被删除或移动
• 网站正在维护中    ← 维护模式提示
• 链接已过期

[🏠 返回首页]  [📰 查看新闻]
```

---

## ⚠️ 注意事项

### 1. 主页不受维护模式影响

**原因：**
- 主页始终可访问
- 用户可以从主页了解维护信息
- 保持最基本的访问入口

### 2. API 端点不受影响

**仍然可用的 API：**
- `/api/maintenance/*` - 管理 API
- `/api/news` - 新闻 API（如果需要可以添加限制）
- `/api/update-news` - 手动更新

### 3. 数据库依赖

维护模式状态存储在 D1 数据库的 `settings` 表中。

**如果数据库查询失败：**
- 默认关闭维护模式（安全降级）
- 网站正常访问

---

## 🔍 故障排查

### Q1: 开启维护模式后没有效果？

**检查：**
1. 确认数据库更新成功
   ```sql
   SELECT * FROM settings WHERE key = 'maintenance_mode';
   ```
   应该看到 `value` 为 `'true'`

2. 清除浏览器缓存
   - Ctrl+Shift+R（强制刷新）

3. 查看 Worker 日志
   ```
   Worker → Logs
   ```

---

### Q2: 提示 Unauthorized (401)？

**原因：**
- ADMIN_TOKEN 不正确
- Authorization header 格式错误

**检查：**
```javascript
// 正确格式
'Authorization': 'Bearer mysecret123'

// 错误格式
'Authorization': 'mysecret123'  // 缺少 Bearer
'Authorization': 'Bearer  mysecret123'  // 多了空格
```

---

### Q3: 数据库报错？

**错误：** `no such table: settings`

**解决：**
1. 执行 `schema-v2.sql` 创建 settings 表
2. 或手动添加：
   ```sql
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   INSERT INTO settings (key, value) VALUES ('maintenance_mode', 'false');
   ```

---

### Q4: 如何强制关闭维护模式？

**方法 1：直接修改数据库**
```sql
-- D1 Console 执行
UPDATE settings SET value = 'false' WHERE key = 'maintenance_mode';
```

**方法 2：删除设置重置**
```sql
DELETE FROM settings WHERE key = 'maintenance_mode';
INSERT INTO settings (key, value) VALUES ('maintenance_mode', 'false');
```

---

## 💡 进阶用法

### 自定义维护模式行为

可以修改代码实现更复杂的逻辑：

#### 1. 白名单IP（只允许特定IP访问）

```javascript
async function handleRequest(request, env, ctx) {
  const clientIP = request.headers.get('CF-Connecting-IP');
  const whitelist = ['1.2.3.4', '5.6.7.8']; // 白名单IP
  
  const isMaintenanceMode = await checkMaintenanceMode(env);
  if (isMaintenanceMode && !whitelist.includes(clientIP)) {
    // 非白名单IP，显示404
    return new Response(get404HTML(), { status: 404 });
  }
  
  // 正常处理请求...
}
```

#### 2. 指定页面维护

```javascript
// 只维护特定页面
const maintenancePages = ['/news.html', '/email-apply.html'];
const isMaintenanceMode = await checkMaintenanceMode(env);

if (isMaintenanceMode && maintenancePages.includes(url.pathname)) {
  return new Response(get404HTML(), { status: 404 });
}
```

#### 3. 定时自动开启/关闭

可以结合 Cron 实现定时维护：

```javascript
// 在 scheduled() 函数中
async function handleScheduled(event, env, ctx) {
  const now = new Date();
  const hour = now.getHours();
  
  // 凌晨 2-4 点自动开启维护模式
  if (hour >= 2 && hour < 4) {
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('maintenance_mode', 'true').run();
  } else {
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('maintenance_mode', 'false').run();
  }
}
```

---

## 📚 完整文件清单

### 必需文件：
- ✅ `worker-d1-cron.js` - 更新的主程序
- ✅ `schema-v2.sql` - 新的数据库结构

### 可选文件：
- 📄 `maintenance-console.html` - 可视化管理控制台
- 📄 `MAINTENANCE-MODE-GUIDE.md` - 本文档

---

## 🎉 总结

你现在拥有：

1. ✅ **精美的 404 页面** - 动画效果 + 友好提示
2. ✅ **维护模式系统** - 一键开启/关闭
3. ✅ **管理控制台** - 可视化操作界面
4. ✅ **API 接口** - 支持自动化管理
5. ✅ **安全机制** - ADMIN_TOKEN 认证

**现在就开始使用吧！** 🚀
