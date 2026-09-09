import { z } from 'zod';
import type { Core } from './core.ts';
import {
  onboardingSchemas,
  onboardingDiscover,
  onboardingImport,
  onboardingGet,
  onboardingList,
  onboardingVerify,
  onboardingOrganize,
  onboardingCutover,
  onboardingRestore,
  onboardingPlan,
  onboardingConnect,
} from './onboarding.ts';

export function registerOnboarding(
  core: Core,
  endpoint: string,
  register: (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    readOnly: boolean,
    fn: (args: any) => unknown,
  ) => void,
) {
  register(
    'aacl_onboarding_discover',
    'Explore requested native asset roots or default local runtime roots. Saves a resumable manifest; excludes authentication, sessions, caches and plugin-managed content.',
    onboardingSchemas.discover.shape,
    false,
    (args) => onboardingDiscover(core, args),
  );
  register(
    'aacl_onboarding_list',
    'List saved onboarding operations and status.',
    onboardingSchemas.list.shape,
    true,
    (args) => onboardingList(core, args),
  );
  register(
    'aacl_onboarding_get',
    'Read source metadata, exclusions, backups and onboarding progress.',
    onboardingSchemas.get.shape,
    true,
    (args) => onboardingGet(core, args),
  );
  register(
    'aacl_onboarding_import',
    'Back up selected discovered files and import disabled assets with support files. Repeating does not duplicate imports.',
    onboardingSchemas.import.shape,
    false,
    (args) => onboardingImport(core, args),
  );
  register(
    'aacl_onboarding_plan',
    'Prepare connection snippets and bootstrap guidance preserving native settings. A plan does not verify a connection.',
    onboardingSchemas.plan.shape,
    true,
    (args) => onboardingPlan(core, { ...args, endpoint: args.endpoint ?? endpoint }),
  );
  register(
    'aacl_onboarding_verify',
    'After retrieving every imported asset through aacl_asset_get, record a Core write for the user onboarding request. MCP provenance is verified by the handler.',
    onboardingSchemas.verify.shape,
    false,
    (args) => onboardingVerify(core, args, 'mcp'),
  );
  register(
    'aacl_onboarding_connect',
    'Install the requested AACL MCP entry and bootstrap guide for supported local runtimes. Preserves existing values, backs up configuration privately and rejects unsupported/conflicting syntax. Installation does not manufacture connection proof.',
    onboardingSchemas.connect.shape,
    false,
    (args) => onboardingConnect(core, { ...args, endpoint: args.endpoint ?? endpoint }),
  );
  register(
    'aacl_onboarding_organize',
    'Apply user-requested classifications and saved relationships as a reversible batch. Leave uncertain assets disabled or unbound.',
    onboardingSchemas.organize.shape,
    false,
    (args) => onboardingOrganize(core, args),
  );
  register(
    'aacl_onboarding_cutover',
    'After verification and organization, stop native auto-loading by removing imported unchanged files with verified backups. Keep runtime settings and authentication.',
    onboardingSchemas.cutover.shape,
    false,
    (args) => onboardingCutover(core, args),
  );
  register(
    'aacl_onboarding_restore',
    'Restore absent native files from verified backups and optionally roll back organization. Reject later conflicting edits.',
    onboardingSchemas.restore.shape,
    false,
    (args) => onboardingRestore(core, args),
  );
}
