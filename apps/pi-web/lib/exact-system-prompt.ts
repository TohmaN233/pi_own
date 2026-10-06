import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface ExactSystemPromptRef {
  current?: () => string;
}

/** Apply exact host-owned prompts through Pi's per-turn extension contract. */
export function createExactSystemPromptExtension(ref: ExactSystemPromptRef): InlineExtension {
  return {
    name: "pi-web-exact-system-prompt",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        const getPrompt = ref.current;
        return getPrompt ? { systemPrompt: getPrompt() } : undefined;
      });
    },
  };
}
