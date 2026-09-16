import { fromHtml } from "hast-util-from-html";
import type { Element, Root, RootContent } from "hast";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const REMOVED_TAGS = new Set(["nav", "style", "template", "noscript", "iframe", "canvas", "button", "input", "select", "textarea"]);
const BLOCK_TAGS = new Set([
	"address", "article", "blockquote", "body", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "ol", "p", "pre", "section", "table", "ul",
]);

export type CourseWebMaterial = {
	name: string;
	bytes: Uint8Array;
	sourceUrl: string;
	finalUrl: string;
	contentType: string;
	method: string;
	title: string;
};

export type CaptureCourseWebMaterialOptions = {
	fetch?: typeof fetch;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureHttpUrl(value: string, label: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error) {
		throw new Error(`${label} must be a valid HTTP(S) URL`, { cause: error });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${label} must use http or https (received ${parsed.protocol || "an unsupported protocol"})`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`${label} must not contain username or password credentials`);
	}
	return parsed;
}

function normalizedMediaType(header: string | null): string {
	return header?.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function declaredLength(response: Response): number | null {
	const value = response.headers.get("content-length");
	if (value === null) return null;
	if (!/^\d+$/u.test(value.trim())) throw new Error("Web material response has an invalid Content-Length header");
	const length = Number(value);
	if (!Number.isSafeInteger(length)) throw new Error("Web material response has an unsafe Content-Length header");
	return length;
}

async function cancelBody(response: Response): Promise<void> {
	if (response.body) await response.body.cancel().catch(() => undefined);
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
	const length = declaredLength(response);
	if (length !== null && length > MAX_RESPONSE_BYTES) throw new Error("Web material response exceeds the 16 MiB limit");

	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Web material response exceeds the 16 MiB limit");
		return bytes;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (total + value.byteLength > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("Web material response exceeds the 16 MiB limit");
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function propertyValue(element: Element, ...names: string[]): string {
	for (const name of names) {
		const value = element.properties[name];
		if (typeof value === "string" && value.trim()) return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (Array.isArray(value) && value.length) return value.join(" ");
	}
	return "";
}

function isMathScript(element: Element): boolean {
	if (element.tagName.toLowerCase() !== "script") return false;
	const type = propertyValue(element, "type").trim().toLowerCase();
	return type.startsWith("math/tex") || type.startsWith("application/x-tex");
}

function shouldRemoveElement(element: Element): boolean {
	const tagName = element.tagName.toLowerCase();
	if (tagName === "script") return !isMathScript(element);
	if (REMOVED_TAGS.has(tagName)) return true;
	if (tagName === "aside") return true;
	const role = propertyValue(element, "role").trim().toLowerCase();
	if (role === "navigation" || role === "complementary") return true;
	const ariaHidden = propertyValue(element, "aria-hidden", "ariaHidden").trim().toLowerCase();
	if (ariaHidden === "true") return true;
	const identity = `${propertyValue(element, "id")} ${propertyValue(element, "class", "className")} ${propertyValue(element, "data-testid", "dataTestid")} ${propertyValue(element, "data-region", "dataRegion")}`.toLowerCase();
	return /(?:^|[\s_-])(sidebar|side[-_ ]?bar|cookie[-_ ]?banner|consent[-_ ]?banner|share[-_ ]?buttons?|social[-_ ]?share|advertisement?|ads?)(?:$|[\s_-])/u.test(identity);
}

function cleanElement(element: Element): Element | null {
	if (shouldRemoveElement(element)) return null;
	const children: Element["children"] = [];
	for (const child of element.children) {
		if (child.type === "element") {
			const cleaned = cleanElement(child);
			if (cleaned) children.push(cleaned);
		} else {
			children.push(child);
		}
	}
	return { ...element, children };
}

function cleanRoot(root: Root): Root {
	const children: Root["children"] = [];
	for (const child of root.children) {
		if (child.type === "element") {
			const cleaned = cleanElement(child);
			if (cleaned) children.push(cleaned);
		} else {
			children.push(child);
		}
	}
	return { ...root, children };
}

function findElements(node: RootContent | Root, predicate: (element: Element) => boolean): Element[] {
	const found: Element[] = [];
	const visit = (candidate: RootContent | Root): void => {
		if (candidate.type !== "element" && candidate.type !== "root") return;
		if (candidate.type === "element" && predicate(candidate)) found.push(candidate);
		for (const child of candidate.children) visit(child);
	};
	visit(node);
	return found;
}

function rawText(node: RootContent | Root): string {
	if (node.type === "text") return node.value;
	if (node.type !== "element" && node.type !== "root") return "";
	return node.children.map((child) => rawText(child)).join("");
}

function plainText(node: RootContent | Root): string {
	if (node.type === "text") return node.value;
	if (node.type !== "element" && node.type !== "root") return "";
	if (["script", "style", "head", "title", "meta"].includes(node.type === "element" ? node.tagName.toLowerCase() : "")) return "";
	return node.children.map((child) => plainText(child)).join(" ");
}

function firstText(node: RootContent | Root): string {
	return plainText(node).replace(/\s+/gu, " ").trim();
}

function escapeInlineText(value: string): string {
	return value.replace(/`/gu, "\\`").replace(/\s+/gu, " ");
}

