import type { ZodRawShape } from 'zod';

/** One how-to topic in the pdl_help catalog. */
export type HelpTopic = Readonly<{
  id: string;
  title: string;
  summary: string;
  guide: readonly string[];
  tools: readonly string[];
}>;

/**
 * Structural view of a registered tool. The help module depends on this shape
 * only, never on the tool registry, so the registry can include pdl_help in the
 * list pdl_help describes without an import cycle.
 */
export type HelpToolEntry = Readonly<{
  name: string;
  description: string;
  inputSchema: ZodRawShape;
}>;

/** One tool parameter documented from its Zod schema. */
export type ParamDoc = Readonly<{
  name: string;
  type: string;
  required: boolean;
  description?: string;
  values?: readonly string[];
}>;

/** pdl_help arguments. */
export type HelpQuery = Readonly<{
  topic?: string;
  tool?: string;
}>;

/** Outcome of resolving a help query, mirroring the ToolResponse shape. */
export type HelpResult = Readonly<{
  ok: boolean;
  data?: unknown;
  error?: string;
  next_steps: readonly string[];
}>;
