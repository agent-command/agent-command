/** Dev-only document/LDtk pipeline; never mounted as a public upload endpoint. */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkRules, resolveRules, type TerrainPreset } from '../../packages/game/src/rules/contract.ts';
import { generateMapDocument, hashMapDocument } from '../../packages/game/src/maps/maps.ts';
import { exportLdtk, importLdtk, validateMapDocument, type MapDocument } from '../../packages/game/src/maps/document.ts';

const [command, input, output, sizeText, generatedOutput] = process.argv.slice(2);
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
if (command === 'generate' && input && output && sizeText && generatedOutput) {
  const seed = Number(output), size = Number(sizeText);
  const checked = checkRules({ terrain: input, map: { seed, params: { size } } });
  if (!checked.ok) throw new Error(checked.error);
  const rules = resolveRules(checked.options);
  save(generatedOutput, generateMapDocument(seed, input as TerrainPreset, rules.map, 2, seed));
} else if (command === 'export' && input && output) {
  const document = json(input);
  const result = validateMapDocument(document);
  if (!result.valid) throw new Error(result.errors.join('; '));
  save(output, exportLdtk(document as MapDocument));
} else if (command === 'import' && input && output) {
  save(output, importLdtk(json(input)));
} else if (command === 'inspect' && input) {
  const document = json(input);
  const result = validateMapDocument(document);
  console.log(JSON.stringify({ valid: result.valid, errors: result.errors, hash: result.valid ? hashMapDocument(document as MapDocument) : undefined, fairness: result.fairness }, null, 2));
  if (!result.valid) process.exitCode = 1;
} else {
  throw new Error('Usage: maps/main.ts generate <preset> <seed> <48|64|80> <map.json> | export <map.json> <project.ldtk> | import <project.ldtk> <map.json> | inspect <map.json>');
}
