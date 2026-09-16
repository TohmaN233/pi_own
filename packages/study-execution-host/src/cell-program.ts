import { sha256Hex, stableStringify } from "../../harness-core/src/index.ts";

export interface StudyCellProgramInput {
	language: "python" | "r";
	code: string;
	parameters: Record<string, unknown>;
	/** Actual filenames produced by the isolated runner, independently of the user's aliases. */
	inputs: Array<{ name: string; fileName: string }>;
}

function rLiteral(value: unknown): string {
	if (value === null) return "NULL";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `list(${value.map(rLiteral).join(",")})`;
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		const entries = Object.entries(value);
		return `structure(list(${entries.map(([, item]) => rLiteral(item)).join(",")}),names=c(${entries.map(([key]) => JSON.stringify(key)).join(",")}))`;
	}
	throw new Error("Cell parameters must contain finite JSON values");
}

/** Deterministic adapter glue. Its hash is additional evidence, never the user's codeHash. */
export function compileStudyCellProgram(input: StudyCellProgramInput) {
	if (input.language !== "python" && input.language !== "r") throw new Error("Unsupported cell language");
	if (!input.code.trim() || input.code.length > 131072 || input.code.includes("\0"))
		throw new Error("Invalid cell code");
	if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters))
		throw new Error("Cell parameters must be an object");
	// Also rejects non-finite values that JSON.stringify would silently replace with null.
	const parametersR = rLiteral(input.parameters);
	const parameterJson = stableStringify(input.parameters);
	if (Buffer.byteLength(parameterJson) > 65536) throw new Error("Cell parameters exceed 64 KiB");
	if (input.inputs.length > 64) throw new Error("Cell inputs exceed 64 files");
	const aliases = new Set<string>();
	for (const item of input.inputs) {
		for (const name of [item.name, item.fileName])
			if (
				!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) ||
				name.endsWith(".") ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
			)
				throw new Error("Cell input mappings require portable filenames");
		if (aliases.has(item.name.toLowerCase())) throw new Error("Duplicate cell input alias");
		aliases.add(item.name.toLowerCase());
	}
	const pythonBindings = JSON.stringify(Object.fromEntries(input.inputs.map((item) => [item.name, item.fileName])));
	const rBindings = rLiteral(Object.fromEntries(input.inputs.map((item) => [item.name, item.fileName])));
	const program =
		input.language === "python"
			? [
					"import json as _pi_json, os as _pi_os, pathlib as _pi_pathlib, sys as _pi_sys",
					`parameters = _pi_json.loads(${JSON.stringify(parameterJson)})`,
					`inputs = {k: str(_pi_pathlib.Path(__file__).parent / v) for k, v in _pi_json.loads(${JSON.stringify(pythonBindings)}).items()}`,
					"output_directory = _pi_os.getcwd()",
					"_pi_os.environ['MPLBACKEND'] = 'Agg'",
					"try:",
					`    exec(compile(${JSON.stringify(input.code)}, 'study-cell.py', 'exec'), globals())`,
					"finally:",
					"    if 'matplotlib.pyplot' in _pi_sys.modules:",
					"        _pi_plt = _pi_sys.modules['matplotlib.pyplot']",
					"        for _pi_number in _pi_plt.get_fignums():",
					"            _pi_plt.figure(_pi_number).savefig(_pi_pathlib.Path(output_directory) / ('plot-%03d.png' % _pi_number))",
					"",
				].join("\n")
			: [
					`parameters <- ${parametersR}`,
					`.pi_names <- ${rBindings}`,
					'.pi_program <- Sys.getenv("R_COMPAT_PROGRAM")',
					'if (!nzchar(.pi_program)) stop("The R adapter did not supply its verified program path")',
					"inputs <- lapply(.pi_names, function(name) file.path(dirname(.pi_program), name))",
					"output_directory <- getwd()",
					'options(device = function(...) grDevices::png(filename = file.path(output_directory, "plot-%03d.png"), ...))',
					".pi_execute <- function() {",
					"  on.exit(while (grDevices::dev.cur() > 1L) grDevices::dev.off(), add = TRUE)",
					`  .pi_source <- ${JSON.stringify(input.code)}`,
					'  eval(parse(text = .pi_source, srcfile = srcfilecopy("study-cell.R", .pi_source)), envir = .GlobalEnv)',
					"}",
					".pi_execute()",
					"",
				].join("\n");
	return {
		language: input.language,
		fileName: input.language === "r" ? "program.R" : "program.py",
		program,
		protocol: "study-cell-program-v1" as const,
		compiledProgramHash: `sha256:${sha256Hex(program)}`,
	};
}
