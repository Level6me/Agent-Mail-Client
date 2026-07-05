const API_BASE = '';
let currentFolder = 'inbox';
let currentCursor = null;
let selectedEmailId = null;

// 初始化
async function init() {
  await loadUserInfo();
  await loadEmails();
  setupEventListeners();
}

// 加载用户信息
async function loadUserInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/me`);
    const data = await res.json();
    if (data.ok && data.data.aliases.length > 0) {
      const email = data.data.aliases[0].email;
      document.getElementById('currentEmail').textContent = email;
    }
  } catch (error) {
    console.error('加载用户信息失败:', error);
  }
}

// 加载邮件列表
async function loadEmails(folder = 'inbox', cursor = null) {
  try {
    const url = `${API_BASE}/api/messages?dir=${folder}&limit=20${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.ok) {
      renderEmailList(data.data.messages || []);
      currentCursor = data.data.next_cursor;
      updateUnreadCount(data.data.messages || []);
    } else {
      showError('加载邮件失败: ' + data.error);
    }
  } catch (error) {
    showError('加载邮件失败: ' + error.message);
  }
}

// 渲染邮件列表
function renderEmailList(emails) {
  const container = document.getElementById('emailList');
  
  if (emails.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-gray-500">
        <i class="fas fa-inbox text-4xl mb-2"></i>
        <p>暂无邮件</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = emails.map(email => `
    <div class="email-item border-b border-gray-200 p-4 hover:bg-gray-50 cursor-pointer ${!email.is_read ? 'bg-blue-50' : ''}" data-id="${email.message_id}">
      <div class="flex items-start justify-between mb-2">
        <div class="flex-1 min-w-0">
          <div class="font-medium text-gray-900 truncate ${!email.is_read ? 'font-bold' : ''}">
            ${escapeHtml(email.from?.name || email.from?.email || 'Unknown')}
          </div>
          <div class="text-sm text-gray-600 truncate">${escapeHtml(email.subject || '(无主题)')}</div>
        </div>
        <div class="text-xs text-gray-500 ml-2 whitespace-nowrap">
          ${formatDate(email.created_at)}
        </div>
      </div>
      <div class="text-sm text-gray-500 truncate">${escapeHtml(email.snippet || '')}</div>
      ${email.has_attachments ? '<i class="fas fa-paperclip text-gray-400 text-xs mt-1"></i>' : ''}
    </div>
  `).join('');
  
  // 添加点击事件
  document.querySelectorAll('.email-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      loadEmailDetail(id);
    });
  });
}

// 加载邮件详情
async function loadEmailDetail(id) {
  try {
    const res = await fetch(`${API_BASE}/api/messages/${id}`);
    const data = await res.json();
    
    if (data.ok) {
      renderEmailDetail(data.data);
      selectedEmailId = id;
    } else {
      showError('加载邮件详情失败: ' + data.error);
    }
  } catch (error) {
    showError('加载邮件详情失败: ' + error.message);
  }
}

