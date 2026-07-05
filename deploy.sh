#!/bin/bash
set -e

# ==========================================
# Agent Mail Client 一键部署与更新脚本
# 支持首次自动克隆部署，也支持在已有目录中运行更新
# ==========================================

run_deploy() {
    echo "🚀 开始部署 Agent Mail Client..."

    REPO_DIR="Agent-Mail-Client"
    REPO_URL="https://github.com/Level6me/Agent-Mail-Client.git"

    # 1. 检查目录状态并获取最新代码
    if [ -f "server.js" ] && [ -f "package.json" ]; then
        echo "📂 检测到已在项目目录中，正在拉取最新代码..."
        git pull
    elif [ -d "$REPO_DIR" ]; then
        echo "📂 检测到项目目录 $REPO_DIR 已存在，进入目录并更新..."
        cd "$REPO_DIR"
        git pull
    else
        echo "📂 项目目录不存在，正在从 GitHub 克隆仓库..."
        # 确保安装了 git
        if ! command -v git &> /dev/null; then
            echo "📦 正在安装 Git..."
            sudo apt-get update && sudo apt-get install -y git
        fi
        git clone "$REPO_URL"
        cd "$REPO_DIR"
    fi

    # 2. 安装 Node.js (如果未安装)
    if ! command -v node &> /dev/null; then
        echo "📦 正在安装 Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi

    # 3. 安装 PM2 进程管理器 (如果未安装)
    if ! command -v pm2 &> /dev/null; then
        echo "📦 正在安装 PM2..."
        sudo npm install -g pm2
    fi

    # 4. 安装项目依赖
    echo "📦 正在更新项目生产环境依赖..."
    npm install --production

    # 5. 安装 agently-cli (如果未安装)
    if ! command -v agently-cli &> /dev/null; then
        echo "📦 正在安装 agently-cli..."
        sudo npm install -g @tencent-qqmail/agently-cli
    fi

    # 6. 创建默认配置文件
    if [ ! -f .env ]; then
        echo "⚙️ 创建默认环境配置..."
        cp .env.example .env
    fi

    # 7. 启动或重启应用
    echo "🚀 启动/重启应用..."
    if pm2 show agent-mail-client &>/dev/null; then
        pm2 restart agent-mail-client
        echo "✅ PM2 进程 'agent-mail-client' 已成功重启！"
    else
        pm2 start server.js --name agent-mail-client
        echo "✅ PM2 进程 'agent-mail-client' 已成功创建并启动！"
    fi
    pm2 save
    pm2 startup || true

    # 8. 配置 Nginx 反向代理 (可选)
    if ! command -v nginx &> /dev/null; then
        echo "🔧 正在安装并配置 Nginx..."
        sudo apt-get update && sudo apt-get install -y nginx
    fi

    # 如果 Nginx sites 配置文件不存在，则写入并启用
    if [ ! -f /etc/nginx/sites-available/agent-mail-client ]; then
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
    fi

    echo "✅ 部署与更新完成！"
    echo "📝 下一步："
    echo "1. 访问 Web 页面，直接在页面上进行扫码授权绑定，无需进入终端运行授权命令"
    echo "2. 如需修改配置，请编辑项目目录下的 .env 文件"
    echo "3. 修改 /etc/nginx/sites-available/agent-mail-client 中的 server_name 并重启 nginx"
    echo "4. 访问 http://your-server-ip"
}

# 运行部署
run_deploy "$@"
