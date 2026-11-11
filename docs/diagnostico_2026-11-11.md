# Diagnóstico y cambios — brief del 11-nov-2026

## 1. De dónde sale el precio y por qué llega con 1–2 sesiones de atraso

**Fuente:** el scanner lee `data/{TICKER}.json`, que escribe el workflow de GitHub Actions `fetch-data.yml` con yfinance (Yahoo). El navegador no consulta precios en vivo: el intento directo a Yahoo casi siempre lo bloquea CORS. No hay caché propia por sesión del navegador; GitHub Pages sí cachea ~10 min (ahora se pide con `cache: 'no-cache'`).

Hay **tres causas que se suman**:

| # | Causa | Evidencia |
|---|---|---|
| 1 | **El cron corre 3–4 h tarde.** `0 22 * * 1-5` se ejecutó en realidad a las 01:37–03:57 UTC. El commit "datos: update 2026-11-11" es la corrida de la **tarde del 10-nov**. La barra del 11-nov no existía hasta ~01:40 UTC del 12-nov, así que un scan hecho después del cierre del 11-nov solo podía ver el 10-nov. | Runs #10–#13: `created_at` 2026-11-05T01:59Z, 11-06T01:59Z, 11-07T01:37Z, 11-10T03:57Z, 11-11T01:42Z. |
| 2 | **El batch de yfinance devuelve algunos tickers una sesión atrás.** En la corrida del 10-nov, ~40 de 146 tickers (NOW…PINS, META, ABBV, ONON, PSX, FANG, IR, SPOT, ARM, IBIT, TIGO) quedaron en el 9-nov mientras SPY y el resto llegaban al 10-nov. | Log del job 130262237444: `TTD (260 bars, last=2026-11-09)`, `SPY (260 bars, last=2026-11-10)`. |
| 3 | **El chequeo de frescura no lo detectaba**: solo marcaba STALE con > 3 días calendario, así que el manifest decía "0 stale". | `data/manifest.json` del 11-nov: `"stale_tickers":[]`. |

Por eso el 11-nov TTD, ABNB, ONON y ABBV mostraron el cierre del 9-nov (2 sesiones) y CPA el del 10-nov (1 sesión): exactamente lo que había en el caché. Los precios del scanner en el brief (14.93, 190.29, 37.53, 293.30, 148.22) coinciden al centavo con esos archivos.

**Arreglo del pipeline** (`.github/scripts/fetch_data.py`, `fetch-data.yml`):
- 4 corridas por día en minutos no redondos (21:17, 22:43, 01:13 y 11:37 UTC); cada una solo hace commit si hay cambios.
- Fecha de referencia = última barra de SPY; cada ticker por detrás se vuelve a bajar individualmente (hasta 3 intentos).
- Nunca se reemplaza un archivo por una serie más vieja.
- `data/manifest.json` registra `ref_date`, la última barra de cada ticker y la lista de atrasados vs la referencia; el scanner la muestra en "Salud del scan".
- El commit indica la fecha real de las barras: `datos: barras al 2026-11-11 (run …)`.

## 2. Hallazgo grave: la página publicada fallaba al final de cada scan desde el 27-oct

El commit `ea34eb1` (27-oct) quitó `const marketRegime=await detectMarketRegime()` y dejó `marketRegime` sin declarar. En un Chromium headless contra la versión publicada, el scan termina con `ReferenceError: marketRegime is not defined` y la tabla queda vacía. **Ninguno de los cambios del 27-oct, 29-oct y 2-nov (filtro de earnings, R/R real, fechas de barra, stop roto) llegó a verse en `deco08md.github.io/swing-scanner`.** Las filas que David y su asesor revisaron el 2 y el 11-nov tienen que venir de otra copia (el brief la llama `swing_trade_scanner_v5.html`). Eso explica por qué el brief del 2-nov seguía reportando "no filtra earnings". Corregido, y verificado en headless.

## 3. Qué barra usa cada indicador (después del cambio)

