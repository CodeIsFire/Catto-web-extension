# 🐱 Catto

Catto is a browser extension that reads the current page, summarizes it, and lets you chat with an in-page cat companion to ask questions, get summaries, and request page changes — all in natural language.

## ✨ Features

- **Smart content extraction** — pulls clean article text from the current page using [Readability](https://github.com/mozilla/readability)
- **Structural page mapping** — builds an outline of headings, links, buttons, and form fields so the assistant understands page layout, not just text
- **Floating cat widget** — a lightweight, in-page chat UI that stays out of your way until you need it
- **Natural-language page edits** — describe what you want changed, and Catto plans and applies the action
- **Powered by Groq** — fast LLM responses for chat and action planning

## 📦 Installation

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions` in Edge).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder.
5. Pin the Catto icon to your toolbar for quick access.

## 🔑 Setup: Adding Your Groq API Key

Catto needs a [Groq API key](https://console.groq.com/keys) to power its chat and reasoning features. The key is stored locally in your browser and never leaves your machine except to call the Groq API directly.

1. Open the extension's service worker console:
   - Go to `chrome://extensions`
   - Find Catto → click **service worker** (under "Inspect views")
2. Run the following in the console:
   ```js
   chrome.storage.sync.set({ groqApiKey: "YOUR_GROQ_API_KEY" });
   ```
3. Reload the extension and open any web page — the cat widget should appear.

### Updating your key later

```js
chrome.storage.sync.set({ groqApiKey: "NEW_GROQ_API_KEY" });
```

> 💡 **Tip:** You can verify the stored key at any time with:
> ```js
> chrome.storage.sync.get("groqApiKey", console.log);
> ```

## 🚀 Usage

1. Navigate to any web page.
2. Click the floating cat widget in the corner of the page.
3. Ask Catto to:
   - Summarize the page or article
   - Explain a specific section
   - Find a link, button, or form field
   - Make a change — e.g. *"hide the sidebar"* or *"make the font bigger"*
4. Catto reads the page structure, plans an action (if needed), and applies it directly.

## 🗂️ Project Structure

| File | Description |
|---|---|
| `manifest.json` | Extension manifest (permissions, entry points) |
| `background.js` | Service worker — handles Groq API integration |
| `content.js` | Extracts page content/structure and applies actions |
| `cat-buddy.js` | Floating cat widget and in-page chat UI |
| `Readability.js` | Mozilla's article extraction library |

## 🔒 Privacy & Security

- Your Groq API key is stored in `chrome.storage.sync` and stays local to your browser (synced across your own signed-in Chrome profile only).
- **Never commit your API key to source control.** Consider adding a `.env` or local config exclusion if you fork this project.
- Page content is sent to the Groq API only when you actively chat with Catto — nothing is sent in the background.

## 🛠️ Troubleshooting

| Issue | Fix |
|---|---|
| Cat widget doesn't appear | Reload the extension and refresh the page |
| "No API key" error | Re-run the `chrome.storage.sync.set` command above |
| Page edits not applying | Check the console for errors in `content.js`; some sites with strict CSP may block DOM changes |

## 🤝 Contributing

Issues and pull requests are welcome! If you'd like to add support for other LLM providers or browsers, feel free to open a discussion first.

## 📄 License

Add your license here (e.g., MIT).
