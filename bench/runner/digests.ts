import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import { BUILD } from '../acbench-ladder.ts';
console.log(JSON.stringify({ gameDigest: await benchmarkSourceDigest(BUILD.game), runnerDigest: await benchmarkSourceDigest(BUILD.runner) }));
