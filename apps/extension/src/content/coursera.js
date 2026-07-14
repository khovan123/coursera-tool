const DEFAULTS = {
  enabled: true,
  runnerActive: false,
  skipVideo: true,
  playbackRate: 16,
  autoOpenQuiz: false,
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
  actionTimer: null,
  actionKind: null,
  lastActionAt: 0,
  lastAdvanceUrl: "",
  advanceAttempts: 0,
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
  resetAdvanceAttemptsAfterNavigation();

  const mediaElements = [...document.querySelectorAll("video, audio")];
  if (mediaElements.length) {
    if (state.actionKind !== "media-finished") clearRunnerTimer();
    mediaElements.forEach(prepareMedia);
    return;
  }

  if (LOCKED_BROWSER_PATH.test(location.pathname)) {
    pauseRunnerForManualAssessment("Locked-browser assessment detected; complete it manually.");
    return;
  }

  if (ASSESSMENT_PATH.test(location.pathname)) {
    if (isProctoredAssessment()) {
      pauseRunnerForManualAssessment("Proctored assessment detected; complete it manually.");
      return;
    }
    handleAssessmentItem("Assessment opened; complete it manually.");
    return;
  }

  if (isExternalActivityPage()) {
    queueRunnerAction(completeExternalActivity, 800, "External activity detected", "external-activity");
    return;
  }

  if (hasAssessmentControls()) {
    handleAssessmentItem("Assessment detected; complete it manually.");
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
  if (!candidate) return openNextCourseItem();

  const current = currentCourseUrl();
  if (candidate instanceof HTMLAnchorElement && normalizeCourseUrl(candidate.href) === current) {
    return openNextCourseItem();
  }

  if (state.lastAdvanceUrl !== location.href) {
    state.lastAdvanceUrl = location.href;
    state.advanceAttempts = 0;
  }

  if (state.advanceAttempts >= 3) {
    stopCourseRunner("Course runner stopped because the next item did not open.");
    return false;
  }

  if (!clickRunnerTarget(candidate)) return false;

  state.advanceAttempts += 1;
  setStatus("Advanced to the next course item");
  return true;
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
  const nextLink = findNextCourseItemLink();

  if (clickRunnerTarget(nextLink)) {
    setStatus("Opened the next incomplete course item");
    return true;
  }

  const moduleToggle = findNextModuleToggle();
  if (clickRunnerTarget(moduleToggle)) {
    setStatus("Opened the next course module");
    queueRunnerAction(openNextCourseItem, 700);
    return true;
  }

  stopCourseRunner("Course runner stopped: no next course item was found.");
  return false;
}

function findNextCourseItemLink() {
  const current = currentCourseUrl();
  const links = uniqueCourseLinks([...document.querySelectorAll('a[href*="/learn/"]')]);
  const currentIndex = links.findIndex((link) => normalizeCourseUrl(link.href) === current);
  const candidates = currentIndex >= 0 ? links.slice(currentIndex + 1) : links;

  return candidates.find((link) => {
    const url = new URL(link.href, location.href);
    return isActionable(link)
      && isRunnableCourseItemPath(url.pathname)
      && !isCompletedItem(link);
  });
}

function findNextModuleToggle() {
  const toggles = [...document.querySelectorAll('button[aria-expanded="false"]')]
    .filter(isCourseModuleToggle);
  const currentLink = findCurrentCourseLink();
  if (!currentLink) return toggles[0];

  return toggles.find((toggle) => (
    currentLink.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
  ));
}

function findCurrentCourseLink() {
  const current = currentCourseUrl();
  return [...document.querySelectorAll('a[href*="/learn/"]')]
    .find((link) => normalizeCourseUrl(link.href) === current);
}

function isCourseModuleToggle(button) {
  const text = normalizeText(button.innerText || button.getAttribute("aria-label") || "");
  return isActionable(button) && /(module|week|tuần|lesson|bài)/i.test(text);
}

function uniqueCourseLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    const href = normalizeCourseUrl(link.href);
    if (seen.has(href)) return false;
    seen.add(href);
    return true;
  });
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
  state.lastAdvanceUrl = "";
  state.advanceAttempts = 0;
  setStatus("Course runner started");
  scanPage();
}

function pauseRunnerForManualAssessment(message) {
  stopCourseRunner(message);
}

function handleAssessmentItem(manualMessage) {
  if (state.settings.autoOpenQuiz) {
    pauseRunnerForManualAssessment(manualMessage);
    return;
  }
  queueRunnerAction(openNextCourseItem, 900, "Skipping assessment; looking for the next lesson");
}

function stopCourseRunner(message) {
  state.settings.runnerActive = false;
  clearRunnerTimer();
  chrome.storage.local.set({ runnerActive: false }).catch(() => {});
  setStatus(message);
}

function resetAdvanceAttemptsAfterNavigation() {
  if (!state.lastAdvanceUrl || state.lastAdvanceUrl === location.href) return;
  state.lastAdvanceUrl = location.href;
  state.advanceAttempts = 0;
}

function currentCourseUrl() {
  return normalizeCourseUrl(location.href);
}

function normalizeCourseUrl(value) {
  const url = new URL(value, location.href);
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
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

function isRunnableCourseItemPath(pathname) {
  if (LEARNING_ITEM_PATH.test(pathname) || EXTERNAL_ACTIVITY_PATH.test(pathname)) return true;
  return state.settings.autoOpenQuiz && ASSESSMENT_PATH.test(pathname) && !LOCKED_BROWSER_PATH.test(pathname);
}

function hasAssessmentControls() {
  const selectors = [
    '[data-testid*="question-container"]',
    '[data-testid*="quiz-question"]',
    '.rc-FormPartsQuestion',
    'fieldset',
  ];
  for (const selector of selectors) {
    const roots = [...document.querySelectorAll(selector)].filter((root) => root.querySelector("input, textarea, [contenteditable=true]"));
    if (roots.length) return true;
  }
  return false;
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
