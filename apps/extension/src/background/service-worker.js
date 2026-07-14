const DEFAULTS = {
  enabled: true,
  runnerActive: false,
  skipVideo: true,
  playbackRate: 16,
  autoOpenQuiz: false,
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => current[key] === undefined),
  );
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});
