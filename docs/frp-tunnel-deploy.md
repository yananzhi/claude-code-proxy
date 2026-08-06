# frp 内网穿透部署方案

> 将家庭内网（NAT 后、无公网 IP）的 HTTP 服务，通过公网服务器用 frp 暴露到公网，支持 HTTPS、Basic Auth 鉴权、WebSocket（终端）、自动重连、开机自启。

本文档为开源通用方案，所有 IP / 域名 / token / 密码均用占位符表示，部署时替换为你自己的值。

---

## 1. 适用场景

- **家庭电脑 A**：Windows，位于家庭宽带 NAT 后，无公网 IP，运行本地 HTTP 服务（含 WebSocket）。
- **公网服务器 B**：Linux VPS，有公网 IP，有域名，能开放公网端口，已装 nginx。
- **目标**：公网用户通过 `https://<子域名>` 访问 A 上的服务。

本方案以 claude-code-proxy 项目的两个 web 服务为例：
- management 网页（含 CLI 终端，走 WebSocket）
- 控制台（trace/统计）

---

## 2. 整体架构

```
                        公网用户（浏览器）
                              │
                              │  https://mgmt.<your-domain>   ← 管理页 + CLI 终端(wss)
                              │  https://trace.<your-domain>  ← trace/统计页
                              │  (Basic Auth 弹窗输用户名密码)
                              ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  公网服务器 B  <your-server-ip>  (Linux, 域名 <your-domain>)   │
   │                                                              │
   │  防火墙: 80/443 已放行, 7000 待放行                            │
   │                                                              │
   │  nginx :443                                                  │
   │  ├─ server_name mgmt.<your-domain>                           │
   │  │   auth_basic + proxy_pass http://127.0.0.1:8080 (frps)    │
   │  │   (WebSocket Upgrade 头透传, read_timeout 3600s)          │
   │  ├─ server_name trace.<your-domain>                          │
   │  │   proxy_pass http://127.0.0.1:8080 (frps, 按 Host 路由)   │
   │  └─ (现有站点配置不动)                                        │
   │                                                              │
   │  certbot: 签 mgmt + trace 证书（自动续期）                   │
   │                                                              │
   │  frps :7000  ◄──── 接受 frpc 长连接 (token 鉴权)             │
   │   └─ vhostHTTPPort 8080 (仅 127.0.0.1, 不对公网)             │
   └──────────────┬───────────────────────────────────────────────┘
                  │ frpc 主动长连接 (TCP :7000, 绕过家庭 NAT)
                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  家庭电脑 A  (Windows, 无公网 IP, NAT 后)                      │
   │                                                               │
   │  frpc.exe  ←─ 跟 web 服务一起手动起（或用 start 脚本）         │
   │   └─ proxy mgmt:  http  127.0.0.1:11544 → mgmt.<your-domain> │
   │   └─ proxy trace: http  127.0.0.1:11444 → trace.<your-domain>│
   │              │                                                │
   │              ▼                                                │
   │  web 服务:                                                    │
   │   ├─ management  127.0.0.1:11544  (含终端 WebSocket)         │
   │   └─ 控制台      127.0.0.1:11444                              │
   └───────────────────────────────────────────────────────────────┘
```

### 端口暴露总结

- 公网只开 **443**（nginx，HTTPS 入口）+ **7000**（frps 隧道端口）
- 两个 web 服务共享 443，靠子域名 Host 分发，**不多开端口**
- frps 的 vhost 端口（8080）仅 bind 127.0.0.1 给 nginx 反代，**不对公网开放**

### WebSocket（终端）链路

```
浏览器 wss://mgmt.<your-domain>/api/terminals/:tid/ws
  → nginx :443 (Upgrade 头透传)
  → frps vhost :8080 (http proxy, 原生支持 WebSocket)
  → frpc 隧道
  → 127.0.0.1:11544 (management WebSocketServer)
```

前端动态拼 WebSocket URL（`wss://` + `location.host` + `/api/terminals/:tid/ws`），通过子域名访问时自动跟随当前域名，**前端零改动**。

---

## 3. 关键技术决策

