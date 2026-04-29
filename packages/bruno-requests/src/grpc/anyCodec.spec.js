/**
 * @jest-environment node
 */

import * as nodePath from 'node:path';
import protobuf from 'protobufjs';
import { TypeRegistry, fullNameFromTypeUrl } from './typeRegistry';
import { packAnyFieldsInValue, unpackAnyFieldsInValue, isAnyTypeName } from './anyCodec';

const PROTO_PATH = nodePath.join(__dirname, '__fixtures__', 'any-test.proto');

describe('TypeRegistry', () => {
  test('loadFromProtoFile registers user-defined message types', async () => {
    const registry = new TypeRegistry();
    await registry.loadFromProtoFile(PROTO_PATH);

    expect(registry.has('brunotest.any.Inner')).toBe(true);
    expect(registry.has('.brunotest.any.Inner')).toBe(true);
    expect(registry.has('brunotest.any.Wrapper')).toBe(true);
    expect(registry.lookupType('brunotest.any.Inner')).toBeInstanceOf(protobuf.Type);
  });

  test('loadFromProtoFile registers imported well-known types', async () => {
    const registry = new TypeRegistry();
    await registry.loadFromProtoFile(PROTO_PATH);
    expect(registry.has('google.protobuf.Any')).toBe(true);
  });

  test('lookupTypeByUrl strips the type URL prefix', async () => {
    const registry = new TypeRegistry();
    await registry.loadFromProtoFile(PROTO_PATH);
    const type = registry.lookupTypeByUrl('type.googleapis.com/brunotest.any.Inner');
    expect(type).toBeInstanceOf(protobuf.Type);
    expect(type.fullName.replace(/^\./, '')).toBe('brunotest.any.Inner');
  });

  test('fullNameFromTypeUrl handles URLs with and without prefix', () => {
    expect(fullNameFromTypeUrl('type.googleapis.com/foo.Bar')).toBe('foo.Bar');
    expect(fullNameFromTypeUrl('foo.Bar')).toBe('foo.Bar');
    expect(fullNameFromTypeUrl('a/b/c.Type')).toBe('c.Type');
    expect(fullNameFromTypeUrl('')).toBe('');
  });

  test('lookupType returns null for unknown types', () => {
    const registry = new TypeRegistry();
    expect(registry.lookupType('unknown.Type')).toBeNull();
    expect(registry.lookupType('')).toBeNull();
    expect(registry.lookupType(null)).toBeNull();
  });
});

describe('isAnyTypeName', () => {
  test('matches the protobufjs typeName form (leading dot)', () => {
    expect(isAnyTypeName('.google.protobuf.Any')).toBe(true);
  });

  test('matches the bare full-name form', () => {
    expect(isAnyTypeName('google.protobuf.Any')).toBe(true);
  });

  test('rejects unrelated names', () => {
    expect(isAnyTypeName('google.protobuf.Timestamp')).toBe(false);
    expect(isAnyTypeName('Any')).toBe(false);
    expect(isAnyTypeName('')).toBe(false);
    expect(isAnyTypeName(undefined)).toBe(false);
  });
});

