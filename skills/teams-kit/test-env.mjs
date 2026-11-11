// Tests run kit tools with the host environment minus the Being's own settings: on a Being's box the live
// BEING_*/OWNER_* values would otherwise win over a fixture's and reach the live state (as onboarding did on 3 Nov).
// INVOCATION_ID (run from a unit) would put test jobs in real scopes; TMUX would let tmux reach a live server.
export const HOST_ONLY = /^(BEING_|OWNER_|M365_|HOOK_)|^(INVOCATION_ID|TMUX|TMUX_PANE)$/;
export const hostEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_ONLY.test(k)));
