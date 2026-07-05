const API_BASE = '';
const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  const token = localStorage.getItem('auth_token');
  if (token && (typeof url === 'string' && url.includes('/api'))) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await originalFetch(url, options);
  if (res.status === 401 && !url.includes('/api/login')) {
    localStorage.removeItem('auth_token');
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.remove('hidden');
  }
  return res;
};

let currentFolder = 'inbox';
let currentCursor = null;
let selectedEmailId = null;

let quill = null;
let currentDraftId = null;
let autoSaveTimer = null;
let cachedContacts = [];
let isComposeMinimized = false;
let isComposeMaximized = false;
let isLoadingMore = false;
let hasMoreEmails = true;

// 初始化
async function init() {
  // 初始化 Quill 富文本编辑器
  quill = new Quill('#bodyEditor', {
    theme: 'snow',
    placeholder: '编写邮件正文...',
    modules: {
      toolbar: [
        ['bold', 'italic', 'underline'],
        [{ 'color': [] }, { 'background': [] }],
        ['link', 'clean']
      ]
    }
  });

  // 绑定 Quill 快捷键（Ctrl+Enter 极速发信）
  if (quill && quill.root) {
    quill.root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendEmail();
      }
    });
  }

  // 绑定 Quill 图片拖拽与粘贴
  setupQuillImagePasteDrop();

  // 设置页面常规监听器
  setupEventListeners();

  // 绑定并控制安全登录逻辑
  setupLoginEvents();

  const token = localStorage.getItem('auth_token');
  const overlay = document.getElementById('loginOverlay');
  if (token) {
    if (overlay) overlay.classList.add('hidden');
    // 有 Token 则静默拉取首屏数据
    await loadUserInfo();
    await loadEmails();
    await loadUnreadCount();
  } else {
    if (overlay) overlay.classList.remove('hidden');
  }
}

// 绑定 Quill 富文本粘贴及拖拽图片（Base64 转换内联插入）
function setupQuillImagePasteDrop() {
  const container = document.getElementById('bodyEditor');
  if (!container) return;

  // 监听粘贴事件
  container.addEventListener('paste', (e) => {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;
    
    const items = clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          insertImageAsBase64(file);
        }
      }
    }
  });

  // 监听拖拽事件
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.indexOf('image') !== -1) {
          insertImageAsBase64(files[i]);
        }
      }
    }
  });
}

function insertImageAsBase64(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const base64Data = event.target.result;
    const range = quill.getSelection(true);
    // 在当前光标位置插入内联图片
    quill.insertEmbed(range.index, 'image', base64Data);
    quill.setSelection(range.index + 1);
  };
  reader.readAsDataURL(file);
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

// 加载邮件列表 (支持 refresh 强制刷新、离线指示器检测与无限滚动翻页追加)
async function loadEmails(folder = 'inbox', cursor = null, refresh = false) {
  if (cursor) {
    if (isLoadingMore || !hasMoreEmails) return;
    isLoadingMore = true;
    
    // 在列表底部渲染一个精致低调的加载中指示器
    const listEl = document.getElementById('emailList');
    const loaderHtml = `
      <div id="listScrollLoader" class="py-3 text-center text-gray-400 select-none">
        <i class="fas fa-spinner fa-spin text-[10px]"></i>
        <span class="text-[9px] ml-1">正在加载...</span>
      </div>
    `;
    listEl.insertAdjacentHTML('beforeend', loaderHtml);
  } else {
    hasMoreEmails = true;
    isLoadingMore = false;
    currentCursor = null;
  }

  try {
    const currentOffset = document.querySelectorAll('.email-item').length;
    let url = `${API_BASE}/api/messages?dir=${folder}&limit=20&offset=${currentOffset}`;
    if (cursor) url += `&cursor=${cursor}`;
    if (refresh) url += `&refresh=true`;

    const res = await fetch(url);
    const data = await res.json();
    
    // 移除底部的加载中指示器
    const loaderEl = document.getElementById('listScrollLoader');
    if (loaderEl) loaderEl.remove();

    // 控制离线降级状态警示徽标的显隐
    const offlineBadge = document.getElementById('offlineBadge');
    if (offlineBadge) {
      if (data.is_offline) {
        offlineBadge.classList.remove('hidden');
      } else {
        offlineBadge.classList.add('hidden');
      }
    }

    if (data.ok) {
      const newMessages = data.data.messages || [];
      currentCursor = data.data.next_cursor;
      
      if (!currentCursor) {
        hasMoreEmails = false;
      }

      if (cursor) {
        // 追加模式：生成 HTML 片段并无缝拼接到列表尾部
        const listEl = document.getElementById('emailList');
        if (newMessages.length > 0) {
          const appendHtml = newMessages.map(email => renderSingleEmailItemMarkup(email)).join('');
          listEl.insertAdjacentHTML('beforeend', appendHtml);
          // 重新绑定新追加卡片上的所有事件处理器
          bindEmailItemEvents(newMessages);
        }
        isLoadingMore = false;
        
        // 若没有更多了，在尾部加一个小小的极简底线文案
        if (!hasMoreEmails) {
          listEl.insertAdjacentHTML('beforeend', `<div class="py-4 text-center text-[9px] text-gray-300 select-none">已加载全部邮件</div>`);
        }
      } else {
        // 重绘模式：首次整屏渲染
        renderEmailList(newMessages);
      }
      
      loadUnreadCount();
    } else {
      showError('加载邮件失败: ' + data.error);
      isLoadingMore = false;
    }
  } catch (error) {
    showError('加载邮件失败: ' + error.message);
    isLoadingMore = false;
    const loaderEl = document.getElementById('listScrollLoader');
    if (loaderEl) loaderEl.remove();
  }
}

