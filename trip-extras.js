// trip-extras.js — MERGED INTO trip.js IN v190. Intentionally empty.
//
// This file used to run after trip.js and reassign window.saveStop,
// window.openEditStopModal and window._planCallAI. That meant a function could
// have two definitions, with only the later one running: a fix applied to
// saveStop in trip.js could be silently undone here, and the _planCallAI and
// PLAN_CHAT_SYSTEM in trip.js were dead code that looked live.
//
// It is kept as an empty file, not deleted, so any browser still holding a
// cached copy of an older trip.html does not 404 on the script tag.
