import type { DatabaseSync } from "node:sqlite";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import { choice, integer, list, object, StudyError, text } from "../../study-research-host/src/contracts.ts";

export const MATH_RENDERER_VERSION = "pi-math-v1/plotly-strict-4.1.0";
interface CommonSpec {
	title: string;
	purpose: string;
	xLabel: string;
	yLabel: string;
}
export type MathVisualSpec =
	| (CommonSpec & { kind: "polynomial"; coefficients: number[]; domain: [number, number]; samples: number })
	| (CommonSpec & { kind: "matrix2d"; matrix: [[number, number], [number, number]] })
	| (CommonSpec & {
			kind: "surface3d";
			zLabel: string;
			shape: "saddle" | "paraboloid" | "gaussian";
			scale: number;
			domain: [number, number];
			samples: number;
	  })
	| (CommonSpec & { kind: "scatter2d" | "scatter3d"; zLabel: string; points: number[][] });
export interface MathSeries {
	name: string;
	type: "scatter" | "scatter3d" | "surface";
	mode?: "lines" | "markers";
	x: number[];
	y: number[];
	z?: number[] | number[][];
}
export interface MathVisualArtifact {
	id: string;
	scope: string;
	rendererVersion: string;
	spec: MathVisualSpec;
	specHash: string;
	data: MathSeries[];
	dataHash: string;
	createdAt: string;
}