// 单个邮件列表卡片的 HTML 渲染
function renderSingleEmailItemMarkup(email) {
  const isUnread = !email.is_read && !email.is_draft;
  const starIcon = email.is_starred ? 'fas fa-star text-yellow-400' : 'far fa-star text-gray-300';
  
  // 如果是草稿，显示草稿标记和收件人代替发件人
  let fromDisplayName = 'Unknown';
  if (email.is_draft) {
    const recipients = email.to?.map(t => t.email).join(', ') || '';
    fromDisplayName = recipients ? `[草稿] 发至: ${recipients}` : '[新建草稿]';
  } else {
    fromDisplayName = email.from?.name || email.from?.email || 'Unknown';
  }

  return `
    <div class="email-item border-b border-gray-200 p-3 hover:bg-gray-50 cursor-pointer flex items-start relative ${isUnread ? 'bg-gray-50/50' : ''}" data-id="${email.message_id}" data-draft="${email.is_draft ? 'true' : 'false'}" data-folder="${email.dir || 'inbox'}">
      
      <!-- 左侧状态控制栏（已读未读与星标并列） -->
      <div class="flex-shrink-0 flex flex-col items-center gap-2 mr-3 mt-0.5 w-5">
        <!-- 已读未读小圈 -->
        ${!email.is_draft ? `
          <button class="read-toggle-btn p-0.5 focus:outline-none" data-id="${email.message_id}" data-read="${email.is_read ? 'true' : 'false'}" title="切换已读/未读">
            <div class="w-2 h-2 rounded-full ${email.is_read ? 'border border-gray-300 bg-transparent' : 'bg-black'} transition-all"></div>
          </button>
        ` : '<div class="w-2 h-2"></div>'}
        
        <!-- 星标星星 -->
        ${!email.is_draft ? `
          <button class="star-btn focus:outline-none p-0.5" data-id="${email.message_id}">
            <i class="${starIcon} hover:text-yellow-500 text-[11px]"></i>
          </button>
        ` : ''}
      </div>

      <div class="flex-1 min-w-0">
        <div class="flex items-baseline justify-between mb-0.5">
          <div class="font-medium text-gray-900 truncate ${isUnread ? 'font-semibold' : ''}">
            ${escapeHtml(fromDisplayName)}
          </div>
          <span class="text-[10px] text-gray-400 whitespace-nowrap ml-2">${formatDate(email.created_at)}</span>
        </div>
        <div class="text-xs text-gray-700 truncate">${escapeHtml(email.subject || '(无主题)')}</div>
        <div class="text-[11px] text-gray-400 truncate mt-0.5">${escapeHtml(email.snippet || '')}</div>
        ${email.has_attachments ? '<div class="mt-0.5"><i class="fas fa-paperclip text-gray-400 text-[10px]"></i></div>' : ''}
      </div>
    </div>
  `;
}

// 绑定邮件列表项事件处理器（基于 dataset.bound 锁去重防堆积）
function bindEmailItemEvents(emails) {
  // 绑定邮件点击
  document.querySelectorAll('.email-item').forEach(item => {
    if (item.dataset.bound) return;
    item.dataset.bound = 'true';
    
    item.addEventListener('click', (e) => {
      // 阻止点击星星、已读圆点时触发详情加载
      if (e.target.closest('.star-btn') || e.target.closest('.read-toggle-btn')) {
        return;
      }
      
      const id = item.dataset.id;
      const isDraft = item.dataset.draft === 'true';
      
      if (isDraft) {
        const draftEmail = emails.find(em => em.message_id === id) || { message_id: id, is_draft: true };
        openComposeModal(draftEmail);
      } else {
        loadEmailDetail(id);
      }
    });
  });

  // 绑定标星点击
  document.querySelectorAll('.star-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      toggleEmailStar(id, btn.querySelector('i'));
    });
  });

  // 绑定已读未读圆点点击
  document.querySelectorAll('.read-toggle-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const isRead = btn.dataset.read === 'true';
      toggleEmailReadState(id, !isRead, btn);
    });
  });
}

