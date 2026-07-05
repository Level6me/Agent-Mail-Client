# Agent Mail Client

基于 agently-cli 的 Web 邮箱客户端，用于收发 Agent Mail 邮件。

## 功能

- 📥 收件箱管理（收件箱、已发送、垃圾邮件、已删除）
- 📧 发送邮件（支持抄送、密送）
- ↩️ 回复/转发邮件
- 🔍 搜索邮件
- 📎 附件下载
- 🗑️ 删除邮件

## 技术栈

- **后端**: Node.js + Express
- **前端**: HTML + Tailwind CSS + Vanilla JS
- **邮件服务**: [agently-cli](https://agent.qq.com)

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 安装 agently-cli

```bash
npm install -g @tencent-qqmail/agently-cli
```

### 3. 授权邮箱

```bash
agently-cli auth login
```

### 4. 启动服务

```bash
node server.js
```

访问 http://localhost:3000

## 部署

使用 systemd 部署：

```bash
# 创建服务文件
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

## 配置

创建 `.env` 文件：

```
PORT=3000
NODE_ENV=production
```

## License

MIT
