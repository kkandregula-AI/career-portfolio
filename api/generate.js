import pdf from "pdf-parse";
import mammoth from "mammoth";

const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 5;
const ipStore = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipStore.has(ip)) ipStore.set(ip, []);
  const timestamps = ipStore.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  timestamps.push(now);
  ipStore.set(ip, timestamps);
  return timestamps.length <= MAX_REQUESTS;
}

async function extractText(fileBase64, mime) {
  const buffer = Buffer.from(fileBase64, "base64");

  if (mime === "application/pdf") {
    const data = await pdf(buffer);
    return data.text;
  }

  if (mime.includes("word")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  return buffer.toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const ip = req.headers["x-forwarded-for"] || "local";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const { fileBase64, mimeType, role, notes, template } = req.body;

    const resumeText = await extractText(fileBase64, mimeType);

    const systemPrompt = `
You are a premium portfolio website generator.
Output ONLY a full HTML document.
Template style: ${template}
`;

    const userPrompt = `
Target Role: ${role || "Not specified"}
Notes: ${notes || "None"}

RESUME:
${resumeText}
`;

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 2000,
        stream: false
      })
    });

    const data = await openaiResponse.json();
    const text = data?.choices?.[0]?.message?.content || "";

    res.status(200).json({ text });

  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}