const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const DB_PATH_DEFAULT = path.join(__dirname, 'mail_cache_default.db');
let db = null;
let currentDbEmail = null;

// AES-256-GCM 加解密配置
const ENCRYPTION_KEY = Buffer.from(process.env.DB_ENC_KEY || '0123456789abcdef0123456789abcdef');
const IV_LENGTH = 12;

function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (e) {
    console.error('加密失败:', e);
    return text;
  }
}

function decrypt(text) {
  if (!text) return text;
  try {
    const parts = text.split(':');
    if (parts.length !== 3) return text;
    const [ivHex, authTagHex, encryptedText] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('解密失败:', e);
    return text;
  }
}

// 切换/初始化指定账号的独立物理数据库
function switchAccountDb(email) {
  if (!email) return Promise.resolve();
  const safeEmail = email.replace(/[^a-zA-Z0-9@.-]/g, '_');
  if (currentDbEmail === safeEmail && db !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const newDbPath = path.join(__dirname, `mail_cache_${safeEmail}.db`);
    const openNewDb = () => {
      db = new sqlite3.Database(newDbPath, (err) => {
        if (err) return reject(err);
        currentDbEmail = safeEmail;
        initSchema().then(resolve).catch(reject);
      });
    };
    
    if (db) {
      db.close(() => {
        openNewDb();
      });
    } else {
      openNewDb();
    }
  });
}

// 默认初始化（如果还没有账号，先生成一个默认库防止报错）
function initDb() {
  if (db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH_DEFAULT, (err) => {
      if (err) return reject(err);
      currentDbEmail = 'default';
      initSchema().then(resolve).catch(reject);
    });
  });
}

