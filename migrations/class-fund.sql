-- =====================================================================
-- 高一（7）班 · 班费收支账本 · D1 migration
--
-- 执行（远程库）:
--   npx wrangler d1 execute qlzx-news-db -c wrangler.old-news.toml --file=migrations/class-fund.sql --remote
-- 执行（本地库）:
--   npx wrangler d1 execute qlzx-news-db -c wrangler.old-news.toml --file=migrations/class-fund.sql --local
--
-- 全部语句幂等：重复执行不会重复插入账目（固定 id + INSERT OR IGNORE +
-- settings 里的 fund_seeded 标记双重保险，见指导2 §54）。
-- Worker 里 ensureFundTables() 也会建同样的表，所以不跑这个文件页面也能用，
-- 只是没有初始数据；初始数据也可以走后台「班费收支 · 初始化」。
-- =====================================================================

-- 账目表。金额一律以「分」为单位的整数存（amount_cents），不用浮点，
-- 保证 440.00 - 197.29 = 242.71 这类计算不出现误差（指导2 §28）。
-- kind 明确区分 income / expense，不靠正负号猜（指导2 §27）。
CREATE TABLE IF NOT EXISTS class_fund (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  class_label  TEXT    NOT NULL DEFAULT '高一（7）班',
  kind         TEXT    NOT NULL,                 -- 'income' 收入 | 'expense' 支出
  occurred_on  TEXT    NOT NULL,                 -- 'YYYY-MM-DD'，账目发生日期
  account      TEXT    NOT NULL DEFAULT '微信',   -- 微信 / 支付宝 / 现金 / 银行卡 …
  amount_cents INTEGER NOT NULL,                 -- 金额，单位「分」，恒为正整数
  verified     INTEGER NOT NULL DEFAULT 0,       -- 0 待核对 | 1 已核对
  note         TEXT    NOT NULL DEFAULT '',      -- 收入来源 / 支出用途
  evidence_key TEXT    NOT NULL DEFAULT '',      -- 凭证（支付截图）在 KV 里的 key，空 = 没上传
  created_by   TEXT    NOT NULL DEFAULT 'admin',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 老库（没有 evidence_key 这一列）不用手动改：Worker 的 ensureFundTables() 每次进账目
-- 接口都会跑一次 ALTER TABLE 补列。这里不写 ALTER 是为了保住「整段重复执行不报错」。

CREATE INDEX IF NOT EXISTS idx_fund_date   ON class_fund(occurred_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fund_kind   ON class_fund(kind, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_fund_verify ON class_fund(verified);

-- 最小化修改记录（指导2 §29）：只记谁在什么时候把哪条账目改成了什么样，
-- 不做完整审计平台。
CREATE TABLE IF NOT EXISTS class_fund_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id     INTEGER NOT NULL,
  action      TEXT    NOT NULL,              -- create | update | verify | delete
  before_json TEXT    NOT NULL DEFAULT '',
  after_json  TEXT    NOT NULL DEFAULT '',
  actor       TEXT    NOT NULL DEFAULT 'admin',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fund_audit_time ON class_fund_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- ---------------------------------------------------------------------
-- 初始数据：来源《高一（7）班班费收支明细表》原始表格，未做任何修改或补充。
-- 原始表格未给出「核对」具体状态，故一律按待核对(0)；未给出收入备注，故留空
-- （指导2 §16 / §18：没有数据不编造）。
-- 固定 id 1-6 + INSERT OR IGNORE：重复执行幂等。
-- ---------------------------------------------------------------------
INSERT OR IGNORE INTO class_fund (id, class_label, kind, occurred_on, account, amount_cents, verified, note, created_by, created_at, updated_at) VALUES
  (1, '高一（7）班', 'income',  '2026-09-01', '微信', 44000, 0, '',                    'seed', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  (2, '高一（7）班', 'expense', '2026-08-31', '微信',   579, 0, '钟表挂钩',              'seed', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  (3, '高一（7）班', 'expense', '2026-09-02', '微信',   400, 0, '白板笔1黑+1红',         'seed', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  (4, '高一（7）班', 'expense', '2026-09-05', '微信', 16000, 0, '教师节老师礼物16盆植物', 'seed', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  (5, '高一（7）班', 'expense', '2026-09-11', '微信',   670, 0, '扫把挂钩四个',          'seed', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  (6, '高一（7）班', 'expense', '2026-09-16', '微信',  2080, 0, '磁性座位表',            'seed', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- 种子标记：后台「初始化」据此判断是否已经导过，避免重复插（指导2 §54）。
INSERT OR IGNORE INTO settings (key, value) VALUES ('fund_seeded', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fund_class_label', '高一（7）班');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fund_title', '班费收支');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fund_slogan', '每一笔班费，都清清楚楚地记录在这里。');
