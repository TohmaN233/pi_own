# Mode Ecosystem

Pi-own modes are user-selectable experiences that can be assembled, installed, and moved between compatible hosts.

## Language

**Mode Pack**:
The portable unit that describes one mode's behavior, selected capabilities, resources, and any mode-specific frontend. Every mode can be exported as a Mode Pack.
_Avoid_: Code Mode package

**Mode Component**:
An independently identifiable part of a Mode Pack that can be selected, replaced, or shared when assembling modes.
_Avoid_: Function

Component names alone are not globally unique identities. Same-named, different-content components in separate mode scopes may coexist.

**Qualified Registration**:
A public tool, command, or capability name deterministically prefixed with its package identity when two providers would otherwise expose the same name in one active session. Skills are excluded and retain their upstream names. The package's original bytes remain unchanged; the host records the mapping used at activation.

**Selected Skill Name**:
The unprefixed upstream Skill name exposed by one active mode. A portable mode package cannot contain two selectable providers with the same Skill name, even if their main `SKILL.md` bytes match; support files may differ, and an optional provider could be enabled later. Import preflight rejects the ambiguous package before activation. Separate modes may each select their own version.

**Local Dependency**:
A mode-owned component needed on the user's machine. Its full content and dependency edges travel with the exported Mode Pack. A separately declared host prerequisite is an External Dependency, not an implicit missing file.

**External Dependency**:
A declared requirement supplied by the target host rather than bundled in the Mode Pack, such as a local executable or compatible Pi runtime. Import preflight checks it, lists any missing or incompatible requirement, and leaves resolution to the Pi agent before import can succeed.

**Target Platform**:
The operating system and architecture for which a Mode Pack contains complete mode-owned content. Import preflight rejects a different target platform before installation.

**Install Conflict**:
A detected incompatibility in the mechanical import preflight between a Mode Pack's requested components and components already installed for Pi or another mode. A shared name with different content is not itself a conflict when the components can remain isolated or their public registrations can be qualified. Registration and installation stop before activation only for a real incompatible dependency or an unresolved registration collision after qualification; the report compares the conflicting components and dependencies. A conflict discovered only during normal mode use is an implementation defect, not the intended resolution flow.

**Compatible Upgrade**:
Selecting the newest shared component version only when it satisfies every installed mode's explicitly declared compatibility requirements and passes verification. Without such a declaration, the installed version and content hash must match exactly; otherwise import fails with an Install Conflict.

**Import Work Module**:
The user-facing pi-own action for importing a portable Mode Pack. Import runs a mechanical dependency and registration conflict preflight. A failed preflight produces a prepared diagnostic prompt for the Pi agent; Pi-session imports deliver it to that agent, and the frontend may expose an explicit send action.

**Hot-Installable Frontend**:
A Mode Pack frontend whose bundled assets and host capability bindings become usable immediately after a successful import, without rebuilding or restarting pi-own.
