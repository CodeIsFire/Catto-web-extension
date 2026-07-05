console.log("[Catto] content script loaded on", window.location.href);

// Step 3: real extraction — clean article text via Readability, plus a
// structural outline the agent can point actions at later (headings,
// links, buttons, form fields with CSS selectors).

// --- Clean article text -----------------------------------------------
function extractArticle() {
  try {
    // Readability mutates the DOM it's given, so hand it a clone —
    // we don't want to strip anything off the live page.
    const clone = document.cloneNode(true);
    const article = new Readability(clone).parse();
    return article
      ? { title: article.title, textContent: article.textContent.trim() }
      : null;
  } catch (err) {
    console.warn("[Catto] Readability failed:", err);
    return null;
  }
}

// --- Structural outline -------------------------------------------------
// A CSS selector for a given element. We verify uniqueness before handing
// it to the model — if the structural nth-of-type path doesn't resolve to
// exactly this element (DOM shifted, ambiguous siblings, etc.), we tag the
// element with a stable data-attribute instead so the model can never be
// pointed at the wrong node.
let anchorCounter = 0;
const ANCHOR_ATTR = "data-ai-companion-anchor";

function structuralSelectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const path = [];
  let node = el;
  while (node && node.nodeType === 1 && path.length < 5) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    path.unshift(part);
    node = parent;
  }
  return path.join(" > ");
}

function isUniqueMatch(selector, el) {
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false; // malformed selector (shouldn't happen, but be safe)
  }
}

function selectorFor(el) {
  const structural = structuralSelectorFor(el);
  if (isUniqueMatch(structural, el)) return structural;

  // Structural path is ambiguous or unreliable — anchor with our own
  // attribute so the selector we hand to the model is guaranteed to
  // resolve to this exact element, now and later when an action applies.
  let anchorId = el.getAttribute(ANCHOR_ATTR);
  if (!anchorId) {
    anchorId = `a${++anchorCounter}`;
    el.setAttribute(ANCHOR_ATTR, anchorId);
  }
  return `[${ANCHOR_ATTR}="${anchorId}"]`;
}

function truncate(str, n) {
  const clean = str.trim().replace(/\s+/g, " ");
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

function extractOutline() {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).map(
    (el) => ({
      tag: el.tagName.toLowerCase(),
      text: truncate(el.innerText, 100),
      selector: selectorFor(el)
    })
  );

  const links = Array.from(document.querySelectorAll("a[href]"))
    .filter((el) => el.innerText.trim().length > 0)
    .slice(0, 30)
    .map((el) => ({
      text: truncate(el.innerText, 80),
      href: el.href,
      selector: selectorFor(el)
    }));

  const buttons = Array.from(
    document.querySelectorAll("button, input[type='submit'], input[type='button']")
  )
    .slice(0, 30)
    .map((el) => ({
      text: truncate(el.innerText || el.value || "", 60),
      selector: selectorFor(el)
    }));

  const formFields = Array.from(
    document.querySelectorAll("input, textarea, select")
  )
    .slice(0, 30)
    .map((el) => ({
      type: el.tagName.toLowerCase() === "input" ? el.type : el.tagName.toLowerCase(),
      name: el.name || null,
      placeholder: el.placeholder || null,
      selector: selectorFor(el)
    }));

  return { headings, links, buttons, formFields };
}

function collectPageInfo() {
  const article = extractArticle();
  const outline = extractOutline();

  return {
    type: "PAGE_INFO",
    url: window.location.href,
    title: document.title,
    article, // { title, textContent } or null if extraction failed
    outline // { headings, links, buttons, formFields }
  };
}

// Step 9: debounce the initial extraction/send. Content scripts run at
// document_idle, but a lot of pages keep mutating the DOM after that
// (hydration, lazy-loaded content, cookie banners). We wait for a quiet
// period so we extract/send once, with settled content — not on every tiny
// DOM change, and not before the page is actually done moving around.
const SETTLE_DELAY_MS = 1000;
const MAX_WAIT_AFTER_LOAD_MS = 5000;

let settleTimer = null;
let hardCapTimer = null;
let sent = false;

function sendPageInfoOnce() {
  if (sent) return;
  sent = true;
  mutationObserver.disconnect();
  clearTimeout(settleTimer);
  clearTimeout(hardCapTimer);
  chrome.runtime.sendMessage(collectPageInfo());
}

function scheduleSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(sendPageInfoOnce, SETTLE_DELAY_MS);
}

const mutationObserver = new MutationObserver(scheduleSettle);

function startWatching() {
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  scheduleSettle();
  // Hard cap so a page that never stops mutating still gets sent eventually.
  hardCapTimer = setTimeout(sendPageInfoOnce, MAX_WAIT_AFTER_LOAD_MS);
}

if (document.readyState === "complete") {
  startWatching();
} else {
  window.addEventListener("load", startWatching, { once: true });
}

// --- Step 6/7/8: apply an approved action to the live page -----------------
// Deliberately tiny, closed vocabulary — the model can only ever ask for
// things in this list, never raw JS or raw HTML. We track enough state so
// any applied action can be undone, and we track the currently-highlighted
// element so preview can clean itself up.
const originalValues = new Map(); // selector -> original innerText (replace_text)
const originalInputValues = new Map(); // selector -> original value (fill_input)
const insertedNodes = new Map(); // action key -> inserted element (insert_element)
const toggledClasses = new Map(); // action key -> true (toggle_class), so undo knows to toggle back
let highlightedEl = null;

// Ordered log of currently-applied actions, most recent last, so we can
// undo everything in one shot ("Undo all") without the panel needing to
// track/replay the list itself.
let appliedActionLog = [];

function undoOneAction(action) {
  if (action.type === "replace_text") {
    const el = document.querySelector(action.selector);
    const original = originalValues.get(action.selector);
    if (!el || original === undefined) return { ok: false, error: "Nothing to undo for this selector." };
    el.innerText = original;
    originalValues.delete(action.selector);
    return { ok: true };
  }
  if (action.type === "fill_input") {
    const el = document.querySelector(action.selector);
    const original = originalInputValues.get(action.selector);
    if (!el || original === undefined) return { ok: false, error: "Nothing to undo for this selector." };
    el.value = original;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    originalInputValues.delete(action.selector);
    return { ok: true };
  }
  if (action.type === "insert_element") {
    const key = actionKey(action);
    const el = insertedNodes.get(key);
    if (!el) return { ok: false, error: "Nothing to undo for this action." };
    el.remove();
    insertedNodes.delete(key);
    return { ok: true };
  }
  if (action.type === "toggle_class") {
    const el = document.querySelector(action.selector);
    const key = actionKey(action);
    if (!el || !toggledClasses.has(key)) return { ok: false, error: "Nothing to undo for this action." };
    el.classList.toggle(action.className);
    toggledClasses.delete(key);
    return { ok: true };
  }
  return { ok: false, error: `Unsupported action type: ${action.type}` };
}

// Actions aren't guaranteed to carry a stable id from the model, so we key
// per-action state off a deterministic fingerprint of the action itself.
// Same action object -> same key, both when applying and when undoing.
function actionKey(action) {
  return JSON.stringify(action);
}

// insert_element is intentionally restricted to plain text content in a
// small set of tags — never innerHTML — so the model can't smuggle in
// scripts or arbitrary markup.
const ALLOWED_INSERT_TAGS = new Set(["div", "p", "span", "li", "button", "a"]);
const ALLOWED_POSITIONS = new Set(["before", "after", "prepend", "append"]);

// Only allow hrefs that can't execute script in the page context. Blocks
// javascript:, data:, vbscript:, etc. — a model-generated href is untrusted
// input as far as the live page is concerned.
function sanitizeHref(href) {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return url.href;
    }
  } catch {
    // Not a parseable absolute/relative URL — reject rather than guess.
  }
  return null;
}

function buildInsertedElement(action) {
  const tag = ALLOWED_INSERT_TAGS.has(action.tag) ? action.tag : "div";
  const el = document.createElement(tag);
  el.textContent = action.text || "";
  if (tag === "a") {
    const safeHref = sanitizeHref(action.href);
    el.href = safeHref || "#";
    if (!safeHref) el.addEventListener("click", (e) => e.preventDefault());
  }
  el.dataset.aiCompanionInserted = "true";
  return el;
}

function clearHighlight() {
  if (highlightedEl) {
    highlightedEl.style.outline = "";
    highlightedEl.style.outlineOffset = "";
    highlightedEl = null;
  }
}

