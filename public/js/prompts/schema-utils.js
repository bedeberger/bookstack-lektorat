// JSON-Schema-Atome für Grammar-Constrained Decoding (lokale Provider).
// Strict-Defaults: additionalProperties:false, alle properties als required.
// Claude verwendet keine Schemas – callAI ignoriert das Argument für Claude.

export function _obj(properties, { addl = false } = {}) {
  return {
    type: 'object',
    additionalProperties: addl,
    required: Object.keys(properties),
    properties,
  };
}

export const _str = { type: 'string' };
export const _num = { type: 'number' };
