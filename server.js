const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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

// 获取用户信息
app.get('/api/me', async (req, res) => {
  try {
    const result = await execCli('+me');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 列出邮件
app.get('/api/messages', async (req, res) => {
  try {
    const { dir = 'inbox', limit = 20, cursor, after, before, has_attachments, is_unread } = req.query;
    let args = `message +list --dir ${dir} --limit ${limit}`;
    if (cursor) args += ` --cursor ${cursor}`;
    if (after) args += ` --after ${after}`;
    if (before) args += ` --before ${before}`;
    if (has_attachments === 'true') args += ` --has-attachments`;
    if (is_unread === 'true') args += ` --is-unread`;
    
    const result = await execCli(args);
    // Transform response to match frontend expectations
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

// 读取邮件详情
app.get('/api/messages/:id', async (req, res) => {
  try {
    const result = await execCli(`message +read --id ${req.params.id}`);
    res.json(result);
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
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 发送邮件（两阶段确认）
app.post('/api/send', async (req, res) => {
  try {
    const { to, subject, body, cc, bcc, attachments, confirmation_token } = req.body;
    let args = `message +send`;
    
    if (Array.isArray(to)) {
      to.forEach(t => args += ` --to ${t}`);
    } else {
      args += ` --to ${to}`;
    }
    
    args += ` --subject "${subject}" --body "${body.replace(/"/g, '\\"')}"`;
    
    if (cc) {
      if (Array.isArray(cc)) {
        cc.forEach(c => args += ` --cc ${c}`);
      } else {
        args += ` --cc ${cc}`;
      }
    }
    
    if (bcc) {
      if (Array.isArray(bcc)) {
        bcc.forEach(b => args += ` --bcc ${b}`);
      } else {
        args += ` --bcc ${bcc}`;
      }
    }
    
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach(a => args += ` --attachment ${a}`);
    }
    
    if (confirmation_token) {
      args += ` --confirmation-token ${confirmation_token}`;
    }
    
    const result = await execCli(args);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 回复邮件
app.post('/api/reply', async (req, res) => {
  try {
    const { id, body, reply_all, cc, bcc, attachments, confirmation_token } = req.body;
    let args = `message +reply --id ${id}`;
    
    args += ` --body "${body.replace(/"/g, '\\"')}"`;
    
    if (reply_all) args += ` --reply-all`;
    
    if (cc) {
      if (Array.isArray(cc)) {
        cc.forEach(c => args += ` --cc ${c}`);
      } else {
        args += ` --cc ${cc}`;
      }
    }
    
    if (bcc) {
      if (Array.isArray(bcc)) {
        bcc.forEach(b => args += ` --bcc ${b}`);
      } else {
        args += ` --bcc ${bcc}`;
      }
    }
    
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach(a => args += ` --attachment ${a}`);
    }
    
    if (confirmation_token) {
      args += ` --confirmation-token ${confirmation_token}`;
    }
    
    const result = await execCli(args);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 转发邮件
app.post('/api/forward', async (req, res) => {
  try {
    const { id, to, body, cc, bcc, include_attachments, attachments, confirmation_token } = req.body;
    let args = `message +forward --id ${id}`;
    
    if (Array.isArray(to)) {
      to.forEach(t => args += ` --to ${t}`);
    } else {
      args += ` --to ${to}`;
    }
    
    args += ` --body "${body.replace(/"/g, '\\"')}"`;
    
    if (cc) {
      if (Array.isArray(cc)) {
        cc.forEach(c => args += ` --cc ${c}`);
      } else {
        args += ` --cc ${cc}`;
      }
    }
    
    if (bcc) {
      if (Array.isArray(bcc)) {
        bcc.forEach(b => args += ` --bcc ${b}`);
      } else {
        args += ` --bcc ${bcc}`;
      }
    }
    
    if (include_attachments) args += ` --include-attachments`;
    
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach(a => args += ` --attachment ${a}`);
    }
    
    if (confirmation_token) {
      args += ` --confirmation-token ${confirmation_token}`;
    }
    
    const result = await execCli(args);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除邮件（两阶段确认）
app.post('/api/trash', async (req, res) => {
  try {
    const { id, confirmation_token } = req.body;
    let args = `message +trash --id ${id}`;
    
    if (confirmation_token) {
      args += ` --confirmation-token ${confirmation_token}`;
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
    const result = await execCli(`attachment +download --msg ${msgId} --att ${attId} --output ./downloads`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Agent Mail Client running at http://localhost:${PORT}`);
});