function absoluteUrl(value: string, base: string): string | null {
	const candidate = value.trim();
	if (!candidate || /^(?:data|javascript|vbscript|blob):/iu.test(candidate)) return null;
	try {
		const resolved = new URL(candidate, base);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
		return resolved.href;
	} catch {
		return null;
	}
}

function inlineCode(value: string): string {
	const runs = value.match(/`+/gu)?.map((run) => run.length) ?? [];
	const fence = "`".repeat(Math.max(1, ...(runs.length ? runs : [0])) + 1);
	const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
	return `${fence}${padding}${value}${padding}${fence}`;
}

function codeFence(value: string, language: string): string {
	const runs = value.match(/`+/gu)?.map((run) => run.length) ?? [];
	const fence = "`".repeat(Math.max(3, ...(runs.length ? runs : [0])) + 1);
	const content = value.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "");
	return `${fence}${language}\n${content}\n${fence}`;
}

function renderInlineChildren(children: Element["children"], baseUrl: string): string {
	return children.map((child) => renderInline(child, baseUrl)).join("");
}

function renderInline(node: RootContent, baseUrl: string): string {
	if (node.type === "text") return escapeInlineText(node.value);
	if (node.type !== "element") return "";
	const tagName = node.tagName.toLowerCase();
	if (tagName === "script" && isMathScript(node)) {
		const value = rawText(node).trim();
		return value ? `$$${value}$$` : "";
	}
	if (tagName === "math") {
		const value = firstText(node);
		return value ? `$${value}$` : "";
	}
	if (tagName === "br") return "\n";
	if (tagName === "img") {
		const source = absoluteUrl(propertyValue(node, "src"), baseUrl);
		return source ? `![${escapeInlineText(propertyValue(node, "alt"))}](${source})` : escapeInlineText(propertyValue(node, "alt"));
	}
	if (tagName === "a") {
		const text = renderInlineChildren(node.children, baseUrl).trim();
		const href = absoluteUrl(propertyValue(node, "href"), baseUrl);
		if (!href) return text;
		return `[${text || escapeInlineText(href)}](${href})`;
	}
	if (tagName === "strong" || tagName === "b") {
		const value = renderInlineChildren(node.children, baseUrl).trim();
		return value ? `**${value}**` : "";
	}
	if (tagName === "em" || tagName === "i") {
		const value = renderInlineChildren(node.children, baseUrl).trim();
		return value ? `*${value}*` : "";
	}
	if (tagName === "del" || tagName === "s" || tagName === "strike") {
		const value = renderInlineChildren(node.children, baseUrl).trim();
		return value ? `~~${value}~~` : "";
	}
	if (tagName === "code") return inlineCode(rawText(node));
	if (BLOCK_TAGS.has(tagName)) return renderBlock(node, baseUrl);
	return renderInlineChildren(node.children, baseUrl);
}

function isElement(node: RootContent, tagName?: string): node is Element {
	return node.type === "element" && (tagName === undefined || node.tagName.toLowerCase() === tagName);
}

function renderFlow(children: Element["children"] | Root["children"], baseUrl: string): string {
	const blocks: string[] = [];
	let inline = "";
	const flushInline = (): void => {
		const value = inline.trim();
		if (value) blocks.push(value);
		inline = "";
	};
	for (const child of children) {
		if (child.type === "element" && isBlockElement(child)) {
			flushInline();
			const block = renderBlock(child, baseUrl).trim();
			if (block) blocks.push(block);
		} else {
			inline += renderInline(child, baseUrl);
		}
	}
	flushInline();
	return blocks.join("\n\n");
}

function isBlockElement(element: Element): boolean {
	const tagName = element.tagName.toLowerCase();
	return BLOCK_TAGS.has(tagName) || (tagName === "script" && isMathScript(element)) || tagName === "math";
}

function renderList(element: Element, baseUrl: string): string {
	const ordered = element.tagName.toLowerCase() === "ol";
	const startValue = Number(propertyValue(element, "start"));
	const start = Number.isSafeInteger(startValue) && startValue > 0 ? startValue : 1;
	const items = element.children.filter((child): child is Element => isElement(child, "li"));
	return items.map((item, index) => {
		const nested = item.children.filter((child): child is Element => isElement(child, "ul") || isElement(child, "ol"));
		const content = renderFlow(item.children.filter((child) => !(child.type === "element" && (child.tagName.toLowerCase() === "ul" || child.tagName.toLowerCase() === "ol"))), baseUrl).trim();
		const prefix = ordered ? `${start + index}. ` : "- ";
		const lines = (content || "").split("\n");
		const rendered = lines.map((line, lineIndex) => lineIndex === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`).join("\n");
		const nestedMarkdown = nested.map((list) => renderList(list, baseUrl)).filter(Boolean).join("\n\n");
		return nestedMarkdown ? `${rendered}\n${nestedMarkdown.split("\n").map((line) => `  ${line}`).join("\n")}` : rendered;
	}).join("\n");
}

function tableRows(table: Element): Element[] {
	const rows: Element[] = [];
	const visit = (node: RootContent): void => {
		if (node.type !== "element") return;
		const tagName = node.tagName.toLowerCase();
		if (tagName === "table") {
			for (const child of node.children) visit(child);
			return;
		}
		if (tagName === "tr") {
			rows.push(node);
			return;
		}
		for (const child of node.children) visit(child);
	};
	for (const child of table.children) visit(child);
	return rows;
}

function renderTable(table: Element, baseUrl: string): string {
	const rows = tableRows(table).map((row) => row.children.filter((child): child is Element => isElement(child, "th") || isElement(child, "td")));
	if (!rows.length) return "";
	const width = Math.max(...rows.map((row) => row.length), 1);
	const renderedRows = rows.map((row) => Array.from({ length: width }, (_, index) => {
		const value = row[index] ? renderFlow(row[index].children, baseUrl) : "";
		return value.replace(/\s+/gu, " ").trim().replace(/\|/gu, "\\|");
	}));
	const header = renderedRows[0] ?? Array.from({ length: width }, () => "");
	const separator = Array.from({ length: width }, () => "---");
	return [
		`| ${header.join(" | ")} |`,
		`| ${separator.join(" | ")} |`,
		...renderedRows.slice(1).map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

function renderBlock(node: RootContent | Root, baseUrl: string): string {
	if (node.type === "root") return renderFlow(node.children, baseUrl);
	if (node.type !== "element") return "";
	const tagName = node.tagName.toLowerCase();
	if (tagName === "head" || tagName === "title" || tagName === "meta" || tagName === "link") return "";
	if (tagName === "script" && isMathScript(node)) {
		const value = rawText(node).trim();
		return value ? `$$\n${value}\n$$` : "";
	}
	if (tagName === "math") {
		const value = firstText(node);
		return value ? `$$\n${value}\n$$` : "";
	}
	if (tagName === "h1" || tagName === "h2" || tagName === "h3" || tagName === "h4" || tagName === "h5" || tagName === "h6") {
		const level = Number(tagName.slice(1));
		return `${"#".repeat(level)} ${renderInlineChildren(node.children, baseUrl).trim()}`;
	}
	if (tagName === "p") return renderInlineChildren(node.children, baseUrl).trim();
	if (tagName === "pre") {
		const code = node.children.find((child): child is Element => isElement(child, "code"));
		const source = code ? rawText(code) : rawText(node);
		const languageMatch = code ? propertyValue(code, "class", "className").match(/(?:^|\s)(?:language|lang)-([\w+-]+)/iu) : null;
		return codeFence(source, languageMatch?.[1] ?? "");
	}
	if (tagName === "ul" || tagName === "ol") return renderList(node, baseUrl);
	if (tagName === "table") return renderTable(node, baseUrl);
	if (tagName === "blockquote") {
		const content = renderFlow(node.children, baseUrl);
		return content ? content.split("\n").map((line) => `> ${line}`).join("\n") : "";
	}
	if (tagName === "hr") return "---";
	return renderFlow(node.children, baseUrl);
}

function extractTitle(root: Root, fallback: string): string {
	const titleElement = findElements(root, (element) => element.tagName.toLowerCase() === "title")[0];
	const title = titleElement ? firstText(titleElement) : "";
	if (title) return title;
	const heading = findElements(root, (element) => /^h[1-6]$/u.test(element.tagName.toLowerCase()))[0];
	return heading ? firstText(heading) : fallback;
}

function selectedContent(root: Root, baseUrl: string): { markdown: string; readableText: string } {
	const body = findElements(root, (element) => element.tagName.toLowerCase() === "body")[0];
	const candidates = findElements(root, (element) => {
		const tagName = element.tagName.toLowerCase();
		return tagName === "main" || tagName === "article" || propertyValue(element, "role").trim().toLowerCase() === "main";
	});
	const contains = (parent: Element, child: Element): boolean => parent !== child && findElements(parent, (element) => element === child).length > 0;
	const outermost = (items: Element[]): Element[] => items.filter((item) => !items.some((other) => contains(other, item)));
	const primary = outermost(candidates.filter((candidate) => candidate.tagName.toLowerCase() === "main" || propertyValue(candidate, "role").trim().toLowerCase() === "main"));
	const articleCandidates = outermost(candidates.filter((candidate) => candidate.tagName.toLowerCase() === "article"));
	const renderCandidates = (items: Element[]): { markdown: string; readableText: string } | null => {
		const cleaned = items.map((candidate) => cleanElement(candidate)).filter((candidate): candidate is Element => candidate !== null);
		if (!cleaned.length) return null;
		const selectedRoot = { type: "root", children: cleaned } as Root;
		return { markdown: renderBlock(selectedRoot, baseUrl), readableText: firstText(selectedRoot) };
	};
	const primaryResult = renderCandidates(primary);
	const chosen = primaryResult?.markdown.trim() ? primaryResult : renderCandidates(articleCandidates);
	if (chosen?.markdown.trim()) return chosen;
	const cleanedBody = body ? cleanElement(body) : null;
	if (cleanedBody) {
		const markdown = renderBlock(cleanedBody, baseUrl);
		if (markdown.trim()) return { markdown, readableText: firstText(cleanedBody) };
	}
	const cleanedRoot = cleanRoot(root);
	return { markdown: renderBlock(cleanedRoot, baseUrl), readableText: firstText(cleanedRoot) };
}

function looksLikeHtml(bytes: Uint8Array): boolean {
	const prefix = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/u, "").trimStart().toLowerCase();
	return prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<head") || prefix.startsWith("<body") || prefix.startsWith("<main") || prefix.startsWith("<article");
}

function markdownHeader(title: string, sourceUrl: string, finalUrl: string, fetchedAt: string, body: string): string {
	const header = [
		`# ${title || "Web material"}`,
		"",
		`> Source URL: ${sourceUrl}`,
		`> Final URL: ${finalUrl}`,
		`> Fetched at: ${fetchedAt}`,
		"> Capture: one fetched page converted to Markdown; this does not claim whole-site coverage.",
	];
	return `${header.join("\n")}\n\n${body.trim()}`;
}

function extensionForMediaType(mediaType: string): string {
	const known: Record<string, string> = {
		"application/pdf": ".pdf",
		"application/rtf": ".rtf",
		"application/json": ".json",
		"application/xml": ".xml",
		"text/plain": ".txt",
		"text/markdown": ".md",
		"text/csv": ".csv",
	};
	return known[mediaType] ?? "";
}

function sanitizeFilename(value: string): string {
	const sanitized = value.replace(/[<>:"/\\|?*\x00-\x1f]/gu, "_").replace(/[. ]+$/u, "").trim();
	return sanitized || "web-material";
}

function nameFromUrl(url: string, mediaType: string, html: boolean): string {
	const parsed = new URL(url);
	let segment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname;
	try {
		segment = decodeURIComponent(segment);
	} catch {
		// Keep the URL segment when percent-decoding fails; filename sanitization still applies.
	}
	segment = sanitizeFilename(segment);
	if (html) {
		segment = segment.replace(/\.(?:x?html?)$/iu, "") || "web-material";
		return `${segment}.md`;
	}
	if (!/\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment)) segment += extensionForMediaType(mediaType);
	return segment;
}

function isLoginOrChallenge(title: string, readableText: string, root: Root): "login" | "challenge" | null {
	const titleText = title.toLowerCase();
	const text = readableText.replace(/\s+/gu, " ").trim();
	const shortPage = text.length < 1200;
	const challengePattern = /(?:cloudflare|captcha|verify you are human|access denied|checking your browser|just a moment|enable javascript and cookies|javascript required)/iu;
	if (challengePattern.test(titleText) || (shortPage && challengePattern.test(text))) return "challenge";
	const hasPassword = findElements(root, (element) => element.tagName.toLowerCase() === "input" && propertyValue(element, "type").toLowerCase() === "password").length > 0;
	const loginPattern = /(?:^|\b)(?:log[ -]?in|sign[ -]?in|authentication required|create an account|register to continue)(?:\b|$)/iu;
	if (hasPassword || loginPattern.test(titleText) || (text.length < 500 && loginPattern.test(text))) return "login";
	if (/^(?:loading|please wait|one moment)[.!…\s]*$/iu.test(text) || /^(?:enable javascript|javascript required)[.!…\s]*$/iu.test(text)) return "challenge";
	return null;
}

async function fetchResponse(sourceUrl: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<{ response: Response; finalUrl: URL }> {
	let requestUrl = sourceUrl;
	for (let redirectCount = 0; ; redirectCount += 1) {
		const response = await fetchImpl(requestUrl.href, { redirect: "manual", signal });
		const responseUrl = response.url ? ensureHttpUrl(response.url, "Fetched response URL") : requestUrl;
		if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: responseUrl };
		if (redirectCount >= MAX_REDIRECTS) {
			await cancelBody(response);
			throw new Error(`Web material fetch exceeded the ${MAX_REDIRECTS}-redirect limit`);
		}
		const location = response.headers.get("location");
		if (!location) {
			await cancelBody(response);
			throw new Error(`Web material redirect from ${requestUrl.href} has no Location header`);
		}
		let nextUrl: URL;
		try {
			nextUrl = ensureHttpUrl(new URL(location, responseUrl).href, "Redirect URL");
		} catch (error) {
			await cancelBody(response);
			throw error;
		}
		await cancelBody(response);
		requestUrl = nextUrl;
	}
}

export async function captureCourseWebMaterial(url: string, options: CaptureCourseWebMaterialOptions = {}): Promise<CourseWebMaterial> {
	if (typeof url !== "string" || !url.trim()) throw new Error("Web material URL is required");
	const sourceUrl = ensureHttpUrl(url.trim(), "Web material URL");
	const fetchImpl = options.fetch ?? fetch;
	const controller = new AbortController();
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(new Error(`Fetching web material timed out after ${FETCH_TIMEOUT_MS} ms`));
		}, FETCH_TIMEOUT_MS);
	});

	try {
		let fetched: { response: Response; finalUrl: URL };
		try {
			fetched = await Promise.race([fetchResponse(sourceUrl, fetchImpl, controller.signal), timeoutPromise]);
		} catch (error) {
			if (timedOut) throw new Error(`Fetching web material timed out after ${FETCH_TIMEOUT_MS} ms`, { cause: error });
			throw new Error(`Failed to fetch web material from ${sourceUrl.href}: ${errorMessage(error)}`, { cause: error });
		}
		const { response, finalUrl } = fetched;
		if (response.status < 200 || response.status >= 300) throw new Error(`Web material request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} for ${finalUrl.href}`);
		let bytes: Uint8Array;
		try {
			bytes = await Promise.race([readResponseBytes(response), timeoutPromise]);
		} catch (error) {
			if (timedOut) throw new Error(`Fetching web material timed out after ${FETCH_TIMEOUT_MS} ms`, { cause: error });
			throw error;
		}
		if (bytes.byteLength === 0) throw new Error("Web material response is empty");
		const headerContentType = response.headers.get("content-type")?.trim() ?? "";
		const mediaType = normalizedMediaType(headerContentType);
		const html = HTML_MEDIA_TYPES.has(mediaType) || mediaType.endsWith("+html") || (!mediaType && looksLikeHtml(bytes));
		const contentType = headerContentType || (html ? "text/html" : "application/octet-stream");
		const name = nameFromUrl(finalUrl.href, mediaType, html);
		if (!html) return { name, bytes, sourceUrl: sourceUrl.href, finalUrl: finalUrl.href, contentType, method: "raw", title: name.replace(/\.[^.]+$/u, "") };

		const htmlText = new TextDecoder("utf-8").decode(bytes);
		const parsed = fromHtml(htmlText, { fragment: false });
		const title = extractTitle(parsed, name.replace(/\.md$/u, ""));
		const selected = selectedContent(parsed, finalUrl.href);
		const diagnosis = isLoginOrChallenge(title, selected.readableText, parsed);
		if (diagnosis === "login") throw new Error("Web material page requires login; fetch an authenticated copy with a browser and import the saved file");
		if (diagnosis === "challenge") throw new Error("Web material page appears to be a bot challenge or JavaScript-only shell; fetch it with a browser and import the saved file");
		if (!selected.markdown.trim() || !selected.readableText.trim()) throw new Error("Web material page has no readable content; it may be a login page, challenge, or JavaScript-only shell");
		const body = selected.markdown;
		const fetchedAt = new Date().toISOString();
		const markdown = markdownHeader(title, sourceUrl.href, finalUrl.href, fetchedAt, body);
		return { name, bytes: new TextEncoder().encode(markdown), sourceUrl: sourceUrl.href, finalUrl: finalUrl.href, contentType, method: "html-markdown", title };
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
