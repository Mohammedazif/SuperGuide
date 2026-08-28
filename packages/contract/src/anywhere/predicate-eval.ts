import type { DigestNode, ExpectPredicate, PageDigest, TargetDescriptor } from "./index.js";

function matches(node: DigestNode, target: TargetDescriptor): boolean {
  return node.role === target.role && node.name === target.name;
}

function findAll(digest: PageDigest, target: TargetDescriptor): DigestNode[] {
  return digest.nodes.filter((node) => matches(node, target));
}

export function evaluatePredicate(predicate: ExpectPredicate, digest: PageDigest): boolean {
  switch (predicate.kind) {
    case "element-present":
      return findAll(digest, predicate.target).length > 0;
    case "element-absent":
      return findAll(digest, predicate.target).length === 0;
    case "text-matches": {
      if (predicate.target === null) {
        return digest.nodes.some((node) => node.name.includes(predicate.contains));
      }
      return findAll(digest, predicate.target).some((node) =>
        node.name.includes(predicate.contains),
      );
    }
    case "url-matches":
      return digest.url.includes(predicate.contains);
    case "value-equals":
      return findAll(digest, predicate.target).some((node) => node.value === predicate.value);
    case "state-is": {
      const nodes = findAll(digest, predicate.target);
      if (nodes.length === 0) return false;
      return nodes.some((node) => {
        switch (predicate.state) {
          case "checked":
            return node.state.checked === true;
          case "unchecked":
            return node.state.checked === false;
          case "disabled":
            return node.state.disabled;
          case "enabled":
            return !node.state.disabled;
          case "expanded":
            return node.state.expanded === true;
          case "collapsed":
            return node.state.expanded === false;
          default: {
            const exhausted: never = predicate.state;
            throw new Error(`unreachable state ${JSON.stringify(exhausted)}`);
          }
        }
      });
    }
    default: {
      const exhausted: never = predicate;
      throw new Error(`unreachable predicate ${JSON.stringify(exhausted)}`);
    }
  }
}
