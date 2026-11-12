// The shapes of real sevDesk answers (issue #60): field names and types, never values. The manual
// E2E run records them through test/e2e/record-shapes.ts and writes the fields of `RECORDED` to
// test/sevdesk-shapes.json; test/response-shapes.test.ts checks the patched spec and the mock's
// canonical answers (test/sevdesk-answers.ts) against that recording. It imports nothing, because
// the recorder loads it into the server the E2E run spawns.

/**
 * A shape: each field path with its types. A path joins the keys with `.` and writes an array item
 * as `[]` (`objects[].update`, `objects.order.id`); a key that is no identifier becomes `*`, so a
 * key can never carry a value. The types are those of `TYPES`, sorted and joined by `|`
 * (`null|string`).
 */
export type Shape = Record<string, string>;

/** The recorded shapes by endpoint (`METHOD /path template`), as test/sevdesk-shapes.json has them. */
export type Recording = Record<string, Shape>;

/** The recording of the last E2E run, written by test/e2e/live.e2e.ts only. */
export const RECORDING_FILE = new URL('./sevdesk-shapes.json', import.meta.url);

/** The types a shape knows: those of JSON values. */
const TYPES = new Set(['array', 'boolean', 'null', 'number', 'object', 'string']);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `fields` of each document in a list answer, after the list itself. */
function rows(fields: string[]): string[] {
  return ['objects', ...fields.map((field) => `objects[].${field}`)];
}

/**
 * The endpoints whose real answers the E2E run records, each with the fields the guides, helpers
 * and `savePdf` rely on: only these reach the recording, so it stays stable and holds no more than
 * the checks need.
 */
export const RECORDED: Record<string, string[]> = {
  // The offer guide, step 1; the E2E run's contact lookup.
  'GET /Contact': rows(['id', 'objectName', 'name']),
  // The offer guide, step 3.
  'GET /SevSequence/Factory/getByType': ['objects', 'objects.format', 'objects.nextSequence'],
  // The offer guide, step 5, and the writes ledger's object id.
  'POST /Order/Factory/saveOrder': [
    'objects',
    'objects.order',
    'objects.order.id',
    'objects.orderPos',
  ],
  // savePdf and a getPdf through sevdesk.request (number, status, update), the confirmation preview
  // and the E2E run's cleanup.
  'GET /Order/{orderId}': rows([
    'id',
    'objectName',
    'orderNumber',
    'orderType',
    'orderDate',
    'status',
    'update',
    'sendDate',
    'header',
    'headText',
    'address',
    'currency',
    'sumNet',
    'sumGross',
  ]),
  // The pagination guide; the position fields of the saveOrder template.
  'GET /Order/{orderId}/getPositions': rows([
    'id',
    'objectName',
    'name',
    'quantity',
    'price',
    'taxRate',
    'unity',
    'unity.id',
  ]),
  // pdfBytes() and the delivery guide.
  'GET /Order/{orderId}/getPdf': [
    'objects',
    'objects.filename',
    'objects.mimeType',
    'objects.base64Encoded',
    'objects.content',
  ],
  // No code reads the render answer; these are the fields the mock's answer gives.
  'POST /Order/{orderId}/render': ['objects', 'objects.docId'],
  // savePdf('Invoice') and the confirmation preview.
  'GET /Invoice/{invoiceId}': rows([
    'id',
    'objectName',
    'invoiceNumber',
    'invoiceDate',
    'status',
    'update',
    'address',
    'currency',
    'sumNet',
    'sumGross',
  ]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The union of the types `a` (if any) and `b`, sorted and joined by `|`. */
function union(a: string | undefined, b: string): string {
  const types = new Set([...(a?.split('|') ?? []), ...b.split('|')]);
  return [...types].sort().join('|');
}

/** The type of a JSON value. */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** The shape of a JSON value: the types of every field at every depth, never a value. */
export function shapeOf(value: unknown): Shape {
  const shape: Shape = {};
  const visit = (field: unknown, path: string) => {
    shape[path] = union(shape[path], typeOf(field));
    walk(field, path);
  };
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, `${path}[]`);
    } else if (isRecord(node)) {
      for (const [key, field] of Object.entries(node)) {
        visit(field, child(path, IDENTIFIER.test(key) ? key : '*'));
      }
    }
  };
  walk(value, '');
  return shape;
}

/** Both shapes in one: every path of either, with the union of its types. */
export function mergeShapes(a: Shape, b: Shape): Shape {
  const merged = { ...a };
  for (const [path, types] of Object.entries(b)) merged[path] = union(merged[path], types);
  return merged;
}

// Each recorded endpoint's path template as a pattern: a parameter matches one segment.
const TEMPLATES = Object.keys(RECORDED).map((endpoint) => {
  const [method = '', template = ''] = endpoint.split(' ');
  return { endpoint, method, pattern: new RegExp(`^${template.replace(/\{\w+\}/g, '[^/]+')}$`) };
});

/** The recorded endpoint `method path` (a path relative to the API base) is a call of, if any. */
export function endpointOf(method: string, path: string): string | undefined {
  return TEMPLATES.find((template) => template.method === method && template.pattern.test(path))
    ?.endpoint;
}

/** A JSON schema of the patched spec, as far as a shape reads it. */
interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
}

/** The answers of an operation of the patched spec, as far as a shape reads them. */
interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: Schema } | undefined> }>;
}

