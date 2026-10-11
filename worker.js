// Enotes — Cloudflare Worker لتفريغ الصوت (Workers AI / Whisper)
// الربط المطلوب: Settings > Bindings > Workers AI  باسم  AI
// (اختياري) KV باسم RL لتحديد عدد الطلبات لكل مستخدم باليوم

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_BYTES = 9 * 1024 * 1024;      // ~4.7 دقيقة WAV 16kHz mono
const MAX_SECONDS = 245;                 // 4 دقائق + هامش
const PER_IP_DAILY = 12;                 // أقصى عدد مقاطع لكل مستخدم باليوم (إذا RL موجود)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    try {
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 1000) return json({ error: 'empty' }, 400);
      if (buf.byteLength > MAX_BYTES) return json({ error: 'too_long' }, 413);
      // WAV 16kHz mono 16-bit: 44 byte header
      const dv = new DataView(buf);
      const rate = dv.getUint32(24, true) || 16000, ch = dv.getUint16(22, true) || 1, bits = dv.getUint16(34, true) || 16;
      const secs = (buf.byteLength - 44) / (rate * ch * (bits / 8));
      if (secs > MAX_SECONDS) return json({ error: 'too_long' }, 413);

      if (env.RL) {
        const ip = req.headers.get('CF-Connecting-IP') || 'x';
        const day = new Date().toISOString().slice(0, 10);
        const key = 'u:' + day + ':' + ip;
        const n = parseInt((await env.RL.get(key)) || '0', 10);
        if (n >= PER_IP_DAILY) return json({ error: 'limit' }, 429);
        await env.RL.put(key, String(n + 1), { expirationTtl: 90000 });
      }

      const LANG = (new URL(req.url).searchParams.get('lang') || 'en').slice(0, 2);
      const out = await env.AI.run(MODEL, { audio: b64(buf), task: 'transcribe', language: LANG, vad_filter: true });
      const segs = (out.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text }));
      return json({ text: out.text || '', segments: segs, dur: secs });
    } catch (e) {
      return json({ error: 'server', m: String(e && e.message || e) }, 500);
    }
  }
};
