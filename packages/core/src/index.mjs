// 公共出口：外部只从这里拿东西，不直接 import 内部文件。

export { validateManifest, resolvePierce, PIERCE_LEVELS } from './contracts.mjs'
export { createToolRegistry, createPromptService, createFocusService, createDeliveryService, createSlotRegistry } from './services.mjs'
export { createModelClient } from './model-client.mjs'
export { createSignalService, validateSignal, SIGNAL_KINDS, SIGNAL_ROUTES, SIGNAL_TO } from './signals.mjs'
export { attachDshAdapter } from './adapter-dsh.mjs'
export { createHost } from './host.mjs'
export { createSessionAdapter } from './session.mjs'
export {
  TEXT_OUTPUT_SCHEMA,
  IMAGE_OUTPUT_SCHEMA,
  normalizeParameters,
  normalizeToolResult,
  toDshToolDefinition,
  toDshUserMessage,
  toDshPromptSection,
  textOfSessionEvent,
} from './dsh-contract.mjs'