describe('packAnyFieldsInValue', () => {
  let registry;

  beforeAll(async () => {
    registry = new TypeRegistry();
    await registry.loadFromProtoFile(PROTO_PATH);
  });

  test('passes through values that have no @type marker', () => {
    const input = { title: 'hello', count: 1, nested: { a: [1, 2, 3] } };
    expect(packAnyFieldsInValue(input, registry)).toEqual(input);
  });

  test('packs a top-level Any value into {type_url, value: Buffer}', () => {
    const input = {
      title: 't',
      payload: {
        '@type': 'type.googleapis.com/brunotest.any.Inner',
        id: 7,
        label: 'hello'
      }
    };
    const out = packAnyFieldsInValue(input, registry);
    expect(out.title).toBe('t');
    expect(out.payload.type_url).toBe('type.googleapis.com/brunotest.any.Inner');
    expect(Buffer.isBuffer(out.payload.value)).toBe(true);
    expect(out.payload.value.length).toBeGreaterThan(0);

    // Round-trip: decoding the bytes with the Inner type should give back the original.
    const Inner = registry.lookupType('brunotest.any.Inner');
    const decoded = Inner.toObject(Inner.decode(out.payload.value));
    expect(decoded).toEqual({ id: 7, label: 'hello' });
  });

  test('packs Any values nested arbitrarily deep', () => {
    const input = {
      nested: {
        inner_any: {
          '@type': 'type.googleapis.com/brunotest.any.Inner',
          id: 42,
          label: 'deep'
        }
      }
    };
    const out = packAnyFieldsInValue(input, registry);
    expect(out.nested.inner_any.type_url).toBe('type.googleapis.com/brunotest.any.Inner');
    expect(Buffer.isBuffer(out.nested.inner_any.value)).toBe(true);
  });

  test('packs every element of a repeated Any field', () => {
    const input = {
      extras: [
        { '@type': 'type.googleapis.com/brunotest.any.Inner', id: 1, label: 'a' },
        { '@type': 'type.googleapis.com/brunotest.any.Inner', id: 2, label: 'b' }
      ]
    };
    const out = packAnyFieldsInValue(input, registry);
    expect(out.extras).toHaveLength(2);
    out.extras.forEach((entry) => {
      expect(entry.type_url).toBe('type.googleapis.com/brunotest.any.Inner');
      expect(Buffer.isBuffer(entry.value)).toBe(true);
    });
  });

  test('throws when @type references an unknown type', () => {
    const input = {
      payload: { '@type': 'type.googleapis.com/does.not.Exist', id: 1 }
    };
    expect(() => packAnyFieldsInValue(input, registry)).toThrow(/was not found/);
  });

  test('throws when @type is missing or empty', () => {
    expect(() => packAnyFieldsInValue({ '@type': '' }, registry)).toThrow(/non-empty string/);
    expect(() => packAnyFieldsInValue({ '@type': 123 }, registry)).toThrow(/non-empty string/);
  });

  test('throws when no registry is available but @type is present', () => {
    expect(() =>
      packAnyFieldsInValue({ '@type': 'type.googleapis.com/foo.Bar' }, null)
    ).toThrow(/no type registry/);
  });

  test('does not treat Buffer values as containers to recurse into', () => {
    const input = { blob: Buffer.from([1, 2, 3]) };
    const out = packAnyFieldsInValue(input, registry);
    expect(Buffer.isBuffer(out.blob)).toBe(true);
    expect(out.blob.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });
});

describe('unpackAnyFieldsInValue', () => {
  let registry;

  beforeAll(async () => {
    registry = new TypeRegistry();
    await registry.loadFromProtoFile(PROTO_PATH);
  });

  test('round-trips an Any field through pack + unpack', () => {
    const original = {
      payload: {
        '@type': 'type.googleapis.com/brunotest.any.Inner',
        id: 99,
        label: 'roundtrip'
      }
    };
    const packed = packAnyFieldsInValue(original, registry);

    // Simulate what proto-loader produces on the response side: bytes as base64.
    const responseShaped = {
      payload: {
        type_url: packed.payload.type_url,
        value: packed.payload.value.toString('base64')
      }
    };

    // Field descriptor mirroring what method.responseType.type.field looks like.
    const fields = [
      { name: 'payload', type: 'TYPE_MESSAGE', typeName: '.google.protobuf.Any', label: 'LABEL_OPTIONAL' }
    ];

    const out = unpackAnyFieldsInValue(responseShaped, fields, registry);
    expect(out.payload['@type']).toBe('type.googleapis.com/brunotest.any.Inner');
    expect(out.payload.id).toBe(99);
    expect(out.payload.label).toBe('roundtrip');
  });

  test('leaves messages unchanged when the descriptor has no Any fields', () => {
    const fields = [{ name: 'title', type: 'TYPE_STRING' }];
    const value = { title: 'hello' };
    expect(unpackAnyFieldsInValue(value, fields, registry)).toEqual(value);
  });

  test('preserves the raw Any when the type_url is unknown', () => {
    const fields = [
      { name: 'payload', type: 'TYPE_MESSAGE', typeName: '.google.protobuf.Any' }
    ];
    const value = {
      payload: { type_url: 'type.googleapis.com/unknown.Type', value: 'AAAA' }
    };
    const out = unpackAnyFieldsInValue(value, fields, registry);
    expect(out.payload).toEqual(value.payload);
  });
});
