# Green Room site responsive / FF2K evidence

Captured from the unmodified `origin/main` baseline and the fixed local worktree with headless Google Chrome against `python3 -m http.server 4173 --bind 127.0.0.1 --directory site`.

## Before

- `before-home-1280x768.png` — baseline home `Inspired, independent.` split at 1280 × 768.
- `before-docs-1280x768.png` — baseline docs `Information here. Rooms there.` split at 1280 × 768.

The exact pixel collision reported on the live deployment did not reproduce in this machine's Chrome/system-font rendering, but both captures show the shared risk: the left display type is sized from the viewport (`7vw`) rather than its narrow grid track and nearly consumes the full column. The fix addresses that shared primitive rather than route-specific spacing.

## After

- `after-home-1280x768.png` — home split after container-aware type sizing.
- `after-docs-1280x768.png` — docs split after container-aware type sizing.
- `after-characters-1280x768.png` — FF2K visible as card 19 with the creator-authorized pseudonymous-original candidate label.
- `after-responsive-report.json` — compact machine-readable summary.

The rendered regression pass covered all 24 static routes at widths 320, 375, 390, 896, 897, 1024, 1280, and 1440 (192 route/viewport checks). It found zero non-200 responses, horizontal overflows, broken images, split-column/heading collisions, console errors, or third-party network requests.
