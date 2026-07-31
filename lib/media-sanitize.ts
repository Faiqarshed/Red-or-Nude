import "server-only";
import sanitizeHtml from "sanitize-html";

// Elements/attributes a normal vector export (Figma, Illustrator, etc.) needs.
// Anything not on these lists — <script>, <foreignObject>, event handlers,
// javascript:/data: URIs — is dropped rather than escaped.
const ALLOWED_TAGS = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "defs", "clipPath", "mask", "linearGradient",
  "radialGradient", "stop", "use", "symbol", "title", "desc", "marker", "pattern",
  "filter", "feGaussianBlur", "feOffset", "feColorMatrix", "feBlend", "feComposite",
  "feMerge", "feMergeNode", "feFlood", "feTile", "feMorphology",
  "feComponentTransfer", "feFuncR", "feFuncG", "feFuncB", "feFuncA", "feDropShadow",
];

const ALLOWED_ATTRS = [
  "id", "class", "transform", "style", "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "opacity", "clip-path", "clip-rule",
  "mask", "filter", "color", "display", "viewBox", "width", "height",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "patternUnits", "patternTransform", "preserveAspectRatio", "font-family",
  "font-size", "font-weight", "text-anchor", "dominant-baseline", "xmlns",
  "xmlns:xlink", "xlink:href", "href", "in", "in2", "result", "values", "type",
  "dx", "dy", "stdDeviation", "edgeMode",
];

/** Strips script tags, event handler attributes, and other executable content
 * from an uploaded SVG before it's written to storage and served same-origin. */
export function sanitizeSvg(svg: string): string {
  return sanitizeHtml(svg, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { "*": ALLOWED_ATTRS },
    // Default schemes (http/https/ftp/mailto) already exclude javascript:/data: —
    // relative and fragment refs (e.g. xlink:href="#gradient1") have no scheme
    // and are unaffected.
    parser: { xmlMode: true },
    disallowedTagsMode: "discard",
  });
}
