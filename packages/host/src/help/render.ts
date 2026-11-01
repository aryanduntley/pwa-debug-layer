import type { ZodRawShape, ZodTypeAny } from 'zod';
import { HELP_CAPABILITIES, HELP_WORKFLOW } from './topics.js';
import type {
  HelpQuery,
  HelpResult,
  HelpToolEntry,
  HelpTopic,
  ParamDoc,
} from './types.js';

const MAX_SUGGESTIONS = 5;
const SUMMARY_MAX_CHARS = 220;

type ZodDefLike = Readonly<{
  typeName?: string;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  type?: ZodTypeAny;
  values?: readonly unknown[] | Record<string, unknown>;
  value?: unknown;
  options?: readonly ZodTypeAny[];
  checks?: readonly Readonly<{ kind?: string }>[];
  shape?: () => ZodRawShape;
}>;

const defOf = (schema: ZodTypeAny): ZodDefLike =>
  (schema as unknown as { _def: ZodDefLike })._def;

/** Strip optional/default/nullable/effects wrappers down to the value type. */
const unwrap = (schema: ZodTypeAny): ZodTypeAny => {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return def.innerType !== undefined ? unwrap(def.innerType) : schema;
    case 'ZodEffects':
      return def.schema !== undefined ? unwrap(def.schema) : schema;
    default:
      return schema;
  }
};

const enumValues = (schema: ZodTypeAny): readonly string[] | undefined => {
  const def = defOf(schema);
  if (def.typeName === 'ZodEnum' && Array.isArray(def.values)) {
    return def.values.map(String);
  }
  if (def.typeName === 'ZodNativeEnum' && def.values !== undefined) {
    return Object.values(def.values).map(String);
  }
  return undefined;
};

const typeLabel = (raw: ZodTypeAny): string => {
  const schema = unwrap(raw);
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return (def.checks ?? []).some((c) => c.kind === 'int') ? 'integer' : 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodEnum':
    case 'ZodNativeEnum':
      return 'enum';
    case 'ZodLiteral':
      return JSON.stringify(def.value);
    case 'ZodArray':
      return def.type !== undefined ? `${typeLabel(def.type)}[]` : 'array';
    case 'ZodObject': {
      const keys = def.shape !== undefined ? Object.keys(def.shape()) : [];
      return keys.length > 0 ? `object { ${keys.join(', ')} }` : 'object';
    }
    case 'ZodUnion':
      return (def.options ?? []).map(typeLabel).join(' | ') || 'union';
    case 'ZodRecord':
      return 'record';
    default:
      return 'any';
  }
};

const describeParam = (name: string, schema: ZodTypeAny): ParamDoc => {
  const values = enumValues(unwrap(schema));
  const description = schema.description ?? unwrap(schema).description;
  return Object.freeze({
    name,
    type: typeLabel(schema),
    required: !schema.isOptional(),
    ...(description !== undefined ? { description } : {}),
    ...(values !== undefined ? { values: Object.freeze([...values]) } : {}),
  });
};

/** Document every parameter of a tool from its Zod raw shape. */
export const describeParams = (shape: ZodRawShape): readonly ParamDoc[] =>
  Object.freeze(
    Object.entries(shape).map(([name, schema]) => describeParam(name, schema)),
  );

