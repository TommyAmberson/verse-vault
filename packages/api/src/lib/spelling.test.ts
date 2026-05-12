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

  it('rewrites for british', () => {
    expect(applyDialect('hard labor', 'british')).toBe('hard labour');
    expect(applyDialect('the center', 'british')).toBe('the centre');
    expect(applyDialect('great defense', 'british')).toBe('great defence');
  });

  it('british diverges from canadian on -ize verbs', () => {
    // baptize/realize/recognize stay -ize in Canadian but flip to -ise in British.
    expect(applyDialect('to baptize', 'canadian')).toBe('to baptize');
    expect(applyDialect('to baptize', 'british')).toBe('to baptise');
    expect(applyDialect('I realize', 'canadian')).toBe('I realize');
    expect(applyDialect('I realize', 'british')).toBe('I realise');
    expect(applyDialect('we recognize', 'british')).toBe('we recognise');
  });

  it('british diverges from canadian on -ization nouns', () => {
    expect(applyDialect('the organization', 'canadian')).toBe('the organization');
    expect(applyDialect('the organization', 'british')).toBe('the organisation');
  });

  it('shared canadian/british substitutions land the same in both', () => {
    // ``-our``, ``-re``, ``-ence`` and doubled-consonant inflections are
    // shared territory.
    for (const dialect of ['british', 'canadian'] as const) {
      expect(applyDialect('Savior', dialect)).toBe('Saviour');
      expect(applyDialect('the theater', dialect)).toBe('the theatre');
      expect(applyDialect('they traveled', dialect)).toBe('they travelled');
      expect(applyDialect('our defense', dialect)).toBe('our defence');
    }
  });
});
