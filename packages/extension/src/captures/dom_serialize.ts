import type { NodeIdAllocator } from './node_ids.js';
import type { NodeSummary } from './types.js';

const TEXT_CAP_BYTES = 16_384;
const MAX_CHILDREN_PER_NODE = 32;

const capText = (text: string): string =>
  text.length > TEXT_CAP_BYTES
    ? `${text.slice(0, TEXT_CAP_BYTES)}…<truncated ${text.length - TEXT_CAP_BYTES}>`
    : text;

const syntheticTagName = (nodeType: number): string | undefined => {
  if (nodeType === 3) return '#text';
  if (nodeType === 8) return '#comment';
  if (nodeType === 9) return '#document';
  if (nodeType === 11) return '#fragment';
  return undefined;
};

const serializeAttrs = (
  element: Element,
): Readonly<Record<string, string>> | undefined => {
  const attrs = element.attributes;
  if (attrs === undefined || attrs === null || attrs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (let i = 0; i < attrs.length; i += 1) {
    const a = attrs.item(i);
    if (a !== null) out[a.name] = a.value;
  }
  return out;
};

export const summarizeNode = (
  node: Node,
  depthCap: number,
  allocator: NodeIdAllocator,
): NodeSummary => {
  const nodeId = allocator.idFor(node);
  const nodeType = node.nodeType;

  if (nodeType === 1) {
    const element = node as Element;
    const tagName = element.tagName;
    const attrs = serializeAttrs(element);
    const childCount = element.childNodes.length;
    const overChildLimit = childCount > MAX_CHILDREN_PER_NODE;
    if (depthCap <= 0 || overChildLimit) {
      const base: NodeSummary = {
        nodeId,
        nodeType,
        tagName,
        childCount,
        truncated: true,
      };
      return attrs === undefined ? base : { ...base, attrs };
    }
    const base: NodeSummary = { nodeId, nodeType, tagName, childCount };
    return attrs === undefined ? base : { ...base, attrs };
  }

  if (nodeType === 3 || nodeType === 8) {
    const text = node.nodeValue ?? '';
    const tagName = syntheticTagName(nodeType);
    const base: NodeSummary = { nodeId, nodeType, textContent: capText(text) };
    return tagName === undefined ? base : { ...base, tagName };
  }

  const tagName = syntheticTagName(nodeType);
  const base: NodeSummary = { nodeId, nodeType };
  return tagName === undefined ? base : { ...base, tagName };
};
