-- ============================================================
-- 建平世纪中学非官方站 · 账号系统初始化 SQL
-- 用途: 用户账号 / 邮箱验证码 / 英语单词本 / 网盘文件元数据
-- 执行: wrangler d1 execute jianping-db --file=init-accounts.sql
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- PBKDF2 格式: salt_hex:hash_hex
  role TEXT NOT NULL DEFAULT 'user',    -- 'user' | 'admin'
  created_at INTEGER NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT NOT NULL DEFAULT '',      -- 头像链接（imgur.la）
  banned INTEGER NOT NULL DEFAULT 0,    -- 1=已封禁
  pending_email TEXT NOT NULL DEFAULT '' -- 改绑邮箱待验证的新邮箱
);

-- 已有库补列（列已存在会报 duplicate column，可忽略）
-- ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
-- ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE users ADD COLUMN pending_email TEXT NOT NULL DEFAULT '';

-- 邮箱验证码（60s 有效, 5 次尝试上限, 一码一用）
CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,              -- SHA-256(验证码), 不存明文
  purpose TEXT NOT NULL DEFAULT 'register',  -- 'register'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codes_email ON email_codes(email, purpose);

-- 英语单词本（每用户最多 150 条）
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word TEXT NOT NULL,
  translation TEXT NOT NULL,            -- 中文释义
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, word)
);
CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id);

-- 网盘文件元数据（文件内容在 FILES_KV, key = "file:<id>")
CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY,                  -- UUID, 对应 KV key
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  uploaded_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_drive_user ON drive_files(user_id);
