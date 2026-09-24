// Import a dependency-free .ts module as ESM whatever the nearest package.json says about module type.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

export async function importTs(path) {
  const js = stripTypeScriptTypes(await readFile(path, 'utf8'));
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
