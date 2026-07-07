import type { SVGProps } from "react";

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} {...base} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function HeartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} {...base} {...props}>
      <path d="M12 20s-7-4.35-9.2-8.5C1.3 8.4 2.6 5 5.8 5 8 5 9.4 6.6 12 9.2 14.6 6.6 16 5 18.2 5c3.2 0 4.5 3.4 3 6.5C19 15.65 12 20 12 20Z" />
    </svg>
  );
}

export function CartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} {...base} {...props}>
      <path d="M3 4h2l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.2L21 8H6" />
      <circle cx="9.5" cy="20" r="1.3" />
      <circle cx="18" cy="20" r="1.3" />
    </svg>
  );
}

// Saudi Riyal symbol (simplified glyph).
export function Riyal(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" {...props}>
      <path d="M6 4.2c0-.5.4-.9.9-.9s.9.4.9.9v9.1l3.4-.7V5.1c0-.5.4-.9.9-.9s.9.4.9.9v7.1l2.3-.5c.5-.1 1 .2 1.1.7.1.5-.2 1-.7 1.1l-2.7.6v1.6l3.2-.7c.5-.1 1 .2 1.1.7.1.5-.2 1-.7 1.1L6 19.4v-1.9l5.2-1.1v-1.6L6 15.9V4.2Z" />
    </svg>
  );
}

export function PinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} {...base} {...props}>
      <path d="M12 22s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
      <circle cx="12" cy="11" r="2.4" />
    </svg>
  );
}

export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function InstagramIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...base} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TiktokIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...base} {...props}>
      <path d="M14 4c.4 2.6 2 4.2 4.5 4.4v3c-1.7 0-3.2-.5-4.5-1.4v5.6a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1v3.1a2.6 2.6 0 1 0 1.8 2.5V4H14Z" />
    </svg>
  );
}

export function FacebookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...base} {...props}>
      <path d="M14.5 8.5h-2a1 1 0 0 0-1 1V12h3l-.5 3h-2.5v6" />
      <path d="M8.5 12h3" />
      <path d="M11.5 21v-9" />
      <path d="M14.5 8.5V6.8c0-.8.5-1.3 1.3-1.3H17" />
    </svg>
  );
}

export function LinkedInIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} {...base} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8 10.5V16M8 7.6v.01M11.5 16v-3.2a1.8 1.8 0 0 1 3.6 0V16M11.5 16v-5.5" />
    </svg>
  );
}
