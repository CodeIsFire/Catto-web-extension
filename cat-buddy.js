// Catto "cat buddy" — a floating cat (rendered purely from your
// .lottie animation) that drifts around the page, can be grabbed and
// thrown around with the mouse, and opens an inline chat when clicked.
// No side panel involved. Lives in its own Shadow DOM so page CSS can't
// clash with it. Chat + page-editing logic is reused from background.js /
// content.js via messaging and the same-page bridge content.js exposes at
// window.__aiCompanionBridge.

(function () {
  // Don't run inside iframes — one cat per tab, not one per frame.
  if (window !== window.top) return;
  // Don't run on pages the extension shouldn't decorate.
  if (!location.protocol.startsWith("http")) return;

  const CAT_SIZE = 110; // px, square box the animation renders into

  // --- Build the widget (Shadow DOM keeps host-page CSS out) -----------
  const host = document.createElement("div");
  host.id = "ai-companion-cat-buddy-host";
  host.style.cssText =
    "position:fixed; left:0; top:0; width:0; height:0; z-index:2147483647; pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .cat-wrap {
      position: fixed;
      left: 0px;
      top: 0px;
      width: ${CAT_SIZE}px;
      height: ${CAT_SIZE}px;
      pointer-events: auto;
      cursor: grab;
      touch-action: none;
    }
    .cat-wrap.dragging { cursor: grabbing; }
    .cat-wrap.facing-left .lottie-frame { transform: scaleX(-1); }
    .lottie-frame {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 4px 4px rgba(0,0,0,0.3));
      pointer-events: none; /* clicks/drags go through to .cat-wrap */
    }
    .close-btn {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #444;
      color: #fff;
      font: 11px/16px system-ui, sans-serif;
      text-align: center;
      opacity: 0;
      transition: opacity 0.15s;
      cursor: pointer;
      z-index: 2;
      pointer-events: auto;
    }
    .cat-wrap:hover .close-btn { opacity: 0.85; }

    /* --- Chat popup ------------------------------------------------- */
    .chat-panel {
      position: fixed;
      left: 0px;
      top: 0px;
      width: 300px;
      max-height: 380px;
      background: #1e1e1e;
      color: #eee;
      border: 1px solid #3a3a3a;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: system-ui, sans-serif;
      opacity: 0;
      transform: scale(0.98);
      transition: opacity 0.15s, transform 0.15s;
      pointer-events: none;
    }
    .chat-panel.open {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
    }
    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: #262626;
      border-bottom: 1px solid #3a3a3a;
      font-size: 12px;
      font-weight: 600;
    }
    .chat-header .x {
      cursor: pointer;
      opacity: 0.7;
      font-size: 14px;
      line-height: 1;
    }
    .chat-header .x:hover { opacity: 1; }
    .chat-log {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 120px;
    }
    .bubble {
      padding: 7px 9px;
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1.4;
      max-width: 88%;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user { align-self: flex-end; background: #3b6ef5; color: #fff; }
    .bubble.bot { align-self: flex-start; background: #2a2a2a; border: 1px solid #444; }
    .bubble.bot.error { border-color: #a33; color: #e57373; }
    .action-row { display: flex; gap: 6px; margin: -2px 0 4px; }
    .action-row button {
      padding: 4px 10px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 11.5px;
      color: #fff;
    }
    .chat-input-row {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid #3a3a3a;
    }
    .chat-input-row textarea {
      flex: 1;
      resize: none;
      height: 34px;
      background: #2a2a2a;
      color: #eee;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 12.5px;
      font-family: inherit;
    }
    .chat-input-row button {
      padding: 0 12px;
      background: #3b6ef5;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .chat-input-row button:disabled { opacity: 0.5; cursor: default; }
  `;

  const wrap = document.createElement("div");
  wrap.className = "cat-wrap";
  wrap.title = "Drag me, throw me, or click me to chat";

  const lottieFrame = document.createElement("div");
  lottieFrame.className = "lottie-frame";

  const closeBtn = document.createElement("div");
  closeBtn.className = "close-btn";
  closeBtn.textContent = "×";
  closeBtn.title = "Hide for this page";

  wrap.appendChild(lottieFrame);
  wrap.appendChild(closeBtn);

  const chatPanel = document.createElement("div");
  chatPanel.className = "chat-panel";

  const chatHeader = document.createElement("div");
  chatHeader.className = "chat-header";
  const chatTitle = document.createElement("span");
  chatTitle.textContent = "Catto";
  const chatClose = document.createElement("span");
  chatClose.className = "x";
  chatClose.textContent = "×";
  chatHeader.appendChild(chatTitle);
  chatHeader.appendChild(chatClose);

  const chatLog = document.createElement("div");
  chatLog.className = "chat-log";

  const chatInputRow = document.createElement("div");
  chatInputRow.className = "chat-input-row";
  const chatInput = document.createElement("textarea");
  chatInput.placeholder = "Ask about this page, or ask me to change it...";
  const chatSend = document.createElement("button");
  chatSend.textContent = "Send";
  chatInputRow.appendChild(chatInput);
  chatInputRow.appendChild(chatSend);

  chatPanel.appendChild(chatHeader);
  chatPanel.appendChild(chatLog);
  chatPanel.appendChild(chatInputRow);

  shadow.appendChild(style);
  shadow.appendChild(chatPanel);
  shadow.appendChild(wrap);

  function mountHost() {
    (document.body || document.documentElement).appendChild(host);
  }
  if (document.body) mountHost();
  else window.addEventListener("DOMContentLoaded", mountHost, { once: true });

  // --- The animation is the cat's only visual, always playing ----------
  let anim = null;
  if (typeof lottie !== "undefined") {
    fetch(chrome.runtime.getURL("cat-thinking-lottie.json"))
      .then((r) => r.json())
      .then((animationData) => {
        anim = lottie.loadAnimation({
          container: lottieFrame,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData
        });
      })
      .catch((err) => console.warn("[Catto] cat animation failed to load:", err));
  }

  // --- Physics: float, drag, throw ---------------------------------------
  let x = Math.random() * Math.max(0, window.innerWidth - CAT_SIZE);
  let y = Math.random() * Math.max(0, window.innerHeight - CAT_SIZE) * 0.6 + 40;
  let vx = 0, vy = 0; // px/ms, used while "thrown"
  let driftVX = 0, driftVY = 0; // px/ms, gentle ambient float
  let nextDriftRerollAt = 0;
  let mode = "floating"; // "floating" | "dragging" | "thrown"
  let chatOpen = false;
  let dismissed = false;
  let lastFrameTime = null;

  function maxX() { return Math.max(0, window.innerWidth - CAT_SIZE); }
  function maxY() { return Math.max(0, window.innerHeight - CAT_SIZE); }

  function applyPosition() {
    wrap.style.left = `${x}px`;
    wrap.style.top = `${y}px`;
  }

  function rerollDrift(now) {
    const speed = 0.05 + Math.random() * 0.07; // px/ms — lively float
    const angle = Math.random() * Math.PI * 2;
    driftVX = Math.cos(angle) * speed;
    driftVY = Math.sin(angle) * speed;
    nextDriftRerollAt = now + 1500 + Math.random() * 2000;
  }

  function updateFacing(dx) {
    if (Math.abs(dx) < 0.001) return;
    wrap.classList.toggle("facing-left", dx < 0);
  }

  function bounceWalls() {
    if (x < 0) { x = 0; vx = Math.abs(vx) * 0.7; driftVX = Math.abs(driftVX); }
    if (x > maxX()) { x = maxX(); vx = -Math.abs(vx) * 0.7; driftVX = -Math.abs(driftVX); }
    if (y < 0) { y = 0; vy = Math.abs(vy) * 0.7; driftVY = Math.abs(driftVY); }
    if (y > maxY()) { y = maxY(); vy = -Math.abs(vy) * 0.7; driftVY = -Math.abs(driftVY); }
  }

  function frame(now) {
    if (dismissed) return;
    if (lastFrameTime === null) lastFrameTime = now;
    const dt = Math.min(now - lastFrameTime, 50); // clamp so a stalled tab doesn't jump
    lastFrameTime = now;

    if (mode === "thrown") {
      x += vx * dt;
      y += vy * dt;
      bounceWalls();
      const friction = Math.pow(0.994, dt);
      vx *= friction;
      vy *= friction;
      updateFacing(vx);
      if (Math.hypot(vx, vy) < 0.02) {
        mode = "floating";
        rerollDrift(now);
      }
      applyPosition();
    } else if (mode === "floating" && !chatOpen) {
      if (now >= nextDriftRerollAt) rerollDrift(now);
      x += driftVX * dt;
      y += driftVY * dt;
      bounceWalls();
      updateFacing(driftVX);
      applyPosition();
    }
    // "dragging" mode: position is driven directly by pointermove, nothing to do here.

    requestAnimationFrame(frame);
  }
  rerollDrift(0);
  applyPosition();
  requestAnimationFrame(frame);

  window.addEventListener("resize", () => {
    x = Math.min(x, maxX());
    y = Math.min(y, maxY());
    applyPosition();
    if (chatOpen) positionChatPanel();
  });

  // --- Grab / throw interaction ------------------------------------------
  const CLICK_MAX_MOVE = 6; // px
  const CLICK_MAX_TIME = 350; // ms

  let dragOffsetX = 0, dragOffsetY = 0;
  let pointerDownAt = 0;
  let pointerDownPos = { x: 0, y: 0 };
  let pointerHistory = []; // {x, y, t} recent samples, for release velocity

  wrap.addEventListener("pointerdown", (e) => {
    if (e.target === closeBtn) return;
    wrap.setPointerCapture(e.pointerId);
    mode = "dragging";
    wrap.classList.add("dragging");
    dragOffsetX = e.clientX - x;
    dragOffsetY = e.clientY - y;
    pointerDownAt = performance.now();
    pointerDownPos = { x: e.clientX, y: e.clientY };
    pointerHistory = [{ x: e.clientX, y: e.clientY, t: pointerDownAt }];
  });

  wrap.addEventListener("pointermove", (e) => {
    if (mode !== "dragging") return;
    x = Math.min(Math.max(e.clientX - dragOffsetX, 0), maxX());
    y = Math.min(Math.max(e.clientY - dragOffsetY, 0), maxY());
    applyPosition();
    if (chatOpen) positionChatPanel();

    const now = performance.now();
    pointerHistory.push({ x: e.clientX, y: e.clientY, t: now });
    // Only need a short recent window to estimate throw velocity.
    while (pointerHistory.length > 2 && now - pointerHistory[0].t > 120) pointerHistory.shift();
  });

  wrap.addEventListener("pointerup", (e) => {
    if (mode !== "dragging") return;
    wrap.releasePointerCapture(e.pointerId);
    wrap.classList.remove("dragging");

    const totalMove = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    const elapsed = performance.now() - pointerDownAt;
    const wasClick = totalMove < CLICK_MAX_MOVE && elapsed < CLICK_MAX_TIME;

    if (wasClick) {
      mode = "floating";
      rerollDrift(performance.now());
      if (chatOpen) closeChat();
      else openChat();
      return;
    }

    if (chatOpen) {
      // Dragged while chat was open — just park it here, chat stays open.
      mode = "floating";
      driftVX = 0;
      driftVY = 0;
      return;
    }

    // Real throw: estimate velocity from the recent pointer history.
    const first = pointerHistory[0];
    const last = pointerHistory[pointerHistory.length - 1];
    const dt = Math.max(1, last.t - first.t);
    vx = (last.x - first.x) / dt;
    vy = (last.y - first.y) / dt;
    // Cap so a huge mouse jump doesn't launch the cat off-screen instantly.
    const MAX_V = 2.5;
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_V) {
      vx = (vx / speed) * MAX_V;
      vy = (vy / speed) * MAX_V;
    }
    mode = Math.hypot(vx, vy) < 0.03 ? "floating" : "thrown";
    if (mode === "floating") rerollDrift(performance.now());
  });

  // --- Chat ---------------------------------------------------------------
  const SUPPORTED_ACTION_TYPES =
    (window.__aiCompanionBridge && window.__aiCompanionBridge.supportedActionTypes) ||
    ["replace_text", "fill_input", "insert_element", "toggle_class"];

  function bridge() {
    return window.__aiCompanionBridge;
  }

  function appendBubble(role, text) {
    const b = document.createElement("div");
    b.className = `bubble ${role}`;
    b.textContent = text;
    chatLog.appendChild(b);
    chatLog.scrollTop = chatLog.scrollHeight;
    return b;
  }

  function styleActionBtn(btn, bg) {
    btn.style.background = bg;
  }

  function appendActionRow(action) {
    const row = document.createElement("div");
    row.className = "action-row";
    const doItBtn = document.createElement("button");
    doItBtn.textContent = "Do it";
    styleActionBtn(doItBtn, "#3b6ef5");
    doItBtn.addEventListener("click", () => startPreview(action, row));
    row.appendChild(doItBtn);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // Some actions (currently just highlight_element) are non-destructive
  // visual-only changes, so we apply them the instant the reply arrives
  // instead of waiting for a "Do it" click — just show an Undo option
  // afterward in case the person wants it removed.
  const AUTO_APPLY_ACTION_TYPES = ["highlight_element"];

  function appendAutoAppliedRow(action) {
    const row = document.createElement("div");
    row.className = "action-row";
    const result = bridge() ? bridge().applyAction(action) : { ok: false, error: "Page bridge unavailable." };
    chatLog.appendChild(row);

    if (!result.ok) {
      const failBtn = document.createElement("button");
      failBtn.textContent = result.error || "Couldn't highlight that.";
      failBtn.disabled = true;
      styleActionBtn(failBtn, "#a33");
      row.appendChild(failBtn);
      chatLog.scrollTop = chatLog.scrollHeight;
      return;
    }

    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo highlight";
    styleActionBtn(undoBtn, "#555");
    undoBtn.addEventListener("click", () => {
      const undoResult = bridge() ? bridge().undoAction(action) : { ok: false };
      if (undoResult.ok) {
        undoBtn.disabled = true;
        undoBtn.textContent = "Removed";
      }
    });
    row.appendChild(undoBtn);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function startPreview(action, row) {
    const result = bridge() ? bridge().previewAction(action) : { ok: false, error: "Page bridge unavailable." };
    if (!result.ok) {
      row.innerHTML = "";
      const failBtn = document.createElement("button");
      failBtn.textContent = result.error || "Couldn't preview that.";
      failBtn.disabled = true;
      styleActionBtn(failBtn, "#a33");
      row.appendChild(failBtn);
      return;
    }
    row.innerHTML = "";
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm";
    styleActionBtn(confirmBtn, "#2e7d32");
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    styleActionBtn(cancelBtn, "#555");
    confirmBtn.addEventListener("click", () => applyAction(action, row));
    cancelBtn.addEventListener("click", () => {
      bridge() && bridge().cancelPreview();
      row.innerHTML = "";
      const doItBtn = document.createElement("button");
      doItBtn.textContent = "Do it";
      styleActionBtn(doItBtn, "#3b6ef5");
      doItBtn.addEventListener("click", () => startPreview(action, row));
      row.appendChild(doItBtn);
    });
    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);
  }

  function applyAction(action, row) {
    const result = bridge() ? bridge().applyAction(action) : { ok: false, error: "Page bridge unavailable." };
    row.innerHTML = "";
    if (!result.ok) {
      const failBtn = document.createElement("button");
      failBtn.textContent = result.error || "Failed";
      failBtn.disabled = true;
      styleActionBtn(failBtn, "#a33");
      row.appendChild(failBtn);
      return;
    }
    const appliedBtn = document.createElement("button");
    appliedBtn.textContent = "Applied ✓";
    appliedBtn.disabled = true;
    styleActionBtn(appliedBtn, "#2e7d32");
    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo";
    styleActionBtn(undoBtn, "#555");
    undoBtn.addEventListener("click", () => {
      const undoResult = bridge() ? bridge().undoAction(action) : { ok: false };
      if (undoResult.ok) {
        row.innerHTML = "";
        const doItBtn = document.createElement("button");
        doItBtn.textContent = "Do it";
        styleActionBtn(doItBtn, "#3b6ef5");
        doItBtn.addEventListener("click", () => startPreview(action, row));
        row.appendChild(doItBtn);
      }
    });
    row.appendChild(appliedBtn);
    row.appendChild(undoBtn);
  }

  let pendingThinkingBubble = null;

  function setChatInputEnabled(enabled) {
    chatInput.disabled = !enabled;
    chatSend.disabled = !enabled;
    if (enabled) chatInput.focus();
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    appendBubble("user", text);
    chatInput.value = "";
    setChatInputEnabled(false);
    pendingThinkingBubble = appendBubble("bot", "Thinking…");
    chrome.runtime.sendMessage({ type: "CHAT_MESSAGE", text });
  }

  chatSend.addEventListener("click", sendChatMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "CHAT_RESPONSE") {
      const payload = message.payload;
      if (pendingThinkingBubble) {
        pendingThinkingBubble.textContent = payload.reply;
        pendingThinkingBubble = null;
      } else {
        appendBubble("bot", payload.reply);
      }
      if (payload.action && SUPPORTED_ACTION_TYPES.includes(payload.action.type)) {
        if (AUTO_APPLY_ACTION_TYPES.includes(payload.action.type)) {
          appendAutoAppliedRow(payload.action);
        } else {
          appendActionRow(payload.action);
        }
      }
      setChatInputEnabled(true);
    }

    if (message.type === "CHAT_ERROR") {
      const text = `Something went wrong: ${message.payload}`;
      if (pendingThinkingBubble) {
        pendingThinkingBubble.textContent = text;
        pendingThinkingBubble.classList.add("error");
        pendingThinkingBubble = null;
      } else {
        appendBubble("bot", text).classList.add("error");
      }
      setChatInputEnabled(true);
    }
  });

  // --- Open/close/position the chat panel ---------------------------------
  function positionChatPanel() {
    const panelW = 300;
    const panelH = chatPanel.offsetHeight || 380;
    let left = Math.min(Math.max(x, 4), window.innerWidth - panelW - 4);
    const spaceAbove = y;
    const spaceBelow = window.innerHeight - (y + CAT_SIZE);
    let top;
    if (spaceAbove >= panelH + 10 || spaceAbove > spaceBelow) {
      top = Math.max(4, y - panelH - 10);
    } else {
      top = Math.min(y + CAT_SIZE + 10, window.innerHeight - panelH - 4);
    }
    chatPanel.style.left = `${left}px`;
    chatPanel.style.top = `${top}px`;
  }

  function openChat() {
    chatOpen = true;
    mode = "floating";
    driftVX = 0;
    driftVY = 0;
    chatPanel.classList.add("open");
    positionChatPanel();
    if (!chatLog.children.length) {
      appendBubble("bot", "Hey! Ask me about this page, or tell me what to change on it.");
    }
    setChatInputEnabled(true);
  }

  function closeChat() {
    chatOpen = false;
    chatPanel.classList.remove("open");
    rerollDrift(performance.now());
  }

  chatClose.addEventListener("click", closeChat);

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissed = true;
    host.remove();
  });
})();
