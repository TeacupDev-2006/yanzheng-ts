/**
 * 研证评卷引擎核心包入口。
 */

export * from './models.js'
export * from './gates/gates.js'
export { ALL_PANELS, CONTENT_PANEL, normalizePanels, AVAILABLE_SKILLS, gradeOf, SPREAD_RATIO_THRESHOLD, CONFIDENCE_FLOOR, PASS_LINE, GRADE_BANDS } from './rubric.js'
export type { JudgeSpec, PanelSpec } from './rubric.js'
export * from './arbiter.js'
export * from './engine.js'
export * from './judges/base-judge.js'
export { LLMClient, LLMError, loadsLenient, listModels, assertHttpScheme } from './llm/client.js'
export type { ChatMessage, ChatOptions, ChatResult, MockFn } from './llm/client.js'
export { demoMockLLM } from './llm/demo-mock.js'
export { parsePdfText, splitSections, loadPaper } from './skills/pdf-parse.js'
export type { PaperSection, LoadPaperResult } from './skills/pdf-parse.js'
export { hybridChunkMatch, loadCorpusDir, runSimilarityCheck, cosine } from './skills/similarity.js'
export type { ChunkMatch, SimilarityResult, EmbedFn } from './skills/similarity.js'
export * from './skills/citation.js'
export * from './skills/consistency.js'
export * from './skills/literature.js'
export * from './skills/http-guard.js'
export { renderHtml } from './reports/html-report.js'
export { exportPptx } from './reports/ppt-export.js'