- **Precio mostrado** = precio vivo si se pudo obtener; si no, el último cierre completo del caché, etiquetado "cierre DD-mmm (−N)".
- **RSI, EMA20/50, ATR, setup, stop, target y R/R** se calculan sobre la **misma serie que el precio mostrado**: cierres completos, más la barra viva si existe.
- **Stop del scanner** (para STOP_BROKEN, STOP_TOO_CLOSE y RISK_WIDE) = cierre de la última barra completa − 2×ATR14 de esas barras, como en el brief.
- **R/R real** = `realRR(precio actual, precio actual − 2×ATR, máx 20d de cierres)`.
- **Volumen** = volumen del último día **completo** / **media** de las 20 sesiones previas. Antes era la **mediana**, y en datos de caché se tomaba una barra de más. Las diferencias del 11-nov se explican sobre todo por la barra vieja: el 6.8x de TTD era el día del salto del 9-nov.

## 4. RSI de PG (64 vs 62.7): causa encontrada

El pipeline bajaba precios **ajustados por dividendo** (`auto_adjust=True`). PG pagó ex-dividendo de $1.0885 el 2026-10-23. Todas las barras anteriores quedaban multiplicadas por 0.99342 y desaparecía la caída del ex-dividendo, lo que sube el RSI.

| Serie hasta el cierre del 30-oct | RSI Wilder14 |
|---|---|
| IBKR sin ajuste (251 barras) | **62.7** |
| Caché del scanner (ajustado) | **64.4** |
| Caché con el ajuste del 23-oct revertido | **62.7** |

Arreglo: `auto_adjust=False` (solo ajuste por splits). Queda fijado en `tests/scanner_core.test.js` con las barras de IBKR (`tests/fixtures/pg_ibkr_2026-11-11.json`). Es probable que las desviaciones de stop de PG, COST y TMO del 2-nov tengan la misma causa; no está verificado.

## 5. Reglas implementadas (`scanner-core.js`, compartido entre navegador y tests)

Parámetros por defecto: `earningsDays=7, postEarningsSessions=3, postEarningsGapPct=5, maxRiskPct=10, minStopAtr=1, maxExtPct=10, rsiLo=55, rsiHi=70, minRR=1.5, hideStaleSessions=2`.

| Bandera | Nivel | Regla |
|---|---|---|
| STALE | aviso (1 sesión) / **oculta** (≥ 2; botón "Mostrar de todos modos") | `sessionsBetween(barra, último cierre completo)` ≥ 1. Usa el calendario NYSE con feriados 2026–27 y el corte de las 16:00 ET. |
| STOP_BROKEN | bloquea (sección propia) | precio vivo ≤ stop del scanner |
| EARNINGS_BLOCK | bloquea | próximo reporte en 0–7 días calendario |
| NO_EARNINGS_DATA | aviso | sin fecha próxima ni reporte en los últimos 60 días ("sin dato", nunca "ok"); ETFs exentos |
| POST_EARNINGS_GAP | aviso | reportó hace ≤ 3 sesiones **y** (movimiento vivo > 5 % vs scanner, o la barra es previa a la reacción, o > 5 % desde el reporte) |
| RR_LOW / STOP_TOO_CLOSE / RISK_WIDE | aviso | R/R real < 1.5; stop < 1 ATR del precio vivo; stop a > 10 % del precio |
| STACK_INV / BELOW_EMA20 / RSI_OUT / EXTENDED | aviso | EMA20 ≤ EMA50; precio ≤ EMA20; RSI fuera de 55–70; > 10 % sobre EMA20 |
| VOL_DOWN_DAY | info | volumen ≥ 1.5x en un día < −2 % |
| HOLDING | bloquea (sección "Ya en cartera") | `portfolio.json`: posiciones, órdenes pendientes y exclusiones |
| SEEN_TODAY | info | ya sugerido hoy en este navegador |

Además:
- Una fila con cualquier aviso no puede salir como "Triple Confirmation — Entrada inmediata"; baja a "En Radar".
- P7: con RSI ≥ 75, STALE o POST_EARNINGS_GAP el score queda en máximo 64, así que ya no puede tener fuerza alta.
- P8: recuadro "Salud del scan" con conteos y datos del pipeline; va en rojo si hay filas STALE o sin dato de earnings.
- Earnings: `data/earnings_auto.json` (Yahoo, best effort, 1 vez al día) + `earnings.json` manual, que **gana campo por campo**. Se sembraron las fechas del brief: CPA 18-nov amc, NVDA 17-nov amc, MDT 24-nov bmo, y los últimos reportes de ONON, ABNB, ABBV y TTD.

