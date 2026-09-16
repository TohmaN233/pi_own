import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { captureCourseWebMaterial } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./course-builder-web-material.ts");
const decode = (bytes) => new TextDecoder().decode(bytes);

function response(body, options = {}) {
	return new Response(body, {
		status: options.status ?? 200,
		statusText: options.statusText,
		headers: {
			...(options.contentType ? { "content-type": options.contentType } : {}),
			...(options.headers ?? {}),
		},
	});
}

test("captures the complete selected HTML content as provenance-marked Markdown", async () => {
	const html = `<!doctype html>
<html><head><title>Numerical Optimization</title></head><body>
<nav>Navigation that must be removed</nav>
<main>
  <h1>Numerical Optimization</h1>
  <p>Read <a href="/chapters/intro">the introduction</a> and <img src="/images/figure.png" alt="figure"></p>
  <h2>Late section</h2>
  <ul><li>First point</li><li>Second point</li></ul>
  <pre><code class="language-python">def step(x):\n    return x + 1</code></pre>
  <script type="math/tex">x^2 + y^2</script>
  <table><thead><tr><th>Method</th><th>Rate</th></tr></thead><tbody><tr><td>Newton</td><td>Quadratic</td></tr></tbody></table>
</main>
<div class="sidebar">Sidebar control</div>
</body></html>`;
	const result = await captureCourseWebMaterial("https://example.test/course/page", {
		fetch: async () => response(html, { contentType: "text/html; charset=utf-8" }),
	});
	const markdown = decode(result.bytes);
	assert.equal(result.name, "page.md");
	assert.equal(result.title, "Numerical Optimization");
	assert.equal(result.method, "html-markdown");
	assert.equal(result.sourceUrl, "https://example.test/course/page");
	assert.equal(result.finalUrl, "https://example.test/course/page");
	assert.equal(result.contentType, "text/html; charset=utf-8");
	assert.match(markdown, /> Source URL: https:\/\/example\.test\/course\/page/);
	assert.match(markdown, /> Fetched at: \d{4}-\d{2}-\d{2}T/);
	assert.match(markdown, /this does not claim whole-site coverage/);
	assert.match(markdown, /Late section/);
	assert.match(markdown, /```python\ndef step\(x\):/);
	assert.match(markdown, /\$\$\nx\^2 \+ y\^2\n\$\$/);
	assert.match(markdown, /\| Method \| Rate \|/);
	assert.match(markdown, /\| Newton \| Quadratic \|/);
	assert.match(markdown, /\[the introduction\]\(https:\/\/example\.test\/chapters\/intro\)/);
	assert.match(markdown, /!\[figure\]\(https:\/\/example\.test\/images\/figure\.png\)/);
	assert.doesNotMatch(markdown, /Navigation that must be removed|Sidebar control/);
});

test("uses an article or cleaned body when a page has no main element", async () => {
	const html = "<html><head><title>Article</title></head><body><header><nav>menu</nav></header><article><h1>Article</h1><p>Readable article text.</p></article><article><h2>Late sibling</h2><p>Late article text.</p></article><aside>Related controls</aside></body></html>";
	const result = await captureCourseWebMaterial("https://example.test/article", {
		fetch: async () => response(html, { contentType: "text/html" }),
	});
	const markdown = decode(result.bytes);
	assert.match(markdown, /Readable article text/);
	assert.match(markdown, /Late article text/);
	assert.doesNotMatch(markdown, /menu|Related controls/);
});

test("returns non-HTML bytes unchanged and derives a sanitized filename without an extension allowlist", async () => {
	const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
	const pdf = await captureCourseWebMaterial("https://example.test/files/lesson", {
		fetch: async () => response(pdfBytes, { contentType: "application/pdf" }),
	});
	assert.deepEqual(pdf.bytes, pdfBytes);
	assert.equal(pdf.name, "lesson.pdf");
	assert.equal(pdf.method, "raw");
	assert.equal(pdf.contentType, "application/pdf");

	const custom = await captureCourseWebMaterial("https://example.test/files/lesson.weird", {
		fetch: async () => response(new Uint8Array([1, 2, 3]), { contentType: "application/x-custom" }),
	});
	assert.equal(custom.name, "lesson.weird");
	assert.deepEqual(custom.bytes, new Uint8Array([1, 2, 3]));
});

test("rejects HTTP errors and oversized responses before returning material", async () => {
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/missing", { fetch: async () => response("no", { status: 503, statusText: "Unavailable" }) }),
		/HTTP 503 Unavailable/,
	);
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/large", { fetch: async () => response("small", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } }) }),
		/16 MiB/,
	);
});

test("bounds streamed responses instead of silently truncating them", async () => {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(16 * 1024 * 1024));
			controller.enqueue(new Uint8Array([1]));
			controller.close();
		},
	});
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/stream", { fetch: async () => new Response(stream, { headers: { "content-type": "application/octet-stream" } }) }),
		/16 MiB/,
	);
});

test("rejects unsupported protocols and credentials before fetching", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return response("unexpected", { contentType: "text/plain" });
	};
	await assert.rejects(() => captureCourseWebMaterial("file:///tmp/lesson", { fetch: fetchImpl }), /http or https/);
	await assert.rejects(() => captureCourseWebMaterial("https://user:password@example.test/lesson", { fetch: fetchImpl }), /credentials/);
	assert.equal(calls, 0);
});

test("validates each HTTP redirect target and keeps the final URL", async () => {
	const seen = [];
	const html = "<html><head><title>Redirected</title></head><body><main><p>Final content.</p></main></body></html>";
	const result = await captureCourseWebMaterial("http://example.test/start", {
		fetch: async (url) => {
			seen.push(url);
			return url.endsWith("/start")
				? response(null, { status: 302, headers: { location: "https://example.test/final" } })
				: response(html, { contentType: "text/html" });
		},
	});
	assert.deepEqual(seen, ["http://example.test/start", "https://example.test/final"]);
	assert.equal(result.finalUrl, "https://example.test/final");

	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/start", { fetch: async () => response(null, { status: 302, headers: { location: "ftp://example.test/file" } }) }),
		/http or https/,
	);
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/start", { fetch: async () => response(null, { status: 302, headers: { location: "https://user:password@example.test/final" } }) }),
		/credentials/,
	);
});

test("fails clearly for empty JavaScript shells, login pages, and challenges", async () => {
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/app", { fetch: async () => response("<html><body><div id=\"root\"></div><script src=\"app.js\"></script></body></html>", { contentType: "text/html" }) }),
		/readable content|shell/,
	);
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/login", { fetch: async () => response("<html><head><title>Sign in</title></head><body><form><input type=\"password\"></form></body></html>", { contentType: "text/html" }) }),
		/login/,
	);
	await assert.rejects(
		() => captureCourseWebMaterial("https://example.test/check", { fetch: async () => response("<html><head><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>", { contentType: "text/html" }) }),
		/challenge|bot/,
	);
});
