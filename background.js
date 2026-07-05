// Groq configuration is read from Chrome storage so secrets are not
// committed to source control. Configure your key once in the extension
// service worker console with:
// chrome.storage.sync.set({ groqApiKey: "YOUR_GROQ_API_KEY" });
const GROQ_API_KEY_STORAGE_KEY = "groqApiKey";
let GROQ_API_KEY = "";

// openai/gpt-oss-120b is Groq's recommended replacement for general text use.
const GROQ_MODEL = "openai/gpt-oss-120b";

async function getGroqApiKey() {
  if (GROQ_API_KEY) return GROQ_API_KEY;

  const result = await chrome.storage.sync.get([GROQ_API_KEY_STORAGE_KEY]);
  const configuredKey = result[GROQ_API_KEY_STORAGE_KEY]?.trim();

  if (!configuredKey) {
    throw new Error(
      "No Groq API key configured. Set chrome.storage.sync.groqApiKey to your key."
    );
  }

  GROQ_API_KEY = configuredKey;
  return GROQ_API_KEY;
}

// Step 2: hold the latest page info per tab, and relay it to the panel.
const pageInfoByTab = new Map();

// Step 10: chat. History is per tab (chat.completions role/content pairs,
// no system prompt in here — that's rebuilt fresh each call from the
// latest pageInfo). Capped so we don't blow up token usage on long chats.
const chatHistoryByTab = new Map();
const MAX_CHAT_HISTORY_MESSAGES = 12;

// If the person fires off multiple messages before the first reply lands,
// concurrent requests would read/write chatHistoryByTab out of order. Queue
// per tab so each chat turn's history read + append happens atomically
// relative to other turns on the same tab.
const chatQueueByTab = new Map();

function queueChatTurn(tabId, fn) {
  const prev = chatQueueByTab.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of prior turn's outcome
  chatQueueByTab.set(tabId, next);
  return next;
}

// Chat is now only driven from the in-page cat-buddy widget, a content
// script in a specific tab — reached via chrome.tabs.sendMessage.
function forwardChatUpdate(tabId, message) {
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  }
}

// --- Shared page-context + action-vocabulary builders -------------------
// Feeds the chat prompt so the model can ground answers in the real page
// and reference real elements instead of inventing them.
function getArticlePart(pageInfo) {
  return pageInfo.article
    ? `Article title: ${pageInfo.article.title}\nArticle text (may be truncated):\n${pageInfo.article.textContent.slice(0, 3000)}`
    : "No article-style content was found on this page.";
}

function getOutlinePart(pageInfo) {
  const o = pageInfo.outline;
  // Include selectors so the model can reference REAL elements instead of
  // inventing ones. Keep it short — just headings for now, since that's
  // the only element type Step 6 supports editing.
  const headingList = o.headings
    .slice(0, 10)
    .map((h) => `- "${h.text}" -> selector: ${h.selector}`)
    .join("\n") || "(none found)";

  const linkList = o.links
    .map((l) => l.text)
    .filter(Boolean)
    .slice(0, 15)
    .join(" | ") || "(none)";

  return (
    `Page headings (with CSS selectors you may reference):\n${headingList}\n\n` +
    `Notable links on page (context only — links aren't an editable action target): ${linkList}\n` +
    `Buttons: ${o.buttons.map((b) => b.text).filter(Boolean).slice(0, 10).join(" | ") || "(none)"}\n` +
    `Form fields: ${o.formFields.map((f) => f.placeholder || f.name || f.type).slice(0, 10).join(" | ") || "(none)"}`
  );
}

function getActionVocab() {
  return (
    `Supported action types (use the exact shape shown, or set "action" to null):\n\n` +
    `1. replace_text — replace the visible text of a heading listed above.\n` +
    `   {"type": "replace_text", "selector": "<exact heading selector above>", "newText": "..."}\n\n` +
    `2. fill_input — type a value into a form field listed above.\n` +
    `   {"type": "fill_input", "selector": "<exact form field selector above>", "value": "..."}\n\n` +
    `3. insert_element — add a small new element next to an existing element listed above ` +
    `(heading, link, button, or form field). Text content only, no markup/HTML.\n` +
    `   {"type": "insert_element", "selector": "<exact selector above>", ` +
    `"position": "before" | "after" | "prepend" | "append", ` +
    `"tag": "div" | "p" | "span" | "li" | "button" | "a", "text": "...", "href": "... (only if tag is a)"}\n\n` +
    `4. toggle_class — toggle a CSS class on an existing element listed above (e.g. to ` +
    `hide/show or restyle something that already has relevant classes on the page).\n` +
    `   {"type": "toggle_class", "selector": "<exact selector above>", "className": "..."}\n`
  );
}

