/** User directories belong to the running host, never to the deployment bundle. */
export function runtimeHomeDirectory(): string {
  // A static os.homedir() import lets Next's file tracer evaluate the builder's
  // home and recursively package it when a caller lists directories. Resolve
  // this runtime-only builtin at the call boundary instead.
  return process.getBuiltinModule("os").homedir();
}
