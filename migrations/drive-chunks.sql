-- ============================================================
-- 云盘分片存储 · D1 迁移（库：jpc_d1 / Worker: jpc-normal-page）
-- 执行: npx wrangler d1 execute jpc_d1 --remote --file=migrations/drive-chunks.sql
-- 说明: Worker 首次调用任何接口时会在「旧库补列」里自动补这一列（ensureSchema），
--       这里留档一份，方便手动执行/审阅。
--
-- chunk_count 的含义：
--   0  = 老格式，整份文件存在单个 KV 键 file:<id> 里
--   >0 = 分片存储，键是 file:<id>:0 .. file:<id>:(chunk_count-1)，每片 ≤24MiB
-- KV 单值上限 25MiB，大文件只能切开存；片大小取 24MiB 是为了留余量。
-- 老行默认 0，下载/删除会走单键分支，不需要回填数据。
-- ============================================================

ALTER TABLE drive_files ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
