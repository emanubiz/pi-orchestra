import { z } from "zod";

export const boardIdSchema = z.object({
  boardId: z.string().min(1),
});

export const createBoardSchema = z.object({
  cwd: z.string().min(1),
  label: z.string().min(1).optional(),
});

export const graphSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  cwd: z.string().optional(),
  entryNodeId: z.string().nullable().optional(),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      promptId: z.string().min(1),
      promptOverride: z.string().nullable().optional(),
      canBeFinal: z.boolean().nullable().optional(),
      runtime: z.enum(["pi", "hermes", "claude"]).optional(),
      runtimeConfig: z.record(z.unknown()).optional(),
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string().min(1),
      sourceNodeId: z.string().min(1),
      targetNodeId: z.string().min(1),
    }),
  ),
});

export const putGraphSchema = z.object({
  boardId: z.string().min(1),
  graph: graphSchema,
});

export const runBoardSchema = z.object({
  boardId: z.string().min(1),
  message: z.string().min(1),
  nodeId: z.string().min(1).optional(),
});

export const injectNodeSchema = z.object({
  boardId: z.string().min(1),
  nodeId: z.string().min(1),
  message: z.string().min(1),
});

export const openUiSchema = z.object({
  boardId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  embed: z.string().min(1).optional(),
});
