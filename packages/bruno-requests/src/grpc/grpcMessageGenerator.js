import { faker } from '@faker-js/faker';

const PROTOBUFJS_TO_DESCRIPTOR_TYPE = {
  double: 'TYPE_DOUBLE',
  float: 'TYPE_FLOAT',
  int32: 'TYPE_INT32',
  int64: 'TYPE_INT64',
  uint32: 'TYPE_UINT32',
  uint64: 'TYPE_UINT64',
  sint32: 'TYPE_SINT32',
  sint64: 'TYPE_SINT64',
  fixed32: 'TYPE_FIXED32',
  fixed64: 'TYPE_FIXED64',
  sfixed32: 'TYPE_SFIXED32',
  sfixed64: 'TYPE_SFIXED64',
  bool: 'TYPE_BOOL',
  string: 'TYPE_STRING',
  bytes: 'TYPE_BYTES'
};

const ensureLeadingDot = (name) => (name && !name.startsWith('.') ? `.${name}` : name);

/**
 * Convert a protobufjs Field into the descriptor-proto-like shape used by the
 * sample generator (matches @grpc/proto-loader's output for top-level fields).
 */
const protobufFieldToDescriptor = (pbField) => {
  const descriptor = {
    name: pbField.name,
    label: pbField.repeated ? 'LABEL_REPEATED' : 'LABEL_OPTIONAL'
  };

  const primitiveType = PROTOBUFJS_TO_DESCRIPTOR_TYPE[pbField.type];
  if (primitiveType) {
    descriptor.type = primitiveType;
    return descriptor;
  }

  if (pbField.resolvedType) {
    descriptor.typeName = ensureLeadingDot(pbField.resolvedType.fullName);
    descriptor.type = pbField.resolvedType.values !== undefined ? 'TYPE_ENUM' : 'TYPE_MESSAGE';
    return descriptor;
  }

  descriptor.type = 'TYPE_STRING';
  return descriptor;
};

/**
 * Resolve a field's nested fields (descriptor-proto shape) using either the
 * field's already-populated `messageType.field` or the typeRegistry lookup
 * via `typeName`.
 */
const resolveNestedFields = (field, typeRegistry) => {
  if (field.messageType && Array.isArray(field.messageType.field)) {
    return { fields: field.messageType.field, typeKey: field.typeName || '' };
  }
  if (typeRegistry && field.typeName) {
    const lookup = typeof typeRegistry.resolveType === 'function'
      ? typeRegistry.resolveType.bind(typeRegistry)
      : typeRegistry.lookupType.bind(typeRegistry);
    const pbType = lookup(field.typeName);
    if (pbType && Array.isArray(pbType.fieldsArray)) {
      return {
        fields: pbType.fieldsArray.map(protobufFieldToDescriptor),
        // Use the resolved protobufjs full name as the cycle key so that
        // unqualified `typeName`s (e.g. "Tree") and qualified ones
        // (e.g. ".brunotest.nested.Tree") collapse to the same identity.
        typeKey: ensureLeadingDot(pbType.fullName)
      };
    }
  }
  return null;
};

/**
 * Generates a sample message based on method parameter fields
 * @param {Object} fields - Method parameter fields
 * @param {Object} options - Generation options
 * @param {Set<string>} seenTypes - Types currently in the recursion path (cycle guard)
 * @returns {Object} Generated message
 */
const generateSampleMessageFromFields = (fields, options = {}, seenTypes = new Set()) => {
  const result = {};

  if (!fields || !Array.isArray(fields)) {
    return {};
  }

  const { typeRegistry } = options;

  fields.forEach((field) => {
    // Generate a value based on field name and type
    if (field.type === 'TYPE_MESSAGE') {
      const resolved = resolveNestedFields(field, typeRegistry);

      if (resolved) {
        const { fields: nestedFields, typeKey } = resolved;
        if (typeKey && seenTypes.has(typeKey)) {
          // Avoid infinite recursion on self-referential / cyclic message types
          result[field.name] = field.label === 'LABEL_REPEATED' ? [{}] : {};
          return;
        }
        const nextSeen = typeKey ? new Set([...seenTypes, typeKey]) : seenTypes;
        if (field.label === 'LABEL_REPEATED') {
          // Generate array of nested messages
          const count = options.arraySize || faker.number.int({ min: 1, max: 3 });
          result[field.name] = Array.from({ length: count }, () =>
            generateSampleMessageFromFields(nestedFields, options, nextSeen)
          );
        } else {
          // Generate single nested message
          result[field.name] = generateSampleMessageFromFields(nestedFields, options, nextSeen);
        }
      } else {
        // No field info for nested message, generate a simple object
        result[field.name] = field.label === 'LABEL_REPEATED' ? [{}] : {};
      }
    } else if (field.type === 'TYPE_ENUM') {
      result[field.name] = field.label === 'LABEL_REPEATED' ? [0] : 0;
    } else {
      // Generate value based on primitive type and name
      let value;

      switch (field.type) {
        case 'TYPE_DOUBLE':
        case 'TYPE_FLOAT':
          value = faker.number.float({ min: 0, max: 1000, precision: 0.01 });
          break;
        case 'TYPE_INT32':
        case 'TYPE_INT64':
        case 'TYPE_SINT32':
        case 'TYPE_SINT64':
        case 'TYPE_UINT32':
        case 'TYPE_UINT64':
        case 'TYPE_FIXED32':
        case 'TYPE_FIXED64':
          value = faker.number.int({ min: 0, max: 1000 });
          break;
        case 'TYPE_BOOL':
          value = faker.datatype.boolean();
          break;
        case 'TYPE_STRING':
          value = faker.lorem.word();
          break;
        case 'TYPE_BYTES':
          value = Buffer.from(faker.string.alpha({ length: { min: 5, max: 10 } })).toString('base64');
          break;
        default:
          value = faker.lorem.word();
      }

      if (field.label === 'LABEL_REPEATED') {
        // Generate array of values
        const count = options.arraySize || faker.number.int({ min: 1, max: 3 });
        result[field.name] = Array.from({ length: count }, () => value);
      } else {
        result[field.name] = value;
      }
    }
  });

  return result;
};

/**
 * Extracts field definitions from a method's request type
 * @param {Object} method - The gRPC method
 * @returns {Array|null} Array of field definitions or null
 */
const getMethodRequestFields = (method) => {
  try {
    // Navigate through various potential property paths to find fields
    if (method.requestType?.type?.field) {
      return method.requestType.type.field;
    }

    if (method.requestType?.field) {
      return method.requestType.field;
    }

    if (method.requestType?.type) {
      return method.requestType.type;
    }
  } catch (error) {
    console.error('Error extracting method request fields:', error);
    return null;
  }
};

/**
 * Generates a sample gRPC message based on a method definition
 * @param {Object} method - gRPC method definition
 * @param {Object} options - Generation options
 * @returns {Object} Generated message
 */
export const generateGrpcSampleMessage = (method, options = {}) => {
  try {
    if (!method) {
      return {};
    }

    const fields = getMethodRequestFields(method);

    if (fields) {
      return generateSampleMessageFromFields(fields, options);
    }

    // If method exists but no field information could be extracted,
    // generate a generic message that matches common patterns
    return {};
  } catch (error) {
    console.error('Error generating gRPC sample message:', error);
  }
};
