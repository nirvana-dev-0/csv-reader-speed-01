// Driver for this entry: the harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported so all of its work runs under them (the rules: the house baseline runs
// with --no-incremental-marking, and an entry may tune V8's flags too).
// --no-incremental-marking: as the house baseline (marking the answer graph a step at a time cost ~0.4 s).
// --no-opt: every heat round is a fresh process, so run() is always cold: TurboFan's optimisation of the hot loop
// costs more CPU (~0.5 s) than it saves on a ~0.2 s warm parse. Measured on the practice set, cold first call
// 1.07-1.13 s with optimisation vs 0.45-0.57 s without, end-to-end CPU 2.0-2.2 s vs 1.5-1.7 s; answers identical.
setFlagsFromString('--no-incremental-marking --no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
