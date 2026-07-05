#!/bin/bash
set -e

# ==========================================
# Agent Mail Client 服务器端一键更新与重新部署脚本
# ==========================================

echo "🔄 开始在服务器更新并重新部署 Agent Mail Client..."

# 1. 拉取最新代码
echo "📦 正在从 GitHub 拉取最新代码..."
git pull

# 2. 安装/更新依赖
echo "📦 正在更新生产环境依赖..."
npm install --production

# 3. 重启 PM2 运行实例
echo "🔄 正在重启 PM2 进程服务..."
if pm2 show agent-mail-client &>/dev/null; then
    pm2 restart agent-mail-client
    echo "✅ PM2 进程 'agent-mail-client' 已成功重启！"
else
    pm2 start server.js --name agent-mail-client
    echo "✅ PM2 进程 'agent-mail-client' 已启动！"
fi

# 保存 PM2 进程状态
pm2 save

echo "🎉 服务器端部署更新完成！"
pm2 status agent-mail-client
