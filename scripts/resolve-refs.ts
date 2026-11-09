// Inlines every local `$ref` of an OpenAPI document, so the embedded spec needs no resolver at
// runtime. Fails closed: a non-local ref, a ref to a missing target or a cycle throws and names
// the ref, so a changed upstream spec stops `update-spec` instead of shipping half-resolved.
// Sibling keys of a `$ref` are dropped, as OpenAPI 3.0's Reference Object prescribes.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function pointerTarget(document: Json, ref: string): Json {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref (only local refs): ${ref}`);
  let node: Json | undefined = document;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    node =
      node !== null && typeof node === 'object' && Object.hasOwn(node, key)
        ? (node as Record<string, Json>)[key]
        : undefined;
    if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return node;
}

/**
 * Returns a copy of `document` with every `$ref` replaced by its resolved target. Each target is
 * resolved once and shared by all its uses; serialised as JSON, every use is written out in full.
 */
export function resolveRefs(document: Json): Json {
  const resolved = new Map<string, Json>();
  const inProgress = new Set<string>();

  function visit(node: Json): Json {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    const ref = node.$ref;
    if (typeof ref !== 'string') {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
    }
    const cached = resolved.get(ref);
    if (cached !== undefined) return cached;
    if (inProgress.has(ref)) throw new Error(`circular $ref: ${ref}`);
    inProgress.add(ref);
    const target = visit(pointerTarget(document, ref));
    inProgress.delete(ref);
    resolved.set(ref, target);
    return target;
  }

  return visit(document);
}
