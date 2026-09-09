import type { Asset, AssetInput, Run, Snapshot } from './domain.ts';

// Absent contracts retain legacy behavior; stored revisions are never rewritten on read.
export function assetBody(a: AssetInput): string {
  const sections: string[] = a.content ? [a.content] : [];
  const list = (label: string, values: string[]) => {
    if (values.length) sections.push(`${label}:\n${values.map((v) => `- ${v}`).join('\n')}`);
  };
  if (a.skill) {
    sections.push(
      `Skill execution mode: ${a.skill.executionMode}\nExecution permission: ${a.skill.executionPermission}`,
    );
    if (a.skill.role) sections.push(`Role constraint (does not select a role): ${a.skill.role}`);
    if (a.skill.taskType)
      sections.push(`Task Type constraint (does not select a task type): ${a.skill.taskType}`);
    list('Expected output', a.skill.expectedOutput);
    list('Completion criteria', a.skill.completionCriteria);
    if (a.skill.steps?.length)
      sections.push(
        'Skill内の手順（現在のRole・Model・権限を引き継ぎます）:\n' +
          a.skill.steps
            .map(
              (s, i) =>
                `${i + 1}. ${s.skillId}${s.condition ? `（条件: ${s.condition}）` : ''}${s.input ? ` 入力: ${JSON.stringify(s.input)}` : ''}${s.output ? ` 出力: ${s.output.join(', ')}` : ''}`,
            )
            .join('\n'),
      );
  }
  if (a.role) {
    list('Responsibilities', a.role.responsibilities);
    list('Expected output', a.role.expectedOutput);
  }
  if (a.taskType) {
    if (a.taskType.objective) sections.push(`Objective: ${a.taskType.objective}`);
    list('Quality criteria', a.taskType.qualityCriteria);
    list('Constraints', a.taskType.constraints);
  }
  return sections.join('\n\n');
}
export function pinnedSkill(run: Run, snapshots: Snapshot[]): Asset | undefined {
  if (run.skill) return run.skill;
  if (!run.skillId) return undefined;
  const first = snapshots.find((s) => s.id === run.snapshotIds[0]);
  return first?.resolution.assets.find((a) => a.id === run.skillId);
}
export function runRequirements(run: Run, snapshots: Snapshot[]) {
  const stage = run.workflow?.workflow?.stages.find((s) => s.id === run.stage);
  const snapshot = snapshots.find((s) => s.id === run.snapshotIds.at(-1));
  const skills = snapshot?.resolution.assets.filter((a) => a.skill) ?? [];
  return {
    completionCriteria: [
      ...new Set([
        ...(stage?.completionCriteria ?? []),
        ...(stage && (stage.canComplete ?? !stage.transitions.length)
          ? run.workflow!.workflow!.completionCriteria
          : []),
        ...skills.flatMap((a) => a.skill!.completionCriteria),
      ]),
    ],
    expectedOutput: [
      ...new Set([
        ...(stage?.expectedOutput ?? []),
        ...skills.flatMap((a) => a.skill!.expectedOutput),
      ]),
    ],
  };
}
