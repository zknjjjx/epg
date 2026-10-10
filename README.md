# 📺 EPG 节目单服务

每天自动更新 2 次的中文电视节目单（EPG）服务，900+ 个频道、约 19 万条节目，回看 7 天、预告未来 3 天。

## 功能

- **XMLTV 格式**：`/epg.xml`（TiviMate / IPTV Pro / Kodi 通用）
- **DIYP 接口**：`/d`（DIYP 播放器 EPG 栏直接填此地址）
- **频道列表**：`/channels`（带搜索框）
- **更新状态 / 更新日志**：`/meta.json`、`/log` 网页直接查看（日志页显示下次更新时间，只保留近 3 天记录）
- **数据源管理**：`/admin` 网页可视化增删 EPG 源，无需改代码
- **手动更新**：`/admin` 一键触发更新
- **Cron 换算工具**：`/admin` 内置"北京时间 → Cron 换算"，设好每天首次运行时间和次数，自动生成 Cloudflare 用的 UTC cron 表达式，一键复制
- **全自动**：Cloudflare Cron 每天 2 次触发更新（北京时间 00:45、07:45）

## 架构

```
Cloudflare Cron（每天 2 次，北京时间 00:45 / 07:45）
    │ 调用 GitHub API (workflow_dispatch)
    ▼
GitHub Actions（update.mjs）
    │ 抓取 9 个 EPG 源 → 合并去重 → 生成文件
    ▼
Cloudflare Worker /push（密钥验证）
    ▼
Cloudflare R2（文件存储）
    ▼
用户访问（XML / DIYP / 网页）
```

重活都在 GitHub Actions 里干，Cloudflare Worker 只负责存文件和对外服务，**免费版足够**，不用开付费。

> 为什么不用 GitHub 的定时触发？GitHub 的 schedule 触发器对新仓库/频繁修改的 cron 注册很慢（实测数小时无响应），改用 Cloudflare Cron 主动触发，稳定可靠。

---

## 部署教程（小白版）

### 准备工作