// 渲染邮件列表
function renderEmailList(emails) {
  const container = document.getElementById('emailList');
  
  if (emails.length === 0) {
    container.innerHTML = `
      <div class="h-full flex items-center justify-center py-20 text-gray-400">
        <div class="text-center space-y-3">
          <!-- Notion 极简折纸几何信封 SVG -->
          <svg class="mx-auto w-10 h-10 text-gray-200 stroke-current stroke-1 fill-none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div class="space-y-0.5">
            <p class="text-xs font-semibold text-gray-500">收件箱已净空</p>
            <p class="text-[10px] text-gray-400 select-none">专注当下，处理完所有待办</p>
          </div>
        </div>
      </div>
    `;
    return;
  }
  
  container.innerHTML = emails.map(email => renderSingleEmailItemMarkup(email)).join('');
  bindEmailItemEvents(emails);
}

// 异步切换星标
async function toggleEmailStar(id, iconEl) {
  try {
    const res = await fetch(`${API_BASE}/api/messages/${id}/star`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (data.data.is_starred) {
        iconEl.className = 'fas fa-star text-yellow-400 hover:text-yellow-500 text-sm';
      } else {
        iconEl.className = 'far fa-star text-gray-300 hover:text-yellow-500 text-sm';
      }
      if (currentFolder === 'starred') {
        loadEmails('starred');
      }
    }
  } catch (error) {
    console.error('切换标星失败:', error);
  }
}

