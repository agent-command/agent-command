import { describe, expect, it } from 'vitest';
import { briefingTopics, buildBriefing, topicPage } from 'playerthree';
import { manifest } from '../src/agent/manifest.ts';
import { PLANES, type SeatMandate } from '../src/rules/contract.ts';

/** Budgets of the knowledge an agent receives (characters of MCP text content): progressive disclosure. */
const DOC_MAX = 6_000;
const ROLE_DOC_MAX = 3_500;
const TOPIC_MAX = 8_000;
const SUMMARY_MAX = 160;
const BRIEFING_MAX = 12_000;

/** A realistic owner mandate: a focus point and both house rules set. */
const MANDATE: SeatMandate = {
  autonomy: 'supervised',
  directive: { stance: 'attack', focusX: 40.5, focusY: 7.5 },
  whenAbsent: 'policy',
  limits: { asteroidDrops: false, collapses: false },
};

describe('briefing size budgets', () => {
  it('keeps the core doc and every role doc within budget', () => {
    expect(manifest.doc.length).toBeLessThanOrEqual(DOC_MAX);
    for (const role of PLANES) expect(manifest.roleDocs[role]!.length, role).toBeLessThanOrEqual(ROLE_DOC_MAX);
  });

  it('keeps every game topic within budget with a one-line summary', () => {
    expect(Object.keys(manifest.topics).length).toBeGreaterThan(0);
    for (const [name, topic] of Object.entries(manifest.topics)) {
      expect(topic.text.length, name).toBeLessThanOrEqual(TOPIC_MAX);
      expect(topic.summary.length, name).toBeLessThanOrEqual(SUMMARY_MAX);
      expect(topic.summary, name).not.toContain('\n');
    }
  });

  it('names one existing READ FIRST topic and only existing later topics in every role doc', () => {
    const names = new Set(briefingTopics(manifest).map((t) => t.name));
    for (const role of PLANES) {
      // Progressive disclosure: deploy the starter, play, then read further topics; at most one is mandatory.
      const [, first, later] = /READ FIRST: ([^.,]+)\. Later: ([^.]+)\./.exec(manifest.roleDocs[role]!) ?? [];
      expect(first, role).toBeDefined();
      for (const topic of [first!, ...later!.split(', ')]) expect(names.has(topic), `${role}: ${topic}`).toBe(true);
    }
  });

  it('keeps each seat\'s default briefing within budget', () => {
    for (const role of PLANES) {
      const briefing = buildBriefing(manifest, { team: 'nw', role }, { mandate: MANDATE });
      const json = JSON.stringify({ ...briefing, commands: [{ role, phase: 'match', team: 'nw' }] });
      expect(json.length, role).toBeLessThanOrEqual(BRIEFING_MAX);
    }
  });

  it('keeps every topic page within budget', () => {
    for (const topic of briefingTopics(manifest)) {
      expect(topic.pages.length, topic.name).toBeGreaterThan(0);
      topic.pages.forEach((page, i) => {
        expect(page.length, `${topic.name} page ${i + 1}`).toBeLessThanOrEqual(TOPIC_MAX);
        expect(topicPage(manifest, topic.name, i + 1).text).toBe(page);
      });
    }
  });
});