1. 一个 [Cloudflare](https://dash.cloudflare.com/) 账号（免费版即可）
2. 一个 [GitHub](https://github.com/) 账号

### 第一步：Fork 本仓库

1. 打开本仓库页面，点击右上角 **Fork** → **Create fork**
2. Fork 到你自己的账号下，仓库名保持 `epg`

### 第二步：Cloudflare 创建 R2 存储桶

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单 → **R2 对象存储** → **创建存储桶**
3. 存储桶名称填 `epg-new`（名字自己定，记住它）
4. 其他默认，点**创建存储桶**

> R2 需要绑定银行卡验证（仅验证，不扣费），免费额度每月 10GB，完全够用。

### 第三步：创建 Worker 并部署代码

1. 左侧菜单 → **Workers 和 Pages** → **创建**
2. 选择 **Hello World** 模板 → **部署**（先随便部署一个）
3. 进入 Worker → 点右上角 **编辑代码**
4. 删除编辑器里默认的全部代码
5. 打开本仓库的 `worker.js`，**复制全部内容**，粘贴到编辑器
6. 点 **部署**

### 第四步：绑定 R2 存储桶

1. 在 Worker 页面 → **设置** → **绑定** → **添加绑定**
2. 类型选 **R2 存储桶**，变量名填 `EPG_BUCKET`，存储桶选你第二步建的 `epg-new`
3. 保存

### 第五步：设置环境变量

在 Worker → **设置** → **变量和密钥** → **添加变量**：

| 类型 | 名称 | 值 | 说明 |
|------|------|-----|------|
| 密钥 | `UPDATE_TOKEN` | 自己生成一串随机字符 | GitHub 推送文件时的验证密钥 |
| 密钥 | `GITHUB_PAT` | GitHub Personal Access Token | 手动更新按钮 + Cloudflare Cron 触发用（见下） |

**生成 UPDATE_TOKEN**：在终端运行：
```bash
openssl rand -hex 32
```
把输出填到 Cloudflare 的密钥 **和** 下面 GitHub 的 Secret，两边必须一致。

**生成 GITHUB_PAT**：
1. 打开 https://github.com/settings/tokens/new
2. Note 填 `epg-update`，Expiration 选 `No expiration`
3. 勾选 `repo` 和 `workflow`
4. 生成后复制，填到 Cloudflare 的密钥

> **管理密码**：默认 `admin`，首次登录 `/admin` 时会提示修改，新密码保存在 R2。也可以在 Cloudflare 后台设置 `ADMIN_PASSWORD` 变量（文本类型）覆盖默认值。

每次添加变量后点 **保存并部署**。

### 第六步：GitHub 设置 Secrets

1. 打开你 Fork 的仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点 **New repository secret**，添加两个：
   - `UPDATE_TOKEN`：和 Cloudflare 里填的**完全一样**
   - `PUSH_URL`：`https://你的Worker域名/push`

### 第七步：设置 Cloudflare 定时触发

1. Worker 页面 → **设置** → **触发器** → **添加 Cron 触发器**
2. 输入：`45 16,23 * * *`
3. 保存

这个 cron 对应北京时间每天 00:45、07:45（各一次）。

> 💡 **不知道 UTC 怎么算？** 访问 `https://你的域名/admin` 登录，里面有"北京时间 → Cron 换算"工具：选好每天首次运行时间和每天几次，自动生成表达式，点复制粘贴过来就行。

> ⚠️ **重要**：如果 Worker 是通过 API/脚本部署的（不是 wrangler），先删掉已有的 Cron 触发器 → 重新部署 Worker 代码 → 再添加触发器，否则触发器可能不执行。这是 Cloudflare 触发器与代码的绑定问题，按此顺序可解决。

### 第八步：绑定自定义域名（可选）

1. Worker 页面 → **设置** → **域和路由** → **添加自定义域**
2. 输入你的域名，按提示去 DNS 添加 CNAME 记录
3. 等待生效后，把第六步的 `PUSH_URL` 改成新域名

### 第九步：手动运行一次测试

1. 访问 `https://你的域名/admin`，用 `admin` 登录并修改密码
2. 点 **🚀 手动更新节目单**，约 1 分钟后生效
3. 访问首页、`/log` 确认有数据

> 之后每天 00:45、07:45 自动运行，无需干预。

---

## 使用说明

| 地址 | 说明 |
|------|------|
| `/` | 首页：订阅地址一键复制 |
| `/epg.xml` | XMLTV 节目单（通用播放器） |
| `/epg.xml.gz` | GZip 压缩版 |
| `/d` | DIYP 接口（DIYP 播放器 EPG 栏填此地址） |
| `/channels` | 频道列表（带搜索） |
| `/channels.json` | 频道列表（原始 JSON） |
| `/meta.json` | 更新状态 |
| `/log` | 更新日志（显示下次更新时间，含每个源的抓取状态，只保留近 3 天） |
| `/admin` | 数据源管理 + 手动更新 + Cron 换算工具 |

### 管理 EPG 数据源

访问 `/admin`，登录后可以：
- 查看当前所有数据源
- 删除不需要的源
- 添加新源（填名称、URL、优先级）
- 一键手动触发更新
- **Cron 换算**：设置每天首次运行时间（如 00:45）和每天次数，自动算出全天运行时间点和 Cloudflare 用的 UTC cron 表达式，一键复制

保存后下次定时更新自动生效。gzip 会自动识别（URL 以 `.gz` 结尾或含 `type=gz`）。
- **备用地址**：URL 里用 `;` 分隔多个地址（如 `https://cdn.example.com/e.xml;https://原地址/e.xml`），按顺序逐个尝试，直到抓成功为止。适合源站不稳定、但有 CDN 镜像的场景。

### 更新机制

- **定时**：Cloudflare Cron 每天 00:45、07:45（北京时间）调用 GitHub API 触发更新
- **手动**：`/admin` 点按钮立即触发
- **重试**：单个源抓取失败自动重试 5 次（3s/6s/12s/24s 退避），避免网络抖动
- **失败处理**：只有**所有源都失败**才算失败，此时旧数据保留不动；单个源失败不影响整体

---

## 数据源

默认 9 个源：

| 源 | 说明 | 优先级 |
|----|------|--------|
| TvWasm/autoEPG | 官方源，质量最高 | 3 |
| 51zmt | CCTV + 卫视 | 1 |
| 112114 | 含地方台 | 2 |
| v1.mk / epg.pw / sparkssssssssss / zsdc / kuke31 / liliu | 聚合源，补全覆盖 | 2 |

合并规则：同频道、同标题、开始时间差 2 分钟内视为重复，保留高优先级来源的数据。

## 文件说明

| 文件 | 说明 |
|------|------|
| `worker.js` | Cloudflare Worker：静态文件服务 + `/push` 接收 + DIYP 查询 + 管理后台 + Cron 触发器 |
| `update.mjs` | 更新脚本：抓取、合并、生成、推送（Node 20+，跑在 GitHub Actions） |
| `.github/workflows/epg-update.yml` | GitHub Actions：仅 `workflow_dispatch` 触发（定时由 Cloudflare Cron 发起） |

## 本地手动更新

```bash
UPDATE_TOKEN=xxx node update.mjs
```

## 常见问题

**Q: Actions 运行失败？**
A: 去 Actions 看日志。常见原因：`UPDATE_TOKEN` 两边不一致；`PUSH_URL` 写错了。

**Q: 某个源失效了？**
A: `/log` 会显示每个源的状态。去 `/admin` 把失效的源删掉就行。

**Q: 忘记管理密码？**
A: 删掉 R2 里的 `admin_pass.txt` 文件（R2 → epg-new → 找到删除），再删掉 `ADMIN_PASSWORD` 变量（如果有），然后用 `admin` 重新登录。

**Q: 播放器里部分频道没节目单？**
A: 频道名对不上。把对不上的台名记下来，可以提 Issue。

**Q: 定时没触发？**
A: 检查 Cloudflare → Worker → 设置 → 触发器，确认 Cron 表达式已保存。再检查 `GITHUB_PAT` 是否有效（过期或权限不足会导致 401）。如果触发器存在但从不执行（Cron 事件页显示 0 事件），按第七步的 ⚠️ 提示：删触发器 → 重部署 → 重加触发器。

## 费用

- Cloudflare 免费版：Worker + R2 免费额度完全够用
- GitHub Actions：公开仓库免费无限制；私有仓库每月 2000 分钟免费（每次运行约 1 分钟，每天 2 次约 60 分钟/月）
- 全程 **0 元**

## Docker 部署（自托管）

不想用 Cloudflare？可以用 Docker 在自己的服务器/NAS 上跑完整服务：

```bash
docker run -d \
  --name epg \
  --restart unless-stopped \
  -p 8080:8080 \
  -v ./data:/data \
  -e ADMIN_PASSWORD=你的密码 \
  ghcr.io/zknjjjx/epg:latest
```

> **网络要求**：部分数据源在国内直连可能失败，需要科学上网环境。否则对应源会抓取失败（单个源失败不影响其他源）。

或用 `docker-compose.yml`（已在仓库中，改好密码后 `docker-compose up -d`）。

容器启动后自动抓取一次，之后每 4 小时自动更新。所有接口和 Cloudflare 版一致。数据存在挂载的 `./data` 目录。

| 变量 | 默认 | 说明 |
|------|------|------|
| `ADMIN_PASSWORD` | `changeme` | /admin 管理密码，务必修改 |
| `DATA_DIR` | `/data` | 数据存储目录 |
| `PORT` | `8080` | 监听端口 |
| `UPDATE_CRON` | `240` | 更新间隔（分钟），默认每 4 小时 |

镜像每次 push 到 main 分支时由 GitHub Actions 自动构建并推送到 `ghcr.io/zknjjjx/epg:latest`。

## License

MIT
