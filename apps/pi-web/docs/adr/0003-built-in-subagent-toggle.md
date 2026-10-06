# One Host subagent implementation

Pi Web pins `pi-subagents@0.74.0` as its sole subagent engine. The old `Agent`
controller, separate profile CRUD and 0.67.0 Code dependency are deleted.
Historical Pi JSONL remains readable without restarting the old engine.

The Host loads upstream factories through private Jiti instances. Windows
detached runners drain cleanup before successful exit; selected permission
policy is forwarded without altering Host globals. The public capability
ceiling is keyed to the parent session and disposed with it. Native dynamic
tool activation stays dynamic: do not force both the full schema and lazy loader.

`/subagents` manages upstream roles, prompts, models and thinking levels.
`/subagents-fleet` manages upstream runs. Settings uses these same commands
through the existing Web custom UI, not a second role registry.

The Host baseline also includes `@eko24ive/pi-ask@1.2.0`,
`pi-context-usage@2.1.0` and existing `@ff-labs/pi-fff@0.11.0`.
Ask and context commands use the Web interactive contract. Installation does
not require the model to read a Skill or delegate without task authorization.
Chat-only sessions do not receive question/delegation tools.

Settings distinguishes disabled resources from actual uninstall. Skill deletion
removes its full installation directory and metadata. npm plugin deletion uses
npm uninstall; local plugin deletion also removes its files. Portable deletion
builds a new current package without the resource and removed offline dependencies,
then erases retired archives and unused runtimes containing that resource.
An uninstall journal allows old conversations to rebase onto the current mode
while retaining transcripts and personal settings. Unexpected missing or corrupt
resources still fail; explicit uninstall records are evidence, not a fallback.
