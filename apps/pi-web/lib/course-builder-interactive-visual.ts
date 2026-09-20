import { createHash } from "node:crypto";
import type { CourseBuilderMaterial } from "../../../packages/course-builder-host/src/index.ts";
import { readLinkedCourseBuilderMaterialBytes } from "./course-builder-local-materials.ts";

const MAX_HTML_BYTES = 8 * 1024 * 1024;

export interface StandaloneInteractiveVisualValidation {
	title: string;
	sourceHash: string;
	hasControls: boolean;
	hasLiveGraphic: boolean;
}

/** Validate the product boundary: an offline classroom page, not a static table or CDN shell. */
export function validateStandaloneInteractiveVisual(bytes: Uint8Array, name: string): StandaloneInteractiveVisualValidation {
	if (!/\.html?$/iu.test(name)) throw new Error("Standalone visualization filename must end in .html");
	if (bytes.byteLength < 80 || bytes.byteLength > MAX_HTML_BYTES) throw new Error("Standalone visualization HTML must be 80 bytes to 8 MiB");
	let html: string;
	try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new Error("Standalone visualization HTML must be valid UTF-8"); }
	if (!/<html(?:\s|>)/iu.test(html) || !/<body(?:\s|>)/iu.test(html)) throw new Error("Standalone visualization requires a complete HTML document");
	if (/<(?:script|img|iframe|link|source|video|audio)\b[^>]*(?:src|href)\s*=\s*["']?(?:https?:|\/\/|\/|\.\.\/|\.\/)/iu.test(html) || /url\(\s*["']?(?:https?:|\/\/|\/|\.\.\/|\.\/)/iu.test(html))
		throw new Error("Standalone visualization cannot depend on external or relative runtime resources");
	if (!/<script(?:\s|>)/iu.test(html)) throw new Error("Standalone visualization requires inline JavaScript interaction");
	const hasControls = /<(?:input|button|select|textarea)\b/iu.test(html);
	if (!hasControls) throw new Error("Standalone visualization requires at least one interactive control");
	const hasLiveGraphic = /<(?:canvas|svg)\b/iu.test(html);
	if (!hasLiveGraphic) throw new Error("Standalone visualization requires a live Canvas or SVG graphic");
	const title = /<title\b[^>]*>([^<]+)<\/title>/iu.exec(html)?.[1]?.trim() || name.replace(/\.html?$/iu, "");
	return {
		title: title.slice(0, 500),
		sourceHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		hasControls,
		hasLiveGraphic,
	};
}

export async function validateLinkedInteractiveVisual(material: CourseBuilderMaterial) {
	const bytes = await readLinkedCourseBuilderMaterialBytes(material);
	return validateStandaloneInteractiveVisual(bytes, material.name);
}

export async function readValidatedInteractiveVisual(material: CourseBuilderMaterial, expectedHash: string) {
	const bytes = await readLinkedCourseBuilderMaterialBytes(material);
	const validation = validateStandaloneInteractiveVisual(bytes, material.name);
	if (validation.sourceHash !== expectedHash) throw new Error("Interactive visualization changed after Host validation; relink and register its current version");
	return { bytes, validation };
}
