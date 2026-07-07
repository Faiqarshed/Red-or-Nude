type LogoProps = {
  className?: string;
  outline?: boolean; // hollow/outlined variant (used over the hero image)
};

// Compact stacked "RED OR / NUDE" wordmark.
export default function Logo({ className = "", outline = false }: LogoProps) {
  return (
    <div
      dir="ltr"
      className={`font-latin font-extrabold leading-[0.92] tracking-tight ${
        outline ? "text-transparent [-webkit-text-stroke:1.5px_#fff]" : "text-red"
      } ${className}`}
    >
      <div className="flex items-center gap-1">
        <span>RED</span>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red" />
        <span>OR</span>
      </div>
      <div>NUDE</div>
    </div>
  );
}
