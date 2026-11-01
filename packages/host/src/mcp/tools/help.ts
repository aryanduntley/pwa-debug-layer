import { z } from 'zod';
import { HELP_TOPICS } from '../../help/topics.js';
import { resolveHelp } from '../../help/render.js';
import {
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';

const inputSchema = {
  topic: z
    .string()
    .optional()
    .describe(
      `How-to topic id: ${HELP_TOPICS.map((t) => t.id).join(' | ')}. Omit for the overview.`,
    ),
  tool: z
    .string()
    .optional()
    .describe('A tool name, e.g. "pdl_click", to get its full description and parameters.'),
};

/**
 * Build the pdl_help tool. getTools is read lazily at call time so the registry
 * index can include pdl_help in the very list pdl_help documents.
 */
export const createHelpTool = (
  getTools: () => readonly ToolDef[],
): ToolDef<typeof inputSchema> =>
  Object.freeze({
    name: 'pdl_help',
    description:
      "How to use pwa-debug, as data. Call with no args for the overview: what pwa-debug can do (you can navigate, click, type and read app state yourself, with no screenshots needed), the startup sequence, and the list of how-to topics. Pass topic (e.g. 'control', 'reading_state', 'mobile', 'pwa') for a how-to, or tool (e.g. 'pdl_click') for that tool's full description and parameters, read from the live registry. Cheap, no side effects; call it whenever you are unsure what pwa-debug can do or how to call a tool.",
    inputSchema,
    handler: async (args): Promise<ToolResponse> => {
      const result = resolveHelp(
        { ...(args.topic !== undefined ? { topic: args.topic } : {}), ...(args.tool !== undefined ? { tool: args.tool } : {}) },
        HELP_TOPICS,
        getTools(),
      );
      return result.ok
        ? okResponse(result.data, result.next_steps)
        : errorResponse(result.error ?? 'help lookup failed', result.next_steps);
    },
  });
