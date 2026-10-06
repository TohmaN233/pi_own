import packageManifest from "../package.json";

const piPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;
const versions = piPackages.map((name) => packageManifest.dependencies[name]);
if (versions.some((version) => !version) || new Set(versions).size !== 1) {
  throw new Error(`Pi core dependency versions have drifted: ${versions.join(", ")}`);
}

export const PI_CORE_VERSION = versions[0]!;

export function piRuntimeIdentity(): string {
  return `pi-sdk-${PI_CORE_VERSION}`;
}
