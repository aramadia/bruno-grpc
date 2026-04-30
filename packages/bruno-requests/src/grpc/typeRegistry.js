import protobuf from 'protobufjs';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

const stripLeadingDot = (name) => (name && name.startsWith('.') ? name.slice(1) : name);

const fullNameFromTypeUrl = (typeUrl) => {
  if (typeof typeUrl !== 'string') return '';
  const slashIdx = typeUrl.lastIndexOf('/');
  return slashIdx >= 0 ? typeUrl.slice(slashIdx + 1) : typeUrl;
};

/**
 * Maintains a registry of protobufjs message Types keyed by their fully-qualified
 * name. Used to look up types when packing/unpacking google.protobuf.Any values
 * whose type_url references arbitrary messages from a loaded proto file.
 */
class TypeRegistry {
  constructor() {
    this.types = new Map();
  }

  /**
   * Register every message Type reachable from a protobufjs Root or Namespace.
   * @param {protobuf.NamespaceBase} namespace
   */
  registerNamespace(namespace) {
    if (!namespace || !Array.isArray(namespace.nestedArray)) return;
    for (const child of namespace.nestedArray) {
      if (child instanceof protobuf.Type) {
        this.types.set(stripLeadingDot(child.fullName), child);
      }
      if (child instanceof protobuf.Namespace) {
        this.registerNamespace(child);
      }
    }
  }

  /**
   * Load a proto file with protobufjs and add all its message types to the registry.
   * Run alongside @grpc/proto-loader so the existing serialization pipeline is unchanged.
   * @param {string} filePath
   * @param {string[]} [includeDirs]
   */
  async loadFromProtoFile(filePath, includeDirs = []) {
    const root = new protobuf.Root();
    if (Array.isArray(includeDirs) && includeDirs.length > 0) {
      const originalResolvePath = root.resolvePath;
      root.resolvePath = (origin, target) => {
        const resolved = originalResolvePath(origin, target);
        if (resolved && fs.existsSync(resolved)) {
          return resolved;
        }
        for (const dir of includeDirs) {
          const candidate = nodePath.resolve(dir, target);
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
        return resolved;
      };
    }
    await root.load(filePath, { keepCase: true });
    root.resolveAll();
    this.registerNamespace(root);
    return root;
  }

  /**
   * @param {string} fullName e.g. ".package.Message" or "package.Message"
   * @returns {protobuf.Type|null}
   */
  lookupType(fullName) {
    if (!fullName) return null;
    return this.types.get(stripLeadingDot(fullName)) || null;
  }

  /**
   * Resolve a type by name, accepting fully-qualified, partially-qualified,
   * or simple names. Falls back to a suffix match against registered full
   * names so unqualified descriptor `typeName` values (e.g. "Address" emitted
   * by @grpc/proto-loader for same-package references) can still be resolved.
   * @param {string} name
   * @returns {protobuf.Type|null}
   */
  resolveType(name) {
    if (!name) return null;
    const stripped = stripLeadingDot(name);
    const direct = this.types.get(stripped);
    if (direct) return direct;
    const suffix = `.${stripped}`;
    for (const [fullName, type] of this.types) {
      if (fullName.endsWith(suffix)) return type;
    }
    return null;
  }

  /**
   * @param {string} typeUrl e.g. "type.googleapis.com/package.Message"
   * @returns {protobuf.Type|null}
   */
  lookupTypeByUrl(typeUrl) {
    return this.lookupType(fullNameFromTypeUrl(typeUrl));
  }

  has(fullName) {
    return this.types.has(stripLeadingDot(fullName));
  }

  clear() {
    this.types.clear();
  }

  get size() {
    return this.types.size;
  }
}

export { TypeRegistry, fullNameFromTypeUrl };