/** A schema's type as a shape writes it; `any` when the spec does not say. */
function specType({ type, properties, items }: Schema): string {
  if (type === 'integer') return 'number';
  if (type !== undefined) return type;
  if (properties !== undefined) return 'object';
  return items === undefined ? 'any' : 'array';
}

/** Adds the fields of `schema` below `path` to `shape`, like `shapeOf` writes them. */
function flatten(schema: Schema, path: string, shape: Shape): void {
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const at = child(path, key);
    shape[at] = specType(field);
    flatten(field, at, shape);
  }
  if (schema.items !== undefined) {
    shape[`${path}[]`] = specType(schema.items);
    flatten(schema.items, `${path}[]`, shape);
  }
}

/**
 * The shape of the JSON answer `spec` (the patched spec, `$ref`s resolved) documents for
 * `endpoint`, its first 2xx answer; undefined when it documents none. A field the spec gives no
 * type has the type `any`.
 */
export function specShape(spec: unknown, endpoint: string): Shape | undefined {
  const [method = '', path = ''] = endpoint.split(' ');
  const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
  const operations = paths[path];
  const operation = isRecord(operations)
    ? (operations[method.toLowerCase()] as Operation | undefined)
    : undefined;
  const answers = Object.entries(operation?.responses ?? {})
    .filter(([status]) => status.startsWith('2'))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [, answer] of answers) {
    const schema = answer.content?.['application/json']?.schema;
    if (schema === undefined) continue;
    const shape: Shape = {};
    flatten(schema, '', shape);
    return shape;
  }
  return undefined;
}

/**
 * How `other` differs from the recorded shape `recorded` in each recorded field: one line per
 * field, naming the endpoint and the field. A field `other` lacks is missing (a renamed field shows
 * as missing); `fits` tells whether its types agree.
 */
function differences(
  endpoint: string,
  recorded: Shape,
  other: Shape,
  label: string,
  fits: (recorded: Set<string>, other: Set<string>) => boolean,
): string[] {
  return Object.entries(recorded).flatMap(([field, types]) => {
    const theirs = other[field];
    if (theirs === undefined) return [`${endpoint}: ${field}: ${label} lacks it`];
    if (fits(new Set(types.split('|')), new Set(theirs.split('|')))) return [];
    return [`${endpoint}: ${field}: recorded ${types}, ${label} has ${theirs}`];
  });
}

/**
 * How the patched spec's answer (`spec`, from `specShape`) differs from the recorded fields: the
 * spec must have each with its type. A recorded `null` says nothing about the type, and a spec
 * field of type `any` takes every type.
 */
export function specDifferences(endpoint: string, recorded: Shape, spec: Shape | undefined) {
  if (spec === undefined) return [`${endpoint}: the patched spec has no JSON answer for it`];
  return differences(endpoint, recorded, spec, 'the patched spec', (real, documented) => {
    if (documented.has('any')) return true;
    return [...real].every((type) => type === 'null' || documented.has(type));
  });
}

/**
 * How a mock answer's shape differs from the recorded fields: it must have each, with a type the
 * real answer had. `null` only where the recording saw it, unless the recording saw nothing but
 * `null`, which says nothing about the type.
 */
export function mockDifferences(endpoint: string, recorded: Shape, answer: Shape): string[] {
  return differences(endpoint, recorded, answer, 'the mock answer', (real, mock) => {
    if (real.size === 1 && real.has('null')) return true;
    return [...mock].every((type) => real.has(type));
  });
}

/** Whether `types` is a union of `TYPES`, as a shape writes it. */
function isTypeUnion(types: unknown): boolean {
  return typeof types === 'string' && types.split('|').every((type) => TYPES.has(type));
}

/**
 * Why `recording` could hold more than structure, one line each; empty when it holds only the
 * fields of `RECORDED` with types as values, so no name, address, amount, token or PDF content.
 */
export function privacyViolations(recording: unknown): string[] {
  if (!isRecord(recording)) return ['the recording is not an object'];
  return Object.entries(recording).flatMap(([endpoint, shape]) => {
    const fields = RECORDED[endpoint];
    if (fields === undefined) return [`${endpoint} is not a recorded endpoint`];
    if (!isRecord(shape)) return [`${endpoint}: not an object of fields`];
    return Object.entries(shape).flatMap(([field, types]) => {
      if (!fields.includes(field)) return [`${endpoint}: ${field} is not a recorded field`];
      return isTypeUnion(types)
        ? []
        : [`${endpoint}: ${field}: ${JSON.stringify(types)} is not a type`];
    });
  });
}

/**
 * The recording after a run that saw `seen` (each endpoint's merged shape): each endpoint it saw
 * gets this run's types of its recorded fields, and a field the real answer lacked is left out;
 * every other endpoint keeps its earlier entry. Endpoints come in the order of `RECORDED`, and one
 * no longer recorded is dropped.
 */
export function nextRecording(previous: Recording, seen: Record<string, Shape>): Recording {
  return Object.fromEntries(
    Object.entries(RECORDED).flatMap(([endpoint, fields]) => {
      const shape = seen[endpoint];
      if (shape === undefined) {
        const kept = previous[endpoint];
        return kept === undefined ? [] : [[endpoint, kept]];
      }
      const types = fields.flatMap((field) => {
        const type = shape[field];
        return type === undefined ? [] : [[field, type]];
      });
      return [[endpoint, Object.fromEntries(types)]];
    }),
  );
}
