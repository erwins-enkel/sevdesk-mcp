/**
 * The `nth` JSON template in a guide's text right after `marker`, from its `{` to the matching `}`.
 */
export function template(text: string, marker: string, nth = 0): string {
  const after = text.split(marker)[nth + 1];
  const start = after?.indexOf('{') ?? -1;
  if (after === undefined || start === -1 || after.slice(0, start).trim() !== '') {
    throw new Error(`No template after ${marker}`);
  }
  let depth = 0;
  for (let index = start; index < after.length; index += 1) {
    if (after[index] === '{') depth += 1;
    if (after[index] === '}' && --depth === 0) return after.slice(start, index + 1);
  }
  throw new Error(`The template after ${marker} is not closed`);
}

/**
 * A template as snippet code: each `<placeholder>` in `values` replaced by its value, a JavaScript
 * expression where the placeholder is a whole value, text where it sits inside a string. Others
 * (such as the HTML of a mail text) stay.
 */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/<([^<>]+)>/g, (match, name: string) => values[name] ?? match);
}
