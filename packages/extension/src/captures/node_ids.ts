export type NodeIdAllocator = {
  readonly idFor: (node: Node) => string;
  readonly dispose: () => void;
};

export const createNodeIdAllocator = (): NodeIdAllocator => {
  let map: WeakMap<Node, string> | null = new WeakMap();
  let counter = 0;

  const idFor = (node: Node): string => {
    if (map === null) {
      throw new Error('NodeIdAllocator: idFor called after dispose');
    }
    const existing = map.get(node);
    if (existing !== undefined) return existing;
    counter += 1;
    const id = `n${counter}`;
    map.set(node, id);
    return id;
  };

  const dispose = (): void => {
    map = null;
  };

  return { idFor, dispose };
};
