export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
// Magister fork: upstream defaults (15s launch / 8s CDP-ready) are tuned for
// desktop OpenClaw where the Chromium binary is already in OS page cache.
// On a cold Fly micro-VM, first launch measures ~8s just to bring DevTools
// online, blowing the 15s total budget. Bumped to give cold launches headroom.
// Measured: cold CDP-ready ~8s, warm ~2s; full nav ~5s after CDP is up.
export const DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS = 45_000;
export const DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS = 20_000;
export const DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES = 120;
export const DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION = 8;
export const DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES = 5;
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 40_000;
export const DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS = 8_000;
export const DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH = 6;
