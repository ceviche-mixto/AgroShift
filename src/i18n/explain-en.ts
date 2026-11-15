// English wording of the engine facts. Mirror of the Spanish TEMPLATES in domain/explain.ts: one sentence
// per fact, built only from `id` + `params`, so nobody adds new claims. Pure; only types from explain.ts.
import type { FindingId, Params } from '../domain/explain.ts';

export const CROP_NAMES_EN: Record<string, string> = {
  maize: 'maize',
  rice: 'rice',
  wheat: 'wheat',
  common_bean: 'common bean',
  cowpea: 'cowpea',
  chickpea: 'chickpea',
  sorghum: 'sorghum',
  finger_millet: 'finger millet',
};

export const FAMILY_NAMES_EN: Record<string, string> = { vegetable: 'vegetable', tuber: 'tuber', perennial: 'perennial crop' };
export const FAMILY_FALLBACK_EN = 'crop without its own sheet';

export const QUESTIONS_EN = {
  why_plan_a: 'Why is Plan A proposed to me?',
  less_water: 'What if I have less water?',
  when_to_switch: 'When should I switch to Plan B?',
  what_to_check: 'What should I check before planting?',
} as const;

export const NEUTRAL_FACT_EN = 'There is one more item worth checking with a local technician.';

/** Assumption of each hypothetical scenario (the engine sends its Spanish text; English is picked by scenario id). */
const ASSUMPTIONS_EN: Record<string, string> = {
  less_rain:
    'If it rained less than in the reference year: how much less is not set, and the crop that needs the least rain is preferred.',
  limited_water: 'If you had less water: it is assessed without counting on irrigation, using only the rainfall of the reference year.',
};

const family = (v: Params[string] | undefined) => (typeof v === 'string' && FAMILY_NAMES_EN[v]) || FAMILY_FALLBACK_EN;
const crop = (v: Params[string] | undefined) => (typeof v === 'string' ? (CROP_NAMES_EN[v] ?? v.replace(/[_-]+/g, ' ')) : 'the crop');
const n = (v: Params[string] | undefined) => (v === null || v === undefined ? 'no data' : v);
const assumption = (p: Params) => (typeof p.scenario === 'string' && ASSUMPTIONS_EN[p.scenario]) || n(p.assumption);

