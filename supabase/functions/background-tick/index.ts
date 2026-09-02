import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { Buffer } from "node:buffer";

const env = (name: string) => Deno.env.get(name) || "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function scheduleNext(prefs: any, retry = false) {
  if (retry) return new Date(Date.now() + 15 * 60_000).toISOString();
  const min = Math.max(15, Number(prefs?.minMinutes) || 180);
  const max = Math.max(min, Number(prefs?.maxMinutes) || 360);
  return new Date(Date.now() + (min + Math.random() * (max - min)) * 60_000).toISOString();
}

function clip(value: unknown, max = 4000) {
  return String(value || "").slice(-max);
}

function recentChat(snapshot: any, characterId: string) {
  const rows = Array.isArray(snapshot?.chats?.[characterId]) ? snapshot.chats[characterId].slice(-24) : [];
  return rows.map((message: any) => `${message.role === "assistant" ? "角色" : "User"}：${clip(message.content, 300)}`).join("\n") || "无近期聊天";
}

function worldBookText(character: any) {
  const books = Array.isArray(character?.worldBooks) ? character.worldBooks : [];
  return books.map((book: any) => `【${clip(book.name, 80)}】\n${clip(book.content, 1600)}`).join("\n\n") || "无";
}

function parseMessages(text: string) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    return (Array.isArray(parsed.messages) ? parsed.messages : []).map(String).map(x => x.trim()).filter(Boolean).slice(0, 3);
  } catch (_) {
    return cleaned.split(/\n+/).map(x => x.trim()).filter(Boolean).slice(0, 3);
  }
}

async function callAI(snapshot: any, character: any) {
  const base = env("BACKGROUND_AI_URL").replace(/\/+$/, "");
  const endpoint = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
  const key = env("BACKGROUND_AI_KEY");
  const model = env("BACKGROUND_AI_MODEL");
  if (!base || !model) throw new Error("缺少 BACKGROUND_AI_URL / BACKGROUND_AI_MODEL");

  const user = snapshot?.user || {};
  const system = `你正在扮演“${character.name}”，要在 User 没打开聊天界面时，像真实联系人一样主动发一条微信。

角色设定：
${character.persona || "保持自然真实"}

角色备注：
${character.notes || "无"}

世界书：
${worldBookText(character)}

User：${user.name || "用户"}

最近聊天：
${recentChat(snapshot, character.id)}

发送前请在内部核对角色身份、关系进度、世界书和最近聊天，确保不违背既有事实。只发 1—3 条短微信，口吻服从角色，不写旁白动作，不解释技术机制，不替 User 说话，也不要机械地问“在吗”或“吃了吗”。不要编造会改变关系或世界观的重大事件。

只返回严格 JSON：{"messages":["第一条","第二条"]}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.95,
      max_tokens: 350,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "现在主动发消息。" },
      ],
    }),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json())?.error?.message || ""; } catch (_) {}
    throw new Error(detail || `AI HTTP ${response.status}`);
  }
  const data = await response.json();
  let content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? "";
  if (Array.isArray(content)) content = content.map((item: any) => item.text || item.content || "").join("");
  return parseMessages(String(content));
}

function configureWebPush() {
  const publicKey = env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) throw new Error("尚未配置 VAPID Secrets");
  webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:admin@example.com", publicKey, privateKey);
}

async function sendPush(subscription: unknown, payload: Record<string, unknown>) {
  configureWebPush();
  await webpush.sendNotification(subscription as any, Buffer.from(JSON.stringify(payload), "utf8"), { TTL: 300 });
}

Deno.serve(async req => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const expectedSecret = env("CRON_SECRET");
  if (!expectedSecret) return json({ error: "尚未配置 CRON_SECRET" }, 503);
  if (req.headers.get("x-cron-secret") !== expectedSecret) return json({ error: "Unauthorized" }, 401);

  try {
    const now = new Date().toISOString();
    const { data: devices, error } = await db.from("push_devices")
      .select("*")
      .eq("enabled", true)
      .lte("next_message_at", now)
      .limit(40);
    if (error) throw error;

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const device of devices || []) {
      const prefs = device.prefs || {};
      if (!prefs.autoMessage || !device.subscription) {
        skipped++;
        await db.from("push_devices").update({ next_message_at: scheduleNext(prefs), updated_at: now }).eq("device_id", device.device_id);
        continue;
      }

      const snapshot = device.snapshot || {};
      const characters = Array.isArray(snapshot.characters) ? snapshot.characters : [];
      if (!characters.length) {
        skipped++;
        await db.from("push_devices").update({ next_message_at: scheduleNext(prefs), updated_at: now }).eq("device_id", device.device_id);
        continue;
      }

      const weighted = characters.map((character: any) => ({
        character,
        weight: (snapshot.chats?.[character.id]?.length || 0) + 1,
      }));
      const total = weighted.reduce((sum: number, item: any) => sum + item.weight, 0);
      let pick = Math.random() * total;
      let chosen = weighted[0].character;
      for (const item of weighted) {
        pick -= item.weight;
        if (pick <= 0) { chosen = item.character; break; }
      }

      try {
        const lines = await callAI(snapshot, chosen);
        if (!lines.length) throw new Error("AI 没有返回消息");
        const rows = lines.map(content => ({ device_id: device.device_id, char_id: chosen.id, content }));
        const { error: insertError } = await db.from("background_messages").insert(rows);
        if (insertError) throw insertError;

        await sendPush(device.subscription, {
          title: chosen.name || "AI 小手机",
          body: lines.join("  ").slice(0, 180),
          charId: chosen.id,
          url: `./?chat=${encodeURIComponent(chosen.id)}`,
          tag: `chat-${chosen.id}`,
        });

        await db.from("push_devices").update({
          last_auto_message_at: now,
          next_message_at: scheduleNext(prefs),
          updated_at: now,
        }).eq("device_id", device.device_id);
        sent++;
      } catch (error: any) {
        console.error("background message failed", device.device_id, error);
        const expired = error?.statusCode === 404 || error?.statusCode === 410;
        await db.from("push_devices").update({
          enabled: expired ? false : true,
          subscription: expired ? null : device.subscription,
          next_message_at: expired ? null : scheduleNext(prefs, true),
          updated_at: now,
        }).eq("device_id", device.device_id);
        failed++;
      }
    }

    return json({ ok: true, checked: (devices || []).length, sent, skipped, failed });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
