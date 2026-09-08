#!/bin/bash
set -e

# ==========================================
# Agent Mail Client 一键全自动部署与更新脚本
# 支持全架构、主流 Linux 发行版（Debian/Ubuntu/CentOS/RHEL/Alibaba Cloud/Rocky/Alma/Fedora/Alpine/openSUSE/Arch）
# 支持首次自动克隆部署，也支持在已有目录中运行更新
# ==========================================

# 1. 权限检测 (Root / Sudo)
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo &> /dev/null; then
        SUDO="sudo"
    else
        echo "❌ 错误: 当前用户非 root 且系统未安装 sudo，请切换至 root 用户或安装 sudo 后重试。"
        exit 1
    fi
fi

# 2. Linux 发行版与包管理器识别
detect_os() {
    if command -v apt-get &> /dev/null; then
        PKG_TYPE="debian"
    elif command -v dnf &> /dev/null; then
        PKG_TYPE="rhel_dnf"
    elif command -v yum &> /dev/null; then
        PKG_TYPE="rhel_yum"
    elif command -v pacman &> /dev/null; then
        PKG_TYPE="arch"
    elif command -v zypper &> /dev/null; then
        PKG_TYPE="suse"
    elif command -v apk &> /dev/null; then
        PKG_TYPE="alpine"
    else
        PKG_TYPE="unknown"
    fi
}

install_pkg() {
    local pkgs=("$@")
    case "$PKG_TYPE" in
        debian)
            $SUDO apt-get update -y
            $SUDO apt-get install -y "${pkgs[@]}"
            ;;
        rhel_dnf)
            $SUDO dnf install -y "${pkgs[@]}"
            ;;
        rhel_yum)
            $SUDO yum install -y "${pkgs[@]}"
            ;;
        arch)
            $SUDO pacman -Sy --noconfirm "${pkgs[@]}"
            ;;
        suse)
            $SUDO zypper install -y "${pkgs[@]}"
            ;;
        alpine)
            $SUDO apk update
            $SUDO apk add "${pkgs[@]}"
            ;;
        *)
            echo "⚠️ 未知包管理器，尝试通过系统命令安装: ${pkgs[*]}"
            ;;
    esac
}

# 3. 安装 Node.js (支持 APT / YUM / DNF / 官方预编译二进制多级兜底)
install_nodejs() {
    echo "📦 正在安装/升级 Node.js (>= 18)..."
    
    case "$PKG_TYPE" in
        debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - || true
            $SUDO apt-get install -y nodejs || true
            ;;
        rhel_dnf|rhel_yum)
            # RHEL / CentOS / Alibaba Cloud Linux / Rocky / AlmaLinux
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - || true
            if [ "$PKG_TYPE" = "rhel_dnf" ]; then
                $SUDO dnf install -y nodejs || true
            else
                $SUDO yum install -y nodejs || true
            fi
            # 若 NodeSource 未能成功就绪，尝试系统模块流
            if ! command -v node &> /dev/null; then
                if command -v dnf &> /dev/null; then
                    $SUDO dnf module enable -y nodejs:20 || true
                    $SUDO dnf install -y nodejs || true
                fi
            fi
            ;;
        arch)
            $SUDO pacman -Sy --noconfirm nodejs npm || true
            ;;
        suse)
            $SUDO zypper install -y nodejs20 npm20 || $SUDO zypper install -y nodejs npm || true
            ;;
        alpine)
            $SUDO apk add nodejs npm || true
            ;;
    esac

    # 校验 Node.js 是否已安装且版本 >= 18；若未达标则启用官方预编译独立二进制包解压兜底
    local need_fallback=0
    if ! command -v node &> /dev/null; then
        need_fallback=1
    else
        local cur_ver
        cur_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1)
        if [ -n "$cur_ver" ] && [ "$cur_ver" -lt 18 ]; then
            echo "⚠️ 当前 Node.js 版本 ($(node -v)) 低于 18，启用官方预编译二进制包升级..."
            need_fallback=1
        fi
    fi

    if [ "$need_fallback" -eq 1 ]; then
        echo "📦 正在通过 Node.js 官方预编译独立二进制包进行全架构免编译安装..."
        local arch
        arch=$(uname -m)
        case "$arch" in
            x86_64)        node_arch="x64" ;;
            aarch64|arm64) node_arch="arm64" ;;
            armv7l)        node_arch="armv7l" ;;
            *)             node_arch="x64" ;;
        esac

        local node_ver="v20.18.0"
        local tar_name="node-${node_ver}-linux-${node_arch}.tar.xz"
        local tar_url="https://nodejs.org/dist/${node_ver}/${tar_name}"
        local tmp_dir
        tmp_dir=$(mktemp -d)

        # 确保依赖 tar 和 xz
        if ! command -v xz &> /dev/null; then
            install_pkg xz || true
        fi
        if ! command -v tar &> /dev/null; then
            install_pkg tar || true
        fi

        echo "⬇️ 正在从官方源下载 Node.js $node_ver ($node_arch)..."
        if curl -fsSL "$tar_url" -o "${tmp_dir}/${tar_name}"; then
            $SUDO tar -xJf "${tmp_dir}/${tar_name}" -C /usr/local --strip-components=1
            rm -rf "$tmp_dir"
        else
            rm -rf "$tmp_dir"
            echo "❌ 下载 Node.js 官方预编译包失败，请检查网络后重试。"
            exit 1
        fi
    fi

    if command -v node &> /dev/null; then
        echo "✅ Node.js 环境已就绪: $(node -v)"
        echo "✅ NPM 环境已就绪: $(npm -v)"
    else
        echo "❌ Node.js 安装失败，请手动安装 Node.js (>= 18) 后重试。"
        exit 1
    fi
}

