import type React from "react";

function externalHref(href: string | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return href;
}

export function ExternalMarkdownLink({ children, href }: { children?: React.ReactNode; href?: string }) {
  const external = externalHref(href);
  if (!external) return <span>{children}</span>;
  return (
    <a
      href={external}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        event.preventDefault();
        void window.bgt.openExternal(external);
      }}
    >
      {children}
    </a>
  );
}

export function handleExternalMarkdownLinkClick(event: React.MouseEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("a[href]");
  const href = externalHref(link?.getAttribute("href") ?? undefined);
  if (!href) return;
  event.preventDefault();
  void window.bgt.openExternal(href);
}
