import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const PERMISSION_CATEGORIES = ["tools", "bash", "mcp", "skills", "special"] as const;
export const INSPECTION_TOOLS = ["read", "grep", "find", "ls", "code_overview", "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_symbols", "lsp_completions", "lsp_code_actions"] as const;
export type PermissionState = "allow" | "ask" | "deny";
export type PermissionPreset = "confirm" | "read" | "auto";
export type PermissionScope = "global" | "project";
export type PermissionPolicy = Partial<Record<typeof PERMISSION_CATEGORIES[number] | "defaultPolicy", Record<string, PermissionState>>>;

export interface PermissionSettings {
  scope: PermissionScope;
  path: string;
  source: string;
  contentHash: string;
  policy: PermissionPolicy;
  globalPolicy: PermissionPolicy;
  cwd: string | null;
  active: boolean;
}

export function parsePermissionPolicy(source: string): PermissionPolicy {
  const errors: ParseError[] = [];
  const policy: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length) {
    const first = errors[0];
    const prefix = source.slice(0, first.offset).split("\n");
    throw new Error(`${printParseErrorCode(first.error)}: line ${prefix.length}, column ${prefix.at(-1)!.length + 1}`);
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Permission policy must be an object");
  for (const [category, rules] of Object.entries(policy)) {
    if (category !== "defaultPolicy" && !PERMISSION_CATEGORIES.includes(category as typeof PERMISSION_CATEGORIES[number])) throw new Error(`Unknown permission category: ${category}`);
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error(`${category} must be an object`);
    for (const [key, state] of Object.entries(rules)) {
      if (!key.trim() || typeof state !== "string" || !["allow", "ask", "deny"].includes(state)) throw new Error(`Invalid permission rule: ${category}.${key}`);
      if (category === "defaultPolicy" && !PERMISSION_CATEGORIES.includes(key as typeof PERMISSION_CATEGORIES[number])) throw new Error(`Unknown default policy: ${key}`);
    }
  }
  return policy as PermissionPolicy;
}

/** Preset selection preserves explicit deny rules. Project wildcards override
 * inherited allows while the upstream engine retains global deny floors. */
export function permissionPreset(policy: PermissionPolicy, preset: PermissionPreset): PermissionPolicy {
  const state = preset === "auto" ? "allow" : "ask";
  const next: PermissionPolicy = { defaultPolicy: {}, special: { ...policy.special } };
  for (const category of PERMISSION_CATEGORIES) {
    next.defaultPolicy![category] = policy.defaultPolicy?.[category] === "deny" ? "deny" : category === "special" ? "ask" : state;
    if (category === "special") continue;
    const denies = Object.fromEntries(Object.entries(policy[category] ?? {}).filter(([, value]) => value === "deny"));
    const denied = policy.defaultPolicy?.[category] === "deny";
    const inspection = !denied && category === "tools" && preset === "read" ? Object.fromEntries(INSPECTION_TOOLS.map((name) => [name, "allow" as const])) : {};
    next[category] = { "*": denied ? "deny" : state, ...inspection, ...denies };
  }
  return next;
}

export function identifyPermissionPreset(policy: PermissionPolicy): PermissionPreset | "custom" {
  if (policy.tools?.["*"] === "allow" && policy.bash?.["*"] === "allow" && policy.mcp?.["*"] === "allow" && policy.skills?.["*"] === "allow") return "auto";
  if (INSPECTION_TOOLS.every((name) => policy.tools?.[name] === "allow") && (policy.tools?.["*"] ?? policy.defaultPolicy?.tools ?? "ask") === "ask") return "read";
  if (PERMISSION_CATEGORIES.every((category) => (policy[category]?.["*"] ?? policy.defaultPolicy?.[category] ?? "ask") === "ask") && Object.values(policy.tools ?? {}).every((state) => state !== "allow")) return "confirm";
  return "custom";
}
