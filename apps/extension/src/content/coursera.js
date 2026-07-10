const DEFAULTS = {
  enabled: true,
  runnerActive: false,
  skipVideo: true,
  playbackRate: 16,
  autoSubmit: false,
};

const ASSESSMENT_PATH = /\/(quiz|exam|assignment(?:-submission)?|peer|programming|assessment)(\/|$)/i;
const LOCKED_BROWSER_PATH = /\/locked-browser-start(\/|$)/i;
const LEARNING_ITEM_PATH = /\/(lecture|supplement|ungradedWidget|discussionPrompt)(\/|$)/i;
const EXTERNAL_ACTIVITY_PATH = /\/(ungradedLti|gradedLti|external-tool|externalTool|lab|workspace)(\/|$)/i;

const state = {
  settings: { ...DEFAULTS },
  processedMedia: new WeakSet(),
  skippedMedia: new WeakSet(),
  advancedMedia: new WeakSet(),
  assessmentKey: "",
  actionTimer: null,
  actionKind: null,
  lastActionAt: 0,
  externalActivityUrl: "",
  externalActivityRetries: 0,
  busy: false,
  status: "Ready",
};

if (!globalThis.__COURSE_TOOL_INITIALIZED__) {
  globalThis.__COURSE_TOOL_INITIALIZED__ = true;
  init().catch((error) => setStatus(error.message, "error"));
}

