import type { Scenario, WaterLevel } from './contracts.ts';

// Escenarios del motor. Puro: sin reloj, sin red y sin azar.
//
// Referencia: la evidencia tal como llega (un solo año calendario, observado o modelado).
// Alternativas: siempre hipotéticas, nunca pronóstico. Parten de la MISMA evidencia de referencia
// y cambian un único supuesto cualitativo. No hay factor numérico (ni «20 % menos lluvia» ni
// «+2 °C») porque ni el catálogo ni las reglas sustentan uno.
//
// | Escenario     | Cuándo se usa para el Plan B   | Qué cambia frente a la referencia                    |
// | limited_water | agua declarada enough/unknown  | se evalúa sin riego: solo cuenta la lluvia del año   |
// | less_rain     | agua declarada limited         | sin riego y, además, se ordena primero el cultivo    |
// |               |                                | cuya ficha pide menos lluvia mínima (más margen)     |
// | hotter        | no se usa                      | sin supuesto sustentable: la ficha no declara la     |
// |               |                                | base temporal de sus temperaturas                    |

export const REFERENCE: Scenario = { id: 'reference', nature: 'observed_reference' };

export interface Alternative {
  scenario: Scenario;
  /** Agua con la que se evalúa el supuesto. */
  water: WaterLevel;
  /** Supuesto declarado. Viaja en `params.assumption` y la plantilla lo muestra tal cual (≤ 120). */
  assumption: string;
}

/** Condición alternativa del Plan B. Con agua ya limitada se explora menos lluvia, no lo mismo otra vez. */
export function alternativeFor(declared: WaterLevel): Alternative {
  return declared === 'limited'
    ? {
        scenario: { id: 'less_rain', nature: 'hypothetical' },
        water: 'limited',
        assumption: 'Si lloviera menos que en el año de referencia: no se fija cuánto y se prefiere el cultivo que pide menos lluvia.',
      }
    : {
        scenario: { id: 'limited_water', nature: 'hypothetical' },
        water: 'limited',
        assumption: 'Si tuvieras menos agua: se evalúa sin contar con riego, solo con la lluvia del año de referencia.',
      };
}