// 渲染邮件详情
function renderEmailDetail(email) {
  const container = document.getElementById('emailDetail');
  
  container.innerHTML = `
    <div class="bg-white p-6">
      <div class="mb-6">
        <h2 class="text-2xl font-bold text-gray-900 mb-2">${escapeHtml(email.subject || '(无主题)')}</h2>
        <div class="flex items-center justify-between text-sm text-gray-600">
          <div>
            <span class="font-medium">${escapeHtml(email.from?.name || email.from?.email || 'Unknown')}</span>
            <span class="text-gray-500">&lt;${escapeHtml(email.from?.email || '')}&gt;</span>
          </div>
          <div>${formatDate(email.created_at)}</div>
        </div>
        <div class="mt-2 text-sm text-gray-600">
          <span class="font-medium">收件人:</span> ${escapeHtml(email.to?.map(t => t.email).join(', ') || '')}
        </div>
        ${email.cc && email.cc.length > 0 ? `
          <div class="mt-1 text-sm text-gray-600">
            <span class="font-medium">抄送:</span> ${escapeHtml(email.cc.map(c => c.email).join(', '))}
          </div>
        ` : ''}
      </div>
      
      <div class="email-content prose max-w-none mb-6">
        ${email.body || `<pre class="whitespace-pre-wrap">${escapeHtml(email.body_text || '')}</pre>`}
      </div>
      
      ${email.attachments && email.attachments.length > 0 ? `
        <div class="border-t border-gray-200 pt-4">
          <h3 class="font-medium text-gray-900 mb-2">
            <i class="fas fa-paperclip mr-2"></i>附件 (${email.attachments.length})
          </h3>
          <div class="space-y-2">
            ${email.attachments.map(att => `
              <div class="flex items-center justify-between p-2 bg-gray-50 rounded">
                <div class="flex items-center">
                  <i class="fas fa-file text-gray-400 mr-2"></i>
                  <span class="text-sm">${escapeHtml(att.filename)}</span>
                  <span class="text-xs text-gray-500 ml-2">(${formatFileSize(att.size)})</span>
                </div>
                <button class="download-att text-blue-600 hover:text-blue-800 text-sm" data-msg="${email.message_id}" data-att="${att.attachment_id}">
                  <i class="fas fa-download mr-1"></i>下载
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      
      <div class="border-t border-gray-200 pt-4 mt-6 flex gap-3">
        <button id="replyBtn" class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
          <i class="fas fa-reply mr-2"></i>回复
        </button>
        <button id="forwardBtn" class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
          <i class="fas fa-share mr-2"></i>转发
        </button>
        <button id="deleteBtn" class="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50">
          <i class="fas fa-trash mr-2"></i>删除
        </button>
      </div>
    </div>
  `;
  
  // 绑定事件
  document.getElementById('replyBtn').addEventListener('click', () => openReplyModal(email));
  document.getElementById('forwardBtn').addEventListener('click', () => openForwardModal(email));
  document.getElementById('deleteBtn').addEventListener('click', () => deleteEmail(email.message_id));
  
  document.querySelectorAll('.download-att').forEach(btn => {
    btn.addEventListener('click', () => {
      downloadAttachment(btn.dataset.msg, btn.dataset.att);
    });
  });
}

// 打开写信模态框
function openComposeModal() {
  document.getElementById('composeModal').classList.remove('hidden');
  document.getElementById('toInput').value = '';
  document.getElementById('ccInput').value = '';
  document.getElementById('subjectInput').value = '';
  document.getElementById('bodyInput').value = '';
}

// 打开回复模态框
function openReplyModal(email) {
  openComposeModal();
  document.getElementById('toInput').value = email.from?.email || '';
  document.getElementById('subjectInput').value = `Re: ${email.subject || ''}`;
  document.getElementById('bodyInput').value = `\n\n---\n在 ${formatDate(email.created_at)}，${email.from?.name || email.from?.email || ''} 写道：\n${email.snippet || ''}`;
}

// 打开转发模态框
function openForwardModal(email) {
  openComposeModal();
  document.getElementById('subjectInput').value = `Fwd: ${email.subject || ''}`;
  const toStr = email.to?.map(t => `${t.name} <${t.email}>`).join(', ') || '';
  document.getElementById('bodyInput').value = `\n\n---\n转发的邮件：\n发件人: ${email.from?.name || ''} <${email.from?.email || ''}>\n日期: ${formatDate(email.created_at)}\n主题: ${email.subject || ''}\n收件人: ${toStr}\n\n${email.snippet || ''}`;
}

// 发送邮件
async function sendEmail() {
  const to = document.getElementById('toInput').value.trim();
  const cc = document.getElementById('ccInput').value.trim();
  const subject = document.getElementById('subjectInput').value.trim();
  const body = document.getElementById('bodyInput').value.trim();
  
  if (!to) {
    alert('请输入收件人');
    return;
  }
  
  if (!subject) {
    if (!confirm('主题为空，确定继续发送吗？')) {
      return;
    }
  }
  
  try {
    // 第一阶段：获取 confirmation token
    const res1 = await fetch(`${API_BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: to.split(',').map(e => e.trim()),
        cc: cc ? cc.split(',').map(e => e.trim()) : undefined,
        subject,
        body
      })
    });
    
    const data1 = await res1.json();
    
    // 检查是否需要确认
    if (data1.ok && data1.data && data1.data.confirmation_required) {
      // 显示确认信息
      const summary = data1.data.summary;
      const confirmMsg = `确认发送这封邮件吗？\n\n发件人: ${summary.from}\n收件人: ${summary.to.join(', ')}\n主题: ${summary.subject}`;
      
      if (!confirm(confirmMsg)) {
        return;
      }
      
      // 第二阶段：发送确认
      const res2 = await fetch(`${API_BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: to.split(',').map(e => e.trim()),
          cc: cc ? cc.split(',').map(e => e.trim()) : undefined,
          subject,
          body,
          confirmation_token: data1.data.confirmation_token
        })
      });
      
      const data2 = await res2.json();
      
      if (data2.ok) {
        alert('邮件发送成功！');
        document.getElementById('composeModal').classList.add('hidden');
        loadEmails(currentFolder);
      } else {
        alert('发送失败: ' + (data2.error || JSON.stringify(data2)));
      }
    } else if (data1.ok) {
      alert('邮件发送成功！');
      document.getElementById('composeModal').classList.add('hidden');
      loadEmails(currentFolder);
    } else {
      alert('发送失败: ' + (data1.error || JSON.stringify(data1)));
    }
  } catch (error) {
    alert('发送失败: ' + error.message);
  }
}