async function init() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, change] of Object.entries(changes)) state.settings[key] = change.newValue;
    scanPage();
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "COURSE_TOOL_STATUS") {
      sendResponse({
        status: state.status,
        busy: state.busy,
        runnerActive: state.settings.runnerActive,
        url: location.href,
      });
      return false;
    }
    if (message?.type === "COURSE_TOOL_SET_RUNNER") {
      setRunnerActive(Boolean(message.active))
        .then(() => sendResponse({ ok: true, active: state.settings.runnerActive }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "COURSE_TOOL_ANSWER") {
      runAssessment(true).then(() => sendResponse({ ok: true })).catch((error) => {
        setStatus(error.message, "error");
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }
    return false;
  });

  new MutationObserver(debounce(scanPage, 350)).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("popstate", () => setTimeout(scanPage, 250));
  state.settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  scanPage();
}

function scanPage() {
  if (!state.settings.enabled || !state.settings.runnerActive || state.busy) return;

  const mediaElements = [...document.querySelectorAll("video, audio")];
  if (mediaElements.length) {
    if (state.actionKind !== "media-finished") clearRunnerTimer();
    mediaElements.forEach(prepareMedia);
    return;
  }

  if (ASSESSMENT_PATH.test(location.pathname)) {
    queueRunnerAction(clickNextItem, 1200, "Skipping assessment item");
    return;
  }

  if (isExternalActivityPage()) {
    queueRunnerAction(completeExternalActivity, 800, "External activity detected", "external-activity");
    return;
  }

  if (collectQuestions().length) {
    queueRunnerAction(clickNextItem, 1200, "Skipping assessment item");
    return;
  }

  if (isReadingPage()) {
    queueRunnerAction(completeReadingAndAdvance, 800, "Reading detected; looking for Mark as completed", "reading");
    return;
  }

  if (LEARNING_ITEM_PATH.test(location.pathname)) {
    const delay = /\/lecture\//i.test(location.pathname) ? 5000 : 2200;
    queueRunnerAction(clickNextItem, delay, "Completing non-media item");
    return;
  }

  queueRunnerAction(openNextCourseItem, 700, "Looking for the next lesson");
}

function isExternalActivityPage() {
  return EXTERNAL_ACTIVITY_PATH.test(location.pathname) || Boolean(findLaunchTarget(false));
}

function completeExternalActivity() {
  const pageUrl = `${location.origin}${location.pathname}`;
  if (state.externalActivityUrl !== pageUrl) {
    state.externalActivityUrl = pageUrl;
    state.externalActivityRetries = 0;
  }

  const launchTarget = findLaunchTarget(false);
  const scope = getActivityScope(launchTarget);
  const unchecked = [...scope.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
    .filter(isUncheckedActivityCheckbox);

  for (const checkbox of unchecked) checkbox.click();
  const delay = unchecked.length ? 600 : 100;
  queueRunnerAction(
    launchExternalActivity,
    delay,
    unchecked.length ? `Checked ${unchecked.length} required option${unchecked.length === 1 ? "" : "s"}` : "Looking for Launch App",
    "external-launch",
  );
}

function isUncheckedActivityCheckbox(checkbox) {
  const checked = checkbox instanceof HTMLInputElement
    ? checkbox.checked
    : checkbox.getAttribute("aria-checked") === "true";
  const disabled = checkbox instanceof HTMLInputElement
    ? checkbox.disabled
    : checkbox.getAttribute("aria-disabled") === "true";
  return !checked
    && !disabled
    && !checkbox.closest('nav, aside, header, footer, [data-testid*="question" i]');
}

function launchExternalActivity() {
  const launchTarget = findLaunchTarget(true);
  if (!launchTarget) {
    state.externalActivityRetries += 1;
    if (state.externalActivityRetries <= 6) {
      queueRunnerAction(launchExternalActivity, 500, "Waiting for Launch App to become available", "external-launch");
      return;
    }
    setStatus("External activity detected, but no enabled Launch App or external link was found.", "error");
    return;
  }

  if (launchTarget instanceof HTMLAnchorElement) {
    const targetUrl = new URL(launchTarget.href, location.href);
    if (targetUrl.origin !== location.origin) {
      launchTarget.target = "_blank";
      launchTarget.rel = "noopener noreferrer";
    }
  }

  if (!clickRunnerTarget(launchTarget)) {
    queueRunnerAction(launchExternalActivity, 500, "Waiting to launch external activity", "external-launch");
    return;
  }

  state.externalActivityRetries = 0;
  const sourcePage = location.href;
  queueRunnerAction(
    () => {
      if (location.href === sourcePage) clickNextItem();
      else scanPage();
    },
    2500,
    "External activity launched; waiting before next item",
    "external-launched",
  );
}

function findLaunchTarget(actionableOnly = true) {
  const selectors = [
    '[data-testid*="launch-app" i]',
    '[data-testid*="launch_app" i]',
    '[data-track-component*="launch" i]',
    'button[aria-label*="launch app" i]',
    'a[aria-label*="launch app" i]',
  ];
  const accept = actionableOnly ? isActionable : isVisible;
  const direct = selectors.map((selector) => document.querySelector(selector)).find(accept);
  if (direct) return direct;

  const controls = [...document.querySelectorAll('main a, main button, [role="main"] a, [role="main"] button')];
  const namedTarget = controls.find((element) => {
    const text = normalizeText(element.innerText || element.getAttribute("aria-label") || "");
    return accept(element)
      && /^(launch|open|start|visit|access|go to)\s+(app|tool|lab|external)(\s|$)/i.test(text);
  });
  if (namedTarget) return namedTarget;

  return controls.find((element) => {
    if (!(element instanceof HTMLAnchorElement) || !accept(element)) return false;
    const url = new URL(element.href, location.href);
    const text = normalizeText(element.innerText || element.getAttribute("aria-label") || "");
    return url.origin !== location.origin
      && !/(privacy|terms|help|support|policy|facebook|linkedin|twitter)/i.test(`${text} ${url.href}`);
  });
}

function getActivityScope(launchTarget) {
  return launchTarget?.closest('main, [role="main"], [data-testid*="item" i]')
    || document.querySelector('main, [role="main"]')
    || document.body;
}

function isReadingPage() {
  if (/\/(supplement|ungradedWidget)\//i.test(location.pathname)) return true;
  if (findMarkCompleteButton()) return true;
  return Boolean(document.querySelector(
    '[data-testid*="reading" i], [data-track-component*="reading" i], .rc-ReadingItem',
  ));
}

function completeReadingAndAdvance() {
  const markComplete = findMarkCompleteButton();
  if (markComplete) {
    if (!clickRunnerTarget(markComplete)) {
      queueRunnerAction(completeReadingAndAdvance, 500, "Waiting to mark reading as completed", "reading");
      return;
    }
    queueRunnerAction(clickNextItem, 900, "Reading marked as completed; moving to next item", "reading-completed");
    return;
  }

  if (isReadingCompleted()) {
    queueRunnerAction(clickNextItem, 400, "Reading is already completed; moving to next item", "reading-completed");
    return;
  }

  setStatus("Reading detected, but Mark as completed button was not found.", "error");
}

function findMarkCompleteButton() {
  const selectors = [
    'button[data-testid*="mark-complete" i]',
    'button[data-testid*="mark_as_complete" i]',
    'button[data-track-component*="mark_complete" i]',
    'button[aria-label*="mark as complete" i]',
  ];
  const direct = selectors.map((selector) => document.querySelector(selector)).find(isActionable);
  if (direct) return direct;

  return [...document.querySelectorAll('button, [role="button"]')].find((button) => {
    const text = normalizeText(button.innerText || button.getAttribute("aria-label") || "");
    return isActionable(button)
      && /^(mark as complete|mark as completed|complete item|đánh dấu.*hoàn thành)$/i.test(text);
  });
}

function isReadingCompleted() {
  const statusElement = document.querySelector(
    '[data-testid*="completed" i], [aria-label*="marked as complete" i], [aria-label="completed" i]',
  );
  if (statusElement) return true;

  return [...document.querySelectorAll('button, [role="status"]')].some((element) => {
    const text = normalizeText(element.innerText || element.getAttribute("aria-label") || "");
    return /^(completed|marked as complete|marked as completed|đã hoàn thành)$/i.test(text);
  });
}

function prepareMedia(media) {
  const rate = clamp(Number(state.settings.playbackRate) || 16, 0.25, 16);
  const mediaType = media.tagName.toLowerCase();
  media.playbackRate = rate;
  media.defaultPlaybackRate = rate;
  if (!state.processedMedia.has(media)) {
    state.processedMedia.add(media);
    media.addEventListener("ratechange", () => {
      const desired = clamp(Number(state.settings.playbackRate) || 16, 0.25, 16);
      if (state.settings.runnerActive && media.playbackRate !== desired) media.playbackRate = desired;
    });
    media.addEventListener("loadedmetadata", () => skipMediaToEnd(media));
    media.addEventListener("durationchange", () => skipMediaToEnd(media));
    media.addEventListener("timeupdate", () => {
      if (Number.isFinite(media.duration) && media.duration - media.currentTime <= 0.5) {
        finishMedia(media);
      }
    });
    media.addEventListener("ended", () => finishMedia(media));
  }
  if (state.settings.skipVideo) skipMediaToEnd(media);
  if (media.paused && !media.ended && media.readyState >= 2) {
    media.play().catch(() => setStatus(`${capitalize(mediaType)} is ready; click once on the page to allow playback.`));
  }
  setStatus(state.settings.skipVideo ? `Skipping current ${mediaType}` : `Playing ${mediaType} at ${rate}x`);
}

function clickNextItem() {
  const selectors = [
    'button[data-testid*="next-item"]',
    'a[data-testid*="next-item"]',
    'button[aria-label*="Next item" i]',
    'a[aria-label*="Next item" i]',
    'button[aria-label*="Go to next item" i]',
    'a[aria-label*="Go to next item" i]',
    'button[aria-label*="Next lesson" i]',
    'a[aria-label*="Next lesson" i]',
    'a[rel="next"]',
  ];
  const direct = selectors.map((selector) => document.querySelector(selector)).find(isActionable);
  const fallback = [...document.querySelectorAll("a, button")].find((element) => {
    const text = normalizeText(element.innerText || element.getAttribute("aria-label") || "");
    return isActionable(element)
      && /^(go to next item|next|continue|tiếp theo|kế tiếp)(\s|$)/i.test(text)
      && !element.closest('form, [data-testid*="question"]');
  });
  const candidate = direct || fallback;
  if (clickRunnerTarget(candidate)) {
    setStatus("Advanced to the next course item");
    return true;
  }
  return openNextCourseItem();
}

function skipMediaToEnd(media) {
  if (!state.settings.runnerActive || !state.settings.skipVideo || state.skippedMedia.has(media)) return;
  if (!Number.isFinite(media.duration) || media.duration <= 1) return;

  state.skippedMedia.add(media);
  media.currentTime = Math.max(0, media.duration - 0.35);
  media.play().catch(() => setStatus("Click once on the page to allow media playback."));
}

function finishMedia(media) {
  if (state.advancedMedia.has(media)) return;
  state.advancedMedia.add(media);
  const mediaType = media.tagName.toLowerCase();
  queueRunnerAction(clickNextItem, 600, `${capitalize(mediaType)} completed; moving to next item`, "media-finished");
}

function openNextCourseItem() {
  const current = `${location.origin}${location.pathname}`.replace(/\/$/, "");
  const links = [...document.querySelectorAll('a[href*="/learn/"]')].filter((link) => {
    const url = new URL(link.href);
    const href = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    return isActionable(link)
      && href !== current
      && LEARNING_ITEM_PATH.test(url.pathname)
      && !ASSESSMENT_PATH.test(url.pathname)
      && !isCompletedItem(link);
  });

  if (clickRunnerTarget(links[0])) {
    setStatus("Opened the next incomplete lesson");
    return true;
  }

  const moduleToggle = [...document.querySelectorAll('button[aria-expanded="false"]')].find((button) => {
    const text = normalizeText(button.innerText || button.getAttribute("aria-label") || "");
    return isActionable(button) && /(module|week|tuần|lesson|bài)/i.test(text);
  });
  if (clickRunnerTarget(moduleToggle)) {
    setStatus("Opened the next course module");
    queueRunnerAction(openNextCourseItem, 700);
    return true;
  }

  setStatus("No incomplete lesson or Next button was found.");
  return false;
}

function isCompletedItem(link) {
  const container = link.closest('li, [data-testid*="item"], [class*="item"]') || link;
  const label = normalizeText(`${container.getAttribute("aria-label") || ""} ${container.innerText || ""}`);
  return /\b(completed|complete|đã hoàn thành)\b/i.test(label)
    || Boolean(container.querySelector('[data-testid*="complete"], [aria-label*="complete" i]'));
}

function clickRunnerTarget(element) {
  if (!isActionable(element) || Date.now() - state.lastActionAt < 900) return false;
  state.lastActionAt = Date.now();
  element.click();
  return true;
}

function queueRunnerAction(action, delay, pendingStatus, kind = "navigation") {
  if (state.actionTimer) return;
  if (pendingStatus) setStatus(pendingStatus);
  state.actionKind = kind;
  state.actionTimer = setTimeout(() => {
    state.actionTimer = null;
    state.actionKind = null;
    if (state.settings.enabled && state.settings.runnerActive && !state.busy) action();
  }, delay);
}

function clearRunnerTimer() {
  clearTimeout(state.actionTimer);
  state.actionTimer = null;
  state.actionKind = null;
}

async function setRunnerActive(active) {
  state.settings.runnerActive = active;
  await chrome.storage.local.set({ runnerActive: active });
  if (!active) {
    clearRunnerTimer();
    setStatus("Course runner paused");
    return;
  }
  setStatus("Course runner started");
  scanPage();
}

async function runAssessment(force) {
  if (state.busy || !state.settings.enabled) return;
  if (isProctoredAssessment()) {
    throw new Error("Proctored assessment detected. Use Coursera's locking browser and complete this assessment manually.");
  }
  const questions = collectQuestions();
  if (!questions.length) {
    if (force) throw new Error("No assessment questions were found on this page.");
    return;
  }
  const key = `${location.href}|${questions.map((question) => question.prompt).join("|")}`;
  if (!force && state.assessmentKey === key) return;

  await setRunnerActive(false);
  state.busy = true;
  state.assessmentKey = key;
  setStatus(`Answering ${questions.length} question${questions.length === 1 ? "" : "s"}...`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "COURSE_TOOL_ASK_AI",
      payload: { title: document.title, questions },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not obtain answers.");
    const filled = applyAnswers(response.answer?.answers || [], questions);
    if (!filled) throw new Error("Answers were returned, but no matching inputs were found.");
    setStatus(`Filled ${filled} answer${filled === 1 ? "" : "s"}`);
    if (state.settings.autoSubmit) setTimeout(clickSubmit, 500);
  } finally {
    state.busy = false;
  }
}

function isProctoredAssessment() {
  if (LOCKED_BROWSER_PATH.test(location.pathname)) return true;
  if (!/\/assignment-submission\//i.test(location.pathname)) return false;

  const pageText = normalizeText(document.body.innerText);
  return /\bproctored\b/i.test(pageText)
    || /Coursera'?s locking browser/i.test(pageText)
    || Boolean([...document.querySelectorAll("button")].find((button) => (
      /^launch manually$/i.test(normalizeText(button.innerText))
    )));
}

function collectQuestions() {
  const roots = findQuestionRoots();
  return roots.map((root, index) => {
    const controls = [...root.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea, input[type="text"], [contenteditable="true"]')];
    const choiceControls = controls.filter((control) => control.matches('input[type="radio"], input[type="checkbox"]'));
    const promptNode = root.querySelector('legend, [data-testid*="question"], [class*="question"], h2, h3');
    return {
      id: `q${index + 1}`,
      prompt: normalizeText(promptNode?.innerText || root.innerText.split("\n").slice(0, 4).join(" ")),
      type: choiceControls.length ? "choice" : "text",
      choices: choiceControls.map((control) => choiceLabel(control, root)).filter(Boolean),
      _root: root,
      _controls: controls,
    };
  }).filter((question) => question.prompt && question._controls.length);
}

function findQuestionRoots() {
  const selectors = [
    '[data-testid*="question-container"]',
    '[data-testid*="quiz-question"]',
    '.rc-FormPartsQuestion',
    'fieldset',
  ];
  for (const selector of selectors) {
    const roots = [...document.querySelectorAll(selector)].filter((root) => root.querySelector("input, textarea, [contenteditable=true]"));
    if (roots.length) return roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));
  }
  return [];
}

function applyAnswers(answers, questions) {
  let count = 0;
  for (const answer of answers) {
    const question = questions.find((item) => item.id === answer.id);
    if (!question) continue;
    if (question.type === "choice") {
      for (const wanted of answer.choices || []) {
        const control = question._controls.find((item) => item.matches('input[type="radio"], input[type="checkbox"]') && similar(choiceLabel(item, question._root), wanted));
        if (control && !control.checked) {
          control.click();
          count += 1;
        }
      }
    } else if (answer.text) {
      const control = question._controls.find((item) => item.matches('textarea, input[type="text"], [contenteditable="true"]'));
      if (control) {
        setNativeValue(control, answer.text);
        count += 1;
      }
    }
  }
  return count;
}

function clickSubmit() {
  const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
  const submit = buttons.find((button) => isActionable(button) && /^(submit|check|grade)(\s|$)/i.test(normalizeText(button.innerText || button.value)));
  if (submit) {
    submit.click();
    setStatus("Assessment submitted");
  } else {
    setStatus("Answers filled; submit button was not found.");
  }
}

function choiceLabel(control, root) {
  const label = control.id ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`) : control.closest("label");
  return normalizeText(label?.innerText || control.parentElement?.innerText || control.value);
}

function setNativeValue(control, value) {
  if (control.isContentEditable) {
    control.focus();
    control.textContent = value;
    control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return;
  }
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function setStatus(message, level = "info") {
  state.status = message;
  chrome.storage.local.set({ lastStatus: message, lastStatusLevel: level }).catch(() => {});
}

function isActionable(element) {
  return Boolean(isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
}

function isVisible(element) {
  return Boolean(element && element.getClientRects().length);
}

function normalizeText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function similar(left, right) {
  const clean = (value) => normalizeText(value).toLocaleLowerCase().replace(/^[a-z]\.|^\d+\.|\s+/g, "");
  const a = clean(left);
  const b = clean(right);
  return a === b || a.includes(b) || b.includes(a);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
