import type { ComponentProps, MouseEvent } from "react";
import { portableHref } from "./navigation";
import { navigatePortableHost } from "./bridge";

export default function Link({ href, onClick, ...props }: ComponentProps<"a">) {
  const resolved = typeof href === "string" ? portableHref(href) : href;
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // An opaque sandbox must never render a host page within the package frame.
    // External navigation is delegated to the host UI after its own validation.
    if (typeof resolved === "string" && resolved.startsWith("/") && !resolved.startsWith("/api/mode-packs/frontend/")) {
      event.preventDefault();
      navigatePortableHost(resolved);
    }
  };
  return <a {...props} href={resolved} onClick={click} />;
}