// --- Step 10: chat -------------------------------------------------------
function buildChatSystemPrompt(pageInfo) {
  return (
    `You are a helpful browser companion chatting with a person about the webpage they're ` +
    `currently on: ${pageInfo.title} (${pageInfo.url}). Answer naturally and helpfully. Use ` +
    `the page context below when it's relevant to their question — don't force it in when ` +
    `it isn't (e.g. general questions, small talk).\n\n` +
    `${getArticlePart(pageInfo)}\n\n${getOutlinePart(pageInfo)}\n\n` +
    `If, and only if, the person explicitly asks you to change something on the page AND it ` +
    `maps to one of the supported actions below, include that action in your response. Never ` +
    `invent a selector that wasn't listed above. If what they're asking for doesn't match ` +
    `anything on the page, say so plainly in your reply and set "action" to null — don't force ` +
    `an unrelated or approximate action just to have one.\n\n` +
    `${getActionVocab()}\n` +
    `Respond with ONLY a JSON object, no markdown fences, no other text, in this exact shape:\n` +
    `{"reply": "your conversational response to show the person", "action": <one action object ` +
    `above, matching its exact shape> or null}`
  );
}

async function getChatReply(pageInfo, history, userMessage) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const apiKey = await getGroqApiKey();

  const messages = [
    {
      role: "system",
      content:
        buildChatSystemPrompt(pageInfo) +
        "\n\nRespond with ONLY valid JSON, no markdown fences, no other text."
    },
    ...history,
    { role: "user", content: userMessage }
  ];

  const body = { model: GROQ_MODEL, messages, temperature: 0.5 };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '{"reply":"","action":null}';
  const cleaned = raw.trim().replace(/^```json\s*|```$/g, "");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Not valid JSON as-is. The model sometimes wraps the object in
    // stray prose/fences — try to salvage the outermost {...} block
    // before giving up and just showing the raw text.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      parsed = { reply: raw, action: null };
    }
  }
  if (typeof parsed.reply !== "string") parsed.reply = String(parsed.reply ?? "");
  if (!parsed.action || typeof parsed.action !== "object") parsed.action = null;
  return parsed;
}

async function handleChatMessage(tabId, text) {
  return queueChatTurn(tabId, async () => {
    const pageInfo = pageInfoByTab.get(tabId);
    if (!pageInfo) {
      forwardChatUpdate(tabId, { type: "CHAT_ERROR", payload: "No page info yet — try again in a moment." });
      return;
    }

    const history = chatHistoryByTab.get(tabId) || [];

    try {
      const result = await getChatReply(pageInfo, history, text);
      const updatedHistory = [
        ...history,
        { role: "user", content: text },
        { role: "assistant", content: result.reply }
      ].slice(-MAX_CHAT_HISTORY_MESSAGES);
      chatHistoryByTab.set(tabId, updatedHistory);
      forwardChatUpdate(tabId, { type: "CHAT_RESPONSE", payload: result });
    } catch (err) {
      console.error("[Catto] chat failed:", err);
      forwardChatUpdate(tabId, { type: "CHAT_ERROR", payload: err.message });
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "PAGE_INFO" && sender.tab) {
    const tabId = sender.tab.id;
    // New page loaded in this tab — last page's conversation no longer
    // applies, so drop it rather than let the model answer chat questions
    // against stale context.
    chatHistoryByTab.delete(tabId);
    pageInfoByTab.set(tabId, message);
  }

  if (message.type === "CHAT_MESSAGE") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    handleChatMessage(tabId, message.text);
  }
});

// Keep memory (and the false impression of freshness) from growing forever.
chrome.tabs.onRemoved.addListener((tabId) => {
  pageInfoByTab.delete(tabId);
  chatHistoryByTab.delete(tabId);
  chatQueueByTab.delete(tabId);
});
