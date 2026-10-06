import generatedArchive from "../runtime/mode-packs/coding.archive.json";
import { parsePortableModePackage, type PortableModePackage } from "../../../packages/mode-pack-host/src/portable-mode-package.ts";

let parsedArchive: PortableModePackage | undefined;

/** Generated at prebuild, then statically imported so Next and a relocated
 * pi-web installation never need a repository checkout to activate Code. */
export function bundledCodeModePackage(): PortableModePackage {
  parsedArchive ??= parsePortableModePackage(generatedArchive);
  return parsedArchive;
}

export function isBundledCodeModePackage(hash: string): boolean {
  return bundledCodeModePackage().packageContentHash === hash;
}
