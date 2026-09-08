import { resolveLocalFileHref } from "./file-links.ts";

interface HtmlNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

/** Convert only recognized filesystem schemes into inert app hrefs before
 * sanitizing HTML. Never relax the sanitizer's script/protocol restrictions. */
export function rehypeLocalFileLinks() {
  return (tree: HtmlNode) => {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.children) pending.push(...node.children);
      if (node.tagName !== "a" && node.tagName !== "img") continue;
      const key = node.tagName === "a" ? "href" : "src";
      const href = node.properties?.[key];
      if (typeof href !== "string" || !/^(?:file:|[a-zA-Z]:[\\/]|\\\\)/i.test(href)) continue;
      const path = resolveLocalFileHref(href);
      if (path) node.properties![key] = `/__pi_file__/${encodeURIComponent(path)}`;
    }
  };
}
