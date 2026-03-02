export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { payload, model } = req.body || {};
    if (!payload) return res.status(400).json({ error: "Missing payload" });

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "Server misconfigured: missing GEMINI_API_KEY" });

    const chosenModel =
      typeof model === "string" && model.trim() ? model.trim() : "gemini-2.0-flash";

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(chosenModel) +
      ":generateContent?key=" +
      encodeURIComponent(key);

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        "Gemini request failed (" + r.status + ")";
      return res.status(r.status).json({ error: msg, raw: data });
    }

    return res.status(200).json({ raw: data });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}