// 初始化表结构
function initSchema() {
  return new Promise((resolve, reject) => {
      db.serialize(() => {
        // 性能调优：开启 WAL 日志模式与 PRAGMA NORMAL
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA synchronous = NORMAL');
        db.run('PRAGMA cache_size = -10000');

        // 创建邮件缓存表与索引
        db.run(`
          CREATE TABLE IF NOT EXISTS emails (
            message_id TEXT PRIMARY KEY,
            dir TEXT,
            from_name TEXT,
            from_email TEXT,
            to_json TEXT,
            cc_json TEXT,
            bcc_json TEXT,
            subject TEXT,
            snippet TEXT,
            body TEXT,
            body_text TEXT,
            created_at INTEGER,
            has_attachments INTEGER,
            attachments_json TEXT,
            is_read INTEGER,
            cached_at INTEGER,
            is_starred INTEGER DEFAULT 0
          )
        `);

        // 升级支持：如果已有 emails 表没有 is_starred 字段，动态添加之
        db.run(`
          ALTER TABLE emails ADD COLUMN is_starred INTEGER DEFAULT 0
        `, () => {
          // 忽略已存在报错
        });

        // 创建草稿表
        db.run(`
          CREATE TABLE IF NOT EXISTS drafts (
            draft_id TEXT PRIMARY KEY,
            to_json TEXT,
            cc_json TEXT,
            subject TEXT,
            body TEXT,
            updated_at INTEGER
          )
        `);

        // 保存目录级最后同步时间
        db.run(`
          CREATE TABLE IF NOT EXISTS sync_history (
            dir TEXT PRIMARY KEY,
            last_sync_time INTEGER
          )
        `);

        // 建立联合索引以加速排序与过滤
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_emails_dir_created 
          ON emails (dir, created_at DESC)
        `);

        db.run(`
          CREATE INDEX IF NOT EXISTS idx_emails_is_starred 
          ON emails (is_starred)
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
  });
}

// 封装异步操作
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 批量保存邮件简要列表（双向加密敏感字段）
async function saveEmailListSummary(emailsList, dir) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO emails (
      message_id, dir, from_name, from_email, to_json, cc_json, bcc_json,
      subject, snippet, created_at, has_attachments, attachments_json,
      is_read, cached_at, is_starred
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT is_starred FROM emails WHERE message_id = ?), 0))
  `);

  const now = Date.now();

  for (const email of emailsList) {
    const fromName = email.from?.name || '';
    const fromEmail = email.from?.email || '';
    const toStr = JSON.stringify(email.to || []);
    const ccStr = JSON.stringify(email.cc || []);
    const bccStr = JSON.stringify(email.bcc || []);
    const subject = email.subject || '';
    const snippet = email.snippet || '';
    const attachmentsStr = JSON.stringify(email.attachments || []);

    stmt.run([
      email.message_id,
      dir,
      encrypt(fromName),
      encrypt(fromEmail),
      encrypt(toStr),
      encrypt(ccStr),
      encrypt(bccStr),
      encrypt(subject),
      encrypt(snippet),
      new Date(email.created_at).getTime(),
      email.has_attachments ? 1 : 0,
      encrypt(attachmentsStr),
      email.is_read ? 1 : 0,
      now,
      email.message_id
    ]);
  }

  return new Promise((resolve, reject) => {
    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// 保存单封邮件详情（包含正文并进行 AES-256 加密）
async function saveEmailDetail(detail) {
  const bodyEnc = encrypt(detail.body || '');
  const bodyTextEnc = encrypt(detail.body_text || '');
  
  await run(`
    UPDATE emails 
    SET body = ?, body_text = ?
    WHERE message_id = ?
  `, [bodyEnc, bodyTextEnc, detail.message_id]);
}

// 获取某一目录最后的同步时间
async function getLastSyncTime(dir) {
  const row = await get('SELECT last_sync_time FROM sync_history WHERE dir = ?', [dir]);
  return row ? row.last_sync_time : 0;
}

// 更新某一目录的同步时间
async function updateLastSyncTime(dir) {
  const now = Date.now();
  await run('INSERT OR REPLACE INTO sync_history (dir, last_sync_time) VALUES (?, ?)', [dir, now]);
}

// 获取本地缓存邮件列表
async function getCachedEmails(dir, limit, offset) {
  const rows = await all(`
    SELECT * FROM emails 
    WHERE dir = ? 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `, [dir, limit, offset]);

  return serializeRows(rows);
}

// 切换标星状态
async function toggleStarred(messageId) {
  const row = await get('SELECT is_starred FROM emails WHERE message_id = ?', [messageId]);
  const nextStarredState = row && row.is_starred === 1 ? 0 : 1;
  await run('UPDATE emails SET is_starred = ? WHERE message_id = ?', [nextStarredState, messageId]);
  return nextStarredState === 1;
}

// 获取标星邮件列表
async function getStarredEmails(limit, offset) {
  const rows = await all(`
    SELECT * FROM emails 
    WHERE is_starred = 1 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `, [limit, offset]);

  return serializeRows(rows);
}

// 通用行解密与格式重构反序列化
function serializeRows(rows) {
  return rows.map(row => ({
    message_id: row.message_id,
    dir: row.dir,
    from: {
      name: decrypt(row.from_name),
      email: decrypt(row.from_email)
    },
    to: JSON.parse(decrypt(row.to_json) || '[]'),
    cc: JSON.parse(decrypt(row.cc_json) || '[]'),
    bcc: JSON.parse(decrypt(row.bcc_json) || '[]'),
    subject: decrypt(row.subject),
    snippet: decrypt(row.snippet),
    created_at: new Date(row.created_at).toISOString(),
    has_attachments: row.has_attachments === 1,
    attachments: JSON.parse(decrypt(row.attachments_json) || '[]'),
    is_read: row.is_read === 1,
    is_starred: row.is_starred === 1
  }));
}

// 获取本地已缓存的单封邮件详情
async function getCachedEmailDetail(messageId) {
  const row = await get('SELECT * FROM emails WHERE message_id = ?', [messageId]);
  if (!row) return null;

  const bodyDec = decrypt(row.body);
  const bodyTextDec = decrypt(row.body_text);
  if (row.body === null && row.body_text === null) return null;

  return {
    message_id: row.message_id,
    dir: row.dir,
    from: {
      name: decrypt(row.from_name),
      email: decrypt(row.from_email)
    },
    to: JSON.parse(decrypt(row.to_json) || '[]'),
    cc: JSON.parse(decrypt(row.cc_json) || '[]'),
    bcc: JSON.parse(decrypt(row.bcc_json) || '[]'),
    subject: decrypt(row.subject),
    snippet: decrypt(row.snippet),
    body: bodyDec,
    body_text: bodyTextDec,
    created_at: new Date(row.created_at).toISOString(),
    has_attachments: row.has_attachments === 1,
    attachments: JSON.parse(decrypt(row.attachments_json) || '[]'),
    is_read: row.is_read === 1,
    is_starred: row.is_starred === 1
  };
}

/* === 草稿箱方法 === */

// 保存草稿
async function saveDraft(draftId, toStr, ccStr, subject, body) {
  const now = Date.now();
  await run(`
    INSERT OR REPLACE INTO drafts (draft_id, to_json, cc_json, subject, body, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [draftId, encrypt(toStr), encrypt(ccStr), encrypt(subject), encrypt(body), now]);
}

