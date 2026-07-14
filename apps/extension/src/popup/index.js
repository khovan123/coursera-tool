const DEFAULTS = {
  enabled: true,
  runnerActive: false,
  skipVideo: true,
  playbackRate: 16,
  autoOpenQuiz: false,
};

const ids = ["enabled", "skipVideo", "playbackRate", "autoOpenQuiz"];
const controls = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const status = document.getElementById("status");
const runner = document.getElementById("runner");

load();

async function load() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  for (const id of ids) {
    const value = settings[id];
    const control = controls[id];
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = value;
    control.addEventListener("change", save);
  }
  updateRunnerButton(Boolean(settings.runnerActive));
  await refreshStatus();
}

runner.addEventListener("click", async () => {
  runner.disabled = true;
  try {
    const tab = await activeTab();
    const { runnerActive = false } = await chrome.storage.local.get("runnerActive");
    const response = await sendToTab(tab, {
      type: "COURSE_TOOL_SET_RUNNER",
      active: !runnerActive,
    });
    if (!response?.ok) throw new Error(response?.error || "The page did not accept the request.");
    updateRunnerButton(response.active);
    await refreshStatus();
  } catch (error) {
    status.dataset.level = "error";
    status.textContent = error.message;
  } finally {
    runner.disabled = false;
  }
});

async function save(event) {
  const control = event.currentTarget;
  const value = control.type === "checkbox" ? control.checked : control.type === "number" ? Number(control.value) : control.value.trim();
  await chrome.storage.local.set({ [control.id]: value });
  status.textContent = "Settings saved";
}

async function refreshStatus() {
  try {
    const tab = await activeTab();
    if (!isCourseraUrl(tab.url)) {
      status.textContent = "Open a Coursera course page";
      runner.disabled = true;
      return;
    }
    const response = await sendToTab(tab, { type: "COURSE_TOOL_STATUS" });
    status.textContent = response?.status || "Ready";
    status.dataset.level = "info";
    updateRunnerButton(Boolean(response?.runnerActive));
  } catch {
    status.textContent = "Reload the Coursera tab after installing the extension";
  }
}

function updateRunnerButton(active) {
  runner.dataset.active = String(active);
  runner.textContent = active ? "Pause course runner" : "Start course runner";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab found.");
  return tab;
}

async function sendToTab(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    const missingReceiver = /receiving end does not exist|could not establish connection/i.test(error.message);
    if (!missingReceiver || !isCourseraUrl(tab.url)) throw error;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/coursera.js"],
      });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (injectionError) {
      throw new Error(`Cannot initialize Coursera Tool in this tab: ${injectionError.message}`);
    }
  }
}

function isCourseraUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "coursera.org" || hostname.endsWith(".coursera.org");
  } catch {
    return false;
  }
}
