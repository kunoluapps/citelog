// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { AI_BOTS, CHECK_COPY, CHECK_GUIDE, CHECK_IDS, CHECK_WEIGHTS, SCORE_RULE } from '../../src/index.js';
import { ANSWER_MAX_WORDS, MIN_SERVER_WORDS, TITLE_MAX_CHARS } from '../../src/readiness/checks.js';

describe('CHECK_GUIDE', () => {
  it('covers every check with the label, why and weight of the check itself', () => {
    expect(Object.keys(CHECK_GUIDE).sort()).toEqual([...CHECK_IDS].sort());
    for (const id of CHECK_IDS) {
      const g = CHECK_GUIDE[id];
      expect(g).toMatchObject({ id, label: CHECK_COPY[id].label, why: CHECK_COPY[id].why, weight: CHECK_WEIGHTS[id] });
      expect(g.tests.length).toBeGreaterThan(10);
      expect(g.fix.length).toBeGreaterThan(10);
    }
  });

  it('quotes the thresholds the checks use', () => {
    expect(CHECK_GUIDE.direct_answer.pass).toContain(`${ANSWER_MAX_WORDS} words`);
    expect(CHECK_GUIDE.no_js_content.fail).toContain(`Under ${MIN_SERVER_WORDS} words`);
    expect(CHECK_GUIDE.title_meta.pass).toContain(`${TITLE_MAX_CHARS} characters`);
    for (const b of AI_BOTS.filter((x) => x.main)) expect(CHECK_GUIDE.robots_ai.pass).toContain(b.name);
    expect(CHECK_GUIDE.llms_txt.pass).toMatch(/Never scored/);
    expect(SCORE_RULE).toMatch(/0\.5 × weight of warnings/);
  });
});