// 获取草稿列表
async function getDrafts() {
  const rows = await all('SELECT * FROM drafts ORDER BY updated_at DESC');
  return rows.map(row => {
    const decryptedBody = decrypt(row.body) || '';
    return {
      message_id: row.draft_id,
      draft_id: row.draft_id,
      dir: 'drafts',
      subject: decrypt(row.subject) || '(无主题)',
      snippet: decryptedBody.replace(/<[^>]*>/g, '').substring(0, 100),
      to: JSON.parse(decrypt(row.to_json) || '[]'),
      cc: JSON.parse(decrypt(row.cc_json) || '[]'),
      body: decryptedBody,
      created_at: new Date(row.updated_at).toISOString(),
      is_read: true,
      is_draft: true
    };
  });
}

// 删除单份草稿
async function deleteDraft(draftId) {
  await run('DELETE FROM drafts WHERE draft_id = ?', [draftId]);
}

// 标记已读/未读状态
async function updateReadStatus(messageId, isRead) {
  await run('UPDATE emails SET is_read = ? WHERE message_id = ?', [isRead ? 1 : 0, messageId]);
}

// 提取去重的历史联系人列表
async function getHistoryContacts() {
  const rows = await all('SELECT from_name, from_email, to_json FROM emails');
  const contacts = new Map();
  for (const row of rows) {
    const fEmail = decrypt(row.from_email);
    const fName = decrypt(row.from_name);
    if (fEmail) {
      contacts.set(fEmail, fName || '');
    }
    try {
      const toList = JSON.parse(decrypt(row.to_json) || '[]');
      for (const t of toList) {
        if (t.email) {
          contacts.set(t.email, t.name || '');
        }
      }
    } catch(e) {}
  }
  return Array.from(contacts.entries()).map(([email, name]) => ({ email, name }));
}

// 统计某分类下未读邮件数量总数
async function getUnreadCount(dir) {
  const row = await get('SELECT COUNT(*) AS count FROM emails WHERE dir = ? AND is_read = 0', [dir]);
  return row ? row.count : 0;
}

// 移动邮件分类目录
async function moveEmailDir(messageId, targetDir) {
  await run('UPDATE emails SET dir = ? WHERE message_id = ?', [targetDir, messageId]);
}

// 清除所有账号隔离缓存数据（登出解绑时调用，防止串号）
async function clearAllCache() {
  try {
    await run('DELETE FROM emails');
    await run('DELETE FROM sync_state');
    await run('DELETE FROM drafts');
    await run('DELETE FROM history_contacts');
  } catch (e) {
    console.error('Clear cache failed:', e);
  }
}

module.exports = {
  initDb,
  saveEmailListSummary,
  saveEmailDetail,
  getLastSyncTime,
  updateLastSyncTime,
  getCachedEmails,
  getCachedEmailDetail,
  toggleStarred,
  getStarredEmails,
  saveDraft,
  getDrafts,
  deleteDraft,
  updateReadStatus,
  getHistoryContacts,
  getUnreadCount,
  clearAllCache,
  switchAccountDb,
  moveEmailDir
};