// 异步切换已读未读状态
async function toggleEmailReadState(id, targetReadState, btnEl) {
  try {
    const res = await fetch(`${API_BASE}/api/messages/${id}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_read: targetReadState })
    });
    const data = await res.json();
    if (data.ok) {
      // 局部重绘该圆点状态
      btnEl.dataset.read = targetReadState ? 'true' : 'false';
      const circleEl = btnEl.querySelector('div');
      if (targetReadState) {
        circleEl.className = 'w-2 h-2 rounded-full border border-gray-300 bg-transparent';
        btnEl.closest('.email-item').classList.remove('bg-gray-50/50');
      } else {
        circleEl.className = 'w-2 h-2 rounded-full bg-black';
        btnEl.closest('.email-item').classList.add('bg-gray-50/50');
      }
      
      // 从后端更新收件箱真实总未读数
      loadUnreadCount();
    }
  } catch (error) {
    console.error('切换已读状态失败:', error);
  }
}

// 从后端拉取收件箱的真实总未读数并更新侧边栏角标
async function loadUnreadCount() {
  try {
    const res = await fetch(`${API_BASE}/api/unread-count`);
    const data = await res.json();
    if (data.ok) {
      document.getElementById('unreadCount').textContent = data.data.count;
    }
  } catch (error) {
    console.error('加载未读计数失败:', error);
  }
}

// 加载邮件详情
async function loadEmailDetail(id) {
  // 展示骨架屏占位图
  showDetailSkeleton();

  try {
    const res = await fetch(`${API_BASE}/api/messages/${id}`);
    const data = await res.json();
    
    // 控制离线状态徽标的显隐
    const offlineBadge = document.getElementById('offlineBadge');
    if (offlineBadge) {
      if (data.is_offline) {
        offlineBadge.classList.remove('hidden');
      } else {
        offlineBadge.classList.add('hidden');
      }
    }

    if (data.ok) {
      renderEmailDetail(data.data);
      selectedEmailId = id;
      
      // 点开后，若该邮件原为未读，自动前端标记该行已读
      const listItemBtn = document.querySelector(`.read-toggle-btn[data-id="${id}"]`);
      if (listItemBtn && listItemBtn.dataset.read === 'false') {
        listItemBtn.dataset.read = 'true';
        const circle = listItemBtn.querySelector('div');
        circle.className = 'w-2 h-2 rounded-full border border-gray-300 bg-transparent';
        listItemBtn.closest('.email-item').classList.remove('bg-gray-50/50');
        loadUnreadCount();
      }

      // 给选中邮件加高亮选中样式
      document.querySelectorAll('.email-item').forEach(item => {
        item.classList.remove('email-item-selected');
        if (item.dataset.id === id) {
          item.classList.add('email-item-selected');
        }
      });
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
  const starIcon = email.is_starred ? 'fas fa-star text-yellow-400' : 'far fa-star text-gray-300';

  // 提取发件人名字的首字符
  const senderDisplayName = email.from?.name || email.from?.email || 'Unknown';
  const firstChar = senderDisplayName.charAt(0).toUpperCase();
  
  // 简易 Hash 算法分配高级冷淡暗灰色系背景
  const avatarColors = ['bg-slate-700', 'bg-zinc-800', 'bg-neutral-800', 'bg-stone-700'];
  const colorIndex = Math.abs(firstChar.charCodeAt(0) % avatarColors.length);
  const avatarBg = avatarColors[colorIndex];

  container.innerHTML = `
    <div class="bg-white p-6 h-full flex flex-col fade-in-content">
      <!-- 邮件标题 -->
      <div class="mb-5">
        <div class="flex items-start justify-between mb-4">
          <h2 class="text-lg font-bold text-black mr-4">${escapeHtml(email.subject || '(无主题)')}</h2>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <!-- 一键复制按钮 -->
            <button id="copyDetailBtn" class="focus:outline-none p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-black transition-colors" title="复制正文">
              <i class="far fa-copy text-sm"></i>
            </button>
            <!-- 星标按钮 -->
            <button id="detailStarBtn" class="focus:outline-none p-1 rounded hover:bg-gray-100" data-id="${email.message_id}">
              <i class="${starIcon} text-base hover:scale-105 transition-transform"></i>
            </button>
          </div>
        </div>
        
        <!-- 发件人圆形头像与账号 -->
        <div class="flex items-center gap-3 py-2 border-b border-[#eaeaea]">
          <div class="w-8 h-8 rounded-full ${avatarBg} text-white flex items-center justify-center font-bold text-xs flex-shrink-0">
            ${firstChar}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-gray-900 text-xs">${escapeHtml(senderDisplayName)}</span>
              <span class="text-[10px] text-gray-400">${formatDate(email.created_at)}</span>
            </div>
            <div class="text-[10px] text-gray-400 truncate">&lt;${escapeHtml(email.from?.email || '')}&gt;</div>
          </div>
        </div>

        <div class="mt-3 text-xs text-gray-500 flex items-start gap-1">
          <span class="font-medium text-gray-400 uppercase mr-1 flex-shrink-0">收件人:</span>
          <div id="recipientsSummary" class="flex-1 min-w-0 truncate text-gray-600 transition-opacity">
            ${escapeHtml(email.to?.map(t => t.email).join(', ') || '')}
          </div>
          <button id="toggleRecipientsBtn" class="text-[10px] text-gray-400 hover:text-black font-semibold ml-2 focus:outline-none flex-shrink-0 select-none">详情</button>
        </div>

        <!-- 抽屉折叠展开面板 (默认隐藏) -->
        <div id="recipientsDrawer" class="hidden mt-2 p-2.5 bg-gray-50 border border-gray-150 rounded-lg text-[11px] text-gray-600 space-y-2 transition-all duration-200">
          <div>
            <span class="font-semibold text-gray-400 uppercase text-[9px] block mb-0.5">发件人</span>
            <span class="text-gray-800">${escapeHtml(email.from?.name || '')} &lt;${escapeHtml(email.from?.email || '')}&gt;</span>
          </div>
          <div>
            <span class="font-semibold text-gray-400 uppercase text-[9px] block mb-0.5">收件人</span>
            <div class="space-y-0.5">
              ${email.to?.map(t => `<div class="text-gray-800">${escapeHtml(t.name || '')} &lt;${escapeHtml(t.email || '')}&gt;</div>`).join('')}
            </div>
          </div>
          ${email.cc && email.cc.length > 0 ? `
            <div>
              <span class="font-semibold text-gray-400 uppercase text-[9px] block mb-0.5">抄送</span>
              <div class="space-y-0.5">
                ${email.cc.map(c => `<div class="text-gray-800">${escapeHtml(c.name || '')} &lt;${escapeHtml(c.email || '')}&gt;</div>`).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
      
      <!-- 支持显示富文本 HTML 内容 -->
      <div class="email-content prose max-w-none mb-6 border-t border-gray-100 pt-4 flex-1 overflow-y-auto">
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
      
      <div class="border-t border-gray-200 pt-4 mt-6 flex gap-3 flex-shrink-0">
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

  // 绑定详情部收件人抽屉展开
  const toggleBtn = document.getElementById('toggleRecipientsBtn');
  const drawer = document.getElementById('recipientsDrawer');
  const summary = document.getElementById('recipientsSummary');
  if (toggleBtn && drawer) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = drawer.classList.contains('hidden');
      if (isHidden) {
        drawer.classList.remove('hidden');
        summary.classList.add('opacity-30');
        toggleBtn.textContent = '收起';
      } else {
        drawer.classList.add('hidden');
        summary.classList.remove('opacity-30');
        toggleBtn.textContent = '详情';
      }
    });
  }
  
  // 详情页一键复制正文
  document.getElementById('copyDetailBtn').addEventListener('click', () => {
    const plainText = email.body_text || (email.body || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    navigator.clipboard.writeText(plainText).then(() => {
      showToast('📋 邮件正文已成功复制！');
    }).catch(err => {
      console.error('复制失败:', err);
    });
  });

  document.getElementById('detailStarBtn').addEventListener('click', () => {
    const id = email.message_id;
    const icon = document.querySelector('#detailStarBtn i');
    toggleEmailStar(id, icon).then(() => {
      loadEmails(currentFolder);
    });
  });

  document.querySelectorAll('.download-att').forEach(btn => {
    btn.addEventListener('click', () => {
      downloadAttachment(btn.dataset.msg, btn.dataset.att);
    });
  });
}

// 加载去重联系人列表
async function loadContacts() {
  try {
    const res = await fetch(`${API_BASE}/api/contacts`);
    const data = await res.json();
    if (data.ok) {
      cachedContacts = data.data || [];
    }
  } catch (e) {
    console.error('获取历史联系人失败:', e);
  }
}

// 渲染联系人补全下拉框
function handleAutocomplete(inputVal) {
  const listEl = document.getElementById('autocompleteList');
  if (!inputVal || inputVal.trim() === '') {
    listEl.classList.add('hidden');
    return;
  }

  // 提取输入框最后一个逗号后面的字符进行补全
  const parts = inputVal.split(',');
  const query = parts[parts.length - 1].trim().toLowerCase();
  if (!query) {
    listEl.classList.add('hidden');
    return;
  }

  const matches = cachedContacts.filter(c => 
    c.email.toLowerCase().includes(query) || 
    (c.name && c.name.toLowerCase().includes(query))
  ).slice(0, 8); // 最多展示 8 个

  if (matches.length === 0) {
    listEl.classList.add('hidden');
    return;
  }

  listEl.innerHTML = matches.map(c => `
    <div class="autocomplete-item p-2 hover:bg-gray-100 cursor-pointer flex items-center justify-between border-b border-gray-100 last:border-0" data-email="${c.email}">
      <span class="font-medium text-gray-800 text-sm">${escapeHtml(c.name || 'Unknown')}</span>
      <span class="text-xs text-gray-400">${escapeHtml(c.email)}</span>
    </div>
  `).join('');

  listEl.classList.remove('hidden');

  // 绑定点击事件
  document.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('click', () => {
      const email = item.dataset.email;
      parts[parts.length - 1] = ' ' + email;
      document.getElementById('toInput').value = parts.join(',') + ', ';
      listEl.classList.add('hidden');
      document.getElementById('toInput').focus();
    });
  });
}

// 打开写信并初始化草稿/补全
function openComposeModal(draftData = null) {
  const modal = document.getElementById('composeModal');
  modal.classList.remove('hidden');
  document.getElementById('draftStatus').textContent = '';
  document.getElementById('autocompleteList').classList.add('hidden');

  // 重置最大化与最小化状态
  isComposeMinimized = false;
  isComposeMaximized = false;
  modal.style.height = '';
  modal.classList.remove('overflow-hidden');
  modal.className = 'fixed bottom-0 right-10 w-[520px] z-50';
  
  const maxIcon = document.querySelector('#maximizeCompose i');
  if (maxIcon) maxIcon.className = 'fas fa-expand text-xs';

  // 预加载历史联系人
  loadContacts();
  
  if (draftData && draftData.is_draft) {
    currentDraftId = draftData.draft_id;
    document.getElementById('toInput').value = draftData.to?.map(t => t.email).join(', ') || '';
    document.getElementById('ccInput').value = draftData.cc?.map(c => c.email).join(', ') || '';
    document.getElementById('subjectInput').value = draftData.subject || '';
    quill.setHTML(draftData.body || '');
  } else {
    currentDraftId = 'draft_' + Math.random().toString(36).substring(2, 15);
    document.getElementById('toInput').value = '';
    document.getElementById('ccInput').value = '';
    document.getElementById('subjectInput').value = '';
    quill.setHTML('');
  }
  
  startDraftAutoSave();
}

function startDraftAutoSave() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    saveDraftSilent(false);
  }, 15000);
}

function stopDraftAutoSave() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
}

async function saveDraftSilent(isManual = false) {
  const to = document.getElementById('toInput').value.trim();
  const cc = document.getElementById('ccInput').value.trim();
  const subject = document.getElementById('subjectInput').value.trim();
  const body = quill.getSemanticHTML().trim();

  if (!to && !subject && (body === '<p></p>' || !body)) {
    return;
  }

  const statusEl = document.getElementById('draftStatus');
  if (isManual) {
    statusEl.textContent = '正在存入草稿...';
  }

  // 整理格式
  const toArr = to ? to.split(',').map(e => e.trim()).filter(Boolean) : [];
  const ccArr = cc ? cc.split(',').map(e => e.trim()).filter(Boolean) : [];

  try {
    const res = await fetch(`${API_BASE}/api/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft_id: currentDraftId,
        to: toArr,
        cc: ccArr,
        subject,
        body
      })
    });
    const data = await res.json();
    if (data.ok) {
      const now = new Date();
      statusEl.textContent = `草稿已于 ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 暂存`;
      if (currentFolder === 'drafts') {
        loadEmails('drafts');
      }
    } else if (isManual) {
      statusEl.textContent = '草稿保存失败: ' + data.error;
    }
  } catch (error) {
    if (isManual) {
      statusEl.textContent = '草稿保存失败: ' + error.message;
    }
  }
}

