import { useSyncExternalStore } from "react";
import { navigatePortableHost } from "./bridge";

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

/** Next's router is a build-time frontend dependency, not a required runtime
 * module for a packaged page. Keep the original query contract in the frame. */
export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  return new URLSearchParams(search);
}

export function portableHref(href: string): string {
  const route = href.split(/[?#]/u, 1)[0];
  const file = route === "/study" ? "study.html"
    : route === "/course-builder" ? "course-builder.html"
      : route === "/course-builder/lesson" ? "lesson.html"
        : route === "/course-builder/study-assets" ? "study-assets.html"
          : null;
  if (!file) return href;
  const suffix = href.slice(route.length);
  return new URL(`${file}${suffix}`, window.location.href).href;
}

export function useRouter() {
  const navigate = (href: string, replace = false) => {
    const resolved = portableHref(href);
    if (resolved.startsWith("/")) navigatePortableHost(resolved);
    else if (replace) window.location.replace(resolved);
    else window.location.assign(resolved);
  };
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, true),
    back: () => window.history.back(),
    refresh: () => window.location.reload(),
    prefetch: async () => {},
  };
}
