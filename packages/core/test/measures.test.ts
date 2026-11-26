// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { autoStage, defaultBrandTerms, MEASURES } from '../src/index.js';

describe('autoStage (SCOPE decision 4)', () => {
  it.each([
    ['roth ira for beginners', 'discovery'],
    ['best app to learn investing', 'discovery'],
    ['what is an etf', 'discovery'],
    ['bywell vs acorns for learning', 'evaluation'],
    ['acorns alternative', 'evaluation'],
    ['bywell review', 'evaluation'],
    ['compare robo advisors', 'evaluation'],
    ['is bywell premium worth it', 'decision'],
    ['bywell price', 'decision'],
    ['how much does bywell cost', 'decision'],
    ['sign up for bywell', 'decision'],
    ['best price vs acorns', 'decision'],
    ['versioning tips', 'discovery'],
  ] as const)('%s → %s', (prompt, stage) => {
    expect(autoStage(prompt)).toBe(stage);
  });
});

describe('defaultBrandTerms', () => {
  it('site name and domain, de-duplicated, www dropped', () => {
    expect(defaultBrandTerms('Bywell', 'www.bywell.org')).toEqual(['Bywell', 'bywell.org']);
    expect(defaultBrandTerms('bywell.org', 'bywell.org')).toEqual(['bywell.org', 'bywell']);
    expect(defaultBrandTerms(null, 'ansa.chat')).toEqual(['ansa', 'ansa.chat']);
    expect(defaultBrandTerms(null, 'blog.example.co.uk')).toEqual(['blog.example.co.uk']);
    expect(MEASURES.brandTermsPerSite).toBe(5);
  });
});
