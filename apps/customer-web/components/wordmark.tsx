/**
 * The storefront wordmark: "ETicketsGo" in the display face, with the marigold light as its
 * full stop (docs/design/specimen). Text, not a picture, so it is sharp at every size and
 * reads in any colour the band around it sets; `currentColor` makes it ink on paper and paper
 * on a stage without a second version.
 *
 * Local to the storefront for now. The consoles still use the `Logo` mark from web-kit; D-1's
 * system can absorb this once the owner has seen it in the header and the footer.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex items-baseline whitespace-nowrap font-brand-display text-[1.375rem] font-extrabold leading-none tracking-[-0.03em] ${className}`}
    >
      ETicketsGo
      <span className="ml-0.5 inline-block h-2 w-2 rounded-full bg-brand-marigold" />
    </span>
  );
}
