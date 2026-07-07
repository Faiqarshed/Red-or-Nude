type MarqueeProps = {
  text?: string;
  className?: string;
};

// The "RED OR NUDE" strip that repeats horizontally across the page.
export default function Marquee({
  text = "RED OR NUDE",
  className = "",
}: MarqueeProps) {
  const items = Array.from({ length: 12 });
  return (
    <div
      className={`w-full overflow-hidden bg-red py-2.5 md:py-3 ${className}`}
      dir="ltr"
    >
      <div className="flex w-max animate-marquee whitespace-nowrap">
        {[0, 1].map((group) => (
          <div key={group} className="flex shrink-0" aria-hidden={group === 1}>
            {items.map((_, i) => (
              <span key={i} className="mx-5 flex items-center gap-3 md:mx-7 md:gap-4">
                <img src="/Vector.svg" alt="" aria-hidden className="h-[11px] w-auto md:h-[13px]" />
                <img
                  src="/Vector-1.svg"
                  alt={text}
                  className="h-[15px] w-auto select-none md:h-[18px]"
                />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