function finite(value: unknown, label: string, bound = 1000000): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > bound)
		throw new StudyError("INVALID_VISUAL", `${label} must be finite and bounded`);
	return value;
}
function label(value: unknown, field: string): string {
	const result = text(value, field, 200);
	if (/[<>]/u.test(result)) throw new StudyError("INVALID_VISUAL", "Plot labels must be plain text, not HTML");
	return result;
}
function domain(value: unknown): [number, number] {
	const pair = list(value, "domain", 2);
	if (pair.length !== 2) throw new StudyError("INVALID_VISUAL", "Domain needs two endpoints");
	const low = finite(pair[0], "domain", 100);
	const high = finite(pair[1], "domain", 100);
	if (low >= high) throw new StudyError("INVALID_VISUAL", "Domain must increase");
	return [low, high];
}
export function parseMathVisualSpec(value: unknown): MathVisualSpec {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new StudyError("INVALID_VISUAL", "Expected a visual object");
	const kind = choice(
		(value as Record<string, unknown>).kind,
		["polynomial", "matrix2d", "surface3d", "scatter2d", "scatter3d"],
		"visual kind",
	);
	const common = ["kind", "title", "purpose", "xLabel", "yLabel"];
	const extras =
		kind === "polynomial"
			? ["coefficients", "domain", "samples"]
			: kind === "matrix2d"
				? ["matrix"]
				: kind === "surface3d"
					? ["zLabel", "shape", "scale", "domain", "samples"]
					: ["points", "zLabel"];
	const row = object(value, [...common, ...extras], "visual spec");
	const base: CommonSpec = {
		title: label(row.title, "title"),
		purpose: text(row.purpose, "purpose", 3000),
		xLabel: label(row.xLabel, "xLabel"),
		yLabel: label(row.yLabel, "yLabel"),
	};
	if (kind === "polynomial") {
		const coefficients = list(row.coefficients, "coefficients", 9).map((v) => finite(v, "coefficient", 1000));
		if (!coefficients.length)
			throw new StudyError("INVALID_VISUAL", "Polynomial needs coefficients in ascending powers");
		return {
			...base,
			kind,
			coefficients,
			domain: domain(row.domain),
			samples: integer(row.samples, "samples", 5, 513),
		};
	}
	if (kind === "matrix2d") {
		const matrix = list(row.matrix, "matrix", 2).map((r) =>
			list(r, "matrix row", 2).map((v) => finite(v, "matrix coefficient", 100)),
		);
		if (matrix.length !== 2 || matrix.some((r) => r.length !== 2))
			throw new StudyError("INVALID_VISUAL", "Matrix must be 2 by 2");
		return { ...base, kind, matrix: matrix as [[number, number], [number, number]] };
	}
	if (kind === "surface3d")
		return {
			...base,
			kind,
			zLabel: label(row.zLabel, "zLabel"),
			shape: choice(row.shape, ["saddle", "paraboloid", "gaussian"], "shape"),
			scale: finite(row.scale, "scale", 100),
			domain: domain(row.domain),
			samples: integer(row.samples, "samples", 5, 65),
		};
	const points = list(row.points, "points", 4096).map((point) => {
		const coordinates = list(point, "coordinates", 3).map((v) => finite(v, "coordinate"));
		if (coordinates.length !== (kind === "scatter2d" ? 2 : 3))
			throw new StudyError("INVALID_VISUAL", "Point dimensionality differs from visual kind");
		return coordinates;
	});
	if (!points.length) throw new StudyError("INVALID_VISUAL", "Scatter needs at least one point");
	return {
		...base,
		kind,
		points,
		zLabel: row.zLabel === undefined && kind === "scatter2d" ? "z" : label(row.zLabel, "zLabel"),
	};
}
function linspace(bounds: [number, number], count: number): number[] {
	return Array.from({ length: count }, (_, index) => bounds[0] + ((bounds[1] - bounds[0]) * index) / (count - 1));
}
export function computeMathVisual(spec: MathVisualSpec): MathSeries[] {
	if (spec.kind === "polynomial") {
		const x = linspace(spec.domain, spec.samples);
		const y = x.map((point) => spec.coefficients.reduceRight((acc, coefficient) => acc * point + coefficient, 0));
		for (const value of y) finite(value, "computed polynomial", 1e20);
		return [{ type: "scatter", mode: "lines", name: "f(x)", x, y }];
	}
	if (spec.kind === "matrix2d") {
		const points = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0],
		];
		const result = points.map(([x, y]) => [
			spec.matrix[0][0] * x + spec.matrix[0][1] * y,
			spec.matrix[1][0] * x + spec.matrix[1][1] * y,
		]);
		return [
			{
				type: "scatter",
				mode: "lines",
				name: "original unit square",
				x: points.map((p) => p[0]),
				y: points.map((p) => p[1]),
			},
			{
				type: "scatter",
				mode: "lines",
				name: "transformed",
				x: result.map((p) => p[0]),
				y: result.map((p) => p[1]),
			},
		];
	}
	if (spec.kind === "surface3d") {
		const x = linspace(spec.domain, spec.samples);
		const y = [...x];
		const z = y.map((yy) =>
			x.map(
				(xx) =>
					spec.scale *
					(spec.shape === "saddle"
						? xx * xx - yy * yy
						: spec.shape === "paraboloid"
							? xx * xx + yy * yy
							: Math.exp(-(xx * xx + yy * yy))),
			),
		);
		return [{ type: "surface", name: spec.shape, x, y, z }];
	}
	return [
		{
			type: spec.kind === "scatter3d" ? "scatter3d" : "scatter",
			mode: "markers",
			name: "observations",
			x: spec.points.map((p) => p[0]),
			y: spec.points.map((p) => p[1]),
			...(spec.kind === "scatter3d" ? { z: spec.points.map((p) => p[2]) } : {}),
		},
	];
}
export class MathVisualizationHost {
	private readonly db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(
			"CREATE TABLE IF NOT EXISTS math_visual_artifact(id TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id))",
		);
	}
	create(scope: string, input: unknown): MathVisualArtifact {
		text(scope, "visual scope", 512);
		const spec = parseMathVisualSpec(input);
		const specHash = contentHash(spec);
		const data = computeMathVisual(spec);
		const dataHash = contentHash(data);
		const id = `visual_${contentHash({ scope, specHash, dataHash, rendererVersion: MATH_RENDERER_VERSION })
			.replace(/^sha256:/u, "")
			.slice(0, 32)}`;
		const value = {
			id,
			scope,
			rendererVersion: MATH_RENDERER_VERSION,
			spec,
			specHash,
			data,
			dataHash,
			createdAt: new Date().toISOString(),
		};
		this.db
			.prepare("INSERT OR IGNORE INTO math_visual_artifact VALUES(?,?,?)")
			.run(id, scope, stableStringify(value));
		return this.get(scope, id);
	}
	get(scope: string, id: string): MathVisualArtifact {
		const row = this.db.prepare("SELECT payload FROM math_visual_artifact WHERE scope=? AND id=?").get(scope, id) as
			| { payload: string }
			| undefined;
		if (!row) throw new StudyError("VISUAL_NOT_FOUND", "Visual is not in this workspace scope");
		const value = JSON.parse(row.payload) as MathVisualArtifact;
		if (
			value.rendererVersion !== MATH_RENDERER_VERSION ||
			value.scope !== scope ||
			value.id !== id ||
			contentHash(parseMathVisualSpec(value.spec)) !== value.specHash ||
			contentHash(value.data) !== value.dataHash ||
			contentHash(computeMathVisual(value.spec)) !== value.dataHash
		)
			throw new StudyError("CORRUPT_VISUAL", "Visual data or spec integrity failed");
		return value;
	}
	list(scope: string) {
		const rows = this.db
			.prepare("SELECT id FROM math_visual_artifact WHERE scope=? ORDER BY rowid DESC LIMIT 100")
			.all(scope) as unknown as { id: string }[];
		return rows.map((row) => {
			const { data, ...artifact } = this.get(scope, row.id);
			return { ...artifact, seriesCount: data.length };
		});
	}
}
