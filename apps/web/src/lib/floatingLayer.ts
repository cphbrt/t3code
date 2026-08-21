/**
 * Answers whether any element matching a floating-layer selector is actually on
 * screen.
 *
 * Base UI keeps a popup mounted in its portal after it closes, so a plain
 * `document.querySelector` for a popup slot reports a layer that shut hours ago
 * — and a key handler gated on it stops working for the rest of the session.
 * A closed popup fails `checkVisibility` (its positioner carries `hidden`),
 * which is what separates "mounted" from "open".
 */
export function isFloatingLayerVisible(selector: string): boolean {
  return [...document.querySelectorAll(selector)].some((element) => element.checkVisibility());
}