// 删除邮件
async function deleteEmail(id) {
  if (!confirm('确定要删除这封邮件吗？')) {
    return;
  }
  
  try {
    // 第一阶段
    const res1 = await fetch(`${API_BASE}/api/trash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    
    const data1 = await res1.json();
    
    if (data1.ok) {
      alert('邮件已删除');
      document.getElementById('emailDetail').innerHTML = `
        <div class="h-full flex items-center justify-center text-gray-400">
          <div class="text-center">
            <i class="fas fa-envelope-open text-6xl mb-4"></i>
            <p>选择一封邮件查看详情</p>
          </div>
        </div>
      `;
      loadEmails(currentFolder);
    } else if (data1.error && data1.error.includes('confirmation')) {
      // 需要确认
      const res2 = await fetch(`${API_BASE}/api/trash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, confirmation_token: data1.data.confirmation_token })
      });
      
      const data2 = await res2.json();
      
      if (data2.ok) {
        alert('邮件已删除');
        loadEmails(currentFolder);
      } else {
        alert('删除失败: ' + data2.error);
      }
    } else {
      alert('删除失败: ' + data1.error);
    }
  } catch (error) {
    alert('删除失败: ' + error.message);
  }
}

// 下载附件
async function downloadAttachment(msgId, attId) {
  try {
    const res = await fetch(`${API_BASE}/api/attachments/${msgId}/${attId}`);
    const data = await res.json();
    
    if (data.ok) {
      alert(`附件已下载到: ${data.data.saved_to}`);
    } else {
      alert('下载失败: ' + data.error);
    }
  } catch (error) {
    alert('下载失败: ' + error.message);
  }
}

// 搜索邮件
async function searchEmails(query) {
  if (!query.trim()) {
    loadEmails(currentFolder);
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=20`);
    const data = await res.json();
    
    if (data.ok) {
      renderEmailList(data.data.messages || []);
    } else {
      showError('搜索失败: ' + data.error);
    }
  } catch (error) {
    showError('搜索失败: ' + error.message);
  }
}

// 更新未读计数
function updateUnreadCount(emails) {
  const unreadCount = emails.filter(e => e.is_unread).length;
  document.getElementById('unreadCount').textContent = unreadCount;
}

// 设置事件监听
function setupEventListeners() {
  // 文件夹切换
  document.querySelectorAll('.folder-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.folder-btn').forEach(b => b.classList.remove('bg-blue-100'));
      btn.classList.add('bg-blue-100');
      currentFolder = btn.dataset.folder;
      loadEmails(currentFolder);
    });
  });
  
  // 写信按钮
  document.getElementById('composeBtn').addEventListener('click', openComposeModal);
  
  // 关闭写信
  document.getElementById('closeCompose').addEventListener('click', () => {
    document.getElementById('composeModal').classList.add('hidden');
  });
  
  document.getElementById('cancelCompose').addEventListener('click', () => {
    document.getElementById('composeModal').classList.add('hidden');
  });
  
  // 发送邮件
  document.getElementById('sendEmail').addEventListener('click', sendEmail);
  
  // 搜索
  let searchTimeout;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchEmails(e.target.value);
    }, 500);
  });
}

// 工具函数
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else if (diff < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString('zh-CN', { weekday: 'short' });
  } else {
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function showError(message) {
  console.error(message);
  // 可以添加一个 toast 提示
}

// 启动
init();
