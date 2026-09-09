import path from 'node:path';
import { DomainError, type Context, type Project } from './domain.ts';

export function normalizeDirectory(directory: string, project?: Project): string {
  const slash = (s: string) => s.replaceAll('\\', '/');
  let input = slash(directory);
  if (/[\x00-\x1f\x7f]/.test(input) || /^[A-Za-z]:[^/]/.test(input))
    throw new DomainError('DIRECTORY_INVALID', 'directoryのパス形式が不正です');
  for (const mapping of [...(project?.pathMappings ?? [])].sort(
    (a, b) => b.from.length - a.from.length,
  )) {
    const from = slash(mapping.from).replace(/\/$/, '');
    if (input === from || input.startsWith(from + '/')) {
      input = slash(mapping.to).replace(/\/$/, '') + input.slice(from.length);
      break;
    }
  }
  const absolute = input.startsWith('/') || /^[A-Za-z]:\//.test(input);
  if (absolute) {
    if (!project)
      throw new DomainError(
        'DIRECTORY_PROJECT_REQUIRED',
        '絶対directoryにはProjectを指定してください',
      );
    const root = slash(project.root);
    const windows = /^[A-Za-z]:\//.test(root) || root.startsWith('//');
    const api = windows ? path.win32 : path.posix;
    if (windows !== (/^[A-Za-z]:\//.test(input) || input.startsWith('//')))
      throw new DomainError(
        'DIRECTORY_MAPPING_REQUIRED',
        '別OSのパスにはProjectのpathMappingsを設定してください',
      );
    const relative = slash(api.relative(root, input));
    if (relative === '..' || relative.startsWith('../') || api.isAbsolute(relative))
      throw new DomainError('DIRECTORY_OUTSIDE_PROJECT', 'directoryは指定Projectの外です');
    return windows ? (relative || '.').toLowerCase() : relative || '.';
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '..' || normalized.startsWith('../'))
    throw new DomainError('DIRECTORY_OUTSIDE_PROJECT', 'directoryはProject相対で指定してください');
  return project && (/^[A-Za-z]:/.test(project.root) || slash(project.root).startsWith('//'))
    ? normalized.toLowerCase()
    : normalized;
}

export function normalizeProjectContext(context: Context, projects: Project[]): Context {
  const ctx = { ...context };
  let project: Project | undefined;
  if (ctx.project) {
    project = projects.find((p) => p.id === ctx.project);
    if (!project) {
      const matches = projects.filter((p) => p.name === ctx.project || p.root === ctx.project);
      if (matches.length > 1)
        throw new DomainError(
          'PROJECT_AMBIGUOUS',
          `同名Projectが複数あります。IDで指定してください: ${matches.map((p) => `${p.id} (${p.root})`).join(', ')}`,
        );
      project = matches[0];
    }
    if (!project)
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Projectが未登録です。aacl_project_listで候補を確認してください',
        404,
      );
    ctx.project = project.id;
  }
  if (ctx.directory) ctx.directory = normalizeDirectory(ctx.directory, project);
  return ctx;
}
