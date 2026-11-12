import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  endpointOf,
  mergeShapes,
  mockDifferences,
  nextRecording,
  privacyViolations,
  RECORDED,
  RECORDING_FILE,
  type Recording,
  shapeOf,
  specDifferences,
  specShape,
} from './response-shapes.ts';
import { ANSWERS } from './sevdesk-answers.ts';

// The shapes of real sevDesk answers (issue #60): the helpers on small inputs, then the recording
// of the manual E2E run (test/sevdesk-shapes.json) against the patched spec and the mock's answers.

const spec = JSON.parse(
  readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
) as unknown;

const GET_PDF = 'GET /Order/{orderId}/getPdf';
const SEQUENCE = 'GET /SevSequence/Factory/getByType';

/** A spec with one operation, `GET path`, whose 200 answer has `schema`. */
function specWith(path: string, schema: unknown) {
  return {
    paths: {
      [path]: { get: { responses: { 200: { content: { 'application/json': { schema } } } } } },
    },
  };
}

/** The getPdf answer as the official spec documents its flag: base64encoded. */
const officialGetPdf = specWith('/Order/{orderId}/getPdf', {
  type: 'object',
  properties: {
    objects: {
      type: 'object',
      properties: { base64encoded: { type: 'boolean' }, content: { type: 'string' } },
    },
  },
});

/** The sequence answer with `nextSequence` of `schema`. */
function sequenceSpec(schema: unknown) {
  return specWith('/SevSequence/Factory/getByType', {
    properties: { objects: { properties: { nextSequence: schema } } },
  });
}

describe('the shape helpers', () => {
  test('shapeOf records field paths with their types, unions across items, and never a value', () => {
    const shape = shapeOf({
      objects: [
        { id: '1', sendDate: null, sums: { net: 3 } },
        { id: '2', sendDate: '2026-11-09', 'Max Mustermann': true },
      ],
      total: 2,
    });

    expect(shape).toEqual({
      objects: 'array',
      'objects[]': 'object',
      'objects[].id': 'string',
      'objects[].sendDate': 'null|string',
      'objects[].sums': 'object',
      'objects[].sums.net': 'number',
      'objects[].*': 'boolean',
      total: 'number',
    });
    expect(shapeOf([{ id: 1 }])).toEqual({ '[]': 'object', '[].id': 'number' });
  });

  test('mergeShapes unions the types of two shapes', () => {
    expect(mergeShapes({ a: 'string' }, { a: 'null', b: 'number' })).toEqual({
      a: 'null|string',
      b: 'number',
    });
  });

  test('endpointOf finds the recorded endpoint a call is an instance of', () => {
    expect(endpointOf('GET', '/Order/42')).toBe('GET /Order/{orderId}');
    expect(endpointOf('GET', '/Order/42/getPdf')).toBe(GET_PDF);
    expect(endpointOf('POST', '/Order/Factory/saveOrder')).toBe('POST /Order/Factory/saveOrder');
    expect(endpointOf('GET', '/Order')).toBeUndefined();
    expect(endpointOf('PUT', '/Order/42')).toBeUndefined();
  });

  test('a renamed field (issue #48) is missing from the spec and from the mock answer', () => {
    const recorded = {
      objects: 'object',
      'objects.base64Encoded': 'boolean',
      'objects.content': 'string',
    };
    const mock = shapeOf({ objects: { base64encoded: true, content: 'JVBERi0=' } });

    expect(specDifferences(GET_PDF, recorded, specShape(officialGetPdf, GET_PDF))).toEqual([
      'GET /Order/{orderId}/getPdf: objects.base64Encoded: the patched spec lacks it',
    ]);
    expect(mockDifferences(GET_PDF, recorded, mock)).toEqual([
      'GET /Order/{orderId}/getPdf: objects.base64Encoded: the mock answer lacks it',
    ]);
  });

  test('a retyped field is a difference; the spec type integer counts as number', () => {
    const recorded = { 'objects.nextSequence': 'number' };

    expect(
      specDifferences(SEQUENCE, recorded, specShape(sequenceSpec({ type: 'string' }), SEQUENCE)),
    ).toEqual([
      'GET /SevSequence/Factory/getByType: objects.nextSequence: recorded number, the patched spec has string',
    ]);
    expect(
      specDifferences(SEQUENCE, recorded, specShape(sequenceSpec({ type: 'integer' }), SEQUENCE)),
    ).toEqual([]);
    expect(mockDifferences(SEQUENCE, recorded, { 'objects.nextSequence': 'string' })).toEqual([
      'GET /SevSequence/Factory/getByType: objects.nextSequence: recorded number, the mock answer has string',
    ]);
  });

  test('null: a recorded null alone matches anything; the mock gives null only where it was recorded', () => {
    const field = 'objects.nextSequence';
    const string = specShape(sequenceSpec({ type: 'string' }), SEQUENCE);
    const untyped = specShape(sequenceSpec({}), SEQUENCE);

    expect(specDifferences(SEQUENCE, { [field]: 'null' }, string)).toEqual([]);
    expect(specDifferences(SEQUENCE, { [field]: 'null|string' }, string)).toEqual([]);
    expect(specDifferences(SEQUENCE, { [field]: 'number' }, untyped)).toEqual([]);
    expect(mockDifferences(SEQUENCE, { [field]: 'null' }, { [field]: 'string' })).toEqual([]);
    expect(mockDifferences(SEQUENCE, { [field]: 'null|string' }, { [field]: 'null' })).toEqual([]);
    expect(mockDifferences(SEQUENCE, { [field]: 'string' }, { [field]: 'null' })).toEqual([
      'GET /SevSequence/Factory/getByType: objects.nextSequence: recorded string, the mock answer has null',
    ]);
  });

  test('an operation without a JSON answer in the spec is a difference', () => {
    expect(
      specDifferences(GET_PDF, { objects: 'object' }, specShape({ paths: {} }, GET_PDF)),
    ).toEqual(['GET /Order/{orderId}/getPdf: the patched spec has no JSON answer for it']);
  });

  test('privacyViolations accepts recorded fields with types and rejects anything else', () => {
    const valid = Object.fromEntries(
      Object.entries(RECORDED).map(([endpoint, fields]) => [
        endpoint,
        Object.fromEntries(fields.map((field) => [field, 'null|string'])),
      ]),
    );

    expect(privacyViolations(valid)).toEqual([]);
    expect(privacyViolations({ 'GET /Contact': { 'objects[].name': 'MCP Test GmbH' } })).toEqual([
      'GET /Contact: objects[].name: "MCP Test GmbH" is not a type',
    ]);
    expect(privacyViolations({ 'GET /Contact': { 'objects[].name': 'string|Max' } })).toEqual([
      'GET /Contact: objects[].name: "string|Max" is not a type',
    ]);
    expect(privacyViolations({ 'GET /Contact': { 'objects[].email': 'string' } })).toEqual([
      'GET /Contact: objects[].email is not a recorded field',
    ]);
    expect(privacyViolations({ 'GET /Contact/7': {} })).toEqual([
      'GET /Contact/7 is not a recorded endpoint',
    ]);
    expect(privacyViolations({ 'GET /Contact': ['string'] })).toEqual([
      'GET /Contact: not an object of fields',
    ]);
    expect(privacyViolations(['GET /Contact'])).toEqual(['the recording is not an object']);
  });

  test('nextRecording replaces what the run saw, keeps the rest and drops fields the answer lacked', () => {
    const previous: Recording = {
      'GET /Invoice/{invoiceId}': { objects: 'array' },
      'GET /Contact': { objects: 'array', 'objects[].objectName': 'string' },
      'GET /Gone': { objects: 'array' },
    };
    const seen = {
      'GET /Contact': shapeOf({ objects: [{ id: '7', name: 'MCP Test GmbH', surename: null }] }),
    };

    const next = nextRecording(previous, seen);

    expect(next).toEqual({
      'GET /Contact': { objects: 'array', 'objects[].id': 'string', 'objects[].name': 'string' },
      'GET /Invoice/{invoiceId}': { objects: 'array' },
    });
    expect(Object.keys(next)).toEqual(Object.keys(RECORDED).filter((endpoint) => endpoint in next));
  });
});

