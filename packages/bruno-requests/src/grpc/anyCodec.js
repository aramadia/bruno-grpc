import { fullNameFromTypeUrl } from './typeRegistry';

const ANY_TYPE_NAMES = new Set(['google.protobuf.Any', '.google.protobuf.Any']);
const TYPE_KEY = '@type';

const isAnyTypeName = (typeName) => ANY_TYPE_NAMES.has(typeName);

const isPlainObject = (value) =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && !Buffer.isBuffer(value)
  && !ArrayBuffer.isView(value);

/**
 * Recursively walks a JSON value and packs every nested google.protobuf.Any
 * value into its wire form.
 *
 * The proto3 JSON spec encodes Any as:
 *   { "@type": "type.googleapis.com/<full.message.name>", ...inner fields... }
 *
 * @grpc/proto-loader cannot serialize that form directly — it expects the
 * physical Any layout `{ type_url, value: <bytes> }`. We do the conversion
 * here using the supplied {@link TypeRegistry} to look up and encode the
 * nested message.
 *
 * Detection is based purely on the presence of the literal `@type` key,
 * which is illegal as a normal protobuf field name, so it is unambiguous.
 *
 * @param {*} value
 * @param {import('./typeRegistry').TypeRegistry} typeRegistry
 * @returns {*}
 */
const packAnyFieldsInValue = (value, typeRegistry) => {
  if (Array.isArray(value)) {
    return value.map((item) => packAnyFieldsInValue(item, typeRegistry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(value, TYPE_KEY)) {
    return packAnyValue(value, typeRegistry);
  }
  const result = {};
  for (const [k, v] of Object.entries(value)) {
    result[k] = packAnyFieldsInValue(v, typeRegistry);
  }
  return result;
};

const packAnyValue = (value, typeRegistry) => {
  const typeUrl = value[TYPE_KEY];
  if (typeof typeUrl !== 'string' || typeUrl.length === 0) {
    throw new Error('google.protobuf.Any: "@type" must be a non-empty string');
  }
  if (!typeRegistry) {
    throw new Error(
      'google.protobuf.Any: no type registry available to resolve "@type". '
      + 'Load methods from a proto file to enable Any packing.'
    );
  }
  const type = typeRegistry.lookupTypeByUrl(typeUrl);
  if (!type) {
    const fullName = fullNameFromTypeUrl(typeUrl);
    throw new Error(
      `google.protobuf.Any: type "${fullName}" was not found in the loaded proto definitions. `
      + 'Ensure the proto file containing this type is loaded.'
    );
  }
  const inner = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === TYPE_KEY) continue;
    inner[k] = v;
  }
  const innerPacked = packAnyFieldsInValue(inner, typeRegistry);
  const verifyError = type.verify(innerPacked);
  if (verifyError) {
    throw new Error(
      `google.protobuf.Any: failed to verify "${type.fullName}" payload: ${verifyError}`
    );
  }
  const message = type.fromObject(innerPacked);
  const buffer = type.encode(message).finish();
  return { type_url: typeUrl, value: Buffer.from(buffer) };
};

/**
 * Walks a deserialized response and replaces every google.protobuf.Any field
 * — identified by its descriptor `typeName` — with the proto3 JSON form
 * `{ "@type": ..., ...inner fields... }` so users see human-readable output.
 *
 * Walking by descriptor (rather than shape sniffing) avoids false positives
 * on unrelated messages that happen to have `type_url` / `value` fields.
 *
 * @param {*} value - The deserialized response (already in JS object form).
 * @param {Object[]} fields - Field descriptors from `method.responseType.type.field`.
 * @param {import('./typeRegistry').TypeRegistry} typeRegistry
 * @returns {*}
 */
const unpackAnyFieldsInValue = (value, fields, typeRegistry) => {
  if (!Array.isArray(fields) || fields.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((item) => unpackAnyFieldsInValue(item, fields, typeRegistry));
  }
  if (!isPlainObject(value)) return value;

  const result = { ...value };
  for (const field of fields) {
    if (field.type !== 'TYPE_MESSAGE') continue;
    const v = result[field.name];
    if (v === undefined || v === null) continue;
    const isRepeated = field.label === 'LABEL_REPEATED';
    const transformOne = (item) => transformMessageField(item, field, typeRegistry);
    if (isRepeated && Array.isArray(v)) {
      result[field.name] = v.map(transformOne);
    } else {
      result[field.name] = transformOne(v);
    }
  }
  return result;
};

const transformMessageField = (item, field, typeRegistry) => {
  if (!isPlainObject(item)) return item;
  if (isAnyTypeName(field.typeName)) {
    return unpackAnyValue(item, typeRegistry);
  }
  const nestedFields = field.messageType?.field;
  if (Array.isArray(nestedFields)) {
    return unpackAnyFieldsInValue(item, nestedFields, typeRegistry);
  }
  return item;
};

const unpackAnyValue = (anyValue, typeRegistry) => {
  const typeUrl = anyValue.type_url;
  const rawValue = anyValue.value;
  if (typeof typeUrl !== 'string' || typeUrl.length === 0) return anyValue;
  if (!typeRegistry) return anyValue;
  const type = typeRegistry.lookupTypeByUrl(typeUrl);
  if (!type) return anyValue;
  const bytes = toBuffer(rawValue);
  if (!bytes) return anyValue;
  try {
    const decoded = type.decode(bytes);
    const obj = type.toObject(decoded, {
      longs: String,
      enums: String,
      bytes: String,
      defaults: true,
      oneofs: true,
      json: true
    });
    return { [TYPE_KEY]: typeUrl, ...obj };
  } catch (e) {
    // Decoding failed; preserve raw form so caller still sees the data.
    return anyValue;
  }
};

const toBuffer = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') {
    // proto-loader is configured with `bytes: String` -> base64-encoded.
    return Buffer.from(raw, 'base64');
  }
  return null;
};

export { packAnyFieldsInValue, unpackAnyFieldsInValue, isAnyTypeName };