/** First sentence of a description, capped, for one-line tool listings. */
const summarize = (description: string): string => {
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  return firstSentence.length > SUMMARY_MAX_CHARS
    ? `${firstSentence.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : firstSentence;
};

const ok = (data: unknown, next_steps: readonly string[]): HelpResult =>
  Object.freeze({ ok: true, data, next_steps: Object.freeze([...next_steps]) });

const fail = (error: string, next_steps: readonly string[]): HelpResult =>
  Object.freeze({ ok: false, error, next_steps: Object.freeze([...next_steps]) });

/** pdl_help with no arguments: capabilities, workflow, and the topic index. */
export const renderOverview = (
  topics: readonly HelpTopic[],
  toolCount: number,
): HelpResult =>
  ok(
    {
      title: 'pwa-debug: how to use it',
      capabilities: HELP_CAPABILITIES,
      workflow: HELP_WORKFLOW,
      how_to_use_help: [
        'pdl_help() returns this overview.',
        'pdl_help({ topic: "<id>" }) returns a how-to for one area (ids below).',
        'pdl_help({ tool: "<name>" }) returns one tool\'s full description and parameters, read from the live tool registry.',
      ],
      topics: topics.map((t) => ({ id: t.id, title: t.title, summary: t.summary })),
      toolCount,
    },
    [
      'New to this session? Read pdl_help({ topic: "getting_started" }) and pdl_help({ topic: "control" }).',
      'Then start with host_status.',
    ],
  );

/** pdl_help({ topic }): the guide plus a one-line summary per covered tool. */
export const renderTopic = (
  topic: HelpTopic,
  tools: readonly HelpToolEntry[],
): HelpResult => {
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  return ok(
    {
      topic: topic.id,
      title: topic.title,
      guide: topic.guide,
      tools: topic.tools
        .map((name) => byName.get(name))
        .filter((t): t is HelpToolEntry => t !== undefined)
        .map((t) => ({ name: t.name, summary: summarize(t.description) })),
    },
    ['pdl_help({ tool: "<name>" }) gives the parameters for any tool listed here.'],
  );
};

/** pdl_help({ tool }): full description, parameters, and covering topics. */
export const renderToolHelp = (
  tool: HelpToolEntry,
  topics: readonly HelpTopic[],
): HelpResult => {
  const covering = topics.filter((t) => t.tools.includes(tool.name));
  return ok(
    {
      tool: tool.name,
      description: tool.description,
      parameters: describeParams(tool.inputSchema),
      topics: covering.map((t) => t.id),
    },
    covering.length > 0
      ? [`For how this tool fits a workflow: pdl_help({ topic: "${covering[0]!.id}" }).`]
      : [],
  );
};

const tokens = (s: string): readonly string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Rank candidates by substring and token overlap with the query. */
const suggest = (
  query: string,
  candidates: readonly Readonly<{ key: string; text: string }>[],
): readonly string[] => {
  const q = query.toLowerCase();
  const qTokens = tokens(query);
  return candidates
    .map((c) => {
      const key = c.key.toLowerCase();
      const text = c.text.toLowerCase();
      const substring = key.includes(q) || q.includes(key) ? 3 : 0;
      const inText = text.includes(q) ? 2 : 0;
      const overlap = qTokens.filter((w) => text.includes(w)).length;
      return { key: c.key, score: substring + inText + overlap };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => c.key);
};

const resolveTool = (
  name: string,
  topics: readonly HelpTopic[],
  tools: readonly HelpToolEntry[],
): HelpResult => {
  const exact =
    tools.find((t) => t.name === name) ??
    tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (exact !== undefined) return renderToolHelp(exact, topics);
  const suggestions = suggest(
    name,
    tools.map((t) => ({ key: t.name, text: `${t.name} ${t.description}` })),
  );
  return fail(`unknown tool: ${name}`, [
    suggestions.length > 0
      ? `Closest tools: ${suggestions.join(', ')}.`
      : 'No similar tool names.',
    'pdl_help() lists the topics; each topic lists its tools.',
  ]);
};

const resolveTopic = (
  id: string,
  topics: readonly HelpTopic[],
  tools: readonly HelpToolEntry[],
): HelpResult => {
  const exact = topics.find((t) => t.id === id.toLowerCase());
  if (exact !== undefined) return renderTopic(exact, tools);
  const suggestions = suggest(
    id,
    topics.map((t) => ({ key: t.id, text: `${t.id} ${t.title} ${t.summary}` })),
  );
  return fail(`unknown topic: ${id}`, [
    suggestions.length > 0
      ? `Closest topics: ${suggestions.join(', ')}.`
      : `Topics: ${topics.map((t) => t.id).join(', ')}.`,
  ]);
};

/** Dispatch a help query. A tool name wins when both topic and tool are given. */
export const resolveHelp = (
  query: HelpQuery,
  topics: readonly HelpTopic[],
  tools: readonly HelpToolEntry[],
): HelpResult => {
  if (query.tool !== undefined && query.tool.trim() !== '') {
    return resolveTool(query.tool.trim(), topics, tools);
  }
  if (query.topic !== undefined && query.topic.trim() !== '') {
    return resolveTopic(query.topic.trim(), topics, tools);
  }
  return renderOverview(topics, tools.length);
};
