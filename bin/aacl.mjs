#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';

// Resolve the installed CLI without adopting the target project's TypeScript settings.
await tsImport('../server/cli.ts', { parentURL: import.meta.url, tsconfig: false });
