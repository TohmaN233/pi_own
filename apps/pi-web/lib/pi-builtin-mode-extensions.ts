import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export const PI_NATIVE_MCP_EXTENSION_PATH = "<inline:pi-native-mcp>";

/** Native Pi capabilities are independent. MCP follows its own server config;
 * registering only selected orchestration tools prevents MCP from implicitly
 * switching a user-disabled Codemode or tool_search back on. Scoped activities
 * retain their Host tool/source boundary and do not load ambient MCP or models. */
export function createPiBuiltinModeExtensions(
  selectedTools: readonly string[],
  options: { mcp: boolean; models?: boolean },
): Array<ExtensionFactory | { name: string; factory: ExtensionFactory }> {
  return [
    ...(selectedTools.includes("codemode") ? [createCodemodeExtension({ mode: "on", models: options.models ?? false })] : []),
    ...(options.mcp ? [{ name: "pi-native-mcp", factory: createMcpExtension() }] : []),
    ...(selectedTools.includes("tool_search") ? [createToolSearchExtension()] : []),
  ];
}

/** Configured direct MCP tools may arrive after session startup. Script-only,
 * deferred and hidden tools must keep their native exposure instead of being
 * promoted to direct declarations by the Host's mode verification. */
export function nativeMcpDirectToolNames(extensions: Array<{ path?: string; tools?: ReadonlyMap<string, unknown> }>): string[] {
  return extensions.filter((extension) => extension.path === PI_NATIVE_MCP_EXTENSION_PATH).flatMap((extension) =>
    [...(extension.tools ?? [])].flatMap(([name, registered]) => {
      if (!registered || typeof registered !== "object" || !("definition" in registered)) return [];
      const definition = registered.definition;
      return definition && typeof definition === "object" && "exposure" in definition && definition.exposure === "direct" ? [name] : [];
    }),
  );
}
