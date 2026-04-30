/**
 * @jest-environment node
 */

import * as nodePath from 'node:path';
import * as protoLoader from '@grpc/proto-loader';
import { TypeRegistry } from './typeRegistry';
import { generateGrpcSampleMessage } from './grpcMessageGenerator';

const PROTO_PATH = nodePath.join(__dirname, '__fixtures__', 'nested-message-test.proto');

const loadMethod = async (servicePath, methodName) => {
  const def = await protoLoader.load(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
    oneofs: true,
    json: true
  });
  return def[servicePath][methodName];
};

describe('generateGrpcSampleMessage with nested fields', () => {
  test('recurses into nested message fields when typeRegistry is provided', async () => {
    const method = await loadMethod('brunotest.nested.PeopleService', 'Create');
    const typeRegistry = new TypeRegistry();
    await typeRegistry.loadFromProtoFile(PROTO_PATH);

    const sample = generateGrpcSampleMessage(method, { typeRegistry, arraySize: 2 });

    expect(sample).toEqual(expect.objectContaining({
      name: expect.any(String),
      age: expect.any(Number),
      address: expect.objectContaining({
        street: expect.any(String),
        city: expect.any(String),
        zip: expect.any(String)
      }),
      contacts: expect.any(Array)
    }));
    expect(sample.contacts).toHaveLength(2);
    expect(sample.contacts[0]).toEqual(expect.objectContaining({
      email: expect.any(String),
      phone: expect.any(String)
    }));
  });

  test('returns empty objects for nested fields when no typeRegistry is provided', async () => {
    const method = await loadMethod('brunotest.nested.PeopleService', 'Create');

    const sample = generateGrpcSampleMessage(method, { arraySize: 2 });

    expect(sample.address).toEqual({});
    expect(Array.isArray(sample.contacts)).toBe(true);
    expect(sample.contacts).toEqual([{}]);
  });

  test('breaks recursion on self-referential message types', async () => {
    const method = await loadMethod('brunotest.nested.PeopleService', 'CreateTree');
    const typeRegistry = new TypeRegistry();
    await typeRegistry.loadFromProtoFile(PROTO_PATH);

    const sample = generateGrpcSampleMessage(method, { typeRegistry, arraySize: 2 });

    expect(sample).toEqual(expect.objectContaining({
      label: expect.any(String),
      children: expect.any(Array)
    }));
    expect(sample.children).toHaveLength(2);
    // Recursion breaks at the cycle: each direct child has `label` and a
    // `children` placeholder, but grandchildren are not expanded further.
    for (const child of sample.children) {
      expect(child).toEqual(expect.objectContaining({
        label: expect.any(String),
        children: [{}]
      }));
    }
  });
});