export const TEMPLATES_EN: Record<FindingId, (p: Params) => string> = {
  'reason.not_repeated': (p) => `You are not repeating ${crop(p.previous)}: changing crops breaks the cycle of pests and diseases specific to that crop.`,
  'reason.cereal_after_legume': (p) =>
    `After ${crop(p.previous)}, which is a legume, a cereal such as ${crop(p.crop)} makes use of the nitrogen left in the soil.`,
  'reason.legume_after_cereal': (p) =>
    `After ${crop(p.previous)}, which is a cereal, ${crop(p.crop)} rotates the crop: it is a legume and leaves nitrogen for the cereal you plant next.`,
  'reason.legume_after_family': (p) =>
    `Your previous crop is a ${family(p.family)} type and has no sheet of its own: a general rule by crop family was used. ${crop(p.crop)} is a legume and leaves nitrogen in the soil.`,
  'reason.thermal_optimal': (p) =>
    `The average temperature of those dates in the reference year (${n(p.tempC)} °C) is in the ideal range of ${crop(p.crop)} (${n(p.min)} to ${n(p.max)} °C).`,
  'reason.thermal_within_limits': (p) =>
    `The average temperature of those dates in the reference year (${n(p.tempC)} °C) is within the limits of ${crop(p.crop)} (${n(p.min)} to ${n(p.max)} °C).`,
  'reason.rain_covers_minimum': (p) =>
    `Rainfall in the reference year (about ${n(p.rainMm)} mm) reaches the minimum that ${crop(p.crop)} needs (${n(p.minMm)} mm per year), not counting irrigation.`,
  'reason.rain_margin': (p) =>
    `In the reference year it rained about ${n(p.rainMm)} mm and ${crop(p.crop)} needs at least ${n(p.minMm)} mm per year: that leaves ${n(p.marginMm)} mm of margin.`,
  'reason.regional_season': (p) => `The dates fit a documented season for ${crop(p.crop)} in your area: ${n(p.season)}.`,
  'reason.less_water_than_plan_a': (p) =>
    `According to its sheet, ${crop(p.crop)} does well from ${n(p.optimalMinMm)} mm of rain per year and ${crop(p.other)}, from ${n(p.otherOptimalMinMm)} mm: it needs less water.`,
  'reason.fallow_no_rain_support': (p) =>
    `Rainfall in the reference year (about ${n(p.rainMm)} mm) does not reach the minimum of any other crop in the catalog (from ${n(p.minMm)} mm per year): without irrigation, none holds up.`,
  'reason.green_manure_legume': () =>
    'A cover legume (green manure) can leave nitrogen for the cereal you plant next; how much it adds depends on the species and the water, and it is not calculated here.',
  'reason.lower_water_need': (p) => `To save water: according to its sheet, ${crop(p.crop)} does well from ${n(p.optimalMinMm)} mm of rain per year.`,

  'restriction.reference_year': (p) =>
    `The weather of a single reference year was used (${n(p.start)} to ${n(p.end)}), not an average of many years: another year may be different.`,
  'restriction.stale_evidence': () => 'The weather data comes from a saved copy, not from a recent query.',
  'restriction.hypothetical': (p) => `Assumption, not a forecast. ${assumption(p)}`,
  'restriction.thermal_outside_optimal': (p) =>
    `The average temperature of those dates (${n(p.tempC)} °C) is outside the ideal range of ${crop(p.crop)} (${n(p.min)} to ${n(p.max)} °C), although within its limits.`,
  'restriction.depends_on_irrigation': (p) =>
    `Rainfall in the reference year (about ${n(p.rainMm)} mm) does not reach the minimum of ${crop(p.crop)} (${n(p.minMm)} mm per year): this plan depends on irrigation.`,
  'restriction.rain_below_minimum': (p) =>
    `With little water, rainfall in the reference year (about ${n(p.rainMm)} mm) does not reach the minimum of ${crop(p.crop)} (${n(p.minMm)} mm per year): this plan needs supplemental irrigation.`,
  'restriction.green_manure_needs_water': () =>
    'The cover legume also needs some water to grow: if you do not have it, leave the plot fallow without planting.',
  'restriction.rain_above_maximum': (p) =>
    `Rainfall in the reference year (about ${n(p.rainMm)} mm) is above the maximum that ${crop(p.crop)} tolerates according to its sheet (${n(p.maxMm)} mm per year).`,
  'restriction.outside_regional_season': (p) =>
    `The dates do not fit the documented seasons for ${crop(p.crop)} in your area (${n(p.seasons)}).`,

  'action.consult_local_technician': (p) =>
    `This is a decision aid: confirm planting dates and the variety of ${crop(p.crop)} with an agricultural technician in your area.`,
  'action.consult_green_manure': () =>
    'Before sowing the cover crop, confirm with an agricultural technician in your area which species to use and how much water it needs.',
  'action.secure_irrigation': (p) => `Secure irrigation for the whole cycle of ${crop(p.crop)}: rain alone is not enough.`,

  'signal.temperature_out_of_limits': (p) =>
    `If the average temperature of the season leaves the range of ${n(p.min)} to ${n(p.max)} °C, ${crop(p.crop)} stops being an option: look at the other plan.`,
  'signal.irrigation_available': () => 'If you get irrigation water for the whole cycle, go back to Plan A.',
  'signal.less_irrigation': (p) => `If the irrigation water turns out to be less than expected, ${crop(p.crop)} loses its backup: look at the other plan.`,
  'signal.rain_below_minimum': (p) => `If the year's rainfall falls below ${n(p.minMm)} mm, ${crop(p.crop)} would need irrigation: look at the other plan.`,

  'verify.previous_crop_unknown': () =>
    'We do not know which crop was there before: confirm it is not the same one we propose, because repeating it is not advisable.',
  'verify.previous_crop_not_in_catalog': () =>
    'Your previous crop is not in our catalog and we could not check the rotation: confirm the sequence with a local technician.',
  'verify.previous_crop_family_rule': (p) =>
    `The rotation was calculated with a general rule for ${family(p.family)}, not with the sheet of your previous crop: confirm the sequence with a local technician.`,
  'verify.planting_date': () => 'Give at least the planting month: without a date we cannot compare the weather with any crop.',
  'verify.water_availability': (p) =>
    `We do not know how much water you will have: rainfall in the reference year (about ${n(p.rainMm)} mm) does not reach the minimum of ${crop(p.crop)} (${n(p.minMm)} mm per year).`,
  'verify.regional_calendar': (p) => `We have no backed planting calendar for ${crop(p.crop)} in your area: check it locally.`,
  'verify.variety_cycle': (p) => `The shortest cycle on the sheet of ${crop(p.crop)} was assessed (${n(p.days)} days): confirm how long your variety lasts.`,
  'verify.soil_ph': (p) => `We have no data about your soil: ${crop(p.crop)} needs a pH between ${n(p.min)} and ${n(p.max)}.`,
  'verify.no_candidate': () =>
    'No crop in the catalog stayed within its temperature limits for those dates: consult a local technician.',
  'verify.no_alternative': (p) =>
    `Under this assumption we found no other well-supported option (reference year rainfall: about ${n(p.rainMm)} mm). Confirm your available water with a local technician.`,

  'missing.temperature': (p) =>
    `Temperature data for the reference year is missing: there are ${n(p.validDays)} valid days and ${n(p.minDays)} are needed.`,
  'missing.rain': (p) => `Rainfall data for the reference year is missing: there are ${n(p.validDays)} valid days and ${n(p.minDays)} are needed.`,
  'missing.cycle_coverage': () => 'The weather data does not cover the dates of any crop cycle well enough.',
};
