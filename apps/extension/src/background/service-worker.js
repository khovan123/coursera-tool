const DEFAULTS = {
  enabled: true,
  runnerActive: false,
  skipVideo: true,
  playbackRate: 16,
  autoSubmit: false,
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => current[key] === undefined),
  );
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COURSE_TOOL_ASK_AI") return false;

  answerWithGemini(message.payload)
    .then((answer) => sendResponse({ ok: true, answer }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function answerWithGemini(payload) {
  const { geminiApiKey, geminiModel } = await chrome.storage.local.get([
    "geminiApiKey",
    "geminiModel",
  ]);
  if (!geminiApiKey) throw new Error("Add a Gemini API key in the extension popup.");

  const model = geminiModel || DEFAULTS.geminiModel;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: createPrompt(payload) }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || `Gemini request failed (${response.status}).`);
  }

  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  if (!text) throw new Error("Gemini returned an empty response.");

  try {
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Gemini returned an invalid structured answer.");
  }
}

function createPrompt({ title, questions }) {
  return [
    "Answer the following Coursera assessment using only the supplied question text.",
    "Return JSON only with this exact shape:",
    '{"answers":[{"id":"question id","choices":["exact choice text"],"text":"answer for text fields"}]}',
    "For choice questions, copy the exact visible option text and omit text.",
    "For free-response questions, provide a concise complete answer and omit choices.",
    "Do not invent question ids.",
    `Assessment: ${title || "Untitled"}`,
    JSON.stringify(questions),
  ].join("\n");
}
