import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { Buffer } from "node:buffer";

const env = (name: string) => Deno.env.get(name) || "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function nextMessageAt(prefs: Record<string, unknown>) {
  const min = Math.max(15, Number(prefs?.minMinutes) || 180);
  const max = Math.max(min, Number(prefs?.maxMinutes) || 360);
  return new Date(Date.now() + (min + Math.random() * (max - min)) * 60_000).toISOString();
}

function validSubscription(value: any) {
  return !!(value && typeof value.endpoint === "string" && value.keys?.p256dh && value.keys?.auth);
}

async function getDevice(deviceId: string) {
  const { data, error } = await db.from("push_devices").select("*").eq("device_id", deviceId).maybeSingle();
  if (error) throw error;
  return data;
}

async function verifyDevice(deviceId: string, deviceSecret: string) {
  const device = await getDevice(deviceId);
  if (!device) throw new Error("设备尚未注册");
  if (device.secret_hash !== await sha256(deviceSecret)) throw new Error("设备密钥不匹配");
  return device;
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

function checkOrigin(req: Request) {
  const allowed = env("ALLOWED_ORIGIN").replace(/\/$/, "");
  const origin = (req.headers.get("origin") || "").replace(/\/$/, "");
  return !allowed || !origin || origin === allowed;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!checkOrigin(req)) return json({ error: "来源不允许" }, 403);

  try {
    const body = await req.json();
    const action = String(body.action || "");
    const deviceId = String(body.deviceId || "");
    const deviceSecret = String(body.deviceSecret || "");
    if (!deviceId || !deviceSecret) return json({ error: "缺少 deviceId / deviceSecret" }, 400);

    if (action === "register") {
      if (!validSubscription(body.subscription)) return json({ error: "Push subscription 无效" }, 400);
      const secretHash = await sha256(deviceSecret);
      const existing = await getDevice(deviceId);
      if (existing && existing.secret_hash !== secretHash) return json({ error: "设备密钥不匹配" }, 403);
      const prefs = body.prefs || {};
      const row = {
        device_id: deviceId,
        secret_hash: secretHash,
        subscription: body.subscription,
        prefs,
        snapshot: body.snapshot || {},
        enabled: true,
        last_active_at: new Date().toISOString(),
        next_message_at: existing?.next_message_at || nextMessageAt(prefs),
        updated_at: new Date().toISOString(),
      };
      const { error } = await db.from("push_devices").upsert(row, { onConflict: "device_id" });
      if (error) throw error;
      return json({ ok: true, nextMessageAt: row.next_message_at });
    }

    const device = await verifyDevice(deviceId, deviceSecret);

    if (action === "sync") {
      const prefs = body.prefs || device.prefs || {};
      const update: Record<string, unknown> = {
        prefs,
        snapshot: body.snapshot || device.snapshot || {},
        enabled: true,
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (!device.next_message_at) update.next_message_at = nextMessageAt(prefs);
      const { error } = await db.from("push_devices").update(update).eq("device_id", deviceId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "pull") {
      const { data, error } = await db.from("background_messages")
        .select("id,char_id,content,created_at")
        .eq("device_id", deviceId)
        .is("delivered_at", null)
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      return json({ ok: true, messages: data || [] });
    }

    if (action === "ack") {
      const ids = Array.isArray(body.messageIds) ? body.messageIds.map(String).slice(0, 100) : [];
      if (ids.length) {
        const { error } = await db.from("background_messages")
          .update({ delivered_at: new Date().toISOString() })
          .eq("device_id", deviceId)
          .in("id", ids);
        if (error) throw error;
      }
      return json({ ok: true });
    }

    if (action === "test") {
      if (!validSubscription(device.subscription)) return json({ error: "没有可用的 Push subscription" }, 400);
      await sendPush(device.subscription, {
        title: "AI 小手机",
        body: "后台通知已经接通。退出小手机后，也可以收到角色消息。",
        url: "./",
        tag: "ai-phone-test",
      });
      return json({ ok: true });
    }

    if (action === "disable") {
      const { error } = await db.from("push_devices")
        .update({ enabled: false, subscription: null, updated_at: new Date().toISOString() })
        .eq("device_id", deviceId);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "未知 action" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