/** The recording of the last E2E run; without one, the test that needs it fails. */
function recording(): unknown {
  if (!existsSync(RECORDING_FILE)) {
    throw new Error(
      'test/sevdesk-shapes.json is missing: record it with bun run test:e2e against a real account',
    );
  }
  return JSON.parse(readFileSync(RECORDING_FILE, 'utf8')) as unknown;
}

describe('the recording of the real answers (test/sevdesk-shapes.json)', () => {
  test('holds only the recorded fields with their types, never a value', () => {
    expect(privacyViolations(recording())).toEqual([]);
  });

  test('has every field the guides, helpers and savePdf rely on', () => {
    const recorded = recording() as Recording;
    const missing = Object.entries(RECORDED).flatMap(([endpoint, fields]) =>
      fields
        .filter((field) => recorded[endpoint]?.[field] === undefined)
        .map(
          (field) =>
            `${endpoint}: ${field} is not recorded: the real answer lacked it, or no E2E run recorded it yet (bun run test:e2e)`,
        ),
    );
    expect(missing).toEqual([]);
  });

  test('the patched spec has every recorded field with its type', () => {
    const differences = Object.entries(recording() as Recording).flatMap(([endpoint, shape]) =>
      specDifferences(endpoint, shape, specShape(spec, endpoint)),
    );
    expect(differences).toEqual([]);
  });

  test("the mock's answers have every recorded field with a type the real answer had", () => {
    const recorded = recording() as Recording;
    const answers: [string, () => unknown][] = Object.entries(ANSWERS);
    expect(answers.map(([endpoint]) => endpoint)).toEqual(Object.keys(RECORDED));
    const differences = answers.flatMap(([endpoint, answer]) =>
      mockDifferences(endpoint, recorded[endpoint] ?? {}, shapeOf(answer())),
    );
    expect(differences).toEqual([]);
  });
});