run_deploy() {
    echo "🚀 开始部署 Agent Mail Client..."
    detect_os

    REPO_DIR="Agent-Mail-Client"
    REPO_URL="https://github.com/Level6me/Agent-Mail-Client.git"

    # 1. 检查目录状态并获取最新代码
    if [ -f "server.js" ] && [ -f "package.json" ]; then
        echo "📂 检测到已在项目目录中，正在拉取最新代码..."
        git pull || true
    elif [ -d "$REPO_DIR" ]; then
        echo "📂 检测到项目目录 $REPO_DIR 已存在，进入目录并更新..."
        cd "$REPO_DIR"
        git pull || true
    else
        echo "📂 项目目录不存在，正在从 GitHub 克隆仓库..."
        if ! command -v git &> /dev/null; then
            echo "📦 正在安装 Git..."
            install_pkg git curl
        fi
        git clone "$REPO_URL"
        cd "$REPO_DIR"
    fi

    # 2. 检查并安装 Node.js (>= 18)
    local cur_node_ver=""
    if command -v node &> /dev/null; then
        cur_node_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1)
    fi
    if [ -z "$cur_node_ver" ] || [ "$cur_node_ver" -lt 18 ]; then
        install_nodejs
    fi

    # 3. 安装 PM2 进程管理器 (如果未安装)
    if ! command -v pm2 &> /dev/null; then
        echo "📦 正在全局安装 PM2..."
        $SUDO npm install -g pm2
    fi

    # 4. 安装项目依赖
    echo "📦 正在更新项目生产环境依赖..."
    npm install --production

    # 5. 安装 agently-cli (如果未安装)
    if ! command -v agently-cli &> /dev/null; then
        echo "📦 正在安装 agently-cli..."
        $SUDO npm install -g @tencent-qqmail/agently-cli || true
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
    pm2 save || true
    pm2 startup 2>/dev/null || true

    # 8. 配置 Nginx 反向代理 (可选)
    if ! command -v nginx &> /dev/null; then
        echo "🔧 正在安装并配置 Nginx..."
        install_pkg nginx || true
    fi

    if command -v nginx &> /dev/null; then
        # SELinux 权限放行 (针对 RHEL / CentOS / Rocky / AlmaLinux / Alibaba Cloud Linux)
        if command -v getenforce &> /dev/null && [ "$(getenforce)" = "Enforcing" ]; then
            if command -v setsebool &> /dev/null; then
                echo "🛡️ 检测到 SELinux 已启用，放行 Nginx 反代网络权限 (httpd_can_network_connect)..."
                $SUDO setsebool -P httpd_can_network_connect 1 || true
            fi
        fi

        # 确定配置目录（兼容 conf.d 与 sites-available）
        NGINX_CONF_DIR=""
        if [ -d /etc/nginx/conf.d ]; then
            NGINX_CONF_DIR="/etc/nginx/conf.d"
            NGINX_CONF_FILE="$NGINX_CONF_DIR/agent-mail-client.conf"
        elif [ -d /etc/nginx/sites-available ]; then
            NGINX_CONF_DIR="/etc/nginx/sites-available"
            NGINX_CONF_FILE="$NGINX_CONF_DIR/agent-mail-client"
        else
            $SUDO mkdir -p /etc/nginx/conf.d
            NGINX_CONF_DIR="/etc/nginx/conf.d"
            NGINX_CONF_FILE="$NGINX_CONF_DIR/agent-mail-client.conf"
        fi

        if [ ! -f "$NGINX_CONF_FILE" ]; then
            echo "📝 写入 Nginx 代理配置: $NGINX_CONF_FILE"
            $SUDO tee "$NGINX_CONF_FILE" > /dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
            if [ "$NGINX_CONF_DIR" = "/etc/nginx/sites-available" ]; then
                $SUDO ln -sf "$NGINX_CONF_FILE" /etc/nginx/sites-enabled/
            fi
            $SUDO nginx -t && ($SUDO systemctl restart nginx || $SUDO systemctl start nginx || $SUDO service nginx restart || true)
        fi
        $SUDO systemctl enable nginx 2>/dev/null || true
    fi

    echo "=========================================="
    echo "🎉 部署与更新已成功完成！"
    echo "=========================================="
    echo "📝 下一步："
    echo "1. 访问 Web 页面，直接在页面上进行扫码授权绑定，无需进入终端运行授权命令"
    echo "2. 如需修改后端配置，可编辑项目目录下的 .env 文件并执行 'pm2 restart agent-mail-client'"
    echo "3. Nginx 配置文件位于: $NGINX_CONF_FILE"
    echo "4. 直接在浏览器打开: http://<服务器IP> (或 http://<服务器IP>:3000)"
    echo "=========================================="
}

# 运行部署
run_deploy "$@"
