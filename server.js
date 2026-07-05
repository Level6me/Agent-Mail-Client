const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const dbCache = require('./database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const fs = require('fs');

// 会话与管理员凭证
const activeSessions = new Set();
let ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

// 登录防暴破控制 (IP -> { count, lockedUntil })
const failedLoginAttempts = new Map();

// CLI OAuth 授权子进程
let authProcess = null;

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

// 执行 agently-cli 命令的辅助函数 (使用 execFile 避免 shell 注入)
function execCli(argsArray) {
  return new Promise((resolve, reject) => {
    execFile('agently-cli', argsArray, { 
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
    const result = await execCli(['message', '+list', '--dir', dir, '--limit', String(limit)]);
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
    
    execCli(['message', '+read', '--id', messageId])
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
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempt = failedLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  
  if (attempt.lockedUntil > now) {
    const minLeft = Math.ceil((attempt.lockedUntil - now) / 60000);
    return res.status(429).json({ ok: false, error: `输错密码次数过多，请 ${minLeft} 分钟后再试` });
  }

  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    failedLoginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    res.json({ ok: true, data: { token } });
  } else {
    attempt.count++;
    if (attempt.count >= 5) {
      attempt.lockedUntil = now + 15 * 60 * 1000;
    }
    failedLoginAttempts.set(ip, attempt);
    const remaining = 5 - attempt.count;
    const errorMsg = remaining > 0 ? `用户名或密码错误，还剩 ${remaining} 次尝试机会` : '输错密码次数过多，系统已锁定 15 分钟';
    res.status(401).json({ ok: false, error: errorMsg });
  }
});

// CLI 授权状态检测接口
app.get('/api/cli-auth-status', async (req, res) => {
  try {
    const result = await execCli(['+me']);
    if (result && result.ok) {
      const email = result.data?.aliases?.[0]?.email;
      if (email) {
        await dbCache.switchAccountDb(email).catch(console.error);
      }
      res.json({ authorized: true, email: email || '已授权' });
    } else {
      res.json({ authorized: false });
    }
  } catch (error) {
    res.json({ authorized: false });
  }
});

// 启动 CLI 授权流程
app.post('/api/cli-auth-start', (req, res) => {
  if (authProcess) {
    authProcess.kill();
  }
  
  authProcess = spawn('script', ['-q', '-c', 'agently-cli auth login', '/dev/null']);
  let urlSent = false;
  
  const handleData = (data) => {
    const output = data.toString();
    const urlMatch = output.match(/https:\/\/agent\.qq\.com\/page\/oauth[^\s]+/);
    if (urlMatch && !urlSent) {
      urlSent = true;
      res.json({ ok: true, url: urlMatch[0] });
    }
  };

  authProcess.stdout.on('data', handleData);
  authProcess.stderr.on('data', handleData);

  authProcess.on('exit', (code) => {
    if (!urlSent && !res.headersSent) {
      res.status(500).json({ ok: false, error: '授权进程意外退出' });
    }
    authProcess = null;
  });
});

// 退出底层 CLI 邮箱绑定
app.post('/api/cli-auth-logout', async (req, res) => {
  try {
    // 必须同步等待完成，否则前端过快刷新会导致底层还没退出成功，从而仍被判定为 authorized
    await execCli(['auth', 'logout']);
    res.json({ ok: true });
  } catch (e) {
    console.error('Logout error:', e);
    // 即使报错也认为退出成功（可能是没网或进程问题），放行前端跳转
    res.json({ ok: true });
  }
});

// 修改管理员凭证接口
app.post('/api/credentials', (req, res) => {
  const { newUsername, newPassword } = req.body;
  if (!newUsername || !newPassword) {
    return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
  }
  
  ADMIN_USER = newUsername;
  ADMIN_PASSWORD = newPassword;
  
  // 更新 .env 文件
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  try {
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
  } catch (e) {}

  const updateEnv = (content, key, value) => {
    const regex = new RegExp(`^${key}=.*`, 'm');
    if (regex.test(content)) {
      return content.replace(regex, `${key}=${value}`);
    } else {
      return content + (content && !content.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
    }
  };

  envContent = updateEnv(envContent, 'ADMIN_USER', newUsername);
  envContent = updateEnv(envContent, 'ADMIN_PASSWORD', newPassword);
  
  try {
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (e) {
    console.error('Failed to write .env file', e);
  }

  res.json({ ok: true });
});

// 获取用户信息
app.get('/api/me', async (req, res) => {
  try {
    const result = await execCli(['+me']);
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
    const args = ['message', '+list', '--dir', dir, '--limit', String(limit)];
    if (cursor) { args.push('--cursor'); args.push(cursor); }
    if (after) { args.push('--after'); args.push(after); }
    if (before) { args.push('--before'); args.push(before); }
    if (has_attachments === 'true') { args.push('--has-attachments'); }
    if (is_unread === 'true') { args.push('--is-unread'); }
    
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
    const result = await execCli(['message', '+read', '--id', messageId]);
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
    const args = ['message', '+search', '--q', q || '', '--limit', String(limit)];
    if (search_in) { args.push('--search-in'); args.push(search_in); }
    if (from) { args.push('--from'); args.push(from); }
    if (to) { args.push('--to'); args.push(to); }
    if (dir) { args.push('--dir'); args.push(dir); }
    if (after) { args.push('--after'); args.push(after); }
    if (before) { args.push('--before'); args.push(before); }
    if (has_attachments === 'true') { args.push('--has-attachments'); }
    if (is_unread === 'true') { args.push('--is-unread'); }
    if (cursor) { args.push('--cursor'); args.push(cursor); }
    
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
    const args = ['message', '+send'];
    
    if (to && to.length > 0) {
      args.push('--to');
      to.forEach(e => args.push(e));
    }
    if (cc && cc.length > 0) {
      args.push('--cc');
      cc.forEach(e => args.push(e));
    }
    if (subject) {
      args.push('--subject');
      args.push(subject);
    }
    if (body) {
      args.push('--body');
      args.push(body);
    }
    if (confirmation_token) {
      args.push('--confirmation-token');
      args.push(confirmation_token);
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
    const args = ['message', '+trash', '--id', id];
    if (confirmation_token) {
      args.push('--confirmation-token');
      args.push(confirmation_token);
    }
    
    const result = await execCli(args);
    if (result && result.ok && !result.data?.confirmation_required) {
      // 成功移入已删除，同步更新本地 SQLite 缓存目录为 'trash'
      await dbCache.moveEmailDir(id, 'trash').catch(console.error);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 下载附件
app.get('/api/attachments/:msgId/:attId', async (req, res) => {
  try {
    const { msgId, attId } = req.params;
    const result = await execCli(['message', '+attachment', '--id', msgId, '--attachment-id', attId]);
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
