-- D1 数据库表结构
-- 用于存储新闻数据和系统设置

-- 删除已存在的表（如果存在）
DROP TABLE IF EXISTS news;
DROP TABLE IF EXISTS settings;

-- 创建新闻表
CREATE TABLE news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                -- 新闻标题
  link TEXT NOT NULL,                 -- 新闻链接
  description TEXT,                   -- 新闻摘要
  source TEXT NOT NULL,               -- 新闻来源（知乎、微博等）
  pub_date INTEGER,                   -- 发布时间（时间戳）
  created_at INTEGER NOT NULL,        -- 入库时间（时间戳）
  UNIQUE(title, source)               -- 防止同一来源的重复新闻
);

-- 创建系统设置表（用于维护模式等配置）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,               -- 设置键名
  value TEXT NOT NULL,                -- 设置值
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)  -- 更新时间
);

-- 创建索引以提高查询性能
CREATE INDEX idx_created_at ON news(created_at DESC);
CREATE INDEX idx_source ON news(source);
CREATE INDEX idx_pub_date ON news(pub_date DESC);

-- 插入默认设置
INSERT INTO settings (key, value) VALUES ('maintenance_mode', 'false');

-- 插入测试数据（可选）
INSERT INTO news (title, link, description, source, pub_date, created_at) VALUES
  ('测试新闻1', 'https://example.com/1', '这是一条测试新闻', '测试来源', strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000),
  ('测试新闻2', 'https://example.com/2', '这是另一条测试新闻', '测试来源', strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000);