// 打开回复模态框
function openReplyModal(email) {
  openComposeModal();
  document.getElementById('toInput').value = email.from?.email || '';
  document.getElementById('subjectInput').value = `Re: ${email.subject || ''}`;
  quill.setHTML(`<br><br><hr>在 ${formatDate(email.created_at)}，${email.from?.name || email.from?.email || ''} 写道：<br>${email.body || email.body_text || ''}`);
}

// 打开转发模态框
function openForwardModal(email) {
  openComposeModal();
  document.getElementById('subjectInput').value = `Fwd: ${email.subject || ''}`;
  const toStr = email.to?.map(t => `${t.name || ''} <${t.email}>`).join(', ') || '';
  quill.setHTML(`<br><br><hr>转发的邮件：<br>发件人: ${email.from?.name || ''} &lt;${email.from?.email || ''}&gt;<br>日期: ${formatDate(email.created_at)}<br>主题: ${email.subject || ''}<br>收件人: ${toStr}<br><br>${email.body || email.body_text || ''}`);
}

// 发送邮件
async function sendEmail() {
  const to = document.getElementById('toInput').value.trim();
  const cc = document.getElementById('ccInput').value.trim();
  const subject = document.getElementById('subjectInput').value.trim();
  const body = quill.getSemanticHTML().trim();
  
  if (!to) {
    const toInput = document.getElementById('toInput');
    toInput.classList.add('shake-warning');
    toInput.focus();
    setTimeout(() => {
      toInput.classList.remove('shake-warning');
    }, 400);
    return;
  }
  
  if (!subject) {
    if (!confirm('主题为空，确定继续发送吗？')) {
      return;
    }
  }
  
  stopDraftAutoSave();

  try {
    const toArr = to.split(',').map(e => e.trim()).filter(Boolean);
    const ccArr = cc ? cc.split(',').map(e => e.trim()).filter(Boolean) : undefined;

    // 第一阶段
    // 第一阶段
    const res1 = await fetch(`${API_BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: toArr,
        cc: ccArr,
        subject,
        body
      })
    });
    
    const data1 = await res1.json();
    
    if (data1.ok && data1.data && data1.data.confirmation_required) {
      const summary = data1.data.summary;
      const confirmMsg = `确认发送这封邮件吗？\n\n发件人: ${summary.from}\n收件人: ${summary.to.join(', ')}\n主题: ${summary.subject}`;
      
      if (!confirm(confirmMsg)) {
        startDraftAutoSave();
        return;
      }
      
      // 第二阶段
      const res2 = await fetch(`${API_BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toArr,
          cc: ccArr,
          subject,
          body,
          confirmation_token: data1.data.confirmation_token
        })
      });
      
      const data2 = await res2.json();
      
      if (data2.ok) {
        alert('邮件发送成功！');
        await clearCurrentDraftOnSuccess();
      } else {
        alert('发送失败: ' + (data2.error || JSON.stringify(data2)));
        startDraftAutoSave();
      }
    } else if (data1.ok) {
      alert('邮件发送成功！');
      await clearCurrentDraftOnSuccess();
    } else {
      alert('发送失败: ' + (data1.error || JSON.stringify(data1)));
      startDraftAutoSave();
    }
  } catch (error) {
    alert('发送失败: ' + error.message);
    startDraftAutoSave();
  }
}

