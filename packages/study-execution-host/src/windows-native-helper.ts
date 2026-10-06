import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// Both the Windows API and .NET Framework filesystem calls must accept the
// operation-owned paths, which can legitimately extend beyond MAX_PATH.
export const WINDOWS_NATIVE_HELPER_MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
	<application xmlns="urn:schemas-microsoft-com:asm.v3">
		<windowsSettings xmlns:ws2="http://schemas.microsoft.com/SMI/2016/WindowsSettings">
			<ws2:longPathAware>true</ws2:longPathAware>
		</windowsSettings>
	</application>
</assembly>
`;
export const WINDOWS_NATIVE_HELPER_APP_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
	<runtime>
		<AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=false;Switch.System.IO.BlockLongPaths=false" />
	</runtime>
</configuration>
`;

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Legacy csc and CLR startup both require a short executable path. Retain one
 * source-addressed verified image in the local application cache for recovery;
 * only compiler inputs and unpublished candidate bundles are temporary. */
export async function compileWindowsNativeHelper(options: {
	compilerPath: string;
	sourcePath: string;
	name: string;
	compilerArgs?: readonly string[];
	failure: (message: string) => Error;
}): Promise<string> {
	if (![options.compilerPath, options.sourcePath].every(isAbsolute) || !/^[A-Za-z0-9-]+[.]exe$/u.test(options.name))
		throw options.failure(
			"Windows native helper compilation requires absolute source/compiler paths and a safe executable name",
		);
	const localApplicationData = process.env.LOCALAPPDATA;
	if (!localApplicationData || !isAbsolute(localApplicationData))
		throw options.failure("Windows native helper cache requires an absolute LOCALAPPDATA directory");
	const cacheRoot = resolve(localApplicationData, "pi-own", "native");
	const source = await readFile(options.sourcePath);
	const identity = digest(
		JSON.stringify({
			source: digest(source),
			compiler: digest(await readFile(options.compilerPath)),
			name: options.name,
			arguments: options.compilerArgs ?? [],
			manifest: WINDOWS_NATIVE_HELPER_MANIFEST,
			config: WINDOWS_NATIVE_HELPER_APP_CONFIG,
		}),
	);
	const directory = join(cacheRoot, identity),
		executablePath = join(directory, options.name);
	const manifestName = `${options.name.slice(0, -4)}.manifest`,
		configName = `${options.name}.config`;
	if (Math.max(executablePath.length, join(directory, configName).length) >= 260)
		throw options.failure(`Windows native helper application cache exceeds MAX_PATH: ${directory}`);
	await mkdir(cacheRoot, { recursive: true });
	const verify = async () => {
		try {
			const receipt: unknown = JSON.parse(await readFile(join(directory, "identity.json"), "utf8"));
			if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
				throw new Error("invalid identity receipt");
			const saved = receipt as Record<string, unknown>;
			const bytes = await readFile(executablePath),
				info = await stat(executablePath);
			if (
				saved.version !== 1 ||
				saved.identity !== identity ||
				saved.executableSha256 !== digest(bytes) ||
				!info.isFile() ||
				bytes.length < 2 ||
				bytes[0] !== 0x4d ||
				bytes[1] !== 0x5a ||
				(await readFile(join(directory, manifestName), "utf8")) !== WINDOWS_NATIVE_HELPER_MANIFEST ||
				(await readFile(join(directory, configName), "utf8")) !== WINDOWS_NATIVE_HELPER_APP_CONFIG
			)
				throw new Error("compiled executable or long-path declarations differ from their retained identity");
			return executablePath;
		} catch (error) {
			throw Object.assign(
				options.failure(
					`Windows native helper cache is corrupt: ${directory}: ${error instanceof Error ? error.message : String(error)}`,
				),
				{ cause: error },
			);
		}
	};
	let installed = false;
	try {
		await stat(directory);
		installed = true;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	// Only an absent bundle permits compilation. A present damaged bundle is
	// never overwritten: the caller receives the integrity failure.
	return installed ? await verify() : await build();

	async function build(): Promise<string> {
		const temporaryRoot = await realpath(tmpdir());
		const staging = resolve(await mkdtemp(join(temporaryRoot, "pi-csc-")));
		let candidate: string | undefined;
		try {
			const sourcePath = join(staging, "helper.cs"),
				manifestPath = join(staging, "helper.manifest"),
				outputPath = join(staging, "helper.exe");
			if ([sourcePath, manifestPath, outputPath].some((path) => path.length >= 260))
				throw options.failure(`Windows compiler temporary directory exceeds MAX_PATH: ${staging}`);
			await writeFile(sourcePath, source, { flag: "wx" });
			await writeFile(manifestPath, WINDOWS_NATIVE_HELPER_MANIFEST, { flag: "wx" });
			const compiled = spawnSync(
				options.compilerPath,
				[
					"/nologo",
					"/target:exe",
					...(options.compilerArgs ?? []),
					"/win32manifest:helper.manifest",
					"/out:helper.exe",
					"helper.cs",
				],
				{ cwd: staging, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 },
			);
			if (compiled.error || compiled.status !== 0)
				throw options.failure(
					(
						[compiled.stdout, compiled.stderr, compiled.error?.message].filter(Boolean).join("\n") ||
						`csc.exe exited ${compiled.status}`
					).trim(),
				);
			const info = await stat(outputPath),
				executable = await readFile(outputPath);
			if (!info.isFile() || executable.length < 2 || executable[0] !== 0x4d || executable[1] !== 0x5a)
				throw options.failure("Windows compiler did not produce a regular PE executable");
			candidate = resolve(await mkdtemp(join(cacheRoot, ".publish-")));
			await copyFile(outputPath, join(candidate, options.name));
			await copyFile(manifestPath, join(candidate, manifestName));
			await writeFile(join(candidate, configName), WINDOWS_NATIVE_HELPER_APP_CONFIG, { flag: "wx" });
			await writeFile(
				join(candidate, "identity.json"),
				JSON.stringify({ version: 1, identity, executableSha256: digest(executable) }),
				{ flag: "wx" },
			);
			if (!(await readFile(join(candidate, options.name))).equals(executable))
				throw options.failure(`Retained Windows helper differs from its compiled bytes: ${candidate}`);
			try {
				await rename(candidate, directory);
				candidate = undefined;
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!("code" in error) ||
					!["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))
				)
					throw error;
				// Another compiler may have published this exact source identity. Its
				// complete retained bundle must pass the same checks before reuse.
				await verify();
			}
			return await verify();
		} finally {
			try {
				if (candidate) await cleanupOwnedDirectory(cacheRoot, candidate, /^[.]publish-[A-Za-z0-9]+$/u);
			} finally {
				await cleanupOwnedDirectory(temporaryRoot, staging, /^pi-csc-[A-Za-z0-9]+$/u);
			}
		}
	}

	async function cleanupOwnedDirectory(root: string, path: string, pattern: RegExp) {
		const child = relative(root, path),
			info = await lstat(path);
		const physicalRoot = resolve(await realpath(root)),
			physicalPath = resolve(await realpath(path));
		if (
			!isAbsolute(path) ||
			dirname(path) !== root ||
			!pattern.test(child) ||
			basename(path) !== child ||
			info.isSymbolicLink() ||
			!info.isDirectory() ||
			dirname(physicalPath) !== physicalRoot ||
			basename(physicalPath) !== child
		)
			throw options.failure(`Windows compiler cleanup escaped its owned temporary directory: ${path}`);
		await rm(path, { recursive: true });
	}
}
