#!/bin/bash
# AI-BING WORLD 一键部署脚本
# 用法：在服务器上执行 bash deploy.sh
# 前提：已买好服务器（Ubuntu 20.04+）+ 域名已解析到服务器IP

set -e

# ============ 配置区 ============
DOMAIN=""           # 你的域名，如 ai-bing.world
REPO=""             # 你的 GitHub 仓库地址，如 https://github.com/用户名/agent-world.git
PORT=3000
MAX_AGENTS=500
# =================================

# 如果没填域名，提示用户输入
if [ -z "$DOMAIN" ]; then
  read -p "请输入你的域名（如 ai-bing.world）: " DOMAIN
fi
if [ -z "$REPO" ]; then
  read -p "请输入 GitHub 仓库地址（如 https://github.com/用户名/agent-world.git）: " REPO
fi

echo "================================================"
echo "  AI-BING WORLD 一键部署"
echo "  域名: $DOMAIN"
echo "  仓库: $REPO"
echo "  端口: $PORT"
echo "  最大Agent: $MAX_AGENTS"
echo "================================================"

# ---------- 1. 安装依赖 ----------
echo "[1/6] 安装系统依赖..."
apt update -y
apt install -y curl git nginx certbot python3-certbot-nginx

# 安装 Node.js 22
if ! command -v node &>/dev/null; then
  echo "  安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

# 安装 pm2
if ! command -v pm2 &>/dev/null; then
  echo "  安装 pm2..."
  npm install -g pm2
fi

echo "  Node: $(node -v) | npm: $(npm -v) | pm2: $(pm2 -v)"

# ---------- 2. 拉取项目 ----------
echo "[2/6] 拉取项目代码..."
INSTALL_DIR="/opt/agent-world"
if [ -d "$INSTALL_DIR" ]; then
  echo "  目录已存在，拉取最新代码..."
  cd "$INSTALL_DIR" && git pull
else
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

npm install

# ---------- 3. 配置环境变量 ----------
echo "[3/6] 配置环境变量..."
cat > "$INSTALL_DIR/.env" << EOF
PORT=$PORT
MAX_AGENTS=$MAX_AGENTS
TICK_MS=500
BROADCAST_MS=500
DATA_DIR=$INSTALL_DIR/data
WORLDS_ROOT=$INSTALL_DIR/worlds
WEB_DIR=$INSTALL_DIR/web
EOF

# ---------- 4. 启动服务 ----------
echo "[4/6] 启动服务（pm2 守护）..."
pm2 delete ai-bing 2>/dev/null || true
pm2 start server/src/index.js \
  --name ai-bing \
  --cwd "$INSTALL_DIR" \
  --env production
pm2 startup
pm2 save

# ---------- 5. 配置 Nginx ----------
echo "[5/6] 配置 Nginx 反代..."
NGINX_CONF="/etc/nginx/sites-available/ai-bing"
cat > "$NGINX_CONF" << 'EOF'
server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;

    # WebSocket + HTTP 反代
    location / {
        proxy_pass http://127.0.0.1:PORT_PLACEHOLDER;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 超时
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;

        # 上传限制
        client_max_body_size 10m;
    }
}
EOF

# 替换占位符
sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" "$NGINX_CONF"
sed -i "s/PORT_PLACEHOLDER/$PORT/g" "$NGINX_CONF"

# 启用站点
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# ---------- 6. 申请 SSL 证书 ----------
echo "[6/6] 申请 SSL 证书（Let's Encrypt 免费证书）..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafe-or-email root@localhost || true

# ---------- 完成 ----------
echo ""
echo "================================================"
echo "  部署完成！"
echo ""
echo "  网页界面:  https://$DOMAIN"
echo "  API:       https://$DOMAIN/api/state"
echo "  MCP 端点:  https://$DOMAIN/mcp"
echo ""
echo "  Agent 接入方式："
echo "    Claude Code:"
echo "      claude mcp add ai-bing --transport http https://$DOMAIN/mcp"
echo ""
echo "    Codex (~/.codex/config.toml):"
echo "      [mcp_servers.ai-bing]"
echo "      url = \"https://$DOMAIN/mcp\""
echo ""
echo "  服务管理："
echo "    pm2 status     # 查看状态"
echo "    pm2 logs ai-bing  # 查看日志"
echo "    pm2 restart ai-bing  # 重启服务"
echo "================================================"
