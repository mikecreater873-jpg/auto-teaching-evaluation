// popup 控制面板逻辑
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
const DEFAULT_Q13 = "无";

let currentTab = null;

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendToContent(msg) {
  if (!currentTab || !currentTab.id) return null;
  try {
    return await chrome.tabs.sendMessage(currentTab.id, msg);
  } catch (e) {
    return null;
  }
}

async function loadConfig() {
  const d = await chrome.storage.local.get({ answers: DEFAULT_ANSWERS, q13: DEFAULT_Q13 });
  // 渲染答案配置为 JSON 文本域
  const ta = document.getElementById("answers-config");
  const ta2 = document.createElement("textarea");
  ta2.id = "answers-json";
  ta2.value = JSON.stringify(d.answers, null, 2);
  ta.replaceWith(ta2);
  document.getElementById("q13").value = d.q13;
}

function renderLogs(logs) {
  const el = document.getElementById("log");
  el.innerHTML = "";
  (logs || []).forEach((l) => {
    const div = document.createElement("div");
    div.textContent = l;
    el.appendChild(div);
  });
  el.scrollTop = el.scrollHeight;
}

function refreshState() {
  sendToContent({ type: "getstate" }).then((s) => {
    if (s) {
      document.getElementById("status").textContent = s.running ? "运行中" : "未运行";
      document.getElementById("completed").textContent = s.completed || 0;
      renderLogs(s.logs);
    } else {
      document.getElementById("status").textContent = "当前页无扩展注入（请打开评教页面）";
    }
  });
}

// 监听来自 content 的日志/状态
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "log") {
    const el = document.getElementById("log");
    const div = document.createElement("div");
    div.textContent = msg.line;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  } else if (msg.type === "state") {
    document.getElementById("status").textContent = msg.running ? "运行中" : "未运行";
    document.getElementById("completed").textContent = msg.completed || 0;
    renderLogs(msg.logs);
  }
});

document.getElementById("btn-start").addEventListener("click", async () => {
  await sendToContent({ type: "start" });
  document.getElementById("status").textContent = "运行中";
  setTimeout(refreshState, 500);
});

document.getElementById("btn-stop").addEventListener("click", async () => {
  await sendToContent({ type: "stop" });
  document.getElementById("status").textContent = "已请求停止";
  setTimeout(refreshState, 500);
});

document.getElementById("btn-save").addEventListener("click", async () => {
  const jsonEl = document.getElementById("answers-json");
  let answers;
  try {
    answers = JSON.parse(jsonEl.value);
  } catch (e) {
    document.getElementById("save-hint").textContent = "答案格式错误：" + e.message;
    document.getElementById("save-hint").style.color = "#F56C6C";
    return;
  }
  const q13 = document.getElementById("q13").value;
  await chrome.storage.local.set({ answers: answers, q13: q13 });
  const hint = document.getElementById("save-hint");
  hint.textContent = "已保存（刷新评教页面后生效）";
  hint.style.color = "#67C23A";
});

// 初始化
(async () => {
  currentTab = await getActiveTab();
  await loadConfig();
  refreshState();
  setInterval(refreshState, 1500);
})();
