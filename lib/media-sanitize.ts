import "server-only";
import DOMPurify from "isomorphic-dompurify";

/** Strips script tags, event handler attributes, and other executable content
 * from an uploaded SVG before it's written to storage and served same-origin. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}
