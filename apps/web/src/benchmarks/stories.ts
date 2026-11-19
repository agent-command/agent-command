/**
 * Curated narrative for a benchmark release page, keyed by release id: the publication format is closed, so the story
 * (TL;DR, chart verdict, per-model cards) lives here like REFERENCES. Every number is reproducible from the release's
 * published results and authoring ledgers.
 */
export interface ModelStory {
  /** Two or three words, e.g. "Reaver Champion". */
  nickname: string;
  /** Exactly two short sentences, each grounded in a number. */
  bullets: readonly string[];
  /** Favorite Strategy: a label and one data line. */
  strategy: { label: string; detail: string };
  /** Favorite Unit; the page renders `${ratio.toFixed(1)}× the rest of the field`, `detail` is an optional extra line. */
  unit: { name: string; ratio: number; detail?: string };
  /** A short gameplay clip (absolute site paths) beside the card. */
  clip?: { src: string; poster: string; caption: string };
}
export interface ReleaseStory {
  /** Three bullets on what the benchmark is. */
  tldr: readonly string[];
  /** Two sentences under the headline chart. */
  verdict: string;
  /** Implementation details: Objective paragraph. */
  objective: string;
  /** Implementation details: Harness setup paragraph. */
  harness: string;
  /** By publication `experiment.system.id` (the PROFILE_NOTES key); a system without one gets no card text. */
  models: Readonly<Record<string, ModelStory>>;
  /** Authoring turns (model replies) by system id, the mean of its runs, for every system in the release (not carried by publications). */
  turns: Readonly<Record<string, number>>;
}
const clip = (releaseId: string, systemId: string, caption: string): NonNullable<ModelStory['clip']> => ({
  src: `/benchmarks/clips/${releaseId}/${systemId}.mp4`,
  poster: `/benchmarks/clips/${releaseId}/${systemId}.jpg`,
  caption,
});
export const STORIES: Readonly<Record<string, ReleaseStory>> = {
  'acbench-v0-1': {
    tldr: [
      'ACBench measures how well a language model writes a bot: in 45 minutes, with the same tools a player\'s agent uses, it writes the policies that run all four planes of Agent Command.',
      'Every model starts from the same economy-only skeleton, which scores 0, and may read and reuse the built-in bots\' source; it practises against bots up to Veteran.',
      'The frozen policies then play 30 games against the built-in ladder, Novice to Champion, on three maps from both sides; the score is the share of games won, draws counting half.',
    ],
    verdict: 'GPT-6.2 Astra won 27 of its 30 games and beat the Champion in 4 of 6, destroying the enemy Spire in 24 games. No other model won a single game against Elite or Champion; the next best, DeepSeek V4.1 Flash at 43.3, took all 13 of its wins on Spire HP at the time cap.',
    objective: 'Win the most of 30 evaluation games. A game is won by destroying the enemy\'s Surface Spire segment, or by leading at the 30-minute cap (fewest crowns lost, then most Spire HP). Score is 100 × the mean of win 1, draw ½, loss 0 over five opponents (Novice, Standard, Veteran, Elite, Champion) × three maps (Crossfire, Twin Fords, Crown) × both sides.',
    harness: 'Each model ran once in OpenCode through OpenRouter, pinned to a single provider with fallbacks off, for 45 minutes of wall-clock authoring. It commands all four seats through the game\'s MCP tools: briefings and skill files, policy deploys, practice runs against idle, Novice, Standard or Veteran bots on two practice seeds, and policy status. Elite and Champion are evaluation-only. The policies active at the deadline are frozen and evaluated; with one run per model there is no run-to-run interval.',
    models: {
      'gpt-6.2-astra': {
        nickname: 'Spire Breaker',
        bullets: [
          'Destroyed the enemy Spire in 24 of 30 games, the fastest at 4.5 minutes; tanks dealt 76% of its Spire damage.',
          'Forked the built-in Surface bot and set its build mix to tanks only, then tested it in 95 practice games against Veteran.',
        ],
        strategy: { label: 'Bombers open, tanks finish', detail: 'A bomber made its first kill inside the enemy base in 14 of 30 games (median 1.6 min in).' },
        unit: { name: 'Tank', ratio: 3.0, detail: '21.1 per game; 5,226 Spire damage per game' },
        clip: clip('acbench-v0-1', 'gpt-6.2-astra', 'GPT-6.2 Astra\'s tank line finishes the Champion\'s Surface Spire on Crown at 5 min 42 s.'),
      },
      'deepseek-v4.1-flash': {
        nickname: 'Knob Tuner',
        bullets: [
          'Wrote no code: it deployed the stock starters on all four planes and tuned 48 of their knobs, for $0.11, under a tenth of any other run.',
          'All 13 of its wins came on Spire HP at the 30-minute cap; it never destroyed a Spire.',
        ],
        strategy: { label: 'Tunnel early', detail: 'Set the Depths starter to tunnel from minute 3 (stock: never) with 3 sappers; tunnel collapses became its top source of Spire damage (1,073 per game).' },
        unit: { name: 'Sapper', ratio: 3.5, detail: '7.5 per game, from its own Depths knobs' },
        clip: clip('acbench-v0-1', 'deepseek-v4.1-flash', 'A tunnel collapses under the Novice\'s Spire on Twin Fords: the first of nine collapses DeepSeek V4.1 Flash set off that game.'),
      },
      'glm-5.3': {
        nickname: 'Off the Shelf',
        bullets: [
          'Wrote no strategy of its own: the built-in Veteran bot runs Depths (with sandbox limits), Sky and Orbit, and the stock starter runs Surface after it rolled its Surface fork back.',
          'Used 44 turns, the fewest of the field, and practised just 18 games, losing 2.',
        ],
        strategy: { label: 'Stock bots', detail: 'Its army is the built-in bots\': 21.4 troopers per game from the stock Surface starter, the field\'s most.' },
        unit: { name: 'Trooper', ratio: 1.9, detail: '21.4 per game, from the unchanged Surface starter' },
        clip: clip('acbench-v0-1', 'glm-5.3', 'GLM 5.3\'s bomber, escorted by interceptors, brings down the Standard bot\'s Surface Spire on Crown at 18 min 43 s.'),
      },
      'qwen4-max': {
        nickname: 'Open Door',
        bullets: [
          'Forked the Veteran Surface bot to switch off its opening defence (no 12-unit home army first) and build five Headframes instead of three, then tested it only against Veteran.',
          'The Novice made it pay: it destroyed Qwen4 Max\'s Spire in all four games on Crossfire and Crown, and its Spire fell 16 times in all, the most of any model.',
        ],
        strategy: { label: 'Tunnel from minute 4', detail: 'Copied the Veteran\'s Depths settings into the starter\'s knobs (3 sappers, tunnelling from minute 4; stock: never): 107 sapper charges, the field\'s most.' },
        unit: { name: 'Sapper', ratio: 4.6, detail: '8.9 per game, from its own Depths knobs' },
        clip: clip('acbench-v0-1', 'qwen4-max', 'A tunnel collapse under the Novice\'s Spire on Twin Fords brings it down eight seconds before the time cap.'),
      },
      'gpt-6.2-sol': {
        nickname: 'Wrong Rulebook',
        bullets: [
          'Practised the most, 146 games, and by its own choice ran 136 of them under the optional crowns rule, which no evaluation game used.',
          'Wrote map-specific branches on three planes, but its only Twin Fords branch switches on under the crowns rule, so it never ran in evaluation.',
        ],
        strategy: { label: 'Crossfire special', detail: 'On Crossfire all three of its map branches switch on; it won 4 of 10 there and 2 of 10 on each other map.' },
        unit: { name: 'Skiff', ratio: 3.0, detail: '2.7 per game, from the stock Orbit starter it never changed' },
        clip: clip('acbench-v0-1', 'gpt-6.2-sol', 'On Crossfire, where its map branches switch on, GPT-6.2 Sol brings down the Standard bot\'s Surface Spire at 24 min 15 s.'),
      },
      'gpt-6-astra': {
        nickname: 'Home Guard',
        bullets: [
          'Never destroyed a Spire: 26 of 30 games ran to the 30-minute cap, and it lost 20 of them on Spire HP.',
          'Spent its authoring on Depths: 34 of its 76 practice games and 12 reads of the Depths bot\'s source, with its last Depths change 55 seconds before the deadline.',
        ],
        strategy: { label: 'Diggers over sappers', detail: 'Set its Depths fork to 10 diggers, 3 wardens and no sappers: 0.07 sappers per game against the field\'s 3.4.' },
        unit: { name: 'Interceptor', ratio: 1.3, detail: '26.1 per game, from the stock Sky starter it never changed' },
        clip: clip('acbench-v0-1', 'gpt-6-astra', 'The Elite\'s air wing reaches GPT-6 Astra\'s Spire, and the Spire itself shoots down four interceptors in nine seconds.'),
      },
      'gpt-6.1-sol': {
        nickname: 'Empty Orbit',
        bullets: [
          'Forked only its Surface; Sky kept the stock starter and Orbit ran the starter with lancers set to zero.',
          'Its Surface fork switches off raids and breachers: it opened no breaches into an enemy Surface, where five of the other six models opened 18–52.',
        ],
        strategy: { label: 'Empty orbit', detail: 'Its Orbit knobs (3 solar arrays, 1 tug, no lancers) left 3.9 Orbit units per game, the field\'s fewest (others 9.1–20.1).' },
        unit: { name: 'Flak', ratio: 1.5, detail: '8.3 per game, from its Veteran-based Surface fork' },
        clip: clip('acbench-v0-1', 'gpt-6.1-sol', 'The Elite brings down GPT-6.1 Sol\'s Surface Spire on Crossfire at 17 min 50 s.'),
      },
    },
    turns: {
      'gpt-6.2-astra': 119,
      'deepseek-v4.1-flash': 142,
      'glm-5.3': 44,
      'qwen4-max': 61,
      'gpt-6.2-sol': 164,
      'gpt-6-astra': 105,
      'gpt-6.1-sol': 101,
    },
  },
  'acbench-v0-2': {
    tldr: [
      'ACBench measures how well a language model writes a bot: in 45 minutes, with the same tools a player\'s agent uses, it writes the policies that run all four planes of Agent Command, starting from an economy-only skeleton that scores 0.',
      'v0.2 runs every model three times from scratch and scores each run\'s frozen policies in 30 games against the built-in ladder, Novice to Champion; a model\'s score is the mean of its three runs.',
      'The built-in bots set the bar: on the same ladder the Veteran bot scores 50, the Champion bot 83.3 and the default starters 20.',
    ],
    verdict: 'GPT-6.2 Sol won 89 of its 90 games and all 18 against the Champion, scoring above the Champion bot\'s 83.3 in every run. Other models swung from run to run: GPT-6.2 Astra scored 30 and then 100 twice, GPT-6.1 Sol 23.3, 96.7 and 13.3, and Gemini 4 Neon up to 96.7, while Claude Opus 5.5 held steady at 12–15 wins per run and beat no Champion.',
    objective: 'Win the most of 30 evaluation games per run. A game is won by destroying the enemy\'s Surface Spire segment, or by leading at the 30-minute cap (fewest crowns lost, then most Spire HP). A run\'s score is 100 × the mean of win 1, draw ½, loss 0 over five opponents (Novice, Standard, Veteran, Elite, Champion) × three maps (Crossfire, Twin Fords, Crown) × both sides; a model\'s score is the mean of its three runs.',
    harness: 'Each model ran three independent times in OpenCode for 45 minutes of wall-clock authoring, with reasoning effort high and a $40 list-price cap per run, speaking its family\'s own API: Claude and GPT models through their Claude and ChatGPT subscriptions, the others through OpenRouter pinned to a single provider with fallbacks off. It commands all four seats through the game\'s MCP tools: briefings and skill files, policy deploys, practice runs against the built-in bots on two practice seeds, and policy status. The policies active at the deadline are frozen and evaluated.',
    models: {},
    turns: {
      'gpt-6.2-sol-subscription': 71,
      'gpt-6.2-astra-subscription': 258,
      'gpt-6.1-sol-subscription': 125,
      'gpt-6-astra-subscription': 140,
      'claude-opus-5.5-subscription': 59,
      'claude-fable-5.2-subscription': 74,
      'gemini-4-neon': 75,
      'glm-5.3': 57,
      'deepseek-v4.1-flash': 129,
      'qwen4-max': 49,
    },
  },
};
export const storyFor = (releaseId: string): ReleaseStory | null => Object.hasOwn(STORIES, releaseId) ? STORIES[releaseId]! : null;
