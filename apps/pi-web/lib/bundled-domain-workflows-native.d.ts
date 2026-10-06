declare module "pi-caw/lib/workbench-api.mjs" {
  export function validatePortableWorkflowPackage(value: unknown): {
    package: { id: string };
    snapshot: { workflow: { id: string; status: string }; revision_hash: string };
  };
}
