# ✉️ Agent Mail Client

> 基于 [agently-cli](https://agent.qq.com) 构建的现代化 Web 邮箱客户端，用于收发 Agent Mail 邮件。  
> 极简黑白 Vercel 风格 UI · 本地缓存秒开 · 多账号物理隔离 · 移动端自适应适配 · 离线容灾降级

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## ✨ 功能全景

### 📬 核心邮件功能
- **多文件夹管理** — 收件箱 / 已发送 / 星标邮件 / 草稿箱 / 垃圾邮件 / 已删除，一键切换
- **撰写邮件** — Quill 富文本编辑器，支持加粗/斜体/下划线/颜色/链接
- **回复 & 转发** — 引用原文快速回复，一键转发含完整信息头
- **抄送 & 密送** — 支持 CC / BCC 多收件人
- **附件下载** — 邮件附件直接下载到本地
- **搜索邮件** — 全局关键词搜索，后端 `agently-cli` 实时检索

### ⚡ 性能优化
- **本地缓存秒开** — SQLite 本地数据库优先直读（2-5ms 渲染），后台静默同步云端最新邮件
- **正文预拉取** — 后台以 500ms 间隔排队预加载前 20 封邮件正文，点开即显
- **无限滚动** — 触底自动加载下一页，`LIMIT 20 OFFSET` 分页检索
- **WAL 模式** — SQLite 并发读写优化，多请求不阻塞

### 🔒 多账号物理隔离 & 安全认证
- **物理分库隔离** — **多账号安全隔离**，登录不同邮箱时动态切换独立物理 SQLite 数据库（`mail_cache_<email>.db`），彻底防止多邮箱账号间数据串号及泄露
- **用户名密码登录** — Vercel 风格全屏磨砂玻璃登录拦截页
- **Token 鉴权** — `crypto` 生成 32 字节随机 SessionToken，`Authorization: Bearer` 标准传输
- **全局中间件** — `authMiddleware` 拦截所有 `/api/*` 路由，无有效 Token 返回 `401`
- **前端 Fetch Hook** — 自动注入鉴权头，`401` 状态码自动回退登录页
- **退出登录** — 侧边栏一键安全退出，清除凭证并锁定界面
- **全自动 Web OAuth 绑定与解绑** — 首次登录或登出后，前端直接展示绑定链接与向导，支持一键断开绑定，无需操作终端

### 📱 移动端自适应适配 & UI 细节
- **自适应单列滑动布局** — 适配手机和平板，大屏显示完整三栏，小屏自动折叠侧边栏并启用邮件列表与全屏详情的滑动切换
- **防触误放大** — 阻止移动端双指捏合与双击手势放大页面，极大提升触屏操作稳定性
- **等宽侧边栏图标** — 全局使用 FontAwesome `fa-fw` 固定宽度类名，确保文件夹导航文本绝对垂直对齐
- **骨架屏加载** — 列表与详情页完整骨架占位 + 淡入动效
- **选中态指示** — `::before` 伪元素黑色竖线滑块，上下 3px 精准留空
- **Quill 悬浮窗最大化** — 支持新建信箱一键扩展至纯全屏展示，高度动态延展，收起无缝恢复原尺寸
- **收件人抽屉** — 详情页一键展开/收缩查看全部发件人、收件人与抄送人
- **邮件快速删除** — 双阶段安全删除确认 + 5 秒撤销后悔药（Undo Toast）
- **一键复制正文** — 详情页工具栏快速复制邮件内容
- **本地星标** — 重要邮件本地标星管理
- **快捷键** — `Ctrl+Enter` 极速发信
- **图片粘贴** — Quill 编辑器支持拖拽/粘贴图片，自动 Base64 内联插入

### 🛡️ 容灾保护
- **弱网降级** — 云端不可达时自动切换本地 SQLite 离线数据
- **AES-256 加密** — 本地缓存敏感字段（发件人、收件人、抄送、主题、正文、正文纯文本、附件等）进行加密存储保护

---

## 🏗️ 技术栈

| 层级 | 技术 |
|------|------|
| **后端框架** | Node.js + Express 5.x |
| **数据持久层** | SQLite3（WAL 模式） |
| **前端视图** | HTML + Tailwind CSS + Vanilla JS |
| **富文本编辑** | Quill.js |
| **邮件服务** | [@tencent-qqmail/agently-cli](https://agent.qq.com) |
| **环境变量** | dotenv |
| **进程管理** | PM2 (推荐) |

---

## 📁 项目结构

```
Agent-Mail-Client/
├── server.js          # Express 后端主入口（API 路由 + 鉴权中间件 + 后台同步）
├── database.js        # SQLite 持久层（建表 / 缓存读写 / 星标管理）
├── package.json       # 项目依赖配置
├── .env.example       # 环境变量模板
├── .gitignore         # Git 忽略规则
├── deploy.sh          # 部署脚本
├── public/
│   ├── index.html     # 前端单页面（侧边栏 + 列表 + 详情 + 编辑器 + 登录页）
│   └── app.js         # 前端交互逻辑（Fetch Hook / 无限滚动 / 登录控制）
└── README.md
```

---

## 🚀 部署与运行

### 1. 一键全自动部署与更新 (强烈推荐 - 生产服务器)

无论是首次在服务器上安装，还是后续对已有部署进行更新，均可登录远程服务器直接执行以下一键自举部署脚本。脚本会自动完成克隆/拉取代码、配置 Node.js & PM2 环境、安装依赖包并进行应用平滑重启：

```bash
curl -sSL https://raw.githubusercontent.com/Level6me/Agent-Mail-Client/main/deploy.sh | bash
```

---

### 2. 本地手动启动 (调试与开发)

如果你希望在本地计算机上运行以进行调试或开发：

#### (1) 克隆项目
```bash
git clone https://github.com/Level6me/Agent-Mail-Client.git
cd Agent-Mail-Client
```

#### (2) 安装依赖
```bash
npm install
```

#### (3) 安装 agently-cli
安装底层的 QQ 邮箱命令行工具（客户端会自动处理授权跳转，无需手动在终端执行登录）：
```bash
npm install -g @tencent-qqmail/agently-cli
```

#### (4) 配置环境变量
```bash
cp .env.example .env
```
编辑 `.env` 文件，按需修改运行端口及管理员凭证：
```env
PORT=3000
NODE_ENV=production

# 登录凭证（可选，默认 admin / password123）
ADMIN_USER=admin
ADMIN_PASSWORD=your_secure_password
```

#### (5) 启动服务
```bash
node server.js
```
访问 **http://localhost:3000**，使用配置好的管理员凭证登录即可。

---

### 3. 服务器手动进程管理 (可选 - 生产配置)

若不想使用一键脚本，你可以手动配置 PM2 或 systemd 进行服务守护：

#### 使用 PM2 进程守护
```bash
# 全局安装 PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name agent-mail-client

# 保存进程列表并设置开机自启
pm2 save
pm2 startup
```

#### 使用 systemd 守护服务
```bash
sudo tee /etc/systemd/system/agent-mail-client.service > /dev/null <<EOF
[Unit]
Description=Agent Mail Client
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/agent-mail-client
ExecStart=/usr/bin/node /home/ubuntu/agent-mail-client/server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable agent-mail-client
sudo systemctl start agent-mail-client
```

---

## 🔑 API 接口

所有 `/api/*` 接口（`/api/login` 除外）均需要在 Headers 中携带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/login` | 系统管理员登录，返回 SessionToken |
| `GET` | `/api/cli-auth-status` | 检测底层 Agently CLI 的授权绑定状态 |
| `POST` | `/api/cli-auth-start` | 开始底层 Agently CLI 授权登录流程 |
| `POST` | `/api/cli-auth-logout` | 退出/解除当前绑定的发信邮箱账号 |
| `POST` | `/api/credentials` | 修改系统管理员用户名和密码 |
| `GET` | `/api/me` | 获取当前绑定邮箱的基本信息（如别名账号等） |
| `GET` | `/api/messages` | 获取缓存的邮件列表（支持 folder 切换与无限滚动分页） |
| `GET` | `/api/messages/:id` | 获取邮件详情（包含正文、附件元数据与已读同步） |
| `POST` | `/api/messages/:id/star` | 切换邮件星标状态 |
| `POST` | `/api/messages/:id/read` | 标记邮件为已读/未读 |
| `POST` | `/api/messages/:id/move` | 移动本地邮件的文件夹分类 |
| `POST` | `/api/drafts` | 保存/自动同步本地草稿信件 |
| `GET` | `/api/drafts` | 获取本地草稿箱列表 |
| `DELETE` | `/api/drafts/:id` | 彻底物理删除一封本地草稿 |
| `GET` | `/api/contacts` | 获取历史去重联系人列表（前端写信联想补全） |
| `GET` | `/api/unread-count` | 获取收件箱未读邮件数量计数 |
| `GET` | `/api/search` | 全局搜索邮件（调用 CLI 实时多条件匹配检索） |
| `POST` | `/api/send` | 发送邮件（统一接管普通写信、回复与转发二阶段确认流程） |
| `POST` | `/api/trash` | 将邮件移动到垃圾箱（支持二阶段安全核销） |
| `GET` | `/api/attachments/:msgId/:attId` | 下载指定邮件附件至本地服务器指定目录 |

---

## 🔒 安全说明

- 默认登录凭证为 `admin` / `password123`，**请在生产环境中通过 `.env` 文件修改**
- Token 使用 Node.js `crypto.randomBytes(32)` 生成，存储在服务端内存中
- 前端 Token 存储在 `localStorage`，关闭浏览器后下次访问需重新登录（服务重启后 Token 失效）
- `.env` 文件已加入 `.gitignore`，不会被提交到版本库

---

## 📄 License

MIT
