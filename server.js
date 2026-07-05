const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const dbCache = require('./database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 会话与管理员凭证
const activeSessions = new Set();
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

// 鉴权中间件
function authMiddleware(req, res, next) {
  if (req.path.startsWith('/api') && req.path !== '/api/login') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: 未提供登录凭证' });
    }
    const token = authHeader.split(' ')[1];
    if (!activeSessions.has(token)) {
      return res.status(401).json({ error: 'Unauthorized: 登录会话已失效' });
    }
  }
  next();
}

app.use(cors());
app.use(express.json());
app.use(authMiddleware);
app.use(express.static('public'));

// 执行 agently-cli 命令的辅助函数
function execCli(args) {
  return new Promise((resolve, reject) => {
    exec(`agently-cli ${args}`, { 
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000 
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        resolve(stdout);
      }
    });
  });
}

// 后台异步静默同步邮件列表
async function syncEmailsInBackground(dir, limit) {
  try {
    const result = await execCli(`message +list --dir ${dir} --limit ${limit}`);
    if (result.ok && result.data) {
      const messagesList = result.data.data || [];
      // 静默写入本地 SQLite，自动解密/加密
      await dbCache.saveEmailListSummary(messagesList, dir);
      await dbCache.updateLastSyncTime(dir);
      // 同步完列表后，默默排队预拉取这批邮件的正文详情
      triggerDetailPrefetchQueue(messagesList);
    }
  } catch (e) {
    console.warn(`[后台静默同步] 目录 ${dir} 拉取云端失败 (不影响前台):`, e.message);
  }
}

// 后台排队静默预拉取邮件正文详情（不阻塞 Express 并发，间隔 500ms）
async function triggerDetailPrefetchQueue(messagesList) {
  const idsToFetch = [];
  
  // 仅筛选出本地 SQLite 缓存中尚未存在正文的邮件
  for (const msg of messagesList) {
    try {
      const cached = await dbCache.getCachedEmailDetail(msg.message_id);
      if (!cached) {
        idsToFetch.push(msg.message_id);
      }
    } catch (e) {
      // 忽略检查报错
    }
  }

  if (idsToFetch.length === 0) return;

  let index = 0;
  function fetchNext() {
    if (index >= idsToFetch.length) return;
    const messageId = idsToFetch[index++];
    
    execCli(`message +read --id ${messageId}`)
      .then(async (result) => {
        if (result.ok && result.data) {
          await dbCache.saveEmailDetail(result.data);
        }
      })
      .catch(err => {
        console.warn(`[后台详情预载] 邮件 ${messageId} 详情预读失败:`, err.message);
      })
      .finally(() => {
        // 500ms 后拉取下一封邮件正文，保证低功耗和平稳运行
        setTimeout(fetchNext, 500);
      });
  }

  // 延迟 1.5 秒后启动预载，保证用户第一屏渲染完全响应完毕后再消耗 CPU
  setTimeout(fetchNext, 1500);
}

// 用户登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    res.json({ ok: true, data: { token } });
  } else {
    res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
});

