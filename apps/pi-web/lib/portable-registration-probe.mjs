import { createJiti } from "jiti";

await createJiti(import.meta.url, { tsconfigPaths: true }).import("./portable-registration-probe.ts");
