# Catto

Catto is a browser extension that reads the current page, summarizes it, and lets you chat with an in-page cat companion to ask for page changes.

## Features
- Extracts article content from the current page with Readability
- Builds a structural outline of headings, links, buttons, and form fields
- Offers an in-page floating cat widget for chat and page edits
- Uses the Groq API for natural-language responses and action planning

## Setup
1. Install the extension in Chrome or Edge by loading the unpacked folder.
2. Add your own Groq API key in the extension storage so the app can use it locally:
   ```js
   chrome.storage.sync.set({ groqApiKey: "YOUR_GROQ_API_KEY" });
   ```
   You can run this in the extension's service worker console or in the DevTools console for the extension background page.
3. Reload the extension and open a web page.
4. If you want to change the key later, run:
   ```js
   chrome.storage.sync.set({ groqApiKey: "NEW_GROQ_API_KEY" });
   ```

## Files
- manifest.json — extension manifest
- background.js — service worker and Groq integration
- content.js — page content extraction and action application
- cat-buddy.js — floating cat widget and in-page chat UI
- Readability.js — article extraction library

## Notes
- Keep your Groq API key out of source control.
- The extension uses Chrome storage to keep the key local to your browser.