// 获取用户信息
app.get('/api/me', async (req, res) => {
  try {
    const result = await execCli('+me');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 列出邮件 (100% 本地优先秒开，后台静默云端同步，后台正文预载)
app.get('/api/messages', async (req, res) => {
  const { dir = 'inbox', limit = 20, cursor, after, before, has_attachments, is_unread, refresh, offset } = req.query;

  try {
    // 特判一：本地标星信箱
    if (dir === 'starred') {
      const starredList = await dbCache.getStarredEmails(parseInt(limit), 0);
      return res.json({
        ok: true,
        data: {
          messages: starredList,
          next_cursor: null
        }
      });
    }

    // 特判二：本地草稿箱
    if (dir === 'drafts') {
      const draftsList = await dbCache.getDrafts();
      return res.json({
        ok: true,
        data: {
          messages: draftsList,
          next_cursor: null
        }
      });
    }

    // 核心优化：如果不是翻页，且没有传入强制刷新参数，且本地存在该分类缓存：
    // 【直接秒开响应】本地 SQLite 的数据！并在后台静默拉取云端同步。
    if (!cursor && refresh !== 'true') {
      const cachedList = await dbCache.getCachedEmails(dir, parseInt(limit), 0);
      if (cachedList && cachedList.length > 0) {
        // 1. 立刻返回本地零延迟数据给前端呈现
        res.json({
          ok: true,
          data: {
            messages: cachedList,
            next_cursor: null
          }
        });

        // 2. 扔入后台默默去拉最新的云端邮件，更新写入 SQLite 并进行详情预拉取
        setTimeout(() => {
          syncEmailsInBackground(dir, limit);
        }, 50);
        return;
      }
    }

    // 本地无缓存（冷启动）或翻页、强制刷新时的阻塞同步
    let args = `message +list --dir ${dir} --limit ${limit}`;
    if (cursor) args += ` --cursor ${cursor}`;
    if (after) args += ` --after ${after}`;
    if (before) args += ` --before ${before}`;
    if (has_attachments === 'true') args += ` --has-attachments`;
    if (is_unread === 'true') args += ` --is-unread`;
    
    const result = await execCli(args);
    
    if (result.ok && result.data) {
      const messagesList = result.data.data || [];
      await dbCache.saveEmailListSummary(messagesList, dir);
      if (!cursor) {
        await dbCache.updateLastSyncTime(dir);
      }

      // 冷启动同步成功，后台开始顺便预拉取这批邮件的正文
      triggerDetailPrefetchQueue(messagesList);
      
      res.json({
        ok: true,
        data: {
          messages: messagesList,
          next_cursor: result.data.pagination?.next_cursor || null
        }
      });
    } else {
      throw new Error(result.error || '命令行拉取异常');
    }
  } catch (error) {
    console.warn(`[列表冷启动容灾] 目录 ${dir} 同步异常，尝试拉取本地离线缓存:`, error.message);
    try {
      const offsetVal = parseInt(offset) || 0;
      const cachedList = await dbCache.getCachedEmails(dir, parseInt(limit), offsetVal);
      if (cachedList && cachedList.length > 0) {
        return res.json({
          ok: true,
          is_offline: true,
          data: {
            messages: cachedList,
            next_cursor: cachedList.length >= limit ? `local_cursor_${offsetVal + limit}` : null
          }
        });
      }
    } catch (dbErr) {
      console.error('数据库冷启动容灾读取失败:', dbErr);
    }
    res.status(500).json({ error: '同步云端失败且本地无缓存: ' + error.message });
  }
});

// 读取邮件详情 (直读本地解密秒开，无缓存时阻塞冷启动)
app.get('/api/messages/:id', async (req, res) => {
  const messageId = req.params.id;
  try {
    // 1. 本地缓存命中直读（由于后台预载大部分信已秒开）
    const cachedDetail = await dbCache.getCachedEmailDetail(messageId);
    if (cachedDetail) {
      return res.json({
        ok: true,
        data: cachedDetail
      });
    }

    // 2. 缓存未命中时再冷启动命令行拉取
    const result = await execCli(`message +read --id ${messageId}`);
    if (result.ok && result.data) {
      await dbCache.saveEmailDetail(result.data);
      res.json(result);
    } else {
      throw new Error(result.error || '正文拉取异常');
    }
  } catch (error) {
    console.warn(`[正文冷启动容灾] 邮件 ${messageId} 详情失败，尝试本地缓存降级:`, error.message);
    try {
      const cachedDetail = await dbCache.getCachedEmailDetail(messageId);
      if (cachedDetail) {
        return res.json({
          ok: true,
          is_offline: true,
          data: cachedDetail
        });
      }
    } catch (dbErr) {
       console.error('正文离线读取失败:', dbErr);
    }
    res.status(500).json({ error: '读取详情失败且本地无缓存: ' + error.message });
  }
});

// 切换标星状态
app.post('/api/messages/:id/star', async (req, res) => {
  try {
    const isStarred = await dbCache.toggleStarred(req.params.id);
    res.json({ ok: true, data: { is_starred: isStarred } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 保存草稿
app.post('/api/drafts', async (req, res) => {
  try {
    const { draft_id, to, cc, subject, body } = req.body;
    const toStr = JSON.stringify(to || []);
    const ccStr = JSON.stringify(cc || []);
    await dbCache.saveDraft(draft_id, toStr, ccStr, subject, body);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取草稿
app.get('/api/drafts', async (req, res) => {
  try {
    const list = await dbCache.getDrafts();
    res.json({ ok: true, data: { messages: list } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除草稿
app.delete('/api/drafts/:id', async (req, res) => {
  try {
    await dbCache.deleteDraft(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 标记已读/未读状态
app.post('/api/messages/:id/read', async (req, res) => {
  try {
    const { is_read } = req.body;
    await dbCache.updateReadStatus(req.params.id, is_read);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取所有去重的历史联系人列表
app.get('/api/contacts', async (req, res) => {
  try {
    const list = await dbCache.getHistoryContacts();
    res.json({ ok: true, data: list });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取收件箱的总未读数
app.get('/api/unread-count', async (req, res) => {
  try {
    const count = await dbCache.getUnreadCount('inbox');
    res.json({ ok: true, data: { count } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 移动本地邮件的文件夹
app.post('/api/messages/:id/move', async (req, res) => {
  try {
    const { dir } = req.body;
    await dbCache.moveEmailDir(req.params.id, dir);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 搜索邮件
app.get('/api/search', async (req, res) => {
  try {
    const { q, search_in, from, to, dir, after, before, has_attachments, is_unread, limit = 20, cursor } = req.query;
    let args = `message +search --q "${q || ''}" --limit ${limit}`;
    if (search_in) args += ` --search-in ${search_in}`;
    if (from) args += ` --from "${from}"`;
    if (to) args += ` --to "${to}"`;
    if (dir) args += ` --dir ${dir}`;
    if (after) args += ` --after ${after}`;
    if (before) args += ` --before ${before}`;
    if (has_attachments === 'true') args += ` --has-attachments`;
    if (is_unread === 'true') args += ` --is-unread`;
    if (cursor) args += ` --cursor ${cursor}`;
    
    const result = await execCli(args);
    if (result.ok && result.data) {
      res.json({
        ok: true,
        data: {
          messages: result.data.data || [],
          next_cursor: result.data.pagination?.next_cursor || null
        }
      });
    } else {
      res.json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 发送邮件
app.post('/api/send', async (req, res) => {
  try {
    const { to, cc, subject, body, confirmation_token } = req.body;
    let args = 'message +send';
    
    if (to && to.length > 0) {
      args += ` --to ${to.map(e => `"${e}"`).join(' ')}`;
    }
    if (cc && cc.length > 0) {
      args += ` --cc ${cc.map(e => `"${e}"`).join(' ')}`;
    }
    if (subject) {
      args += ` --subject "${subject}"`;
    }
    if (body) {
      args += ` --body "${body.replace(/"/g, '\\"')}"`;
    }
    if (confirmation_token) {
      args += ` --confirmation-token "${confirmation_token}"`;
    }
    
    const result = await execCli(args);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除邮件 (移到垃圾箱)
app.post('/api/trash', async (req, res) => {
  try {
    const { id, confirmation_token } = req.body;
    let args = `message +trash --id ${id}`;
    if (confirmation_token) {
      args += ` --confirmation-token "${confirmation_token}"`;
    }
    
    const result = await execCli(args);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 下载附件
app.get('/api/attachments/:msgId/:attId', async (req, res) => {
  try {
    const { msgId, attId } = req.params;
    const result = await execCli(`message +attachment --id ${msgId} --attachment-id ${attId}`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// 初始化数据库后启动服务
dbCache.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Agent Mail Client running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('初始化数据库失败，进程退出:', err);
  process.exit(1);
});
