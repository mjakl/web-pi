// The cookies web-pi keeps the reader's choices in. The server reads and sets
// them, and the browser writes the session and folder ones itself once a
// navigation has won, so both sides take the names from here.

/** The working folder the picker last committed: where `/new` starts. */
export const CWD_COOKIE = "web-pi-cwd";

/**
 * The session the reader has open. pi-web keeps settings and the top-bar
 * panels over the workspace it was opened from, which a page reached by its
 * own URL cannot tell from the referrer alone.
 */
export const SESSION_COOKIE = "web-pi-session";

/** Which settings section was open last. */
export const SETTINGS_COOKIE = "web-pi-settings";

/** The skill last opened, and the folder it belongs to. */
export const SKILL_COOKIE = "web-pi-skill";

/** How long a choice is remembered, in seconds: a year. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
