# 📺 EPG 节目单服务

每天自动更新的中文电视节目单（EPG）服务，941 个频道、约 19 万条节目，回看 7 天、预告未来 3 天。

## 功能

- **XMLTV 格式**：`/epg.xml`（TiviMate / IPTV Pro / Kodi 通用）
- **DIYP 接口**：`/d`（DIYP / 酷9 播放器直接填此地址）
- **频道列表 / 更新状态 / 更新日志**：网页直接查看
- **数据源管理**：网页可视化增删 EPG 源，无需改代码
- **全自动**：每天北京时间凌晨 01:00 通过 GitHub Actions 更新

## 架构

```
GitHub Actions（每天 01:00 运行 update.mjs）
    │ 抓取 9 个 EPG 源 → 合并去重 → 生成文件
    ▼
Cloudflare Worker /push（密钥验证）
    ▼
Cloudflare R2（文件存储）
    ▼
用户访问（XML / DIYP / 网页）
```

重活都在 GitHub Actions 里干，Cloudflare Worker 只负责存文件和对外服务，**免费版足够**，不用开付费。

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

在 Worker → **设置** → **变量和密钥** → **添加变量**，逐个添加：

| 类型 | 名称 | 值 | 说明 |
|------|------|-----|------|
| 密钥 | `UPDATE_TOKEN` | 自己生成一串随机字符（见下） | GitHub 推送文件时的验证密钥 |
| 文本 | `ADMIN_PASSWORD` | 自己设个密码，如 `epgadmin123` | 网页"源管理"的登录密码（**必须是"文本"类型**，不要选"密钥"，否则自己看不到密码无法登录） |
| 文本 | `EPG_SOURCES` | 见下方 | EPG 数据源列表（可选不设，有内置默认） |

**生成 UPDATE_TOKEN**：在你电脑终端运行（或找个在线随机密码生成器）：
```bash
openssl rand -hex 32
```
把输出的那串字符分别填到 Cloudflare 的密钥 **和** 下面 GitHub 的 Secret，**两边必须一致**。

**EPG_SOURCES**（可选）：一行一个，格式 `名称|URL|优先级`，例如：
```
51zmt|https://epg.51zmt.top:8001/e.xml|1
112114|https://epg.112114.xyz/pp.xml.gz|2
```
不设置也行，代码里有内置默认的 8 个源。以后也可以在网页"源管理"里可视化修改，不用动这里。

每次添加变量后点 **保存并部署**。

### 第六步：GitHub 设置 Secrets

1. 打开你 Fork 的仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点 **New repository secret**，添加两个：
   - `UPDATE_TOKEN`：和 Cloudflare 里填的**完全一样**
   - `PUSH_URL`：`https://你的Worker域名/push`
     - Worker 默认域名类似 `https://epg-new.xxx.workers.dev`，在 Worker 页面的"访问"按钮旁能看到
     - 如果你绑定了自定义域名，就填 `https://你的域名/push`

### 第七步：绑定自定义域名（可选）

1. Worker 页面 → **设置** → **域和路由** → **添加自定义域**
2. 输入你的域名（如 `epg.example.com`），按提示去 DNS 添加 CNAME 记录
3. 等待生效后，把第六步的 `PUSH_URL` 改成新域名

### 第八步：手动运行一次测试

1. 打开你 Fork 的仓库 → **Actions** → 左侧选 **Daily EPG Update**
2. 点 **Run workflow** → **Run workflow**
3. 等 1-2 分钟，看到绿色 ✅ 即成功
4. 访问你的 Worker 域名，首页、`/log` 都应该有数据了

> 之后每天北京时间凌晨 01:00 自动运行，无需干预。

---

## 使用说明

| 地址 | 说明 |
|------|------|
| `/` | 首页：订阅地址一键复制 |
| `/epg.xml` | XMLTV 节目单（通用播放器） |
| `/epg.xml.gz` | GZip 压缩版 |
| `/d` | DIYP 接口（DIYP / 酷9 播放器 EPG 栏填此地址） |
| `/channels.json` | 频道列表 |
| `/meta.json` | 更新状态 |
| `/log` | 更新日志（含每个源的抓取状态） |
| `/admin` | 数据源管理（密码：ADMIN_PASSWORD） |

### 管理 EPG 数据源

访问 `/admin`，输入管理密码后可以：
- 查看当前所有数据源
- 删除不需要的源
- 添加新源（填名称、URL、优先级）
- 修改优先级（1=低，3=高，官方源建议设 3）

保存后第二天凌晨自动生效。源列表按 `名称|URL|优先级` 格式存储，gzip 会自动识别（URL 以 `.gz` 结尾或含 `type=gz`）。

---

## 数据源

默认 9 个源（与 [taksssss/iptv-tool](https://github.com/taksssss/iptv-tool) 同列表）：

| 源 | 说明 | 优先级 |
|----|------|--------|
| TvWasm/autoEPG | 官方源，质量最高（代码写死） | 3 |
| 51zmt | CCTV + 卫视 | 1 |
| 112114 | 含地方台 | 2 |
| v1.mk / epg.pw / sparkpp / zsdc / kuke31 / liliu | 聚合源，补全覆盖 | 2 |

合并规则：同频道、同标题、开始时间差 2 分钟内视为重复，保留高优先级来源的数据。

## 文件说明

| 文件 | 说明 |
|------|------|
| `worker.js` | Cloudflare Worker：静态文件服务 + `/push` 接收 + DIYP 查询 + 管理后台 |
| `update.mjs` | 更新脚本：抓取、合并、生成、推送（Node 20+，跑在 GitHub Actions） |
| `.github/workflows/update.yml` | GitHub Actions 定时任务（每天北京时间 01:00） |

## 本地手动更新

```bash
UPDATE_TOKEN=xxx node update.mjs
```

## 常见问题

**Q: Actions 运行失败？**
A: 去 Actions 点进那次运行看日志。常见原因：GitHub Secret 的 `UPDATE_TOKEN` 和 Cloudflare 的不一致；`PUSH_URL` 写错了。

**Q: 某个源失效了？**
A: `/log` 页面会显示每个源的状态（正常/失败）和报错。去 `/admin` 把失效的源删掉就行。

**Q: 播放器里部分频道没节目单？**
A: 频道名对不上。XMLTV 用 `<display-name>` 匹配，DIYP 用频道名查询。把对不上的台名记下来，可以提 Issue。

**Q: DIYP 在播放器里卡死？**
A: 确认填的是接口地址 `https://你的域名/d`，**不要**填 `diyp.json` 整包文件。播放器会自动拼接 `?ch=频道名&date=日期` 查询。

**Q: 想换 workers.dev 域名？**
A: Worker → 设置 → 域和路由里管理。记得同步改 GitHub 的 `PUSH_URL` Secret。

## 费用

- Cloudflare 免费版：Worker + R2 免费额度完全够用
- GitHub Actions：公开仓库免费，私有仓库每月 2000 分钟免费（每次运行约 1 分钟）
- 全程 **0 元**

## License

MIT
