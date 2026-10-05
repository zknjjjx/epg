# EPG 节目单服务

独立 EPG 服务：每天自动抓取节目单，合并后通过 Cloudflare R2 + Worker 对外提供订阅。

## 架构

```
GitHub Actions (每天北京时间 01:00)
  → update.mjs 抓取三家数据源 → 合并去重 → 生成文件
  → POST 到 Worker /push → 存入 Cloudflare R2
  → Worker 对外提供订阅地址
```

- **数据源**：TvWasm/autoEPG（官方）+ 51zmt + 112114
- **输出格式**：XMLTV (`epg.xml`)、DIYP (`diyp.json`)，均含 gzip 版
- **订阅地址**：https://epg.cc.cd

## 文件说明

| 文件 | 说明 |
|------|------|
| `worker.js` | Cloudflare Worker：纯静态文件服务 + `/push` 接收端 |
| `update.mjs` | 更新脚本：抓取、合并、生成、推送（Node 20+） |
| `.github/workflows/update.yml` | GitHub Actions 定时任务 |

## 部署 Worker

```bash
# 需要 Cloudflare API Token，设置 R2 bucket 绑定 EPG_BUCKET
# 设置 secret UPDATE_TOKEN（/push 鉴权用）
```

## GitHub Secrets

| Secret | 说明 |
|--------|------|
| `UPDATE_TOKEN` | 与 Worker 的 UPDATE_TOKEN 一致，推送鉴权用 |
| `PUSH_URL` | 可选，默认 `https://epg.cc.cd/push` |

## 本地手动更新

```bash
UPDATE_TOKEN=xxx node update.mjs
```
