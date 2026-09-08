const MAX_FILES = 100;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export interface PreparedCourseBuilderUpload {
	items: Array<{ file: File; uploadName: string }>;
	skippedCount: number;
}

function uploadNameFor(file: File): string {
	const segments = (file.webkitRelativePath || "").replaceAll("\\", "/").split("/").filter(Boolean);
	const relativeSegments = segments.length > 1 ? segments.slice(1) : [];
	const uploadName = relativeSegments.length > 0 ? relativeSegments.join(" — ") : file.name;
	if (!uploadName || uploadName.length > 256 || /[\\/\x00-\x1f]/u.test(uploadName)) {
		throw new Error(`资料文件名不安全或过长：${file.name || "未命名文件"}`);
	}
	return uploadName;
}

export function prepareCourseBuilderUpload(files: File[]): PreparedCourseBuilderUpload {
	if (files.length === 0) throw new Error("请选择至少一个资料文件。");
	if (files.length > MAX_FILES) throw new Error(`最多一次导入 ${MAX_FILES} 个文件；当前选择了 ${files.length} 个。`);
	const sourceBytes = files.reduce((total, file) => total + file.size, 0);
	if (sourceBytes > MAX_SOURCE_BYTES) throw new Error("一次导入的资料总大小不能超过 64 MiB。");
	const items = files.map((file) => ({ file, uploadName: uploadNameFor(file) }));
	return { items, skippedCount: 0 };
}
