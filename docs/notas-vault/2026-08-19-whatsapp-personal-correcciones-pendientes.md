---
tema: whatsapp-personal
tipo: nota
proyecto: whatsapp-personal
creada: 2026-08-19
actualizada: 2026-08-19
estado: cerrado
aliases: ["whatsapp-personal once correcciones", "whatsapp-personal correcciones pendientes"]
tags: [whatsapp-personal, forja, glm, revision, deuda-tecnica]
---

# whatsapp-personal: las once correcciones pendientes, aprobado con 0 hallazgos

## Resumen
Run de forja en MODO `hacer` sobre un plan externo (las once correcciones
menores que dejaron las reviews del run que construyó el proyecto), con GLM
implementando y GLM revisando en sesión fresca (override `REVIEW=glm` del
usuario). La primera review (r1) rechazó, pero no por código: la matriz de
cumplimiento ya daba las once correcciones con evidencia, y el fallo fue el
comando decisivo en exit 1 por disco lleno en la VM de Docker. Liberado el
disco, William pidió tres extras (cota de rondas en el resumen, acote de
`sweepStuckTaskRuns`, destrackear los `tsconfig.tsbuildinfo`); la segunda
vuelta los aplicó y la review aprobó con 0 hallazgos, 276 tests en verde.

## Decisiones y acuerdos
- `REDUCE_MAX_ROUNDS = 3` en `summarize.ts`: si tras 3 rondas la pasada de
  reducción del map-reduce sigue sin caber en el tope, sale por
  `trimOldestLines` en vez de seguir llamando al LLM sin fin. Cierra el
  hallazgo de r1 (un modelo que "hace eco" de su entrada dejaba el bucle
  girando).
- `sweepStuckTaskRuns` gana un `userId` opcional, espejo del `conversationId`
  que ya tenía `sweepStuckTranscriptions`: acota el barrido del test a sus
  propias filas. El caller de producción (`runReaperSweep`) no lo pasa, así
  que el comportamiento en producción no cambia.
- `TranscribeButton`: un `done` con transcripción vacía muestra "No se
  detectó voz en el audio." en vez de caer de vuelta a la rama del botón
  inicial (nuevo `transcribe-state.ts`).
- El reaper por reloj (`reaper.ts:25`, marca error a los 10 min sin
  consultar BullMQ) se dejó intacto a propósito: es deuda aceptada por la
  review anterior, no le tocaba al implementador cerrarla por su cuenta.

## Supuestos que resultaron falsos
- Un comando decisivo en exit 1 no siempre es un hallazgo de código: r1
  rechazó por el disco de la VM de Docker al 100% (`wp-postgres` en
  recovery, `57P03`), no por el trabajo. Implementador y revisor lo
  diagnosticaron por separado y coincidieron en la causa raíz.
- La corrección 4 (el catch del reaper distingue `ENOENT`) se daba por
  pendiente en el plan, pero ya venía aplicada en su mayor parte por un
  commit anterior (`796a3ab`) del run que construyó el proyecto; a esta
  vuelta solo le faltaba añadir el log en la rama no-`ENOENT`.
- Los `tsconfig.tsbuildinfo` estaban trackeados en git pese a que
  `.gitignore` los ignora (`*.tsbuildinfo`) desde `c39089b`: ensuciaban cada
  diff y, peor, un `tar` que preserva mtimes hacía que `tsc -b` se creyera
  al día sin emitir `dist` en la copia limpia. Se resolvió con
  `git rm --cached`, tarea de git y por tanto del orquestador, no del
  implementador.

## Datos útiles para el futuro
- Comando decisivo: `docker compose up -d postgres redis && pnpm db-migrate
  && pnpm verify && docker compose -f docker-compose.yml -f
  docker-compose.prod.yml config >/dev/null`
- Verificación desde copia limpia (simula CI, sin `.env` ni artefactos de
  la máquina de desarrollo): `git ls-files --cached --others
  --exclude-standard | tar -cf - -T - | tar -xf - -C <tmp>`, luego `pnpm
  install --frozen-lockfile && pnpm -r build && pnpm -r typecheck && pnpm
  db-migrate && pnpm -r test && docker compose config`.
- 276 tests en verde (worker 75, api 119, panel 9, google 26, llm 21,
  shared 13, mailer 13).
- Plan externo original: `/Users/william/.claude/plans/whatsapp-personal-correcciones.md`
  (copiado a `PLAN.md` en la raíz del repo para este run).

## Pendientes que quedaron
- [ ] El job `images` de CI (smoke `docker build` de api/worker/panel) no se
  re-ejecutó en esta vuelta; Dockerfiles y overlays no cambiaron.
- [ ] El test "respuesta vacía se rechaza" de `ingest.test.ts` sigue
  apoyado en fixtures previos, fuera del alcance de la corrección 9.
- [ ] Deuda aceptada, no cerrar sin decisión de William: `reaper.ts:25`
  sigue decidiendo por reloj en vez de consultar BullMQ.

## Enlaces
- Plan (fuente de verdad de este run): `PLAN.md`
- Reporte de la última vuelta: `EXECUTION_REPORT.md`
- Review aprobada: `WORK_REVIEW.md`; primer rechazo por entorno:
  `WORK_REVIEW.r1.md`
- Nota del run anterior que construyó el proyecto:
  `docs/notas-vault/2026-08-19-whatsapp-personal-cierre-run-forja.md`
