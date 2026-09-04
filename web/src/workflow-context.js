/** The dependency graph, not array order, defines a node's inherited work. */
export function dependencyStepIds(project, step) {
  const steps = new Map((project.steps ?? []).map((item) => [item.id, item]));
  const visited = new Set();
  const pending = [...(step?.dependencies ?? [])];
  while (pending.length) {
    const id = pending.pop();
    if (id === step?.id || visited.has(id)) continue;
    visited.add(id);
    pending.push(...(steps.get(id)?.dependencies ?? []));
  }
  return visited;
}

export function artifactContext(artifact) {
  if (!artifact) return null;
  // Inline artifacts have no file to reread, so their content is authoritative.
  const { content, ...metadata } = artifact;
  return artifact.projectRoot ? metadata : { ...metadata, content };
}

/** Explicit, versioned handoff shared by execution and both independent reviews.
 * Fresh Codex sessions must not have to infer requirements from summaries.
 */
export function workflowContext(project, step = null) {
  const inherited = step ? dependencyStepIds(project, step) : new Set((project.steps ?? []).map((item) => item.id));
  const relevant = (project.steps ?? []).filter((item) => inherited.has(item.id) || item.id === step?.id);
  return {
    contextVersion: 1,
    projectId: project.id,
    immutableRequirements: { goal: project.goal, directives: project.directives ?? [] },
    primaryArtifact: project.primaryArtifact ?? null,
    confirmedDirections: relevant.filter((item) => item.directionAnswer && !["stale", "locked"].includes(item.status)).map((item) => ({
      stepId: item.id, question: item.directionQuestion, optionId: item.selectedDirectionOptionId ?? null, answer: item.directionAnswer
    })),
    dependencyResults: relevant.filter((item) => item.id !== step?.id && item.status === "approved").map((item) => ({
      id: item.id, title: item.title, kind: item.kind, revision: item.revision,
      acceptanceCriteria: item.acceptanceCriteria ?? [],
      result: item.result ? { ...item.result, artifact: artifactContext(item.result.artifact) } : null,
      review: item.agentReview ?? null
    })),
    // A short full graph lets a verifier distinguish future work from blockers.
    workflow: (project.steps ?? []).map((item) => ({ id: item.id, title: item.title, kind: item.kind, status: item.status, dependencies: item.dependencies ?? [] })),
    references: project.executionReferences ?? [],
    attachments: project.attachments ?? []
  };
}
