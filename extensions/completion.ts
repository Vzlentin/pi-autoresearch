import {
	clampThinkingLevel,
	type AssistantMessage,
	type Context,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelRegistry = ExtensionContext["modelRegistry"];
export type ActiveModel = NonNullable<ExtensionContext["model"]>;
export type SessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type ActiveReasoning = ThinkingLevel | undefined;

export interface ProposalCompletionRequest {
	model: ActiveModel;
	context: Context;
	thinkingLevel: SessionThinkingLevel;
	signal: AbortSignal;
}

export type CompleteProposal = (request: ProposalCompletionRequest) => Promise<AssistantMessage>;

function activeReasoning(model: ActiveModel, thinkingLevel: SessionThinkingLevel): ActiveReasoning {
	if (!model.reasoning) return undefined;
	const clamped = clampThinkingLevel(model, thinkingLevel);
	return clamped === "off" ? undefined : clamped;
}

export function createProposalCompleter(modelRegistry: ModelRegistry): CompleteProposal {
	return async ({ model, context, thinkingLevel, signal }) =>
		modelRegistry
			.streamSimple(model, context, {
				reasoning: activeReasoning(model, thinkingLevel),
				signal,
				maxRetries: 0,
				cacheRetention: "none",
			})
			.result();
}
