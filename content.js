// 评教自动答题器 - 核心逻辑（content script）
// 在 jxgl 页面内运行，直接操作 DOM。

// ========== 默认答案配置 ==========
const DEFAULT_ANSWERS = {
  1: ["老师讲解问题非常清晰透彻，重点非常突出。", "老师注重因材施教，对我指导非常到位。"],
  2: "老师非常善于启发我的思维，总是对我的问题给予及时、有帮助的反馈，让我对这门课程产生浓厚兴趣。",
  3: "课程内容对我非常有用，课程所学对我今后学习、工作和生活有很大价值。",
  4: "教学设计精心，教学组织非常好，师生互动非常活跃，老师讲课或指导有方。",
  5: "课程资源丰富全面，教材教辅资源齐备，课内外资源互补，很好地满足学习需求。",
  6: "我非常清楚该课程的学习目标。",
  7: "我能很好地掌握该课程的知识和能力要点，能运用课程所学分析解决复杂问题，综合能力得到很好的训练和提升。",
  8: "是",
  9: "否",
  10: "否",
  11: "是",
  12: "非常喜欢"
};
const DEFAULT_Q13_TEXT = "无";

// ========== 运行状态 ==========
const S = {
  running: false,
  stop: false,
  completed: 0,
  log: []
};

// ========== 工具 ==========

// 调用主世界辅助逻辑（通过 background 的 chrome.scripting 在 MAIN world 执行，绕过 CSP）
let __evalLog = false;
function callMain(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "eval", payload: { type, ...payload } }, (resp) => {
        if (chrome.runtime.lastError) {
          if (!__evalLog) { __evalLog = true; log("[诊断] callMain 通信错误: " + chrome.runtime.lastError.message); }
          resolve({ done: false });
          return;
        }
        resolve(resp && resp.ok ? resp : { done: false });
      });
    } catch (err) {
      if (!__evalLog) { __evalLog = true; log("[诊断] callMain 异常: " + err.message); }
      resolve({ done: false });
    }
  });
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  const line = `[${t}] ${msg}`;
  S.log.push(line);
  if (S.log.length > 500) S.log.shift();
  // 通知 popup 更新日志
  chrome.runtime.sendMessage({ type: "log", line: line }).catch(() => {});
  // 控制台也输出，方便查看
  console.log(line);
}

