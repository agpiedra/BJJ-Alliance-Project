import Image from "next/image";
import { useTranslations } from "next-intl";
import { cn } from "cn";

export interface LogoMarkProps {
  /** Width/height of the plaque in pixels. Defaults to a nav-bar-friendly size. */
  size?: number;
  className?: string;
}

/**
 * The Alliance Jiu-Jitsu lockup, rendered inside a light plaque.
 *
 * `public/branding/logo.png` has an opaque WHITE background (not
 * transparent — confirmed via sharp alpha-channel inspection: min/max alpha
 * both 255 across the whole image), so this component always wraps it in an
 * explicitly light (`bg-white`) backdrop rather than a theme token — the
 * plaque must stay light even if `.dark` is ever activated, since the
 * logo's own background can't be made to blend into a dark surface.
 */
export function LogoMark({ size = 40, className }: LogoMarkProps) {
  const t = useTranslations("app");

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1 shadow-sm",
        className
      )}
      style={{ width: size, height: size }}
    >
      <span className="relative h-full w-full">
        <Image
          src="/branding/logo.png"
          alt={t("title")}
          fill
          sizes={`${size}px`}
          className="object-contain"
        />
      </span>
    </span>
  );
}
