import { describe, expect, it } from 'vitest';

import { applyDialect, toCanadian } from './spelling.js';

describe('toCanadian', () => {
  it('rewrites -or → -our pairs (American → Canadian primary)', () => {
    expect(toCanadian('hard labor')).toBe('hard labour');
    expect(toCanadian('show no favor')).toBe('show no favour');
    expect(toCanadian('our Savior')).toBe('our Saviour');
  });

  it('preserves leading-capital and ALL-CAPS forms', () => {
    expect(toCanadian('Labor')).toBe('Labour');
    expect(toCanadian('LABOR')).toBe('LABOUR');
    expect(toCanadian('savior')).toBe('saviour');
  });

  it('preserves surrounding punctuation', () => {
    expect(toCanadian('labor;')).toBe('labour;');
    expect(toCanadian('the labor,')).toBe('the labour,');
    expect(toCanadian('"labor"')).toBe('"labour"');
  });

  it('handles inflected forms via per-inflection varcon entries', () => {
    expect(toCanadian('laboring all day')).toBe('labouring all day');
    expect(toCanadian('he labored')).toBe('he laboured');
    expect(toCanadian('many labors')).toBe('many labours');
  });

  it('leaves unmapped words alone', () => {
    // Agent-noun -or words that stay -or in Canadian are absent from
    // varcon's substitution set, so they must NOT be touched.
    expect(toCanadian('the emperor')).toBe('the emperor');
    expect(toCanadian('the governor')).toBe('the governor');
    expect(toCanadian('Author of life')).toBe('Author of life');
  });

  it('keeps American -ize endings — varcon has no primary Canadian for them', () => {
    expect(toCanadian('Christ did not send me to <b>baptize</b>'))
      .toBe('Christ did not send me to <b>baptize</b>');
    expect(toCanadian('realize the truth')).toBe('realize the truth');
    expect(toCanadian('recognize his voice')).toBe('recognize his voice');
  });

  it('rewrites -er → -re per varcon (centre, theatre)', () => {
    expect(toCanadian('the center of the city')).toBe('the centre of the city');
    expect(toCanadian('the theater')).toBe('the theatre');
  });

  it('rewrites -ense → -ence', () => {
    expect(toCanadian('our defense')).toBe('our defence');
    expect(toCanadian('great offense')).toBe('great offence');
  });

  it('rewrites doubled-consonant inflections via varcon Z/B fallback', () => {
    // VarCon entry: `A: traveled / B: travelled`. The npm package's
    // compile script falls back C → Z → B, so Canadian inherits
    // British's `travelled` here.
    expect(toCanadian('they traveled')).toBe('they travelled');
    expect(toCanadian('he labeled')).toBe('he labelled');
  });

  it('preserves HTML tag wrappers untouched', () => {
    expect(toCanadian('with all <b>honor</b>'))
      .toBe('with all <b>honour</b>');
    expect(toCanadian('our <b><i>Savior</i></b>'))
      .toBe('our <b><i>Saviour</i></b>');
  });
});

describe('applyDialect', () => {
  it('passes american through unchanged', () => {
    expect(applyDialect('hard labor', 'american')).toBe('hard labor');
  });

  it('rewrites for canadian', () => {
    expect(applyDialect('hard labor', 'canadian')).toBe('hard labour');
  });
});
