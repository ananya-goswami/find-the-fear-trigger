# Activity_1 — Find the Fear Triggers

Plain HTML/CSS/JS. No build step. Deployed at https://find-the-fear-trigger.vercel.app/
(remote `find-the-fear-trigger`; two other remotes exist and are NOT the live site).

## Run it

```bash
node dev-server.cjs        # serves http://127.0.0.1:4173
```

To reach the phone screens: click "Tap to Open" → click `.intro-notif-hit`
(the notification) → click `.inbox-row` / `#inboxOpenBtn`. The footer button does
not exist in the DOM on the first screen; `#footerActions` is empty until you tap
the notification, so `waitForSelector('#footerActions .btn')` times out there.

## phone.webp geometry — READ THIS BEFORE TOUCHING PHONE LAYOUT

`assets/images/phone.webp` is a **3270x1924 landscape canvas** with the phone drawn
small in the middle. Pixel-measured visible bounds:

| | fraction of image |
|---|---|
| left edge | 33.0% |
| right edge | 62.7% |
| top edge | 16.0% |
| bottom edge | 86.3% |

So **~14% of the element's height below the phone is transparent**, and ~70% of its
width is transparent on the sides.

Consequences:
- `img.getBoundingClientRect()` is NOT the visible phone. Visible bottom is
  `box.y + 0.863 * box.height`. Measuring the box instead of this produces
  phantom "gaps" and phantom "overlaps".
- Sizing the element to "fit" the available space leaves a big empty band under
  the phone. Divide by ~0.703 to make the *visible* phone fill a target height.
- The transparent sides are allowed to overflow; `.right-panel` has
  `overflow: hidden` and the footer button is above via `z-index: 6`.

## Coupled CSS values (keep in sync!)

In `game.css`, these two must always carry the **same** size expression — one sizes
the phone, the other scales the text inside its screen. They drifted apart
repeatedly and every time it looked like a new overlap bug:

- `body:has(.classify-grid-empty) .intro-phone-image` → `height`
- `body:has(.classify-grid-empty) .phone-inbox, ... .phone-sms` → `font-size`

Current: `min(118vw, 90vh - 18px)`. Lower the `18px` / raise the `90vh` to grow the
phone. `90vh` is near the limit — the binding cases are 1340x800 and 1902x877,
which sit at ~15px clearance.

## Known-fixed bugs (don't regress)

- **BUG_FFT_06** — extra vertical gap in Avi's speech bubble. Cause:
  `.tej-speech strong { display: block; margin-top: 4px }`. Fixed by
  `margin-top: 0`. The `display: block` is intentional (line break).
- **BUG_FFT_07** — Back/Check button overlapping the phone. Cause was originally
  `transform: scale(1.35)` on `.intro-phone-frame`: `scale()` grows the painted
  image past its layout box, so no button position could avoid it. Do **not**
  re-add a `scale()` here — size via width/height only.

## Verifying a phone/button layout change

Measure the *visible* phone against the button, at several window sizes, e.g.:

```js
const box = await page.locator('.intro-phone-image').first().boundingBox();
const visibleBottom = box.y + 0.8628 * box.height;
const btn = await page.locator('#footerActions .btn').first().boundingBox();
const gap = btn.y - visibleBottom;   // must be > 0
```

Check at least: 1902x877, 1340x800, 1105x706, 1536x1152, 1024x768.

Note: injecting an override with `addStyleTag` does **not** reliably win against
these `:has()` rules — mutate the live `CSSStyleRule.style` instead, or the sweep
silently measures the unchanged value and reports false confidence.