function previewActionImpl(action) {
  // Every action type (including insert_element, which targets an existing
  // anchor element) previews by highlighting action.selector — the node
  // doesn't need to exist yet as the *result* of the action.
  const el = document.querySelector(action.selector);
  if (!el) return { ok: false, error: `No element matches selector: ${action.selector}` };
  clearHighlight();
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.style.outline = "3px solid #ff9800";
  el.style.outlineOffset = "2px";
  highlightedEl = el;
  return { ok: true };
}

function cancelPreviewImpl() {
  clearHighlight();
  return { ok: true };
}

function applyActionImpl(action) {
  clearHighlight();
  try {
    if (action.type === "replace_text") {
      const el = document.querySelector(action.selector);
      if (!el) return { ok: false, error: `No element matches selector: ${action.selector}` };
      if (!originalValues.has(action.selector)) {
        originalValues.set(action.selector, el.innerText);
      }
      el.innerText = action.newText;
      appliedActionLog.push(action);
      return { ok: true };

    } else if (action.type === "fill_input") {
      const el = document.querySelector(action.selector);
      if (!el) return { ok: false, error: `No element matches selector: ${action.selector}` };
      if (!("value" in el)) return { ok: false, error: "Target element doesn't support a value." };
      if (!originalInputValues.has(action.selector)) {
        originalInputValues.set(action.selector, el.value);
      }
      el.value = action.value ?? "";
      // Fire input/change so any page listeners (validation, frameworks) notice.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      appliedActionLog.push(action);
      return { ok: true };

    } else if (action.type === "insert_element") {
      const anchor = document.querySelector(action.selector);
      if (!anchor) return { ok: false, error: `No element matches selector: ${action.selector}` };
      if (!ALLOWED_POSITIONS.has(action.position)) {
        return { ok: false, error: `Unsupported position: ${action.position}` };
      }
      const key = actionKey(action);
      if (insertedNodes.has(key)) return { ok: true }; // already applied, no-op
      const newEl = buildInsertedElement(action);
      if (action.position === "before") anchor.before(newEl);
      else if (action.position === "after") anchor.after(newEl);
      else if (action.position === "prepend") anchor.prepend(newEl);
      else if (action.position === "append") anchor.append(newEl);
      insertedNodes.set(key, newEl);
      appliedActionLog.push(action);
      return { ok: true };

    } else if (action.type === "toggle_class") {
      const el = document.querySelector(action.selector);
      if (!el) return { ok: false, error: `No element matches selector: ${action.selector}` };
      el.classList.toggle(action.className);
      toggledClasses.set(actionKey(action), true);
      appliedActionLog.push(action);
      return { ok: true };

    }
    return { ok: false, error: `Unsupported action type: ${action.type}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function undoActionImpl(action) {
  const result = undoOneAction(action);
  if (result.ok) {
    const key = actionKey(action);
    appliedActionLog = appliedActionLog.filter((a) => actionKey(a) !== key);
  }
  return result;
}

function undoAllImpl() {
  // Undo most-recent-first so insertions/edits unwind cleanly.
  const failures = [];
  while (appliedActionLog.length) {
    const action = appliedActionLog.pop();
    const result = undoOneAction(action);
    if (!result.ok) failures.push({ action, error: result.error });
  }
  clearHighlight();
  return { ok: failures.length === 0, failures };
}

// Same-frame bridge for other content scripts in this extension (e.g. the
// cat-buddy inline chat widget) to apply/undo actions directly, without a
// round trip through chrome.tabs messaging — they already share this page.
// Not exposed to the page itself: window here is the isolated-world global,
// invisible to the page's own scripts.
window.__aiCompanionBridge = {
  previewAction: previewActionImpl,
  cancelPreview: cancelPreviewImpl,
  applyAction: applyActionImpl,
  undoAction: undoActionImpl,
  undoAll: undoAllImpl,
  supportedActionTypes: ["replace_text", "fill_input", "insert_element", "toggle_class"]
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PREVIEW_ACTION") {
    sendResponse(previewActionImpl(message.action));
    return;
  }

  if (message.type === "CANCEL_PREVIEW") {
    sendResponse(cancelPreviewImpl());
    return;
  }

  if (message.type === "APPLY_ACTION") {
    sendResponse(applyActionImpl(message.action));
    return;
  }

  if (message.type === "UNDO_ACTION") {
    sendResponse(undoActionImpl(message.action));
    return;
  }

  if (message.type === "UNDO_ALL") {
    sendResponse(undoAllImpl());
    return;
  }
});