| 决策 | 原因 |
|---|---|
| **子域名分发**，不用路径分发 | 多数 web 服务的路由是根路径绝对路径（`/`、`/api/...`），不支持子路径挂载。挂到 `/mgmt/` 下会全 404。子域名靠 Host 头分发，零侵入。 |
| **HTTPS 交给 nginx + certbot** | frps 只走内网 HTTP，nginx 做 HTTPS 前端 + Let's Encrypt 自动续期，最稳。 |
| **frps vhost 不对公网** | 8080 仅 bind 给 nginx 反代，公网无法直连，更安全。 |
| **两个 proxy 共用一个 vhostHTTPPort** | frp http proxy 靠 `customDomains`（Host 头）区分，多个服务共用 8080，frps 按 Host 路由。 |
| **Basic Auth 在 nginx 层** | HTTPS 下 Basic Auth 密码加密传输，安全。frp token 只防他人接入 frps，与公网访问鉴权无关。 |
| **standalone 用独立 CCP_HOME** | 避免和 VS Code 扩展模式抢端口（扩展用默认 ~/.claude-code-proxy，端口 11434/11534；standalone 用 ~/.claude-code-proxy-standalone，端口 11444/11544）。 |

---

## 4. 使用的软件

| 软件 | 用途 | 版本要求 |
|---|---|---|
| [frp](https://github.com/fatedier/frp) | 内网穿透（frps 服务端 + frpc 客户端） | v0.52+（TOML 配置） |
| nginx | 公网 HTTPS 反向代理 | 任意现代版本 |
| [certbot](https://certbot.eff.org/) | Let's Encrypt SSL 证书签发 + 自动续期 | 任意现代版本 |
| apache2-utils | 提供 `htpasswd` 生成 Basic Auth 密码文件 | Linux 包管理器装 |

---

## 5. 前置条件（部署前准备）

### 5.1 域名 DNS

在域名 DNS 服务商加两条 A 记录（或一条通配符 `*`）：

| 类型 | 主机记录 | 记录值 |
|---|---|---|
| A | `mgmt` | `<your-server-ip>` |
| A | `trace` | `<your-server-ip>` |

验证：
```bash
nslookup mgmt.<your-domain>    # 应返回 <your-server-ip>
nslookup trace.<your-domain>   # 应返回 <your-server-ip>
```
⚠ DNS 必须先生效，否则 certbot 签证书会失败。

### 5.2 公网服务器 B

- Linux + systemd
- 已装 nginx，且 80/443 已放行
- 已装 certbot
- 防火墙（ufw / 云安全组）能放行 7000 端口

### 5.3 家庭电脑 A

- Windows
- 能从公网连到 B 的 7000 端口（B 的防火墙 + 云安全组都放行 7000）

---

## 6. 部署步骤

> 标注：🟦 = 手动操作（DNS/云控制台/浏览器验证），🟩 = 服务器命令

### 步骤 1：服务器 B 安装 frps

**1.1 下载 frp**（Linux amd64）
```bash
FRP_VER=<最新版本，见 https://github.com/fatedier/frp/releases>
wget https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_amd64.tar.gz
tar -xzf frp_${FRP_VER}_linux_amd64.tar.gz
sudo mkdir -p /etc/frp
sudo cp frp_${FRP_VER}_linux_amd64/frps /usr/local/bin/
sudo chmod +x /usr/local/bin/frps
```

**1.2 生成强随机 token**
```bash
openssl rand -hex 32
# 记下此值，frpc 要用同一个
```

**1.3 写 frps 配置** `/etc/frp/frps.toml`
```toml
bindPort = 7000
vhostHTTPPort = 8080
auth.token = "<步骤 1.2 生成的 token>"
```
> ⚠ frp v0.52+ 用 TOML，字段驼峰（`bindPort`/`vhostHTTPPort`/`auth.token`）。勿用老版 INI 下划线语法。

**1.4 写 systemd unit** `/etc/systemd/system/frps.service`
```ini
[Unit]
Description=frp server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

**1.5 启动 + 开机自启**
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now frps
sudo systemctl status frps   # 应 active (running)
```

### 步骤 2：放行端口

**2.1 ufw 放行 7000** 🟩
```bash
sudo ufw allow 7000/tcp
```
（8080 不放行，仅本地给 nginx 反代）

**2.2 云安全组放行 7000** 🟦
- 登录云控制台 → 实例安全组 → 添加入站规则
- 协议 TCP，端口 7000，源 0.0.0.0/0，放行
- ⚠ 这步不做，frpc 连不上 B 的 7000

### 步骤 3：服务器 B 配 nginx + certbot

**3.1 生成 Basic Auth 密码文件** 🟩
```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd.ccp <你的用户名>
# 提示输密码，输两遍
```

**3.2 写两个子域名的 nginx 配置**（先只写 80 端口给 certbot 认领）

`/etc/nginx/sites-available/mgmt.<your-domain>.conf`：
```nginx
server {
    listen 80;
    server_name mgmt.<your-domain>;
    location / {
        return 301 https://$host$request_uri;
    }
}
```
trace 同理，`server_name trace.<your-domain>;`

**3.3 启用 + reload**
```bash
sudo ln -sf /etc/nginx/sites-available/mgmt.<your-domain>.conf /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/trace.<your-domain>.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**3.4 certbot 签证书**（自动改 nginx 配置加 ssl）
```bash
sudo certbot --nginx -d mgmt.<your-domain> --non-interactive --agree-tos -m <你的邮箱> --redirect
sudo certbot --nginx -d trace.<your-domain> --non-interactive --agree-tos -m <你的邮箱> --redirect
```

**3.5 改 nginx 443 block：加反代 + Basic Auth + WebSocket 透传**

certbot 签完后，把 mgmt 配置的 443 block 改成：
```nginx
server {
    server_name mgmt.<your-domain>;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/mgmt.<your-domain>/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/mgmt.<your-domain>/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

    auth_basic "CCP Management";
    auth_basic_user_file /etc/nginx/.htpasswd.ccp;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket 透传（终端必需）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # 终端长连接，防空闲断开
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
server {
    if ($host = mgmt.<your-domain>) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    server_name mgmt.<your-domain>;
    return 404;
}
```
trace 配置同理（`mgmt` 换 `trace`，`auth_basic` 提示文字可改）。

**3.6 reload nginx**
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 步骤 4：家庭电脑 A 安装 frpc

**4.1 下载 frp（Windows 版）** 🟦
- 去 https://github.com/fatedier/frp/releases 下载 `frp_<版本>_windows_amd64.zip`
- 解压到固定目录，如 `C:\frp\`
- 确认 `C:\frp\frpc.exe` 存在

**4.2 写 frpc 配置** `C:\frp\frpc.toml`
```toml
serverAddr = "<your-server-ip>"
serverPort = 7000
auth.token = "<步骤 1.2 生成的同一个 token>"

[[proxies]]
name = "mgmt"
type = "http"
localIP = "127.0.0.1"
localPort = 11544
customDomains = ["mgmt.<your-domain>"]

[[proxies]]
name = "trace"
type = "http"
localIP = "127.0.0.1"
localPort = 11444
customDomains = ["trace.<your-domain>"]
```

**4.3 standalone 独立 CCP_HOME**

为避免和 VS Code 扩展模式抢端口，standalone 用独立配置目录（如 `~\.claude-code-proxy-standalone\`），里面放 `proxy-config.json`：
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "API_TIMEOUT_MS": "600000",
    "ANTHROPIC_MODEL": ""
  },
  "effortLevel": "max",
  "proxy": {
    "listenHost": "127.0.0.1",
    "listenPort": 11444,
    "maxAttempts": 20,
    "backoffSec": 3,
    "backoffMaxSec": 16,
    "passthrough": false,
    "retryRules": [
      { "status": 503, "code": 10310 },
      { "status": 200, "code": 10310 }
    ]
  }
}
```
> 端口 11444 → management 自动 11544（=11444+100）。上游 LLM 在 management 网页在线配置。

**4.4 一键启停脚本**

见项目 `scripts/` 目录：
- `start-external-service.bat` — 起 standalone + frpc
- `stop-external-service.bat` — 精准停止（按端口反查 PID，不误伤 VS Code 扩展）
- `restart-external-service.bat` — 重启

### 步骤 5：联调验证 🟦

1. A 上跑 `start-external-service.bat`（或手动起 standalone + frpc）
2. frpc 日志应出现 `start proxy success` ×2
3. 浏览器访问：
   - `https://mgmt.<your-domain>` → 弹 Basic Auth → 输密码 → management 页
   - `https://trace.<your-domain>` → 控制台页
4. **终端验证**：management 页创建 CLI 终端，能打开、能输入命令 → WebSocket 通
5. 验证自动重连：`taskkill /f /im frpc.exe` 后重启 frpc，公网恢复访问
6. 验证现有站点未受影响：`https://<your-domain>` 仍正常

---

## 7. 关键文件清单

### 公网服务器 B（新建，不动现有配置）
| 文件 | 作用 |
|---|---|
| `/etc/frp/frps.toml` | frps 配置 |
| `/etc/systemd/system/frps.service` | frps 开机自启 |
| `/etc/nginx/sites-available/mgmt.<your-domain>.conf` | mgmt nginx 反代 |
| `/etc/nginx/sites-available/trace.<your-domain>.conf` | trace nginx 反代 |
| `/etc/nginx/.htpasswd.ccp` | Basic Auth 密码文件 |

### 家庭电脑 A（新建）
| 文件 | 作用 |
|---|---|
| `C:\frp\frpc.exe` | frpc 二进制 |
| `C:\frp\frpc.toml` | frpc 配置 |
| `~\.claude-code-proxy-standalone\proxy-config.json` | standalone 独立配置（端口 11444） |
| `scripts\start-external-service.bat` | 一键启动 |
| `scripts\stop-external-service.bat` | 一键停止 |
| `scripts\restart-external-service.bat` | 一键重启 |

---

## 8. 风险与注意

1. **frp 版本与配置语法**：v0.52+ 用 TOML 驼峰字段，老版用 INI 下划线。按下载版本对应语法写，别混用。
2. **DNS 必须先生效**：certbot 签证书时校验域名解析，DNS 没生效 → 签证书失败。
3. **云安全组双层**：ufw 放行 7000 后，云安全组也要放行，两层都开才行。
4. **终端 WebSocket 超时**：nginx 默认 `proxy_read_timeout 60s` 会让空闲终端断连，必须设 `3600s`。
5. **Basic Auth 与 WebSocket**：浏览器在 wss 握手时带 Basic Auth 头，nginx 放行，无需额外配置。
6. **web 服务没起时**：公网访问返回 frps 的 404（frpc 在但本地端口无响应）。这是预期行为（按需开启）。
7. **frps vhost 不对公网**：8080 仅 bind 给 nginx，ufw 不放行，公网无法直连 `<ip>:8080`。
8. **token 保密**：frps.toml 和 frpc.toml 的 `auth.token` 必须一致且不泄露（泄露 = 别人能接你的 frps 转发流量）。
9. **证书自动续期**：certbot 默认装 systemd timer 自动续期。验证：`sudo systemctl list-timers certbot`。
10. **端口隔离**：standalone（11444/11544）和 VS Code 扩展（11434/11534）用不同 CCP_HOME，避免抢端口。

---

## 9. 验证清单

- [ ] `nslookup mgmt.<your-domain>` → `<your-server-ip>`
- [ ] `nslookup trace.<your-domain>` → `<your-server-ip>`
- [ ] B: `systemctl status frps` active
- [ ] B: `ufw status` 含 7000
- [ ] B: frps 日志见 frpc login + register proxy mgmt/trace
- [ ] A: frpc 日志 `start proxy success` ×2
- [ ] 浏览器 `https://mgmt.<your-domain>` → Basic Auth → management 页正常
- [ ] 浏览器 `https://trace.<your-domain>` → 控制台页正常
- [ ] management 页创建终端 → 能交互（WebSocket 通）
- [ ] kill frpc 后重启 → 自动重连，公网恢复
- [ ] `https://<your-domain>` 现有站点仍正常
