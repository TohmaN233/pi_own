import { basename, dirname } from "node:path";
import type { Extension, RegisteredCommand, RegisteredTool } from "@earendil-works/pi-coding-agent";

type PublicKind = "tool" | "command";
type PublicValue = RegisteredTool | RegisteredCommand;
type PublicMap = Map<string, PublicValue>;

export interface QualifiedModeRegistration {
  kind: PublicKind;
  provider: string;
  original: string;
  qualified: string;
}

function packagePrefix(path: string): string {
  const normalized = path.replaceAll("\\", "/");
	const npm = normalized.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/u)?.[1];
	const bundled = normalized.match(/\/resources\/extension\/([^/]+)/u)?.[1];
	const compiled = normalized.match(/\/module-runtime\/extension-([^/]+)\.[cm]?js$/u)?.[1];
	const source = npm ?? bundled ?? compiled ?? basename(dirname(path));
  const prefix = source.replace(/^@/u, "").replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
  if (!prefix) throw new Error(`Cannot qualify Mode Pack registration from ${path}`);
  return /^[a-z]/u.test(prefix) ? prefix : `package_${prefix}`;
}

function renamed(kind: PublicKind, value: PublicValue, name: string): PublicValue {
  return kind === "tool"
    ? { ...(value as RegisteredTool), definition: { ...(value as RegisteredTool).definition, name } }
    : { ...(value as RegisteredCommand), name };
}

/** Pi otherwise reports duplicate tools but resolves them by extension load
 * order. Qualify the concrete session registrations before Pi builds its tool
 * registry, preserving upstream extension files and Skill names. */
export function qualifyModePublicRegistrations(extensions: Extension[]): QualifiedModeRegistration[] {
  const changes: QualifiedModeRegistration[] = [];
  for (const kind of ["tool", "command"] as const) {
    const mapFor = (extension: Extension): PublicMap => (kind === "tool" ? extension.tools : extension.commands) as PublicMap;
    const owners = new Map<string, Extension[]>();
    for (const extension of extensions) {
      for (const name of mapFor(extension).keys()) owners.set(name, [...(owners.get(name) ?? []), extension]);
    }
    const reserved = new Set(owners.keys());
    const aliases = new Map<Extension, Map<string, string>>();
    const availableName = (extension: Extension, name: string): string => {
      const base = `${packagePrefix(extension.path)}_${name}`;
      let candidate = base;
      for (let index = 2; reserved.has(candidate) || extensions.some((provider) => mapFor(provider).has(candidate)); index += 1) candidate = `${base}_${index}`;
      reserved.add(candidate);
      return candidate;
    };
    for (const [name, loadedProviders] of [...owners].sort(([left], [right]) => left.localeCompare(right))) {
      // A pre-trust inline factory can be represented twice in the SDK load
      // result. Its stable extension path is still one registration owner.
      const providers = [...new Map(loadedProviders.map((provider) => [provider.path, provider])).values()];
      if (providers.length < 2) continue;
      const fixed = providers.filter((provider) => provider.path.startsWith("<inline:"));
      if (fixed.length > 1) throw new Error(`Mode Pack host registrations conflict: ${kind}:${name}: ${fixed.map((item) => item.path).join(" vs ")}`);
      for (const provider of providers.filter((candidate) => !candidate.path.startsWith("<inline:")).sort((left, right) => left.path.localeCompare(right.path))) {
        const map = mapFor(provider);
        const value = map.get(name);
        if (!value) throw new Error(`Mode Pack registration disappeared during qualification: ${kind}:${name}`);
        const qualified = availableName(provider, name);
        map.delete(name);
        map.set(qualified, renamed(kind, value, qualified));
        const alias = aliases.get(provider) ?? new Map<string, string>();
        alias.set(name, qualified);
        aliases.set(provider, alias);
        changes.push({ kind, provider: provider.path, original: name, qualified });
      }
    }
    // Late pi.registerTool()/registerCommand() writes through the same map.
    // A newly colliding registration is qualified before the SDK refreshes
    // its public registry, rather than acquiring first-wins precedence.
    for (const extension of extensions) {
      const map = mapFor(extension);
      const aliasesForExtension = aliases.get(extension) ?? new Map<string, string>();
      aliases.set(extension, aliasesForExtension);
      const originalSet = map.set.bind(map);
      map.set = (name, value) => {
        if (extension.path.startsWith("<inline:")) {
          for (const other of extensions.filter((candidate) => candidate.path !== extension.path && mapFor(candidate).has(name))) {
            if (other.path.startsWith("<inline:")) throw new Error(`Mode Pack host registrations conflict: ${kind}:${name}`);
            const otherMap = mapFor(other);
            const prior = otherMap.get(name)!;
            const qualified = availableName(other, name);
            otherMap.delete(name);
            otherMap.set(qualified, renamed(kind, prior, qualified));
            const otherAliases = aliases.get(other) ?? new Map<string, string>();
            otherAliases.set(name, qualified);
            aliases.set(other, otherAliases);
            changes.push({ kind, provider: other.path, original: name, qualified });
            console.info("[mode-pack] qualified registration after host claim", { kind, provider: other.path, original: name, qualified });
          }
          originalSet(name, value);
          reserved.add(name);
          return map;
        }
        let target = aliasesForExtension.get(name) ?? name;
        if (target === name && extensions.some((other) => other.path !== extension.path && mapFor(other).has(name))) {
          target = availableName(extension, name);
          aliasesForExtension.set(name, target);
          changes.push({ kind, provider: extension.path, original: name, qualified: target });
          console.info("[mode-pack] qualified late public registration", { kind, provider: extension.path, original: name, qualified: target });
        }
        originalSet(target, renamed(kind, value, target));
        reserved.add(target);
        return map;
      };
      const originalDelete = map.delete.bind(map);
      map.delete = (name) => originalDelete(aliasesForExtension.get(name) ?? name);
    }
  }
  for (const kind of ["flag", "shortcut"] as const) {
    const mapFor = (extension: Extension): Map<string, unknown> => (kind === "flag" ? extension.flags : extension.shortcuts) as Map<string, unknown>;
    const normalized = (name: string) => kind === "shortcut" ? name.toLocaleLowerCase("en-US") : name;
    const owners = new Map<string, Set<string>>();
    for (const extension of extensions) {
      const names = mapFor(extension)?.keys();
      if (!names) continue;
      for (const name of names) {
        const key = normalized(name);
        const paths = owners.get(key) ?? new Set<string>();
        paths.add(extension.path);
        owners.set(key, paths);
      }
    }
    for (const [name, paths] of owners) if (paths.size > 1) {
      throw new Error(`Mode Pack public ${kind} registration conflict: ${name}: ${[...paths].sort().join(" vs ")}`);
    }
    for (const extension of extensions) {
      const map = mapFor(extension);
      if (!map) continue;
      const originalSet = map.set.bind(map);
      map.set = (name, value) => {
        const key = normalized(name);
        const other = extensions.find((candidate) => candidate.path !== extension.path
          && [...(mapFor(candidate)?.keys() ?? [])].some((candidateName) => normalized(candidateName) === key));
        if (other) throw new Error(`Mode Pack public ${kind} registration conflict: ${key}: ${extension.path} vs ${other.path}`);
        originalSet(name, value);
        return map;
      };
    }
  }
  return changes;
}
