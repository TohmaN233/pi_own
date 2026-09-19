"use client";

import { useEffect, useState } from "react";

type Asset = {
	relativePath: string;
	name: string;
	extension: string;
	size: number;
	updatedAt: string;
	editable: boolean;
	preview: "tex" | "markdown" | "pdf" | "text";
	pdfRelativePath: string | null;
};

function readableSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function AssignmentAssets({ sessionId, assignmentId, revision }: { sessionId: string; assignmentId: string; revision: number }) {
	const [assets, setAssets] = useState<Asset[]>([]);
	const [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		void fetch(`/api/course-builder/assignment-assets?sessionId=${encodeURIComponent(sessionId)}&assignmentId=${encodeURIComponent(assignmentId)}`, { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				const body = await response.json() as { assets?: Asset[]; error?: string };
				if (!response.ok) throw new Error(body.error ?? "无法读取 Assignment 产物");
				setAssets(body.assets ?? []); setError("");
			})
			.catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => controller.abort();
	}, [assignmentId, revision, sessionId]);
	if (error) return <p role="alert">Assignment 文件读取失败：{error}</p>;
	if (!assets.length) return <p>尚未在这个 Assignment 的输出目录保存 `.tex`、`.Rmd`、`.md` 或 `.pdf` 文件。</p>;
	return <div className="assignment-assets">
		<h6>Assignment 文件</h6>
		<ul>{assets.map((asset) => {
			const query = new URLSearchParams({ sessionId, assignmentId, path: asset.relativePath, ...(asset.pdfRelativePath ? { pdfPath: asset.pdfRelativePath } : {}) });
			return <li key={asset.relativePath}>
				<a href={`/api/course-builder/assignment-assets?${query.toString()}`}>{asset.name}</a>
				<span>{asset.extension.slice(1).toUpperCase()} · {readableSize(asset.size)}{asset.editable ? " · 可编辑" : ""}</span>
			</li>;
		})}</ul>
		<style>{`.assignment-assets{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}.assignment-assets h6{margin:0 0 8px;font-size:12px}.assignment-assets ul{display:grid;gap:6px;margin:0;padding:0;list-style:none}.assignment-assets li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--bg)}.assignment-assets a{font-weight:650;color:var(--accent);overflow-wrap:anywhere}.assignment-assets span{flex:none;color:var(--text-muted);font-size:11px}`}</style>
	</div>;
}
