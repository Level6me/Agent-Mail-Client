#!/bin/bash

# Agent Mail Client 部署脚本

set -e

echo "🚀 开始部署 Agent Mail Client..."

# 安装 Node.js (如果未安装)
if ! command -v node &> /dev/null; then
    echo "📦 安装 Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 安装 PM2 (进程管理器)
if ! command -v pm2 &> /dev/null; then
    echo "📦 安装 PM2..."
    sudo npm install -g pm2
fi

# 安装依赖
echo "📦 安装项目依赖..."
npm install --production

# 安装 agently-cli
echo "📦 安装 agently-cli..."
sudo npm install -g @tencent-qqmail/agently-cli

# 创建 .env 文件
if [ ! -f .env ]; then
    echo "⚙️ 创建环境配置..."
    cp .env.example .env
fi

# 启动应用
echo "🚀 启动应用..."
pm2 start server.js --name agent-mail-client
pm2 save
pm2 startup

# 配置 Nginx (可选)
echo "🔧 配置 Nginx..."
sudo apt-get install -y nginx

sudo tee /etc/nginx/sites-available/agent-mail-client > /dev/null <<'EOF'
server {
    listen 80;
    server_name mail.example.com;  # 替换为实际域名或 IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/agent-mail-client /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

echo "✅ 部署完成！"
echo "📝 下一步："
echo "1. 运行 'agently-cli auth login' 完成邮箱授权"
echo "2. 修改 /etc/nginx/sites-available/agent-mail-client 中的 server_name"
echo "3. 访问 http://your-server-ip"