function getAnswers() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ answers: DEFAULT_ANSWERS, q13: DEFAULT_Q13_TEXT }, (d) => {
      resolve({ answers: d.answers, q13: d.q13 });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 页面状态: 'survey'(答题页) / 'list'(名单页) / 'unknown'
function getPageState() {
  const items = document.querySelectorAll(".item");
  const hasTable = document.querySelectorAll(".el-table__row").length > 0;
  const hasTerm = document.querySelectorAll(".el-tabs__item, .el-select").length > 0;
  if (items.length > 0) return "survey";
  if (hasTable || hasTerm) return "list";
  return "unknown";
}

function waitForState(wanted, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const st = getPageState();
      if (wanted.includes(st) || Date.now() > deadline) {
        resolve(getPageState());
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

// 剩余待评老师数
function countPending() {
  return document.querySelectorAll('.el-link[title="点击开始评教"]').length;
}

// 点击第一个待评老师，返回是否点到
function clickFirstTeacher() {
  const links = document.querySelectorAll('.el-link[title="点击开始评教"]');
  if (links.length > 0) {
    links[0].click();
    return true;
  }
  // 兜底
  const all = document.querySelectorAll(".el-link");
  for (const a of all) {
    if (!/disabled|submitted/i.test(a.className) && /点击开始评教|评教/i.test(a.title || "")) {
      a.click();
      return true;
    }
  }
  return false;
}

// 答题。返回 { done, total, failed: [题号...] }
async function doAnswer(answers, q13) {
  const items = document.querySelectorAll(".item");
  let done = 0;
  const failed = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const qNum = idx + 1;
    if (qNum === 13) {
      const r = await callMain("setTextarea", { text: q13, itemIdx: idx });
      if (r.done) done++; else failed.push(qNum);
      continue;
    }
    let ans = answers[qNum];
    if (!ans) { failed.push(qNum); continue; }
    if (!Array.isArray(ans)) ans = [ans];
    let matched = false;
    for (const a of ans) {
      const r = await callMain("checkRadio", { value: a, itemIdx: idx });
      if (r.done) { done++; matched = true; break; }
    }
    if (!matched) failed.push(qNum);
  }
  return { done, total: items.length, failed };
}

// 清理按钮文字：移除普通空格、全角空格、不换行空格(&nbsp;)、换行、制表符等所有空白
function cleanText(t) {
  return (t || "")
    .replace(/\u00a0/g, "")
    .replace(/\u3000/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// 判断按钮是否真正禁用：优先看 disabled 属性，其次类名含 is-disabled / is-disabled
function isBtnDisabled(b) {
  if (b.disabled === true || b.disabled === "disabled") return true;
  const cls = b.className || "";
  // 只有 is-disabled / disabled 才代表禁用，避免误伤
  if (/\bis-disabled\b/.test(cls)) return true;
  return false;
}

// 更可靠地触发点击（click + 冒泡 MouseEvent），确保 Vue/Element 能捕获
function doClick(el) {
  if (!el) return;
  try { el.click(); } catch (e) {}
  try {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } catch (e) {}
}

// 点击"提交"。返回 'clicked' / 'disabled' / 'none'，并记录是否真的点上
async function clickSubmit() {
  const btns = document.querySelectorAll("button");
  const found = [];
  for (const b of btns) {
    if (cleanText(b.textContent).indexOf("提交") >= 0) {
      found.push(b);
    }
  }
  // 优先点第一个"可点"的提交按钮
  for (const b of found) {
    if (!isBtnDisabled(b)) {
      // 通过主世界点击，确保 Vue 3 能捕获
      await callMain("clickText", { text: cleanText(b.textContent) });
      return "clicked";
    }
  }
  if (found.length > 0) {
    log("警告：提交按钮存在但处于禁用状态，可能因题目未答全");
    const info = found.map((b) => `文字=[${cleanText(b.textContent)}] 类名=${b.className} disabled=${b.disabled}`).join(" ; ");
    log("提交按钮详情: " + info);
    return "disabled";
  }
  return "none";
}

// 点击"取消"（返回上一级）
function clickCancel() {
  const btns = document.querySelectorAll("button");
  for (const b of btns) {
    if (cleanText(b.textContent).indexOf("取消") >= 0 && !isBtnDisabled(b)) {
      doClick(b);
      return true;
    }
  }
  return false;
}

// 处理确认弹窗（Element UI 消息框 / 对话框确认按钮）
function confirmSubmit() {
  const texts = ["确定", "确认", "是"];
  const exclude = "取消";
  const clickIn = (root) => {
    const bs = root.querySelectorAll("button");
    for (const b of bs) {
      const t = b.textContent.trim();
      for (const x of texts) {
        if (t === x || t.indexOf(x) >= 0) {
          if (exclude && t.indexOf(exclude) >= 0) continue;
          b.click();
          return true;
        }
      }
    }
    return false;
  };
  const mb = document.querySelector(".el-message-box__btns");
  if (mb && clickIn(mb)) return "confirmed";
  const dlg = document.querySelector(".el-dialog__wrapper_center, .el-dialog");
  if (dlg && clickIn(dlg)) return "confirmed";
  if (clickIn(document)) return "confirmed";
  // 诊断（仅打印一次）：未找到确认按钮，打印当前页面所有按钮和弹窗
  if (!confirmSubmit.__diagnosed) {
    confirmSubmit.__diagnosed = true;
    log("[诊断] 未找到确认按钮，当前页面按钮如下：");
    const bs = document.querySelectorAll("button");
    let btnCount = 0;
    for (const b of bs) {
      const t = cleanText(b.textContent);
      if (t) { log(`  [button] 文字="${t}" 类=${b.className}`); btnCount++; }
    }
    if (btnCount === 0) log("  （页面上没有按钮）");
    const dlgEls = document.querySelectorAll(".el-dialog, .el-message-box, .el-drawer, .el-overlay, [class*='dialog'], [class*='message-box'], [class*='confirm']");
    if (dlgEls.length) {
      log(`[诊断] 发现弹窗/遮罩元素 ${dlgEls.length} 个：`);
      for (const d of dlgEls) {
        log(`  [dialog] 类=${d.className} 文本=${cleanText(d.textContent).slice(0, 100)}`);
      }
    }
  }
  return "none";
}

// 关闭对话框（兜底）
function closeDialog() {
  const dlg = document.querySelector(".el-dialog__wrapper_center, .el-dialog");
  if (!dlg) return false;
  const close = dlg.querySelector(".el-dialog__headerbtn, .el-dialog__close, .el-icon-close");
  if (close) { close.click(); return true; }
  return false;
}

// 检测提交失败错误提示（500 等）。
// 返回 "duplicate"（重复提交/已评过，视为成功）| 错误文本（服务器失败）| ""（无错误）
function submitError() {
  const msgs = document.querySelectorAll(".el-message, .el-message--error, .el-message__content");
  for (const m of msgs) {
    const t = (m.textContent || "").trim();
    if (!t) continue;
    // 重复提交 / 唯一约束冲突：说明该老师已成功提交过，不应再重试
    if (/ORA-00001|unique constraint|duplicate|重复提交|已提交过|已评过/i.test(t)) {
      return "duplicate";
    }
    if (/500|failed|fail|error|eror|失败|错误/i.test(t)) return t;
  }
  return "";
}

// 检测是否出现成功提交提示
function submitSuccess() {
  const msgs = document.querySelectorAll(".el-message--success, .el-message__content");
  for (const m of msgs) {
    const t = (m.textContent || "").trim();
    if (t && /成功|完成|已提交|已评/i.test(t)) return true;
  }
  return false;
}

// 等待提交结果。返回 'success' | 'failed' | 'duplicate' | 'timeout'
async function waitForSubmitResult(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  let lastConfirmTry = 0;
  while (Date.now() < deadline) {
    const now = Date.now();
    // 周期性尝试处理可能延迟出现的确认弹窗（确认本身不产生重复提交，安全）
    if (now - lastConfirmTry >= 1500) {
      lastConfirmTry = now;
      if (confirmSubmit() === "confirmed") {
        log("等待期间捕获到确认弹窗并已确认");
      }
    }
    const err = submitError();
    if (err === "duplicate") return "duplicate";
    if (err) return "failed";
    if (getPageState() === "list") return "success";
    if (submitSuccess()) return "success";
    // 每 5 秒报告一次当前页面状态，便于诊断
    if (now - lastReport >= 5000) {
      lastReport = now;
      const el = document.querySelectorAll(".item").length;
      const msg = document.querySelector(".el-message__content");
      log(`等待中... 页面状态=${getPageState()} 题目数=${el} 提示=${msg ? msg.textContent.trim().slice(0, 60) : "无"}`);
    }
    await sleep(500);
  }
  return "timeout";
}

// 提交成功后，等待并确保回到名单页（不重复点提交）
async function backToList() {
  let st2 = await waitForState(["list"], 30000);
  if (st2 !== "list") {
    log("提交成功后较长时间未自动返回，尝试关闭弹窗/确认...");
    for (let i = 0; i < 4 && getPageState() !== "list"; i++) {
      closeDialog();
      await sleep(1000);
      confirmSubmit();
      await sleep(1000);
      st2 = await waitForState(["list"], 8000);
    }
  }
  log(`backToList 最终状态: ${st2}`);
  return st2 === "list";
}

// ========== 主批处理流程 ==========
async function runBatch() {
  const { answers, q13 } = await getAnswers();
  S.completed = 0;
  log("开始批量评教");

  while (!S.stop) {
    // 等待名单页待评老师加载出来
    let pending = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      pending = countPending();
      if (pending > 0) break;
      await sleep(500);
    }
    if (pending <= 0) {
      log("没有可点击的老师链接，全部完成！");
      break;
    }
    log(`剩余待评老师: ${pending}`);

    // 点击第一个老师
    if (!clickFirstTeacher()) {
      log("没有可点击的老师链接，全部完成！");
      break;
    }

    // 等待进入答题页
    const st = await waitForState(["survey"], 30000);
    if (st !== "survey") {
      log("点击老师后未进入答题页，可能异常，停止。");
      break;
    }
    await sleep(1500);

    // 答题
    const r = await doAnswer(answers, q13);
    log(`答题: ${r.done}/${r.total}`);
    if (r.failed && r.failed.length > 0) {
      log(`注意：第 ${r.failed.join(",")} 题未匹配到答案，可能导致提交按钮禁用`);
    }

    // 提交 + 确认（带重试）
    let submitted = await clickSubmit();
    log(`点击提交按钮结果: ${submitted}`);
    if (submitted === "none") {
      log("未找到提交按钮，停止。");
      break;
    }
    await sleep(1200);
    log(`确认弹窗处理: ${confirmSubmit()}`);
    await sleep(1200);

    // 若提交按钮被禁用，尝试重新答一遍未答的题，再点提交
    if (submitted === "disabled") {
      log("提交按钮禁用，尝试重新补答题...");
      const r2 = await doAnswer(answers, q13);
      log(`补答后: ${r2.done}/${r2.total}`);
      await sleep(800);
      submitted = await clickSubmit();
      log(`补答后再点提交结果: ${submitted}`);
      if (submitted === "clicked") {
        await sleep(1200);
        log(`补答后确认弹窗处理: ${confirmSubmit()}`);
        await sleep(1200);
      }
    }

    // 等待提交结果：成功 / 服务器失败 / 重复提交(已评过)
    log("开始等待提交结果...");
    const res = await waitForSubmitResult();
    log(`提交结果: ${res}`);

    if (res === "duplicate") {
      // 唯一约束冲突 = 该老师其实已提交成功，直接返回名单页即可，不重试
      log("检测到重复提交（该老师已评过，唯一约束冲突），视为成功，返回名单页。");
      if (await backToList()) {
        S.completed++;
        log(`[完成 ${S.completed} 位老师]`);
        continue;
      }
      log("返回名单页失败，停止。");
      break;
    }

    if (res === "failed") {
      const err = submitError();
      log(`提交失败（服务器错误）：${err}，尝试自动取消返回上一级...`);
      let gotList = false;
      for (let retry = 0; retry < 8; retry++) {
        const wait = 3000 + retry * 2000;
        log(`等待 ${Math.round(wait / 1000)} 秒后取消返回...`);
        await sleep(wait);
        clickCancel();
        await sleep(1000);
        clickCancel();
        await sleep(1000);
        closeDialog();
        await sleep(1000);
        const s2 = await waitForState(["list"], 15000);
        if (s2 === "list") { gotList = true; break; }
      }
      if (!gotList) {
        log("多次取消仍无法返回名单页，停止。");
        break;
      }
      log("已返回名单页，继续下一轮（失败老师会自动重试）...");
      continue;
    }

    // success 或 timeout：提交已发出，等待并确认回到名单页，绝不重复点提交（避免唯一约束冲突）
    if (!(await backToList())) {
      log("提交后返回名单页失败，可能异常，停止。");
      break;
    }

    S.completed++;
    log(`[完成 ${S.completed} 位老师]`);
  }

  S.running = false;
  log(`全部完成！共答题 ${S.completed} 位老师`);
  const fb = document.getElementById("eval-float-btn");
  if (fb) fb.textContent = "开始自动评教";
  notifyState();
}

// ========== 消息通信 ==========
function notifyState() {
  chrome.runtime.sendMessage({
    type: "state",
    running: S.running,
    completed: S.completed,
    logs: S.log
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "start") {
    if (!S.running) {
      S.running = true;
      S.stop = false;
      notifyState();
      runBatch();
    }
    sendResponse({ ok: true });
  } else if (msg.type === "stop") {
    S.stop = true;
    sendResponse({ ok: true });
  } else if (msg.type === "getstate") {
    sendResponse({ running: S.running, completed: S.completed, logs: S.log });
  }
  return true;
});

// ========== 浮动按钮 ==========
function ensureFloatButton() {
  if (document.getElementById("eval-float-btn")) return;
  const btn = document.createElement("div");
  btn.id = "eval-float-btn";
  btn.textContent = S.running ? "评教进行中..." : "开始自动评教";
  btn.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:99999;background:#409EFF;color:#fff;" +
    "padding:12px 18px;border-radius:8px;cursor:pointer;font-size:14px;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.3);font-family:sans-serif;";
  btn.addEventListener("click", () => {
    if (S.running) {
      S.stop = true;
      btn.textContent = "开始自动评教";
      log("已请求停止");
    } else {
      S.running = true;
      S.stop = false;
      btn.textContent = "评教进行中...";
      notifyState();
      runBatch();
    }
  });
  document.body.appendChild(btn);
}

// 页面变化时确保浮动按钮存在
let lastBtnCheck = 0;
function initButtonWatcher() {
  callMain("ping", {}).then((r) => log(r.pong ? "[主世界通信正常]" : "[主世界通信失败]"));
  const t = setInterval(() => {
    if (document.body) {
      ensureFloatButton();
      if (S.running) {
        const btn = document.getElementById("eval-float-btn");
        if (btn) btn.textContent = "评教进行中...";
      }
      // 清理旧的，避免重复
      clearInterval(t);
    }
  }, 1000);
}
initButtonWatcher();

log("评教扩展已加载（content script ready）");
