'use strict';
// Unit-Tests für lib/validate.js – toIntId + inClause.
// Lauf: `node --test tests/unit/`

const test = require('node:test');
const assert = require('node:assert/strict');

const { toIntId, inClause } = require('../../lib/validate');

test('toIntId: positive Integer-Strings', () => {
  assert.equal(toIntId('1'), 1);
  assert.equal(toIntId('42'), 42);
  assert.equal(toIntId('  42  '), 42);
  assert.equal(toIntId('1234567890'), 1234567890);
});

test('toIntId: leading-zero abgelehnt', () => {
  assert.equal(toIntId('042'), null);
  assert.equal(toIntId('0'), null);
});

test('toIntId: kein Mitschleppen von Suffix', () => {
  assert.equal(toIntId('42abc'), null);
  assert.equal(toIntId('1e10'), null);
  assert.equal(toIntId('42.0'), null);
  assert.equal(toIntId('-42'), null);
  assert.equal(toIntId('+42'), null);
});

test('toIntId: number-Eingaben', () => {
  assert.equal(toIntId(42), 42);
  assert.equal(toIntId(0), null);
  assert.equal(toIntId(-1), null);
  assert.equal(toIntId(1.5), null);
  assert.equal(toIntId(NaN), null);
  assert.equal(toIntId(Infinity), null);
});

test('toIntId: jenseits Safe-Integer', () => {
  const beyond = String(Number.MAX_SAFE_INTEGER) + '0';
  assert.equal(toIntId(beyond), null);
});

test('toIntId: null/undefined/sonstige Typen', () => {
  assert.equal(toIntId(null), null);
  assert.equal(toIntId(undefined), null);
  assert.equal(toIntId(''), null);
  assert.equal(toIntId({}), null);
  assert.equal(toIntId([]), null);
  assert.equal(toIntId(true), null);
});

test('inClause: leere Liste → (NULL)', () => {
  assert.deepEqual(inClause([]), { sql: '(NULL)', values: [] });
  assert.deepEqual(inClause(null), { sql: '(NULL)', values: [] });
  assert.deepEqual(inClause(undefined), { sql: '(NULL)', values: [] });
  assert.deepEqual(inClause('not-an-array'), { sql: '(NULL)', values: [] });
});

test('inClause: gefüllte Liste', () => {
  assert.deepEqual(inClause([1]), { sql: '(?)', values: [1] });
  assert.deepEqual(inClause([1, 2, 3]), { sql: '(?,?,?)', values: [1, 2, 3] });
});

test('inClause: SQL gegen IN integriert', () => {
  const { sql, values } = inClause([10, 20]);
  assert.equal(`SELECT * FROM t WHERE id IN ${sql}`, 'SELECT * FROM t WHERE id IN (?,?)');
  assert.deepEqual(values, [10, 20]);
});
