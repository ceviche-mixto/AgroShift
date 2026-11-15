// Tipos inferidos de los esquemas Zod. Solo tipos: importar este archivo no carga Zod.
import type { z } from 'zod';
import type * as s from './schemas.ts';

export type LocalDate = z.infer<typeof s.localDateSchema>;
export type Period = z.infer<typeof s.periodSchema>;

export type FarmLocation = z.infer<typeof s.locationSchema>;
export type CropAnswer = z.infer<typeof s.cropAnswerSchema>;
export type PlantingAnswer = z.infer<typeof s.plantingAnswerSchema>;
export type FarmInput = z.infer<typeof s.farmInputSchema>;
export type Goal = (typeof s.GOALS)[number];
export type WaterLevel = (typeof s.WATER_LEVELS)[number];

export type Source = (typeof s.SOURCES)[number];
export type EvidenceKind = (typeof s.EVIDENCE_KINDS)[number];
export type CacheOrigin = (typeof s.CACHE_ORIGINS)[number];
export type CoverageState = (typeof s.COVERAGE_STATES)[number];
export type SourceState = (typeof s.SOURCE_STATES)[number];
export type Coverage = z.infer<typeof s.coverageSchema>;
export type EvidenceData = z.infer<typeof s.evidenceDataSchema>;
export type EvidenceRecord = z.infer<typeof s.evidenceRecordSchema>;

export type ClimateQuery = z.infer<typeof s.climateQuerySchema>;
export type SourceStatus = z.infer<typeof s.sourceStatusSchema>;
export type ClimateEvidence = z.infer<typeof s.climateEvidenceSchema>;

export type Scenario = z.infer<typeof s.scenarioSchema>;
export type Finding = z.infer<typeof s.findingSchema>;
export type Plan = z.infer<typeof s.planSchema>;
export type ResultState = (typeof s.RESULT_STATES)[number];
export type AnalysisResult = z.infer<typeof s.analysisResultSchema>;
export type InputError = z.infer<typeof s.inputErrorSchema>;
export type Alert = z.infer<typeof s.alertSchema>;
export type AnalyzeResponse = z.infer<typeof s.analyzeResponseSchema>;
export type RateLimited = z.infer<typeof s.rateLimitedSchema>;
