# 后台通知部署清单

仓库已经包含网页端 PWA、Service Worker、Supabase 数据表和两个 Edge Functions。真实私钥不要提交到 GitHub。

## 文件对应关系

- `index.html`：通知设置、设备订阅、后台消息回拉。
- `manifest.webmanifest`：把网页安装成主屏幕 PWA。
- `sw.js`：网页关闭或锁屏时接收系统 Web Push。
- `supabase/migrations/20260902000000_push_notifications.sql`：通知设备与后台消息表。
- `supabase/functions/push-gateway/index.ts`：注册设备、同步角色资料、测试通知、拉取消息。
- `supabase/functions/background-tick/index.ts`：定时让角色生成主动消息并推送。
- `supabase/config.toml`：允许浏览器以设备密钥访问通知函数。

## Supabase Secrets

在 Supabase Edge Function Secrets 中配置：

- `VAPID_PUBLIC_KEY`：与网页里预填的 Public Key 相同。
- `VAPID_PRIVATE_KEY`：对应的 Private Key，只放这里。
- `VAPID_SUBJECT`：例如 `mailto:你的邮箱`。
- `BACKGROUND_AI_URL`：后台生成主动消息所用的 OpenAI 兼容 API 地址，填到 `/v1` 或完整 `/chat/completions`。
- `BACKGROUND_AI_KEY`：后台 AI Key。
- `BACKGROUND_AI_MODEL`：后台模型名。
- `CRON_SECRET`：自己生成的一段长随机字符串，用于保护定时函数。
- `ALLOWED_ORIGIN`：Netlify 网站完整域名，例如 `https://example.netlify.app`。

## 部署顺序

1. 在 Supabase SQL Editor 运行 migration 文件内容。
2. 部署 `push-gateway` 和 `background-tick` 两个 Edge Functions。
3. 添加上述 Secrets。
4. 在 Supabase Cron 中按 5—10 分钟调用一次 `background-tick`，使用 POST，并附带请求头 `x-cron-secret: 你的 CRON_SECRET`。
5. Netlify 重新部署 GitHub 仓库。
6. iPhone Safari 打开 HTTPS 网站，点“分享 → 添加到主屏幕”。
7. 从桌面图标打开小手机，在“设置 → 后台消息推送”中填写 Supabase Project URL 和 Publishable / anon key，再点“开启系统通知”。

只有“测试通知”需要 Web Push；“角色主动消息”还需要配置后台 AI Secrets 和 Cron。
