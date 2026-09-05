import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ArgumentCompletion = {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
};

export function completeArguments(
  argumentPrefix: string,
  candidates: readonly ArgumentCompletion[],
): ArgumentCompletion[] | null {
  const query = argumentPrefix.trimStart().toLowerCase();
  const matches = candidates.filter((candidate) =>
    (candidate.searchText ?? candidate.value).toLowerCase().includes(query),
  );
  return matches.length > 0
    ? matches.map(({ searchText: _searchText, ...candidate }) => candidate)
    : null;
}

function modelDescription(model: NonNullable<ExtensionContext["model"]>): string {
  return model.name && model.name !== model.id
    ? `${model.name} · ${model.provider}`
    : model.provider;
}

export function completeModelArgument(
  argumentPrefix: string,
  context: ExtensionContext | undefined,
  specialValues: readonly ArgumentCompletion[],
): ArgumentCompletion[] | null {
  const match = argumentPrefix.match(/^model\s+(.*)$/i);
  if (!match) return null;

  const referencePrefix = match[1] ?? "";
  const models = context?.modelRegistry.getAvailable() ?? [];
  const modelCandidates: ArgumentCompletion[] = models.map((model) => {
    const reference = `${model.provider}/${model.id}`;
    return {
      value: `model ${reference}`,
      label: reference,
      description: modelDescription(model),
      searchText: `model ${reference} ${model.name ?? ""}`,
    };
  });

  const colon = referencePrefix.lastIndexOf(":");
  if (colon >= 0) {
    const baseReference = referencePrefix.slice(0, colon);
    const model = models.find(({ provider, id }) => `${provider}/${id}` === baseReference);
    if (model) {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
      const supported = levels.filter((level) => {
        if (!model.reasoning) return level === "off";
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        return level !== "xhigh" && level !== "max" || mapped !== undefined;
      });
      return completeArguments(
        argumentPrefix,
        supported.map((level) => ({
          value: `model ${baseReference}:${level}`,
          label: `${baseReference}:${level}`,
          description: `${modelDescription(model)} · ${level} thinking`,
        })),
      );
    }
  }

  const terms = referencePrefix.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [...specialValues, ...modelCandidates].filter((candidate) => {
    const searchText = (candidate.searchText ?? candidate.value.slice("model ".length)).toLowerCase();
    return terms.every((term) => searchText.includes(term));
  });
  return matches.length > 0
    ? matches.map(({ searchText: _searchText, ...candidate }) => candidate)
    : null;
}