async function clearCurrentDraftOnSuccess() {
  try {
    await fetch(`${API_BASE}/api/drafts/${currentDraftId}`, { method: 'DELETE' });
  } catch (e) {
    console.error('清除草稿失败:', e);
  }
  document.getElementById('composeModal').classList.add('hidden');
  loadEmails(currentFolder);
}

// 删除邮件
async function deleteEmail(id) {
  if (!confirm('确定要删除这封邮件吗？')) {
    return;
  }
  
  // 定位这封邮件在被删除前所在的原本目录
  const itemEl = document.querySelector(`.email-item[data-id="${id}"]`);
  const originFolder = itemEl ? (itemEl.dataset.folder || 'inbox') : 'inbox';

  try {
    const res1 = await fetch(`${API_BASE}/api/trash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    
    const data1 = await res1.json();
    
    // 执行撤销的回调函数
    const undoCallback = async () => {
      try {
        const undoRes = await fetch(`${API_BASE}/api/messages/${id}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: originFolder })
        });
        const undoData = await undoRes.json();
        if (undoData.ok) {
          showToast('已撤销删除！');
          loadEmails(currentFolder);
        }
      } catch (err) {
        console.error('撤销删除失败:', err);
      }
    };

    if (data1.ok) {
      resetDetailPanel();
      loadEmails(currentFolder);
      showToast('邮件已移至已删除', undoCallback);
    } else if (data1.error && data1.error.includes('confirmation')) {
      const res2 = await fetch(`${API_BASE}/api/trash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, confirmation_token: data1.data.confirmation_token })
      });
      
      const data2 = await res2.json();
      
      if (data2.ok) {
        resetDetailPanel();
        loadEmails(currentFolder);
        showToast('邮件已移至已删除', undoCallback);
      } else {
        showToast('删除失败: ' + data2.error);
      }
    } else {
      showToast('删除失败: ' + data1.error);
    }
  } catch (error) {
    showToast('删除失败: ' + error.message);
  }
}


function resetDetailPanel() {
  document.getElementById('emailDetail').innerHTML = `
    <div class="h-full flex items-center justify-center text-gray-400">
      <div class="text-center">
        <i class="fas fa-envelope-open text-6xl mb-4"></i>
        <p>选择一封邮件查看详情</p>
      </div>
    </div>
  `;
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
  
  const clearBtn = document.getElementById('clearSearchBtn');
  const spinIcon = document.getElementById('searchStatusIcon');
  if (clearBtn) clearBtn.classList.add('hidden');
  if (spinIcon) spinIcon.classList.remove('hidden');

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
  } finally {
    if (spinIcon) spinIcon.classList.add('hidden');
    if (clearBtn && document.getElementById('searchInput').value.trim()) {
      clearBtn.classList.remove('hidden');
    }
  }
}

// 动态淡入淡出 Toast 提示框（支持 5s 后悔药撤销回调）
let toastTimer = null;
function showToast(msg, undoCallback = null) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  if (!toast || !toastMsg) return;

  if (undoCallback) {
    toastMsg.innerHTML = `${msg} <button id="toastUndoBtn" class="text-white underline ml-1 hover:text-gray-300 font-bold focus:outline-none">撤销</button>`;
    // 延迟 20ms 等待 DOM 挂载完毕后绑定点击
    setTimeout(() => {
      const btn = document.getElementById('toastUndoBtn');
      if (btn) {
        btn.onclick = (e) => {
          e.stopPropagation();
          undoCallback();
          hideToast();
        };
      }
    }, 20);
  } else {
    toastMsg.textContent = msg;
  }

  toast.classList.remove('hidden');
  
  // 触发动画
  setTimeout(() => {
    toast.classList.remove('translate-y-10', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
  }, 10);

  // 清除旧的定时器，设定 5秒 自动淡出
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    hideToast();
  }, 5000);
}

function hideToast() {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.classList.remove('translate-y-0', 'opacity-100');
  toast.classList.add('translate-y-10', 'opacity-0');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 300);
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
      document.querySelectorAll('.folder-btn').forEach(b => b.classList.remove('bg-gray-100'));
      btn.classList.add('bg-gray-100');
      currentFolder = btn.dataset.folder;
      loadEmails(currentFolder);
    });
  });

  // 邮件列表滚动触底监听 (无限滚动加载更多)
  const emailList = document.getElementById('emailList');
  if (emailList) {
    emailList.addEventListener('scroll', () => {
      const isScrollBottom = emailList.scrollHeight - emailList.scrollTop - emailList.clientHeight < 60;
      if (isScrollBottom && !isLoadingMore && hasMoreEmails && currentCursor) {
        loadEmails(currentFolder, currentCursor);
      }
    });
  }
  
  // 强制手动同步收信
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const icon = refreshBtn.querySelector('i');
      icon.classList.add('fa-spin', 'text-blue-600');
      
      // 穿透缓存，发送 refresh = true
      await loadEmails(currentFolder, null, true);
      
      icon.classList.remove('fa-spin', 'text-blue-600');
      showToast('最新邮件同步成功！');
    });
  }

  // 写信按钮
  document.getElementById('composeBtn').addEventListener('click', () => openComposeModal(null));
  
  // 手动保存草稿
  document.getElementById('saveDraftBtn').addEventListener('click', () => {
    saveDraftSilent(true);
  });

  // 关闭和取消写信
  document.getElementById('closeCompose').addEventListener('click', () => {
    stopDraftAutoSave();
    document.getElementById('composeModal').classList.add('hidden');
  });
  
  document.getElementById('cancelCompose').addEventListener('click', () => {
    stopDraftAutoSave();
    document.getElementById('composeModal').classList.add('hidden');
  });

  // 最小化写信悬浮窗
  const minimizeBtn = document.getElementById('minimizeCompose');
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => {
      const modal = document.getElementById('composeModal');
      isComposeMinimized = !isComposeMinimized;
      if (isComposeMinimized) {
        modal.style.height = '38px';
        modal.classList.add('overflow-hidden');
      } else {
        modal.style.height = '';
        modal.classList.remove('overflow-hidden');
      }
    });
  }

  // 最大化写信悬浮窗
  const maximizeBtn = document.getElementById('maximizeCompose');
  if (maximizeBtn) {
    maximizeBtn.addEventListener('click', () => {
      const modal = document.getElementById('composeModal');
      const icon = maximizeBtn.querySelector('i');
      isComposeMaximized = !isComposeMaximized;
      if (isComposeMaximized) {
        // 重置最小化状态
        isComposeMinimized = false;
        modal.style.height = '';
        modal.classList.remove('overflow-hidden');

        modal.className = 'fixed bottom-10 right-[7.5vw] w-[85vw] h-[85vh] z-50 transition-all';
        icon.className = 'fas fa-compress text-xs';
      } else {
        modal.className = 'fixed bottom-0 right-10 w-[520px] z-50 transition-all';
        icon.className = 'fas fa-expand text-xs';
      }
    });
  }
  
  // 收件人联想词补全
  const toInput = document.getElementById('toInput');
  const autocompleteList = document.getElementById('autocompleteList');
  if (toInput) {
    toInput.addEventListener('input', (e) => {
      handleAutocomplete(e.target.value);
    });
    
    // 点击页面其他空白处隐藏下拉联想框
    document.addEventListener('click', (e) => {
      if (!toInput.contains(e.target) && !autocompleteList.contains(e.target)) {
        autocompleteList.classList.add('hidden');
      }
    });
  }

  // 发送邮件
  document.getElementById('sendEmail').addEventListener('click', sendEmail);

  // 绑定常规写信输入框的快捷键（Ctrl+Enter 发信）
  const composeInputs = ['toInput', 'ccInput', 'subjectInput'];
  composeInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          sendEmail();
        }
      });
    }
  });
  
  // 搜索
  let searchTimeout;
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val.trim()) {
        if (clearSearchBtn) clearSearchBtn.classList.remove('hidden');
      } else {
        if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
      }

      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchEmails(val);
      }, 500);
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      loadEmails(currentFolder);
    });
  }
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
}

// 渲染极简脉冲闪烁骨架屏占位图
function showDetailSkeleton() {
  const container = document.getElementById('emailDetail');
  container.innerHTML = `
    <div class="bg-white p-6 h-full flex flex-col animate-pulse">
      <div class="mb-5">
        <!-- 标题占位 -->
        <div class="h-6 bg-gray-100 rounded w-2/3 mb-5"></div>
        <!-- 作者栏头像占位 -->
        <div class="flex items-center gap-3 py-2 border-b border-[#eaeaea]">
          <div class="w-8 h-8 rounded-full bg-gray-100 flex-shrink-0"></div>
          <div class="flex-1 space-y-1.5">
            <div class="h-3 bg-gray-100 rounded w-1/4"></div>
            <div class="h-2 bg-gray-100 rounded w-1/3"></div>
          </div>
        </div>
      </div>
      <!-- 正文多行骨架条 -->
      <div class="space-y-3 mt-4 flex-1">
        <div class="h-3 bg-gray-100 rounded w-full"></div>
        <div class="h-3 bg-gray-100 rounded w-11/12"></div>
        <div class="h-3 bg-gray-100 rounded w-5/6"></div>
        <div class="h-3 bg-gray-100 rounded w-full"></div>
        <div class="h-3 bg-gray-100 rounded w-4/5"></div>
        <div class="h-3 bg-gray-100 rounded w-11/12"></div>
        <div class="h-3 bg-gray-100 rounded w-2/3"></div>
      </div>
    </div>
  `;
}

// 绑定登录页事件监听
function setupLoginEvents() {
  const submitBtn = document.getElementById('submitLoginBtn');
  const userEl = document.getElementById('loginUser');
  const passEl = document.getElementById('loginPass');
  const errorEl = document.getElementById('loginError');
  const errorTxt = document.getElementById('loginErrorText');
  const overlay = document.getElementById('loginOverlay');

  if (!submitBtn) return;

  async function handleLogin() {
    const username = userEl.value.trim();
    const password = passEl.value.trim();
    if (!username || !password) {
      errorTxt.textContent = '请输入用户名和密码';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin text-[10px]"></i><span>登录中...</span>`;

    try {
      const res = await originalFetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.ok && data.data.token) {
        localStorage.setItem('auth_token', data.data.token);
        errorEl.classList.add('hidden');
        if (overlay) {
          overlay.classList.add('hidden'); // 隐藏登录拦截页
        }
        
        // 成功登录后重新加载用户数据
        await loadUserInfo();
        await loadEmails();
        await loadUnreadCount();
      } else {
        errorTxt.textContent = data.error || '用户名或密码错误';
        errorEl.classList.remove('hidden');
      }
    } catch (e) {
      errorTxt.textContent = '连接服务失败: ' + e.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<span>安全登录</span><i class="fas fa-arrow-right text-[9px]"></i>`;
    }
  }

  submitBtn.addEventListener('click', handleLogin);
  
  // 支持回车一键登录
  [userEl, passEl].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLogin();
      }
    });
  });
}

// 启动
init();

