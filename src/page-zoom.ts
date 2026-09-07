/**
 * A way back from browser zoom on phones.
 *
 * The page is laid out at a fixed 1280 px (see the viewport meta tag) and a
 * phone shows it scaled to fit. A double-tap on a control or a focused text
 * field can make the browser zoom the PAGE in, which pushes the toolbar off
 * the screen - and it cannot be pinched back, because the canvas keeps every
 * pinch for the game's own zoom. So:
 *
 *  - double-tap zoom is disabled on the UI (`touch-action: manipulation` in
 *    the stylesheet; the canvas keeps `none` for its own gestures), and
 *  - whenever the browser is zoomed in, the canvas hands its touch gestures
 *    back to the browser, so a double-tap or a pinch on the canvas fits the
 *    page again the way it does on the controls. The game's own pan and
 *    pinch on the canvas return as soon as the page fits.
 *  - a "reset zoom" button also floats inside the visible part of the page
 *    (tracked through the visualViewport API, since a fixed-position element
 *    is fixed to the layout viewport and can be off screen just like the
 *    toolbar). Pressing it rewrites the viewport meta tag to the fit-to-width
 *    scale for a moment, which Chrome honours as a new initial scale (Firefox
 *    for Android does not - there the double-tap is the way back), then
 *    restores the tag so pinch zoom on the page stays available.
 *
 * On a desktop browser the visual viewport is never narrower than the layout
 * viewport, so none of this engages.
 */

const LAYOUT_WIDTH = 1280;

export function installPageZoomReset(): void {
  const vv = window.visualViewport;
  const button = document.getElementById('page-zoom-reset');
  const canvas = document.getElementById('plant-canvas');
  const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
  if (!vv || !button || !canvas || !meta) return;

  const originalContent = meta.content;

  const isZoomedIn = (): boolean => {
    // The layout viewport is the full page width; the visual viewport is the
    // part of it on screen. Narrower by more than rounding = zoomed in.
    const layoutWidth = document.documentElement.clientWidth || LAYOUT_WIDTH;
    return vv.width < layoutWidth - 2;
  };

  const place = (): void => {
    const zoomed = isZoomedIn();
    // Zoomed in: the browser gets the canvas gestures (double-tap and pinch
    // fit the page again); otherwise the game keeps them (style.css: none)
    canvas.style.touchAction = zoomed ? 'auto' : '';
    if (!zoomed) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    // Page coordinates of the visible area's top-right corner, inset a little
    const margin = 10;
    const w = button.offsetWidth || 120;
    button.style.left = `${Math.round(vv.pageLeft + vv.width - w - margin)}px`;
    button.style.top = `${Math.round(vv.pageTop + margin)}px`;
  };

  const reset = (): void => {
    // The scale at which the whole 1280 px layout fits the screen: the
    // screen's width in CSS pixels (visual width times current scale) over
    // the layout width
    const screenCssWidth = vv.width * vv.scale;
    const fit = screenCssWidth / (document.documentElement.clientWidth || LAYOUT_WIDTH);
    const s = fit.toFixed(4);
    meta.content = `${originalContent}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}`;
    window.scrollTo(0, 0);
    // Give the engine a frame to apply the new scale, then hand zoom back
    setTimeout(() => {
      meta.content = originalContent;
      place();
    }, 250);
  };

  button.addEventListener('click', (e) => {
    e.preventDefault();
    reset();
  });
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
  window.addEventListener('orientationchange', () => setTimeout(place, 300));
  place();
}
