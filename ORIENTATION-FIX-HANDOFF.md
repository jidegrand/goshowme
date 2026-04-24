# Orientation Fix — Resolved

## Outcome

Confirmed with AUTO ROTATE toggled off in the tech dashboard: video stays
upright through portrait / landscape / upside-down phone rotation. That's
outcome **#1** from the earlier test plan — iOS Safari's CVO (camera
rotation metadata) is fully handling orientation on the WebRTC track.
The tech side does not need to rotate anything.

## What shipped

- Commit `b8b6c7b` "Fix iOS gyro permission timing and orientation stability"
  on `main`. Contains the user.html changes:
  - `DeviceOrientationEvent.requestPermission()` moved ahead of
    `getUserMedia()` so the iOS 13+ prompt runs inside the original
    "Allow camera access" user gesture.
  - `inferSensorOrientation()` rewritten to always return a quadrant so
    the reported angle actually resets back to portrait.
  - 10 Hz throttle and diagnostic logging on the gyro stream.
  - Invalid `{passive:true}` listener option removed.

This fix is harmless when AUTO ROTATE is off — the tech side just ignores
the orientation messages. It's a safety net for any browser down the
road that doesn't apply CVO (older Android WebViews, etc.).

## The one thing to know

Leave **AUTO ROTATE off** in the tech dashboard on any modern browser.
Turning it on double-rotates the CVO-corrected frame and gives you the
"upside-down / inverted" artifact you saw earlier.

localStorage on the tech side remembers the last setting, so once off,
it stays off.

## Optional follow-ups (not urgent)

The AUTO ROTATE toggle is a trap — it only helps on the rare browser
that doesn't apply CVO, and actively breaks the common case. One of:

1. **Light touch** — relabel the button to "Manual rotate (legacy only)"
   and add a tooltip explaining when to use it.
2. **Cleaner** — remove the toggle and its CSS/JS machinery entirely.
   The orientation relay in `server.js` and the gyro path in `user.html`
   can stay as dormant infrastructure, cost is zero.

## Working-tree state

- `public/user.html` — clean, committed in `b8b6c7b`.
- `public/tech.html` — has a CRLF-only diff vs HEAD. `git diff -w`
  reports zero non-whitespace changes. Safe to discard with
  `git checkout -- public/tech.html` whenever you want.

Nothing outstanding. This thread can close.
