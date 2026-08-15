// Serializes a value as JSON that is safe to embed inside a <script> block.
// Escapes "<" so attacker-controlled strings (event titles, calendar names)
// cannot break out via "</script>", and the JS line separators U+2028/U+2029
// which are valid JSON but illegal in JS string literals.
export function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