## 6. Antes / después — corrida real sobre el caché actual (11-nov, 16:51 ET)

En headless, tickers del 11-nov y del 2-nov. Primero sin precio vivo (lo normal en el navegador), después con los precios vivos del brief simulados:

| Ticker | Antes (lo que vio David) | Después, sin vivo | Después, con vivo del brief |
|---|---|---|---|
| TTD | Breakout, 14.93, sin banderas | oculto (2 ses.): STALE, POST_EARNINGS_GAP, RR_LOW, STACK_INV, EXTENDED | STALE, POST_EARNINGS_GAP, RR_LOW, RISK_WIDE, STACK_INV, RSI_OUT (73.2), EXTENDED |
| ABNB | 190.29, R/R 3.5 | oculto: STALE, RR_LOW | STALE, RR_LOW (0.63), STOP_TOO_CLOSE |
| ONON | 37.53, setup activo | oculto: STALE, POST_EARNINGS_GAP, RR_LOW | **desaparece como señal**: con 34.72 no hay setup |
| ABBV | 293.30 | oculto: STALE, RR_LOW, HOLDING (orden 286.40) | ídem |
| CPA | 148.22 | sección Earnings: STALE, EARNINGS_BLOCK, RR_LOW | ídem |

Salud del scan (sin vivo): **0 limpias, 23 STALE, 5 ocultas, 6 sin dato de earnings, 1 earnings ≤ 7 d, 2 post-earnings, 7 en cartera/orden/excluido**. Recuadro en rojo. Para los 18 tickers del 2-nov, la barra actual es del 10-nov: todos salen STALE (1 sesión) hasta que corra el pipeline nuevo.

## 7. Tests

`node tests/scanner_core.test.js` → 27 OK:
- `sessionsBetween` (casos del brief + feriados), `daysTo`, `lastCompletedSession`.
- Bordes de `realRR`.
- Banderas de los 5 tickers del 11-nov, cambio vs scanner, R/R con stop recalculado y con stop del scanner, stop en ATR, riesgo %.
- STOP_BROKEN DVN/OXY, earnings/cartera/score/volumen, y el RSI de PG con datos de IBKR.

Mutaciones (minRR=1.0, quitar frescura, quitar STACK_INV): las tres hacen fallar la suite.

Los datos de los 5 tickers se reconstruyen a partir de las cifras del brief: ATR, stop y máximo de 20 días se derivan del riesgo %, del stop en ATR y del R/R real. Chequeo de consistencia: con ABNB derivado, el R/R con stop del scanner da 3.53, igual al "3.5" del brief. Los valores no publicados en el brief (RSI/EMAs "neutrales") están marcados en el test.

**Los archivos `scanner_checks_2nov.test.js` y `scanner_checks_11nov.test.js` del brief no están en el repo.** Si se agregan a `tests/`, se pueden adaptar a `scanner-core.js`.

## 8. Lo que no se pudo verificar

- **El pipeline nuevo contra Yahoo real**: Yahoo está bloqueado desde este entorno. Se probó con un yfinance simulado que reproduce el fallo del 10-nov (atrasados recuperados en el reintento, atrasado persistente registrado como STALE, ticker fallido). Hay que confirmarlo con la primera corrida real: el log mostrará `retry … ✓`.
- **`fetch_earnings.py`**: no se pudo probar contra Yahoo; corre con `continue-on-error`, así que si falla no afecta los precios.
- **Precio vivo en el navegador**: sigue dependiendo de que Yahoo responda con CORS, lo que normalmente no pasa. La solución real para el intradía es una fuente con CORS y API key (p. ej. Finnhub gratis). No está implementado.
- **La fecha real del reporte de TTD**: TTD sale con POST_EARNINGS_GAP tanto si fue el 6 como el 9-nov.
- **Patrón chasing** (no re-sugerir un ticker que tocó stop y reaparece más caro): no implementado; hace falta un historial de stops tocados.
- **Umbrales `maxExtPct`/`maxRiskPct`**: siguen siendo la suposición del brief.
