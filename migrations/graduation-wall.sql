-- ============================================================
-- 毕业留言墙 · D1 迁移（库：qlzx-news-db / Worker: normal-welcomed-page）
-- 执行: npx wrangler d1 execute qlzx-news-db --remote --file=migrations/graduation-wall.sql
-- 说明: Worker 首次调用留言墙接口时会自动建同样的表（ensureWallTables），
--       这里留档一份，方便手动执行/审阅。全部 IF NOT EXISTS，不会动已有数据。
-- 复用: 留言墙配置存已有 settings 表（key 前缀 grad_wall_），不新建配置表。
-- ============================================================

-- 留言本体：匿名只影响展示，署名在入库时就清空。
-- ip 存明文（后台可见真实 IP），ip_hash 只用于限流/举报去重，两者都落库。
CREATE TABLE IF NOT EXISTS wall_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  class_label TEXT NOT NULL DEFAULT '',
  paper TEXT NOT NULL DEFAULT 'cream',
  anonymous INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'visible',   -- visible | hidden | deleted
  report_count INTEGER NOT NULL DEFAULT 0,
  client_token TEXT NOT NULL DEFAULT '',   -- 幂等令牌：同一次草稿重复提交只落一条
  ip_hash TEXT NOT NULL DEFAULT '',        -- 限流/去重用
  ip TEXT NOT NULL DEFAULT '',             -- 后台展示的真实 IP
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wall_token ON wall_messages(client_token) WHERE client_token <> '';
CREATE INDEX IF NOT EXISTS idx_wall_feed ON wall_messages(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_wall_class ON wall_messages(class_label, id DESC);

-- 举报：同一 IP 对同一条留言只能举报一次
CREATE TABLE IF NOT EXISTS wall_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | dismissed
  ip_hash TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  handled_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wall_report_once ON wall_reports(message_id, ip_hash) WHERE ip_hash <> '';
CREATE INDEX IF NOT EXISTS idx_wall_report_status ON wall_reports(status, id DESC);

-- 存量库补 ip 明文列（新库不用跑；Worker 的 ensureWallTables 也会自愈补一次）
-- ALTER TABLE wall_messages ADD COLUMN ip TEXT NOT NULL DEFAULT '';
-- ALTER TABLE wall_reports  ADD COLUMN ip TEXT NOT NULL DEFAULT '';

-- 默认配置（不覆盖已有值）
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('grad_wall_title', '2026 届毕业留言墙'),
  ('grad_wall_year', '2026'),
  ('grad_wall_slogan', '把想说的话，留在这一年的墙上。'),
  ('grad_wall_open', 'true'),
  ('grad_wall_closed_note', '这一年的留言已经收好了。'),
  ('grad_wall_classes', '["高三(1)班","高三(2)班","高三(3)班","高三(4)班","高三(5)班","高三(6)班","初三(1)班","初三(2)班","初三(3)班","初三(4)班","其他"]');
