// 后台服务：在主世界（MAIN）执行 DOM 交互，绕过页面 CSP 对 inline script 的限制
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "eval") {
    const payload = msg.payload || {};
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "no tab" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: evalFn,
        args: [payload]
      })
      .then((results) => {
        const r = results && results[0] && results[0].result;
        sendResponse({ ok: true, ...(r || {}) });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 保持消息通道，异步返回
  }
});

// 在主世界执行的函数（由 chrome.scripting 序列化运行在页面 MAIN world）
function evalFn(payload) {
  const type = payload.type;
  if (type === "checkRadio") {
    const items = document.querySelectorAll(".item");
    const item = items[payload.itemIdx] || document;
    const inps = item.querySelectorAll('input[type="radio"]');
    for (const inp of inps) {
      if (inp.value === payload.value) {
        const lb = inp.closest("label.el-radio") || inp;
        try { lb.click(); } catch (e) {}
        try { inp.click(); } catch (e) {}
        return { done: true };
      }
    }
    return { done: false };
  }
  if (type === "setTextarea") {
    const items = document.querySelectorAll(".item");
    const item = items[payload.itemIdx] || document;
    const ta = item.querySelector("textarea");
    if (ta) {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, payload.text);
      } catch (e) { ta.value = payload.text; }
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return { done: true };
    }
    return { done: false };
  }
  if (type === "clickText") {
    const btns = document.querySelectorAll("button");
    const txt = (payload.text || "").replace(/\s+/g, "");
    for (const b of btns) {
      if (((b.textContent || "").replace(/\s+/g, "")).indexOf(txt) >= 0) {
        try { b.click(); } catch (e) {}
        return { done: true };
      }
    }
    return { done: false };
  }
  if (type === "ping") {
    return { pong: true };
  }
  return { done: false };
}
